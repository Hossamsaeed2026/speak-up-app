// Supabase Edge Function: push-notify
// بتتنادى من pg_cron كل 5 دقايق. بتشوف لو في حاجة اتغيّرت في (الكراسات / الأنشطة / الجلسات / العملاء)
// وتبعت Web Push لولي الأمر أو الأخصائي المعني — حتى لو التطبيق مقفول.
// النشر: Edge Functions → push-notify → الصق الكود → اقفل "Verify JWT" → Deploy
// Secrets المطلوبة: VAPID_PUBLIC, VAPID_PRIVATE, VAPID_SUBJECT (mailto:you@example.com), PUSH_SECRET
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import webpush from 'npm:web-push@3.6.7';

// ==== PURE-START (منطق المقارنة — من غير أي اعتماد على Deno) ====
const WATCH = ['notebooks', 'clientActivities', 'sessions', 'clients'];

const hash = (s: unknown): string => {
  const str = String(s ?? ''); let h = 5381;
  for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
};
const ymd = (d: unknown) => String(d ?? '').replace(/\//g, '-');
const first = (n: unknown) => String(n ?? '').trim().split(/\s+/)[0] || 'الطفل';
const fmtDay = (d: string) => {
  try { const x = new Date(ymd(d) + 'T12:00:00Z'); return isNaN(+x) ? d : x.toLocaleDateString('ar-EG', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' }); } catch { return d; }
};
const fmtT = (t: string) => {
  const m = String(t ?? '').match(/^(\d{1,2}):(\d{2})/); if (!m) return String(t ?? '');
  let h = +m[1]; const ap = h >= 12 ? 'م' : 'ص'; h = h % 12 || 12; return `${h}:${m[2]} ${ap}`;
};

export type Msg = { users: string[]; tag?: string; title: string; body: string };

export function computeFp(key: string, data: any): any {
  if (key === 'notebooks') {
    const out: Record<string, any> = {};
    for (const cid of Object.keys(data && typeof data === 'object' ? data : {})) {
      if (!Array.isArray(data[cid])) continue; out[cid] = {};
      for (const e of data[cid]) {
        if (!e || e.id == null) continue;
        out[cid][e.id] = { d: ymd(e.date), a: (e.acts || []).length, w: (e.hw || []).length, l: (e.links || []).length, r: (e.draws || []).length, n: hash((e.notes || '') + '|' + (e.goals || '')), p: (e.perf || 0) + '/' + (e.goal || 0) };
      }
    }
    return out;
  }
  if (key === 'clientActivities') {
    const out: Record<string, string[]> = {};
    for (const cid of Object.keys(data && typeof data === 'object' ? data : {})) out[cid] = (Array.isArray(data[cid]) ? data[cid] : []).map((a: any) => String(a?.uid));
    return out;
  }
  if (key === 'clients') {
    const c: Record<string, any> = {};
    for (const x of Array.isArray(data) ? data : []) {
      const sch: Record<string, string> = {};
      for (const s of x.weeklySchedule || []) { const t = String(s.therapistId); sch[t] = (sch[t] ? sch[t] + ';' : '') + `${s.day}|${s.time}|${s.type || ''}`; }
      for (const t of Object.keys(sch)) sch[t] = sch[t].split(';').sort().join(';');
      c[String(x.id)] = { n: x.name || '', st: x.status || '', sch };
    }
    return { c };
  }
  if (key === 'sessions') {
    const ss: Record<string, any> = {}, pc: Record<string, any> = {};
    const today = cairoToday();
    for (const s of Array.isArray(data) ? data : []) {
      const d = ymd(s.date);
      if (d >= today) ss[s.id] = [String(s.clientId), String(s.therapistId), d, s.time || ''];
      if (String(s.parentComment ?? '').trim()) pc[s.id] = [String(s.clientId), hash(s.parentComment), String(s.parentComment).trim().slice(0, 90)];
    }
    return { ss, pc };
  }
  return null;
}

export function cairoToday(): string { return new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Cairo' }).format(new Date()); }

type Ctx = { parentsOf: (cid: string) => string[]; therapistsOf: (tid: string) => string[]; names: Record<string, string>; sessionsById?: Map<string, any>; today: string };

export function diffKey(key: string, O: any, N: any, ctx: Ctx, skip: Set<string>): Msg[] {
  const out: Msg[] = [];
  const nm = (cid: string) => ctx.names[cid] || '';
  if (key === 'notebooks') {
    for (const cid of Object.keys(N)) {
      const users = ctx.parentsOf(cid); if (!users.length) continue;
      const who = first(nm(cid));
      for (const id of Object.keys(N[cid])) {
        const e = N[cid][id], p = (O[cid] || {})[id];
        if (!p) {
          const ex: string[] = []; if (e.a) ex.push(e.a + ' نشاط'); if (e.w) ex.push('واجب منزلي'); if (e.l) ex.push('روابط/فيديو');
          out.push({ users, tag: 'nb:' + id, title: (e.d === ctx.today ? 'كراسة النهارده جاهزة — ' : 'كراسة جديدة — ') + who, body: 'الأخصائي أضاف كراسة جلسة ' + fmtDay(e.d) + (ex.length ? ' (' + ex.join(' + ') + ')' : '') });
          continue;
        }
        const w: string[] = [];
        if (e.a > p.a) w.push('أنشطة جديدة (' + (e.a - p.a) + ')');
        if (e.w > p.w) w.push('واجب منزلي جديد');
        if (e.l > p.l) w.push('رابط/فيديو جديد');
        if (e.r > p.r) w.push('رسمة أو صورة');
        if (e.n !== p.n) w.push('ملاحظات الأخصائي');
        if (e.p !== p.p) w.push('تقييم الجلسة');
        if (w.length) out.push({ users, tag: 'nb:' + id, title: 'إضافة جديدة في كراسة ' + who, body: 'كراسة ' + fmtDay(e.d) + ': ' + w.join('، ') });
      }
    }
  } else if (key === 'clientActivities') {
    for (const cid of Object.keys(N)) {
      const users = ctx.parentsOf(cid); if (!users.length) continue;
      const added = N[cid].filter((u: string) => !(O[cid] || []).includes(u));
      if (added.length) out.push({ users, title: 'نشاط جديد للبيت — ' + first(nm(cid)), body: added.length === 1 ? 'اتضاف نشاط جديد في أنشطة البيت' : 'اتضافوا ' + added.length + ' أنشطة جديدة في أنشطة البيت' });
    }
  } else if (key === 'clients') {
    const mapSt: Record<string, string> = { Active: '🟢 نشط', Stopped: '🔴 موقوف', Completed: '🔵 مكتمل' };
    const txt = (s: string) => s.split(';').map((x) => { const [d, t] = x.split('|'); return d + ' ' + fmtT(t); }).join('، ');
    for (const cid of Object.keys(N.c)) {
      const n = N.c[cid], o = O.c[cid];
      for (const tid of Object.keys(n.sch)) {
        const users = ctx.therapistsOf(tid); if (!users.length) continue;
        const ot = o?.sch?.[tid];
        if (!ot) { skip.add(tid + ':' + cid); out.push({ users, title: 'حالة جديدة: ' + n.n, body: 'اتضافت لأطفالك — المواعيد: ' + txt(n.sch[tid]) }); }
        else if (ot !== n.sch[tid]) { skip.add(tid + ':' + cid); out.push({ users, tag: 'sch:' + cid, title: 'جدول جديد: ' + n.n, body: 'المواعيد الأسبوعية: ' + txt(n.sch[tid]) }); }
        if (o && o.st !== n.st) out.push({ users, title: 'تغيير من الإدارة: ' + n.n, body: 'حالة الطفل بقت ' + (mapSt[n.st] || n.st || 'غير محددة') });
      }
      if (o) for (const tid of Object.keys(o.sch)) if (!n.sch[tid]) {
        const users = ctx.therapistsOf(tid); if (users.length) { skip.add(tid + ':' + cid); out.push({ users, title: 'تغيير من الإدارة: ' + n.n, body: 'اتلغى جدولك الأسبوعي الثابت مع الطفل ده' }); }
      }
    }
  } else if (key === 'sessions') {
    // تعليقات الأخصائي لولي الأمر
    for (const id of Object.keys(N.pc)) {
      const [cid, h, txt] = N.pc[id]; if (O.pc?.[id]?.[1] === h) continue;
      const users = ctx.parentsOf(cid); if (users.length) out.push({ users, tag: 'pc:' + id, title: 'تعليق جديد من الأخصائي — ' + first(nm(cid)), body: txt + (txt.length >= 90 ? '…' : '') });
    }
    // جلسات الأخصائي
    const tids = new Set<string>();
    for (const v of Object.values(N.ss) as any[]) tids.add(v[1]);
    for (const v of Object.values(O.ss) as any[]) tids.add(v[1]);
    for (const tid of tids) {
      const users = ctx.therapistsOf(tid); if (!users.length) continue;
      const added: any[] = [];
      for (const id of Object.keys(N.ss)) {
        const s = N.ss[id]; if (s[1] !== tid) continue; const p = O.ss[id];
        if (!p || p[1] !== tid) { if (!skip.has(tid + ':' + s[0])) added.push(s); continue; }
        if (p[2] !== s[2] || p[3] !== s[3]) out.push({ users, tag: 'mv:' + id, title: 'تعديل موعد جلسة: ' + nm(s[0]), body: 'من ' + fmtDay(p[2]) + ' ' + fmtT(p[3]) + ' إلى ' + fmtDay(s[2]) + ' ' + fmtT(s[3]) });
      }
      if (added.length) {
        added.sort((a, b) => (a[2] + a[3]).localeCompare(b[2] + b[3]));
        const lines = added.slice(0, 3).map((s) => first(nm(s[0])) + ' — ' + fmtDay(s[2]) + ' ' + fmtT(s[3]));
        out.push({ users, title: added.length === 1 ? 'جلسة جديدة في جدولك' : added.length + ' جلسات جديدة في جدولك', body: lines.join(' • ') + (added.length > 3 ? ' • و' + (added.length - 3) + ' كمان' : '') });
      }
      for (const id of Object.keys(O.ss)) {
        const p = O.ss[id]; if (p[1] !== tid || (N.ss[id] && N.ss[id][1] === tid)) continue;
        const real = ctx.sessionsById?.get(id);
        if (!real) out.push({ users, title: 'تم إلغاء جلسة: ' + nm(p[0]), body: 'جلسة ' + fmtDay(p[2]) + ' ' + fmtT(p[3]) + ' اتشالت من جدولك' });
        else if (String(real.therapistId) !== tid) out.push({ users, title: 'جلسة اتنقلت لأخصائي تاني: ' + nm(p[0]), body: fmtDay(p[2]) + ' ' + fmtT(p[3]) });
      }
    }
  }
  return out;
}

// تجميع: أقصى 4 إشعارات لكل مستخدم في الدورة الواحدة، والباقي بيتلخّص في إشعار واحد
export function pack(msgs: Msg[], maxPer = 4): Array<{ user: string; tag?: string; title: string; body: string }> {
  const per: Record<string, Msg[]> = {};
  for (const m of msgs) for (const u of m.users) (per[u] ||= []).push(m);
  const res: Array<{ user: string; tag?: string; title: string; body: string }> = [];
  for (const u of Object.keys(per)) {
    const l = per[u];
    if (l.length <= maxPer) l.forEach((m) => res.push({ user: u, tag: m.tag, title: m.title, body: m.body }));
    else {
      l.slice(0, maxPer - 1).forEach((m) => res.push({ user: u, tag: m.tag, title: m.title, body: m.body }));
      res.push({ user: u, title: 'وفي ' + (l.length - (maxPer - 1)) + ' تحديثات تانية', body: 'افتح التطبيق عشان تشوف كل الجديد' });
    }
  }
  return res;
}
// ==== PURE-END ====

Deno.serve(async (req) => {
  try {
    if (req.headers.get('x-push-secret') !== Deno.env.get('PUSH_SECRET')) return new Response('forbidden', { status: 403 });
    const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);

    // 1) فحص خفيف: بصمات الوقت بس
    const { data: meta, error: e1 } = await db.from('app_state').select('key,updated_at').in('key', WATCH);
    if (e1) return Response.json({ error: 'app_state meta: ' + e1.message }, { status: 500 });
    const { data: snaps, error: e2 } = await db.from('push_snap').select('key,stamp,fp').in('key', WATCH);
    if (e2) return Response.json({ error: 'push_snap read: ' + e2.message }, { status: 500 });
    const snapBy: Record<string, any> = {}; (snaps ?? []).forEach((s: any) => { snapBy[s.key] = s; });
    const changed = (meta ?? []).filter((m: any) => !snapBy[m.key] || Date.parse(snapBy[m.key].stamp) !== Date.parse(m.updated_at)).map((m: any) => m.key);
    if (!changed.length) return Response.json({ ok: true, changed: 0 });

    // 2) نقرأ بس المفاتيح اللي اتغيّرت (app_state_full: فيها النسخ الكاملة للعملاء والجلسات، للسيرفر بس)
    const { data: rows, error: e3 } = await db.from('app_state_full').select('key,data,updated_at').in('key', changed);
    if (e3) return Response.json({ error: 'app_state read: ' + e3.message }, { status: 500 });
    const fresh: Record<string, any> = {}, stamps: Record<string, string> = {}, raw: Record<string, any> = {};
    (rows ?? []).forEach((r: any) => { raw[r.key] = r.data; fresh[r.key] = computeFp(r.key, r.data); stamps[r.key] = r.updated_at; });
    const newFp = (k: string) => fresh[k] ?? snapBy[k]?.fp;

    // 3) المستلمين
    const { data: profs } = await db.from('profiles').select('id,role,staff_id,client_ids').in('role', ['parent', 'therapist']);
    const parents: Record<string, string[]> = {}, thers: Record<string, string[]> = {};
    (profs ?? []).forEach((p: any) => {
      if (p.role === 'parent') (p.client_ids ?? []).forEach((c: unknown) => { (parents[String(c)] ||= []).push(p.id); });
      else if (p.staff_id) (thers[String(p.staff_id)] ||= []).push(p.id);
    });
    const names: Record<string, string> = {};
    const cl = newFp('clients'); if (cl) for (const cid of Object.keys(cl.c)) names[cid] = cl.c[cid].n;
    const ctx = {
      parentsOf: (c: string) => parents[c] ?? [], therapistsOf: (t: string) => thers[t] ?? [], names, today: cairoToday(),
      sessionsById: Array.isArray(raw['sessions']) ? new Map(raw['sessions'].map((s: any) => [String(s.id), s])) : undefined,
    };

    // 4) المقارنة (العملاء الأول عشان نمنع تكرار إشعار الجلسات الجديدة)
    const msgs: Msg[] = []; const skip = new Set<string>();
    const baseline: string[] = [];
    for (const k of ['clients', 'notebooks', 'clientActivities', 'sessions']) {
      if (!changed.includes(k)) continue;
      if (!snapBy[k]) { baseline.push(k); continue; }    // أول مرة = baseline بدون إشعارات
      try { msgs.push(...diffKey(k, snapBy[k].fp, fresh[k], ctx, skip)); } catch (e) { console.error('diff', k, e); }
    }

    // 5) حفظ البصمات الجديدة (حتى لو مفيش إشعارات)
    const { error: e4 } = await db.from('push_snap').upsert(changed.filter((k) => fresh[k] != null).map((k) => ({ key: k, stamp: stamps[k], fp: fresh[k], updated_at: new Date().toISOString() })), { onConflict: 'key' });
    if (e4) return Response.json({ error: 'push_snap save: ' + e4.message }, { status: 500 });

    // 6) الإرسال
    let sent = 0, failed = 0;
    const noSubs: string[] = [];
    const items = pack(msgs);
    if (items.length) {
      webpush.setVapidDetails(Deno.env.get('VAPID_SUBJECT') ?? 'mailto:admin@example.com', Deno.env.get('VAPID_PUBLIC')!, Deno.env.get('VAPID_PRIVATE')!);
      const userIds = [...new Set(items.map((i) => i.user))];
      const { data: subs } = await db.from('push_subs').select('endpoint,user_id,p256dh,auth_key').in('user_id', userIds);
      // throttle: نفس الكراسة/التعليق ما يتبعتش أكتر من مرة كل 15 دقيقة لنفس الشخص
      const tags = [...new Set(items.filter((i) => i.tag).map((i) => i.tag!))];
      const recent: Record<string, number> = {};
      if (tags.length) {
        const { data: lg } = await db.from('push_sent').select('user_id,tag,at').in('tag', tags).gte('at', new Date(Date.now() - 15 * 60 * 1000).toISOString());
        (lg ?? []).forEach((r: any) => { recent[r.user_id + '|' + r.tag] = 1; });
      }
      const logRows: any[] = [], dead: string[] = [];
      const jobs: Promise<void>[] = [];
      for (const it of items) {
        if (it.tag && recent[it.user + '|' + it.tag]) continue;
        const userSubs = (subs ?? []).filter((x: any) => x.user_id === it.user);
        if (!userSubs.length) { if (!noSubs.includes(it.user)) noSubs.push(it.user); continue; }
        if (it.tag) logRows.push({ user_id: it.user, tag: it.tag, at: new Date().toISOString() });
        const payload = JSON.stringify({ title: it.title, body: it.body, tag: it.tag || undefined, url: './' });
        for (const s of userSubs) {
          // urgency: high عشان أندرويد (Doze) ما يأخّرش الإشعار
          jobs.push(
            webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth_key } }, payload, { TTL: 86400, urgency: 'high' })
              .then(() => { sent++; })
              .catch((e: any) => {
                failed++;
                if (e?.statusCode === 404 || e?.statusCode === 410) dead.push(s.endpoint);
                else console.error('push fail', e?.statusCode, e?.body);
              })
          );
        }
      }
      await Promise.allSettled(jobs);
      if (logRows.length) await db.from('push_sent').upsert(logRows, { onConflict: 'user_id,tag' });
      if (dead.length) await db.from('push_subs').delete().in('endpoint', dead);
    }
    const result = { ok: true, changed: changed.length, keys: changed, baseline, notifications: items.length, sent, failed, usersWithoutSubs: noSubs.length };
    console.log('push-notify', JSON.stringify(result));
    return Response.json(result);
  } catch (e) {
    console.error('push-notify error', e);
    return Response.json({ error: (e as Error).message }, { status: 500 });
  }
});
