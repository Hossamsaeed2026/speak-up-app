// Supabase Edge Function: admin-users  (معدّلة: CORS بقايمة دومينات + باسورد 10 + تحقق مدخلات + سجل عمليات + احترام التحقق بخطوتين)
// الاستبدال: Supabase → Edge Functions → admin-users → Code → امسح القديم والصق ده → Deploy
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

// الدومينات المسموحة: من Secret اسمه ALLOWED_ORIGINS (مفصولة بفاصلة). لو مش متضاف، بيشتغل زي الأول (*) لحد ما تضيفه.
const ALLOWED = (Deno.env.get('ALLOWED_ORIGINS') ?? '').split(',').map((s) => s.trim()).filter(Boolean);
function corsFor(req: Request) {
  const origin = req.headers.get('origin') ?? '';
  const allow = ALLOWED.length === 0 ? '*' : (ALLOWED.includes(origin) ? origin : ALLOWED[0]);
  return {
    'Access-Control-Allow-Origin': allow,
    'Vary': 'Origin',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
  };
}

const ROLES = ['admin', 'secretary', 'therapist', 'parent'];
const MIN_PASS = 10;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

Deno.serve(async (req) => {
  const cors = corsFor(req);
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });

  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  try {
    const url = Deno.env.get('SUPABASE_URL')!;
    const anon = Deno.env.get('SUPABASE_ANON_KEY')!;
    const service = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

    const caller = createClient(url, anon, { global: { headers: { Authorization: req.headers.get('Authorization') ?? '' } } });
    const { data: u } = await caller.auth.getUser();
    if (!u?.user) return json({ error: 'لازم تسجّل دخول الأول' }, 401);

    // الدور بيتقري بجلسة المستخدم نفسه: su_role() بترجع null لو مفعّل التحقق بخطوتين ومادخلش بيه
    const { data: myRole } = await caller.rpc('su_role');
    if (myRole !== 'admin') return json({ error: 'الصلاحية دي للمدير فقط (ولو مفعّل التحقق بخطوتين لازم تدخل بيه)' }, 403);

    const admin = createClient(url, service);

    const body = await req.json().catch(() => ({}));
    const action = body.action;
    const email = String(body.email ?? '').trim().toLowerCase();
    if (!email) return json({ error: 'البريد الإلكتروني مطلوب' }, 400);
    if (email.length > 254 || !EMAIL_RE.test(email)) return json({ error: 'البريد الإلكتروني غير صحيح' }, 400);

    async function findId(): Promise<string | null> {
      const { data: p } = await admin.from('profiles').select('id').eq('email', email).maybeSingle();
      if (p?.id) return p.id;
      for (let page = 1; page <= 20; page++) {
        const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 1000 });
        if (error || !data?.users?.length) break;
        const f = data.users.find((x) => (x.email ?? '').toLowerCase() === email);
        if (f) return f.id;
        if (data.users.length < 1000) break;
      }
      return null;
    }

    if (action === 'upsert') {
      const role = String(body.role ?? '');
      const name = String(body.name ?? '').trim().slice(0, 100);
      const password = String(body.password ?? '');
      if (!ROLES.includes(role)) return json({ error: 'الدور غير صحيح' }, 400);
      if (password && password.length < MIN_PASS) return json({ error: `الباسورد لازم يكون ${MIN_PASS} أحرف على الأقل` }, 400);
      if (password.length > 128) return json({ error: 'الباسورد طويل زيادة' }, 400);
      const staffId = body.staff_id ? String(body.staff_id).slice(0, 64) : null;

      // الأطفال المربوطين (لولي الأمر فقط)
      let clientIds: string[] = [];
      if (role === 'parent') {
        if (!Array.isArray(body.client_ids)) return json({ error: 'لازم تختار الأطفال المربوطين بولي الأمر' }, 400);
        clientIds = [...new Set(body.client_ids.map((x: unknown) => String(x)).filter((x: string) => x && x.length <= 64))];
        if (clientIds.length > 20) return json({ error: 'أقصى عدد أطفال لحساب واحد 20' }, 400);
      }

      let id = await findId();

      // منع المدير من تغيير دور حسابه هو
      if (id && id === u.user.id && role !== 'admin') {
        return json({ error: 'مينفعش تغيّر دور حسابك إنت' }, 400);
      }

      if (id) {
        const patch: Record<string, unknown> = { email, email_confirm: true, user_metadata: { name } };
        if (password) patch.password = password;
        const { error } = await admin.auth.admin.updateUserById(id, patch);
        if (error) return json({ error: 'تعذر التعديل: ' + error.message }, 400);
      } else {
        if (!password) return json({ error: `اكتب باسورد للمستخدم الجديد (${MIN_PASS} أحرف على الأقل)` }, 400);
        const { data, error } = await admin.auth.admin.createUser({
          email, password, email_confirm: true, user_metadata: { name },
        });
        if (error || !data?.user) return json({ error: 'تعذر الإنشاء: ' + (error?.message ?? '') }, 400);
        id = data.user.id;
      }
      const { error: pe } = await admin.from('profiles').upsert(
        { id, email, name, role, staff_id: role === 'therapist' ? staffId : null, client_ids: clientIds },
        { onConflict: 'id' },
      );
      if (pe) return json({ error: 'اتحفظ الحساب بس تعذر حفظ الصلاحية: ' + pe.message }, 400);
      // سجل عمليات (بيظهر في Edge Functions → Logs)
      console.log(JSON.stringify({ audit: 'upsert', by: u.user.email, target: email, role, password_changed: !!password, at: new Date().toISOString() }));
      return json({ ok: true, id, password_changed: !!password });
    }

    if (action === 'delete') {
      const id = await findId();
      if (!id) return json({ ok: true, note: 'الحساب مش موجود أصلاً' });
      if (id === u.user.id) return json({ error: 'مينفعش تمسح حسابك إنت' }, 400);
      await admin.from('profiles').delete().eq('id', id);
      const { error } = await admin.auth.admin.deleteUser(id);
      if (error) return json({ error: 'تعذر الحذف: ' + error.message }, 400);
      console.log(JSON.stringify({ audit: 'delete', by: u.user.email, target: email, at: new Date().toISOString() }));
      return json({ ok: true });
    }

    return json({ error: 'أمر غير معروف' }, 400);
  } catch (e) {
    return json({ error: 'خطأ في الدالة: ' + (e as Error).message }, 500);
  }
});
