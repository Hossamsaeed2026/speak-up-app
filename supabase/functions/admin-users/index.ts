// admin-users: إدارة حسابات الدخول (إنشاء / تعديل باسورد / حذف) - للمدير فقط
// الشاشة في التطبيق: الإعدادات > المستخدمين
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });

const ROLES = ['admin', 'secretary', 'therapist'];

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  try {
    const url = Deno.env.get('SUPABASE_URL')!;
    const anon = Deno.env.get('SUPABASE_ANON_KEY')!;
    const service = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

    // 1) مين اللي بيطلب؟ لازم يكون مسجّل دخول
    const caller = createClient(url, anon, { global: { headers: { Authorization: req.headers.get('Authorization') ?? '' } } });
    const { data: u } = await caller.auth.getUser();
    if (!u?.user) return json({ error: 'لازم تسجّل دخول الأول' }, 401);

    // 2) ولازم يكون مدير (بنقرأ الدور من جدول profiles بصلاحية الخدمة)
    const admin = createClient(url, service);
    const { data: me } = await admin.from('profiles').select('role').eq('id', u.user.id).maybeSingle();
    if (me?.role !== 'admin') return json({ error: 'الصلاحية دي للمدير فقط' }, 403);

    const body = await req.json().catch(() => ({}));
    const action = body.action;
    const email = String(body.email ?? '').trim().toLowerCase();
    if (!email) return json({ error: 'البريد الإلكتروني مطلوب' }, 400);

    // دور على المستخدم بالإيميل: جدول profiles الأول، وبعدها قائمة حسابات الدخول
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
      const name = String(body.name ?? '').trim();
      const password = String(body.password ?? '');
      if (!ROLES.includes(role)) return json({ error: 'الدور غير صحيح' }, 400);
      if (password && password.length < 8) return json({ error: 'الباسورد لازم يكون 8 أحرف على الأقل' }, 400);

      let id = await findId();
      if (id) {
        const patch: Record<string, unknown> = { email, email_confirm: true, user_metadata: { name } };
        if (password) patch.password = password;
        const { error } = await admin.auth.admin.updateUserById(id, patch);
        if (error) return json({ error: 'تعذر التعديل: ' + error.message }, 400);
      } else {
        if (!password) return json({ error: 'اكتب باسورد للمستخدم الجديد (8 أحرف على الأقل)' }, 400);
        const { data, error } = await admin.auth.admin.createUser({
          email, password, email_confirm: true, user_metadata: { name },
        });
        if (error || !data?.user) return json({ error: 'تعذر الإنشاء: ' + (error?.message ?? '') }, 400);
        id = data.user.id;
      }
      const { error: pe } = await admin.from('profiles').upsert(
        { id, email, name, role, staff_id: body.staff_id || null },
        { onConflict: 'id' },
      );
      if (pe) return json({ error: 'اتحفظ الحساب بس تعذر حفظ الصلاحية: ' + pe.message }, 400);
      return json({ ok: true, id, password_changed: !!password });
    }

    if (action === 'delete') {
      const id = await findId();
      if (!id) return json({ ok: true, note: 'الحساب مش موجود أصلاً' });
      if (id === u.user.id) return json({ error: 'مينفعش تمسح حسابك إنت' }, 400);
      await admin.from('profiles').delete().eq('id', id);
      const { error } = await admin.auth.admin.deleteUser(id);
      if (error) return json({ error: 'تعذر الحذف: ' + error.message }, 400);
      return json({ ok: true });
    }

    return json({ error: 'أمر غير معروف' }, 400);
  } catch (e) {
    return json({ error: 'خطأ في الدالة: ' + (e as Error).message }, 500);
  }
});
