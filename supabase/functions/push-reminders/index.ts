// Supabase Edge Function: push-reminders
// تذكيرات بالمواعيد (مكمّلة لـ push-notify — مش بديلة):
//   1) ولي الأمر: إشعار قبل ميعاد الجلسة بـ 24 ساعة.
//   2) الأخصائي: الساعة 9 مساءً بتوقيت القاهرة، ملخّص بجلسات بكرة.
// بتتنادى من pg_cron كل 15 دقيقة. نفس الأسرار والجداول بتاعة push-notify.
// النشر: Edge Functions → New function باسم push-reminders → الصق الكود → اقفل "Verify JWT" → Deploy
// Secrets المطلوبة (موجودة بالفعل): VAPID_PUBLIC, VAPID_PRIVATE, VAPID_SUBJECT, PUSH_SECRET
// للتجربة من غير إرسال: ابعت body = {"dry":true} (وممكن "now":"2026-10-23T13:45:00Z" لمحاكاة وقت معيّن)
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import webpush from 'npm:web-push@3.6.7';

// ==== PURE-START (منطق الاختيار — من غير أي اعتماد على Deno) ====
const TZ = 'Africa/Cairo';
const HOUR = 3600 * 1000;
const DONE_STATUS = new Set(['ATT', 'CAN', 'EXC', 'SDE', 'TCA']);   // أي حاجة غير دي = "محجوزة"
const WD = ['الأحد', 'الإثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة', 'السبت'];

export type Msg = { user: string; tag: string; title: string; body: string };

