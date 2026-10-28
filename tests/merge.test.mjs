// اختبارات دمج المزامنة (cloudMerge): node tests/merge.test.mjs
// الدوال بتتقري من index.html نفسه (مع الباتش اللي بيلف window.cloudMerge للكراسات)، فالاختبار بيجرّب الكود الحقيقي.
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const html = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'index.html'), 'utf8');
const slice = (start, end) => {
  const s = html.indexOf(start), e = html.indexOf(end, s);
  if (s < 0 || e < 0) throw new Error(`مش لاقي "${start}" في index.html`);
  return html.slice(s, e);
};
const core = slice('function canon(v)', 'function cloudLocal(') + slice('function cloudIdOf(x)', 'function cloudStatus(');
const patch = slice('var _cm=window.cloudMerge;', 'console.warn("notebooks merge",e)}return _cm.apply(this,arguments)}');
const load = new Function('suLog', 'window',
  core + ';window.cloudMerge=cloudMerge;' + patch +
  'console.warn("notebooks merge",e)}return _cm.apply(this,arguments)};return {merge:window.cloudMerge,canon}');
const { merge, canon } = load(() => {}, {});

const M = (base, local, remote) => merge(JSON.stringify(base), local, remote);
const cases = [];
const test = (name, got, expected) => cases.push([name, got, expected]);

// ولي الأمر سجّل من parent-data والأخصائي عنده تعديل مارفعش لسه
test('feedingResponses: الجهتين بيتحفظوا',
  M({ c1: { s1: { status: 'sometimes' } } },
    { c1: { s1: { status: 'sometimes' } }, c2: { s9: { status: 'consistent' } } },
    { c1: { s1: { status: 'sometimes' }, s2: { status: 'unsure' } } }),
  { c1: { s1: { status: 'sometimes' }, s2: { status: 'unsure' } }, c2: { s9: { status: 'consistent' } } });
test('settings: مديرين عدّلوا حقول مختلفة',
  M({ theme: 'indigo', centerName: 'A', invoiceConfig: { a: 1, b: 1 } },
    { theme: 'pink', centerName: 'A', invoiceConfig: { a: 1, b: 1 } },
    { theme: 'indigo', centerName: 'B', invoiceConfig: { a: 1, b: 2 } }),
  { theme: 'pink', centerName: 'B', invoiceConfig: { a: 1, b: 2 } });
test('نفس الحقل اتعدّل من الجهتين → الجهاز ده يكسب', M({ theme: 'indigo' }, { theme: 'pink' }, { theme: 'green' }), { theme: 'pink' });
test('مسح محلي لمفتاح محدش لمسه', M({ a: 1, b: 2 }, { a: 1 }, { a: 1, b: 2, c: 3 }), { a: 1, c: 3 });
test('مسح من جهاز تاني لمفتاح ماتعدّلش هنا', M({ a: 1, b: 2 }, { a: 1, b: 2, c: 3 }, { a: 1 }), { a: 1, c: 3 });
test('مسح هنا وتعديل هناك → التعديل يفضل', M({ a: 1, b: 2 }, { a: 1 }, { a: 1, b: 5 }), { a: 1, b: 5 });
test('notebookTicks من مصدرين', M({}, { 'e1:h1': { done: true } }, { 'e2:h2': { done: false } }), { 'e1:h1': { done: true }, 'e2:h2': { done: false } });
test('قوايم بالـ id: إضافة ومسح وتعديل',
  M([{ id: 1, v: 1 }, { id: 2, v: 1 }, { id: 3, v: 1 }],
    [{ id: 1, v: 2 }, { id: 3, v: 1 }, { id: 4, v: 1 }],
    [{ id: 1, v: 1 }, { id: 2, v: 1 }, { id: 3, v: 9 }, { id: 5, v: 1 }]),
  [{ id: 1, v: 2 }, { id: 3, v: 9 }, { id: 5, v: 1 }, { id: 4, v: 1 }]);
test('قوايم من غير id → الجهاز ده يكسب', M(['a'], ['a', 'b'], ['a', 'c']), ['a', 'b']);
test('الكراسات (الباتش)',
  M({ c1: [{ id: 'e1', n: 1 }] }, { c1: [{ id: 'e1', n: 1 }, { id: 'e2', n: 1 }] }, { c1: [{ id: 'e1', n: 1 }], c2: [{ id: 'e3', n: 1 }] }),
  { c1: [{ id: 'e1', n: 1 }, { id: 'e2', n: 1 }], c2: [{ id: 'e3', n: 1 }] });
test('من غير نسخة أساس', merge('not json', { a: 1, b: 1 }, { b: 2, c: 3 }), { a: 1, b: 1, c: 3 });
test('اتعدّل هناك بس', M({ a: 1 }, { a: 1 }, { a: 2, z: 1 }), { a: 2, z: 1 });
test('اتعدّل هنا بس', M({ a: 1 }, { a: 3 }, { a: 1 }), { a: 3 });

let failed = 0;
for (const [name, got, expected] of cases) {
  try { assert.equal(canon(got), canon(expected)); console.log('✅', name); }
  catch { failed++; console.error('❌', name, '\n   got:     ', canon(got), '\n   expected:', canon(expected)); }
}
console.log(`${cases.length - failed}/${cases.length} merge tests passed`);
process.exit(failed ? 1 : 0);
