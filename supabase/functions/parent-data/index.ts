// Supabase Edge Function: parent-data  (معدّلة: CORS بقايمة دومينات + متابعة مهارات الأكل والبلع feeding_set / feedingResponses + متابعة معالم التواصل comm_set / commResponses)
// بترجّع لولي الأمر بيانات أطفاله هو بس. الفلترة بتحصل هنا على السيرفر.
// النشر: Supabase → Edge Functions → parent-data → الصق الكود → Deploy
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

// القراية دايماً من app_state_full: الكراسات والتسجيلات ممكن تكون متقسّمة لكل طفل في su_child_blobs، والكتابة على app_state بتتقسّم تاني بالـ trigger
const KEYS = ['clients', 'sessions', 'payments', 'staff', 'branches', 'clientActivities', 'settings', 'evaluations', 'notebooks', 'notebookTicks', 'avatars', 'feedingResponses', 'commResponses'];

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

    const admin = createClient(url, service);
    const { data: me } = await admin.from('profiles').select('role, name, email, client_ids').eq('id', u.user.id).maybeSingle();
    if (me?.role !== 'parent') return json({ error: 'الدالة دي لأولياء الأمور فقط' }, 403);
    // su_role() بجلسة ولي الأمر نفسه بترجع null لو مفعّل التحقق بخطوتين ومادخلش بيه
    const { data: myRole } = await caller.rpc('su_role');
    if (myRole !== 'parent') return json({ error: 'لازم تدخل بالتحقق بخطوتين الأول' }, 403);

    const ids = new Set<string>((me.client_ids ?? []).map((x: unknown) => String(x)));

    let body: any = {};
    try { body = await req.json(); } catch (_) { /* no body = عادي */ }

    // ---------- تعليم مهمة الواجب (الصلاحية الوحيدة لولي الأمر) ----------
    if (body && body.action === 'notebook_tick') {
      const cid = String(body.client_id ?? ''), eid = String(body.entry_id ?? ''), iid = String(body.item_id ?? '');
      if (!ids.has(cid)) return json({ error: 'مش مسموح' }, 403);

      const { data: rows } = await admin.from('app_state_full').select('key,data').in('key', ['notebooks', 'notebookTicks']);
      const mm: Record<string, any> = {};
      (rows ?? []).forEach((r: any) => { mm[r.key] = r.data; });

      const entries: any[] = Array.isArray((mm['notebooks'] ?? {})[cid]) ? mm['notebooks'][cid] : [];
      const entry = entries.find((e: any) => String(e?.id) === eid);
      const item = entry && Array.isArray(entry.hw) ? entry.hw.find((h: any) => String(h?.id) === iid) : null;
      if (!item) return json({ error: 'المهمة غير موجودة' }, 404);

      // التعليمات بتتخزن في مفتاح منفصل عشان ما يتمسحش لما الأخصائي يحفظ الكراسة
      const ticks = (mm['notebookTicks'] && typeof mm['notebookTicks'] === 'object') ? { ...mm['notebookTicks'] } : {};
      ticks[`${eid}:${iid}`] = { done: !!body.done, client_id: cid, by: me.email ?? u.user.email, at: new Date().toISOString() };
      const { error: upErr } = await admin.from('app_state').upsert(
        { key: 'notebookTicks', data: ticks, updated_by: u.user.id, updated_at: new Date().toISOString() },
        { onConflict: 'key' });
      if (upErr) return json({ error: 'تعذر حفظ العلامة' }, 500);
      return json({ ok: true });
    }

    // ---------- تسجيل مهارات الأكل والبلع (ولي الأمر يسجّل بس لأطفاله) ----------
    if (body && body.action === 'feeding_set') {
      const cid = String(body.client_id ?? '');
      if (!ids.has(cid)) return json({ error: 'مش مسموح' }, 403);
      const sid = String(body.skill_id ?? '');
      if (!/^b\d{1,2}_\d{1,2}_\d{2}$/.test(sid)) return json({ error: 'مهارة غير صحيحة' }, 400);
      const status = String(body.status ?? '');
      if (!['consistent', 'sometimes', 'not_observed', 'unsure', 'clear'].includes(status)) return json({ error: 'حالة غير صحيحة' }, 400);
      let date: string | null = null;
      if (body.date) {
        const d = String(body.date);
        if (!/^\d{4}-\d{2}-\d{2}$/.test(d) || isNaN(Date.parse(d))) return json({ error: 'تاريخ غير صحيح' }, 400);
        date = d;
      }
      const note = String(body.note ?? '').trim().slice(0, 500);

      const { data: frow } = await admin.from('app_state_full').select('data').eq('key', 'feedingResponses').maybeSingle();
      const all: Record<string, any> = (frow?.data && typeof frow.data === 'object' && !Array.isArray(frow.data)) ? { ...frow.data } : {};
      const mineR: Record<string, any> = (all[cid] && typeof all[cid] === 'object') ? { ...all[cid] } : {};
      if (status === 'clear') delete mineR[sid];
      else {
        if (!mineR[sid] && Object.keys(mineR).length >= 100) return json({ error: 'تجاوزت الحد المسموح' }, 400);
        mineR[sid] = { status, date, note, by: me.email ?? u.user.email, at: new Date().toISOString() };
      }
      all[cid] = mineR;
      const { error: fErr } = await admin.from('app_state').upsert(
        { key: 'feedingResponses', data: all, updated_by: u.user.id, updated_at: new Date().toISOString() },
        { onConflict: 'key' });
      if (fErr) return json({ error: 'تعذر حفظ التسجيل' }, 500);
      return json({ ok: true });
    }

    // ---------- تسجيل معالم التواصل (ولي الأمر يسجّل بس لأطفاله) ----------
    if (body && body.action === 'comm_set') {
      const cid = String(body.client_id ?? '');
      if (!ids.has(cid)) return json({ error: 'مش مسموح' }, 403);
      const sid = String(body.skill_id ?? '');
      if (!/^c\d{1,2}_\d{2}$/.test(sid)) return json({ error: 'مهارة غير صحيحة' }, 400);
      const status = String(body.status ?? '');
      if (!['consistent', 'sometimes', 'not_observed', 'unsure', 'clear'].includes(status)) return json({ error: 'حالة غير صحيحة' }, 400);
      let date: string | null = null;
      if (body.date) {
        const d = String(body.date);
        if (!/^\d{4}-\d{2}-\d{2}$/.test(d) || isNaN(Date.parse(d))) return json({ error: 'تاريخ غير صحيح' }, 400);
        date = d;
      }
      const note = String(body.note ?? '').trim().slice(0, 500);

      const { data: crow } = await admin.from('app_state_full').select('data').eq('key', 'commResponses').maybeSingle();
      const allC: Record<string, any> = (crow?.data && typeof crow.data === 'object' && !Array.isArray(crow.data)) ? { ...crow.data } : {};
      const mineC: Record<string, any> = (allC[cid] && typeof allC[cid] === 'object') ? { ...allC[cid] } : {};
      if (status === 'clear') delete mineC[sid];
      else {
        if (!mineC[sid] && Object.keys(mineC).length >= 150) return json({ error: 'تجاوزت الحد المسموح' }, 400);
        mineC[sid] = { status, date, note, by: me.email ?? u.user.email, at: new Date().toISOString() };
      }
      allC[cid] = mineC;
      const { error: cErr } = await admin.from('app_state').upsert(
        { key: 'commResponses', data: allC, updated_by: u.user.id, updated_at: new Date().toISOString() },
        { onConflict: 'key' });
      if (cErr) return json({ error: 'تعذر حفظ التسجيل' }, 500);
      return json({ ok: true });
    }

    // ---------- بصمة النسخة: لو ولي الأمر معاه نفس النسخة نرد برد صغير ----------
    const { data: meta } = await admin.from('app_state').select('key,updated_at').in('key', KEYS);
    const version = [...ids].sort().join(',') + '|' + (me.name ?? '') + '|' +
      (meta ?? []).map((r: any) => `${r.key}@${r.updated_at}`).sort().join('|');
    if (body && typeof body.version === 'string' && body.version === version) {
      return json({ ok: true, unchanged: true, version });
    }

    // app_state_full: نفس app_state بس فيها النسخ الكاملة للعملاء والجلسات والمدفوعات (للسيرفر بس)
    const { data: rows, error } = await admin.from('app_state_full').select('key,data').in('key', KEYS);
    if (error) return json({ error: 'تعذر تحميل البيانات' }, 500);
    const m: Record<string, any> = {};
    (rows ?? []).forEach((r: any) => { m[r.key] = r.data; });

    const arr = (k: string) => (Array.isArray(m[k]) ? m[k] : []);

    const clients = arr('clients').filter((c: any) => ids.has(String(c?.id)));
    // ملاحظات الجلسات الداخلية (notes) ما بتتبعتش لولي الأمر. تعليق الأخصائي للأهل (parentComment) بيتبعت
    const sessions = arr('sessions')
      .filter((s: any) => ids.has(String(s?.clientId)))
      .map((s: any) => { const { notes, ...rest } = s; return rest; });
    const payments = arr('payments').filter((p: any) => ids.has(String(p?.clientId)));
    const staff = arr('staff').map((x: any) => ({ id: x?.id, staff_id: x?.staff_id, name: x?.name }));
    // تقييمات الأداء/الاختبارات: بس لأطفاله، وبس اللي الأخصائي سمح بظهورها
    const evaluations = arr('evaluations').filter((e: any) => ids.has(String(e?.clientId)) && e?.parentVisible !== false);
    const ca = (m['clientActivities'] && typeof m['clientActivities'] === 'object') ? m['clientActivities'] : {};
    const clientActivities: Record<string, unknown> = {};
    for (const k of Object.keys(ca)) if (ids.has(String(k))) clientActivities[k] = ca[k];

    // كراسة المتابعة: بس لأطفاله، مع دمج علامات الواجب اللي علّمها ولي الأمر
    const nbAll = (m['notebooks'] && typeof m['notebooks'] === 'object') ? m['notebooks'] : {};
    const ticks = (m['notebookTicks'] && typeof m['notebookTicks'] === 'object') ? m['notebookTicks'] : {};
    const notebooks: Record<string, unknown> = {};
    for (const k of Object.keys(nbAll)) {
      if (!ids.has(String(k)) || !Array.isArray(nbAll[k])) continue;
      notebooks[k] = nbAll[k].map((e: any) => ({
        ...e,
        hw: (Array.isArray(e?.hw) ? e.hw : []).map((h: any) => {
          const t = ticks[`${e?.id}:${h?.id}`];
          return t ? { ...h, done: !!t.done } : h;
        }),
      }));
    }

    // صور أطفاله هو بس (client:<id>) — مش بنبعت صور الأطفال التانيين ولا الموظفين
    const idsLower = new Set([...ids].map((x) => x.trim().toLowerCase()));
    const avatars = arr('avatars').filter((a: any) => {
      const k = String(a?.id ?? '').toLowerCase();
      return k.startsWith('client:') && idsLower.has(k.slice(7));
    });

    // تسجيلات الأكل والبلع: بس لأطفاله
    const frAll = (m['feedingResponses'] && typeof m['feedingResponses'] === 'object') ? m['feedingResponses'] : {};
    const feedingResponses: Record<string, unknown> = {};
    for (const k of Object.keys(frAll)) if (ids.has(String(k))) feedingResponses[k] = frAll[k];

    // تسجيلات التواصل: بس لأطفاله
    const crAll = (m['commResponses'] && typeof m['commResponses'] === 'object') ? m['commResponses'] : {};
    const commResponses: Record<string, unknown> = {};
    for (const k of Object.keys(crAll)) if (ids.has(String(k))) commResponses[k] = crAll[k];

    // رابط Power BI ما يتبعتش لولي الأمر أبداً
    const { powerBiUrl: _hidden, ...settings } = ((m['settings'] ?? {}) as Record<string, unknown>);

    return json({
      ok: true,
      version,
      name: me.name ?? '',
      email: me.email ?? u.user.email,
      client_ids: [...ids],
      clients, sessions, payments, staff, evaluations,
      branches: arr('branches'),
      clientActivities,
      notebooks,
      avatars,
      feedingResponses,
      commResponses,
      settings,
    });
  } catch (e) {
    return json({ error: 'خطأ في الدالة: ' + (e as Error).message }, 500);
  }
});
