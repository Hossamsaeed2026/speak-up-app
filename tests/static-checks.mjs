// فحوصات سريعة من غير أي مكتبات: node tests/static-checks.mjs
// 1) كل <script> جوه index.html بيتعمله compile (خطأ syntax في بلوك واحد بيوقف الميزة كلها في صمت)
// 2) الحاجات اللي service-worker.js بيعتمد عليها موجودة في index.html
// 3) مفيش id مكرر لبلوكات <script>/<style>
// 4) الـ edge functions (TypeScript) سليمة syntax
// 5) مفيش ملفات بيانات (dumps / أرقام موبايلات كتير) في الريبو — الريبو عام
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { stripTypeScriptTypes } from 'node:module';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const errors = [];
const fail = (msg) => errors.push(msg);

// ---------- index.html ----------
const html = readFileSync(join(root, 'index.html'), 'utf8');
const lineOf = (i) => html.slice(0, i).split('\n').length;

let n = 0;
for (const m of html.matchAll(/<script(\s[^>]*)?>([\s\S]*?)<\/script>/gi)) {
  const attrs = m[1] || '';
  if (/\bsrc=/.test(attrs)) continue;
  const type = (attrs.match(/\btype=["']?([^"'\s>]+)/) || [])[1];
  if (type && !/^(text\/javascript|application\/javascript|module)$/i.test(type)) continue;
  const id = (attrs.match(/\bid=["']([^"']+)/) || [])[1] || '(بدون id)';
  n++;
  try {
    new vm.Script(m[2], { filename: `index.html <script ${id}> line ${lineOf(m.index)}` });
  } catch (e) {
    fail(`index.html: خطأ syntax في <script ${id}> (سطر ${lineOf(m.index)}): ${e.message}`);
  }
}
if (n < 10) fail(`index.html: لقيت ${n} سكريبت بس — الملف ناقص؟`);

for (const s of ['suSplash', '</html>']) {
  if (!html.includes(s)) fail(`index.html: لازم يفضل فيه "${s}" (service-worker.js بيرفض يخزّن الصفحة من غيره)`);
}

const ids = {};
for (const m of html.matchAll(/<(script|style)\s[^>]*\bid=["']([^"']+)/gi)) ids[m[2]] = (ids[m[2]] || 0) + 1;
for (const [id, c] of Object.entries(ids)) if (c > 1) fail(`index.html: الـ id "${id}" متكرر ${c} مرات`);

// ---------- edge functions ----------
const fnDir = join(root, 'supabase', 'functions');
for (const name of readdirSync(fnDir)) {
  const p = join(fnDir, name, 'index.ts');
  try { statSync(p); } catch { continue; }
  try {
    const js = stripTypeScriptTypes(readFileSync(p, 'utf8'))
      .replace(/^import .*$/gm, '')
      .replace(/^export /gm, '');
    new vm.Script(`(async () => {${js}\n})`, { filename: p });
  } catch (e) {
    fail(`supabase/functions/${name}: ${e.message}`);
  }
}

// ---------- مفيش بيانات حقيقية في الريبو ----------
const tracked = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean);
const DATA_EXT = /\.(sql|csv|tsv|xlsx?|xls|bak|dump|sqlite3?|db)$/i;
const PHONE = /\b01[0125]\d{8}\b/g;
const MAX_PHONES = 10; // index.html فيه أرقام المركز نفسه
for (const f of tracked) {
  if (DATA_EXT.test(f) && !f.startsWith('supabase/migrations/')) {
    fail(`${f}: ملف بيانات — الريبو عام، ممنوع رفع dumps أو ملفات Excel/CSV`);
    continue;
  }
  if (!/\.(html?|js|mjs|ts|json|md|txt|sql)$/i.test(f)) continue;
  const phones = new Set(readFileSync(join(root, f), 'utf8').match(PHONE) || []);
  if (phones.size > MAX_PHONES) fail(`${f}: فيه ${phones.size} رقم موبايل مختلف — شكله بيانات عملاء`);
}

if (errors.length) {
  console.error(errors.map((e) => '❌ ' + e).join('\n'));
  process.exit(1);
}
console.log(`✅ static checks: ${n} سكريبت في index.html، والـ edge functions، وفحص البيانات — كله تمام`);
