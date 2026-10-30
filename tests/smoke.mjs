// اختبار فتح الصفحة في متصفح حقيقي: node tests/smoke.mjs
// بيشغّل سيرفر محلي، يفتح index.html في Chromium، ويفشل لو ظهر أي خطأ JavaScript في الصفحة.
// محتاج playwright (موجود في جلسات Claude Code، وفي GitHub Actions بيتسطّب من package.json).
import { createRequire } from 'node:module';
import { serve } from './serve.mjs';

const { chromium } = createRequire(import.meta.url)('playwright');
const server = await serve();
const url = server.url;

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