const ymd = (d: unknown) => String(d ?? '').replace(/\//g, '-').slice(0, 10);
const validYmd = (d: string) => /^\d{4}-\d{2}-\d{2}$/.test(d);
const first = (n: unknown) => String(n ?? '').trim().split(/\s+/)[0] || 'الطفل';
const weekday = (d: string) => WD[new Date(d + 'T12:00:00Z').getUTCDay()];

// "16:45" أو "04:45 م" أو "4:45 PM" → دقايق من منتصف الليل
export function parseMin(t: unknown): number | null {
  const x = String(t ?? ''), m = x.match(/(\d{1,2}):(\d{2})/); if (!m) return null;
  let h = +m[1]; const mi = +m[2];
  if (/م|PM/i.test(x) && h < 12) h += 12;
  if (/ص|AM/i.test(x) && h === 12) h = 0;
  return h * 60 + mi;
}
export function fmtMin(min: number): string {
  const h = Math.floor(min / 60), m = String(min % 60).padStart(2, '0');
  return `${h % 12 || 12}:${m} ${h >= 12 ? 'م' : 'ص'}`;
}

function cairoParts(ms: number): Record<string, string> {
  const o: Record<string, string> = {};
  new Intl.DateTimeFormat('en-CA', { timeZone: TZ, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
    .formatToParts(new Date(ms)).forEach((p) => { o[p.type] = p.value; });
  return o;
}
const cairoOffsetMs = (utcMs: number) => { const o = cairoParts(utcMs); return Date.UTC(+o.year, +o.month - 1, +o.day, +o.hour, +o.minute, +o.second) - Math.floor(utcMs / 1000) * 1000; };
// تاريخ + دقايق بتوقيت القاهرة → لحظة UTC (بتراعي التوقيت الصيفي)
export function cairoToUtcMs(date: string, min: number): number {
  const [y, m, d] = date.split('-').map(Number), guess = Date.UTC(y, m - 1, d, 0, min);
  const t = guess - cairoOffsetMs(guess);
  return guess - cairoOffsetMs(t);
}
export const cairoDay = (ms: number) => { const o = cairoParts(ms); return `${o.year}-${o.month}-${o.day}`; };
export const cairoHour = (ms: number) => +cairoParts(ms).hour;
const addDays = (d: string, n: number) => new Date(Date.parse(d + 'T12:00:00Z') + n * 86400000).toISOString().slice(0, 10);

export function plan(a: { now: number; sessions: any[]; clients: any[]; profiles: any[] }): Msg[] {
  const out: Msg[] = [];
  const cl: Record<string, { name: string; active: boolean }> = {};
  for (const c of a.clients || []) cl[String(c.id)] = { name: c.name || '', active: !c.status || c.status === 'Active' };
  const parents: Record<string, string[]> = {}, thers: Record<string, string[]> = {};
  for (const p of a.profiles || []) {
    if (p.role === 'parent') (p.client_ids ?? []).forEach((c: unknown) => { (parents[String(c)] ||= []).push(p.id); });
    else if (p.role === 'therapist' && p.staff_id != null) (thers[String(p.staff_id)] ||= []).push(p.id);
  }
  const tomorrow = addDays(cairoDay(a.now), 1);
  const ninepm = cairoHour(a.now) === 21;
  const byTher: Record<string, Array<{ min: number; name: string }>> = {};

  for (const s of a.sessions || []) {
    const d = ymd(s.date), min = parseMin(s.time);
    if (!validYmd(d) || min == null || DONE_STATUS.has(String(s.status))) continue;
    const c = cl[String(s.clientId)]; if (!c || !c.active) continue;

    // 1) ولي الأمر: الجلسة بتبدأ بعد (23 ساعة .. 24 ساعة] من دلوقتي
    const diff = cairoToUtcMs(d, min) - a.now;
    if (diff > 23 * HOUR && diff <= 24 * HOUR) {
      const id = s.id != null ? String(s.id) : `${s.clientId}-${d}-${min}`;
      for (const u of parents[String(s.clientId)] ?? [])
        out.push({ user: u, tag: 'rem24:' + id, title: 'تذكير بجلسة بكرة — ' + first(c.name), body: `موعد جلسة ${first(c.name)} يوم ${weekday(d)} الساعة ${fmtMin(min)}` });
    }
    // 2) الأخصائي: جلسات بكرة، بتتبعت في ساعة 9 مساءً
    if (ninepm && d === tomorrow && s.therapistId != null) (byTher[String(s.therapistId)] ||= []).push({ min, name: first(c.name) });
  }

  for (const tid of Object.keys(byTher)) {
    const list = byTher[tid].sort((x, y) => x.min - y.min);
    const lines = list.slice(0, 5).map((x) => `${fmtMin(x.min)} ${x.name}`);
    for (const u of thers[tid] ?? [])
      out.push({ user: u, tag: 'rem21:' + tomorrow, title: `جلساتك بكرة ${weekday(tomorrow)} (${list.length})`, body: lines.join(' • ') + (list.length > 5 ? ` • و${list.length - 5} كمان` : '') });
  }
  return out;
}
// ==== PURE-END ====

Deno.serve(async (req) => {
  try {
    if (req.headers.get('x-push-secret') !== Deno.env.get('PUSH_SECRET')) return new Response('forbidden', { status: 403 });
    const opt = await req.json().catch(() => ({}));
    const dry = !!opt?.dry;
    const now = opt?.now ? Date.parse(opt.now) : Date.now();
    if (isNaN(now)) return Response.json({ error: 'bad now' }, { status: 400 });
    const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);

    // app_state_full: نفس app_state بس فيها النسخ الكاملة للعملاء والجلسات (للسيرفر بس)
    const { data: rows, error: e1 } = await db.from('app_state_full').select('key,data').in('key', ['sessions', 'clients']);
    if (e1) return Response.json({ error: 'app_state: ' + e1.message }, { status: 500 });
    const st: Record<string, any> = {}; (rows ?? []).forEach((r: any) => { st[r.key] = r.data; });
    const { data: profs, error: e2 } = await db.from('profiles').select('id,role,staff_id,client_ids').in('role', ['parent', 'therapist']);
    if (e2) return Response.json({ error: 'profiles: ' + e2.message }, { status: 500 });

    const cands = plan({ now, sessions: Array.isArray(st.sessions) ? st.sessions : [], clients: Array.isArray(st.clients) ? st.clients : [], profiles: profs ?? [] });
    if (!cands.length) return Response.json({ ok: true, candidates: 0, sent: 0 });

    // استبعاد اللي اتبعت قبل كده (نفس الشخص + نفس الـ tag)
    const tags = [...new Set(cands.map((m) => m.tag))];
    const { data: done, error: e3 } = await db.from('push_sent').select('user_id,tag').in('tag', tags);
    if (e3) return Response.json({ error: 'push_sent: ' + e3.message }, { status: 500 });
    const was = new Set((done ?? []).map((r: any) => r.user_id + '|' + r.tag));
    const todo = cands.filter((m) => !was.has(m.user + '|' + m.tag));
    if (dry) return Response.json({ ok: true, dry: true, now: new Date(now).toISOString(), candidates: cands.length, toSend: todo });
    if (!todo.length) return Response.json({ ok: true, candidates: cands.length, sent: 0, alreadySent: cands.length });

    webpush.setVapidDetails(Deno.env.get('VAPID_SUBJECT') ?? 'mailto:admin@example.com', Deno.env.get('VAPID_PUBLIC')!, Deno.env.get('VAPID_PRIVATE')!);
    const { data: subs } = await db.from('push_subs').select('endpoint,user_id,p256dh,auth_key').in('user_id', [...new Set(todo.map((m) => m.user))]);
    let sent = 0, failed = 0, noSubs = 0;
    const logRows: any[] = [], dead: string[] = [];
    await Promise.allSettled(todo.map(async (m) => {
      const us = (subs ?? []).filter((x: any) => x.user_id === m.user);
      if (!us.length) { noSubs++; return; }                     // مش اتسجل → مش بنسجّلها كمُرسلة، تتجرب تاني لو اشترك
      const payload = JSON.stringify({ title: m.title, body: m.body, tag: m.tag, url: './' });
      let ok = false;
      await Promise.allSettled(us.map((s: any) =>
        webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth_key } }, payload, { TTL: 3 * 3600, urgency: 'high' })
          .then(() => { ok = true; sent++; })
          .catch((e: any) => { failed++; if (e?.statusCode === 404 || e?.statusCode === 410) dead.push(s.endpoint); else console.error('push fail', e?.statusCode, e?.body); })));
      if (ok) logRows.push({ user_id: m.user, tag: m.tag, at: new Date().toISOString() });
    }));
    if (logRows.length) await db.from('push_sent').upsert(logRows, { onConflict: 'user_id,tag' });
    if (dead.length) await db.from('push_subs').delete().in('endpoint', dead);
    const result = { ok: true, candidates: cands.length, toSend: todo.length, sent, failed, usersWithoutSubs: noSubs };
    console.log('push-reminders', JSON.stringify(result));
    return Response.json(result);
  } catch (e) {
    console.error('push-reminders error', e);
    return Response.json({ error: (e as Error).message }, { status: 500 });
  }
});
