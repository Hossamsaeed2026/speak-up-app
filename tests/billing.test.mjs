// اختبارات حسابات الفواتير: node tests/billing.test.mjs
// بيفتح index.html في Chromium ويشغّل calculateSessionFee / calculateClientInvoice الحقيقيين على بيانات تجريبية.
// القواعد: حضر = كامل، غياب بدون عذر = نص، غياب بعذر وإلغاء من المركز = ببلاش (بيتخصموا الشهر اللي بعده)،
// ملغية = مش محسوبة خالص، والشهر الفاضي بيتقدّر من الجدول بس للشهر الحالي/الجاي وفي فترة الحالة ومن غير التقييم.
// لو غيّرت قاعدة حساب عن قصد، عدّل الحالة هنا معاها.
import { createRequire } from 'node:module';
import { serve } from './serve.mjs';

const { chromium } = createRequire(import.meta.url)('playwright');
const server = await serve();
const browser = await chromium.launch();
let failed = 0, passed = 0;
try {
  const page = await browser.newPage();
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));
  await page.goto(server.url, { waitUntil: 'load', timeout: 60000 });
  await page.waitForTimeout(2000);

  const results = await page.evaluate(() => {
    const out = [];
    const eq = (name, got, want) => out.push({ name, ok: JSON.stringify(got) === JSON.stringify(want), got, want });
    todayCairo = () => '2026-10-15'; // تاريخ ثابت عشان قواعد التقدير
    const S = (id, clientId, date, status, price = 100, extra = {}) => Object.assign({ id, clientId, date, time: '10:00', status, price, type: 'جلسة', branch: 'B001' }, extra);
    const reset = () => { state.sessions = []; state.payments = []; state.clients = []; };
    const C = (id, extra = {}) => { const c = Object.assign({ id, name: 'حالة ' + id, branch: 'B001', status: 'Active', weeklySchedule: [] }, extra); state.clients.push(c); return c; };
    const inv = (id, m) => { const i = calculateClientInvoice(id, m); return { count: i.currentSessionsCount, canceled: i.canceledCount, gross: i.currentGrossDue, credit: i.totalPreviousCredit, net: i.totalNetDue, paid: i.totalPaid, remaining: i.remainingBalance }; };

    // 1) سعر الجلسة الواحدة حسب الحالة
    eq('سعر الجلسة حسب الحالة', ['ATT', 'SDE', 'EXC', 'TCA', 'CAN'].map((st) => calculateSessionFee({ status: st, price: 100 }).net), [100, 50, 0, 0, 0]);
    eq('جلسة مجانية (سعر 0 + خصم)', calculateSessionFee({ status: 'ATT', price: 0, discount: 150 }).net, 0);

    // 2) شهر فيه كل الحالات: كله بيتحسب كامل مقدّماً ماعدا الملغية
    reset(); C('A');
    state.sessions.push(S('a1', 'A', '2026-08-03', 'ATT'), S('a2', 'A', '2026-08-10', 'SDE'), S('a3', 'A', '2026-08-17', 'EXC'), S('a4', 'A', '2026-08-24', 'TCA'), S('a5', 'A', '2026-08-31', 'CAN'));
    eq('شهر بكل الحالات', inv('A', '2026-08'), { count: 4, canceled: 1, gross: 400, credit: 0, net: 400, paid: 0, remaining: 400 });

    // 3) الشهر اللي بعده: خصم بعذر + إلغاء المركز كامل، ونص بدون عذر، والملغية مالهاش خصم
    state.sessions.push(S('a6', 'A', '2026-09-07', 'ATT'), S('a7', 'A', '2026-09-14', 'ATT'), S('a8', 'A', '2026-09-21', 'ATT'));
    eq('خصم الشهر اللي فات', inv('A', '2026-09'), { count: 3, canceled: 0, gross: 300, credit: 250, net: 50, paid: 0, remaining: 50 });

    // 4) الخصم أكبر من المطلوب → صفر (مش بالسالب)، والمدفوعات بتنزل من الباقي
    reset(); C('B');
    state.sessions.push(S('b1', 'B', '2026-08-03', 'EXC', 200), S('b2', 'B', '2026-08-10', 'EXC', 200), S('b3', 'B', '2026-09-07', 'ATT', 200));
    state.payments.push({ id: 'p1', clientId: 'B', amount: 100, date: '2026-08-02', month: '2026-08' });
    eq('خصم أكبر من المطلوب', inv('B', '2026-09').net, 0);
    eq('المدفوع بينزل من الباقي', inv('B', '2026-08'), { count: 2, canceled: 0, gross: 400, credit: 0, net: 400, paid: 100, remaining: 300 });

    // 5) شهر كل جلساته ملغية → مفيش فاتورة ولا تقدير من الجدول
    reset(); C('D', { weeklySchedule: [{ day: 'الأحد', time: '10:00', type: 'جلسة' }] });
    state.sessions.push(S('d1', 'D', '2026-10-04', 'CAN'), S('d2', 'D', '2026-10-11', 'CAN'));
    eq('شهر كله ملغي', inv('D', '2026-10'), { count: 0, canceled: 2, gross: 0, credit: 0, net: 0, paid: 0, remaining: 0 });

    // 6) التقدير من الجدول (شهر مافيهوش جلسات)
    reset();
    const reg = C('E', { startDate: '2026-09-01', weeklySchedule: [{ day: 'الأحد', time: '10:00', type: 'جلسة' }, { day: 'الأربعاء', time: '10:00', type: 'جلسة' }] });
    const unit = suCalcPrice(reg, reg.branch, 'جلسة').net;
    eq('سعر الجلسة من الفرع أكبر من صفر', unit > 0, true);
    eq('تقدير الشهر الحالي', inv('E', '2026-10').gross, 8 * unit);
    eq('تقدير الشهر الجاي', inv('E', '2026-11').gross, 8 * unit);
    eq('مفيش تقدير لشهر فات', inv('E', '2026-09').gross, 0);
    eq('مفيش تقدير قبل تاريخ البداية', inv('E', '2026-08').gross, 0);
    C('F', { startDate: '2026-12-01', weeklySchedule: [{ day: 'الأحد', time: '10:00', type: 'جلسة' }] });
    eq('مفيش تقدير قبل البداية حتى لو الشهر جاي', inv('F', '2026-11').gross, 0);
    C('G', { endDate: '2026-10-31', weeklySchedule: [{ day: 'الأحد', time: '10:00', type: 'جلسة' }] });
    eq('مفيش تقدير بعد تاريخ النهاية', inv('G', '2026-11').gross, 0);
    C('H', { weeklySchedule: [{ day: 'الأحد', time: '10:00', type: 'تقييم' }] });
    eq('التقييم مش بيتقدّر من الجدول', inv('H', '2026-11').gross, 0);

    // 7) الجلسة المترحّلة: الأصلية (ملغية + movedTo) مش محسوبة، والتعويضية محسوبة
    reset(); C('M');
    state.sessions.push(S('m1', 'M', '2026-10-06', 'CAN', 100, { movedTo: 'm2', movedPrevStatus: 'SCHEDULED' }), S('m2', 'M', '2026-10-07', 'SCHEDULED', 100, { movedFrom: 'm1' }), S('m3', 'M', '2026-10-13', 'SCHEDULED'));
    eq('الترحيل مش بيكرر الحساب', inv('M', '2026-10'), { count: 2, canceled: 1, gross: 200, credit: 0, net: 200, paid: 0, remaining: 200 });

    return out;
  });

  for (const r of results) {
    if (r.ok) { passed++; continue; }
    failed++;
    console.error(`❌ ${r.name}\n   المتوقع: ${JSON.stringify(r.want)}\n   الناتج:   ${JSON.stringify(r.got)}`);
  }
  if (pageErrors.length) { failed++; console.error('❌ أخطاء JavaScript في الصفحة:\n   ' + pageErrors.join('\n   ')); }
} finally {
  await browser.close();
  server.close();
}
if (failed) { console.error(`\n${failed} اختبار فشل، ${passed} نجح`); process.exit(1); }
console.log(`✅ billing: ${passed}/${passed} حالة حسابات صح`);
