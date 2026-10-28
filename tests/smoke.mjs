// اختبار فتح الصفحة في متصفح حقيقي: node tests/smoke.mjs
// بيشغّل سيرفر محلي، يفتح index.html في Chromium، ويفشل لو ظهر أي خطأ JavaScript في الصفحة.
// محتاج playwright (موجود في جلسات Claude Code، وفي GitHub Actions بيتسطّب من package.json).
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, dirname, extname, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const { chromium } = createRequire(import.meta.url)('playwright');

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.svg': 'image/svg+xml' };
const server = createServer(async (req, res) => {
  const path = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname)).replace(/^([/\\])+/, '');
  if (path.startsWith('..')) { res.writeHead(403).end(); return; }
  try {
    const body = await readFile(join(root, path || 'index.html'));
    res.writeHead(200, { 'Content-Type': TYPES[extname(path)] || 'application/octet-stream' }).end(body);
  } catch { res.writeHead(404).end(); }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${server.address().port}/index.html`;

const browser = await chromium.launch();
const errors = [];
let ok = false;
try {
  for (const viewport of [{ width: 390, height: 844 }, { width: 1366, height: 900 }]) {
    const page = await browser.newPage({ viewport });
    page.on('pageerror', (e) => errors.push(`[${viewport.width}px] ${e.message}`));
    await page.goto(url, { waitUntil: 'load', timeout: 60000 });
    await page.waitForTimeout(4000);
    const state = await page.evaluate(() => ({
      login: !!document.getElementById('loginForm'),
      merge: typeof window.cloudMerge === 'function',
      splash: !!document.getElementById('suSplash') || document.documentElement.outerHTML.includes('suSplash'),
    }));
    if (!state.login) errors.push(`[${viewport.width}px] شاشة الدخول (#loginForm) مش موجودة`);
    if (!state.merge) errors.push(`[${viewport.width}px] cloudMerge مش متعرّفة — السكريبت الأساسي وقع؟`);
    await page.close();
  }
  ok = errors.length === 0;
} finally {
  await browser.close();
  server.close();
}
if (!ok) {
  console.error(errors.map((e) => '❌ ' + e).join('\n'));
  process.exit(1);
}
console.log('✅ smoke: الصفحة فتحت على موبايل وكمبيوتر من غير أخطاء JavaScript');
