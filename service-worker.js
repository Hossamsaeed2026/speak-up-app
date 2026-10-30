importScripts('push-sw.js?v=4');
const VERSION = 'v8';
const CACHE = 'speakup-' + VERSION;
const SHELL = ['./index.html', './manifest.json', './icons/icon-192.png', './icons/icon-512.png', './icons/apple-touch-icon.png',
  // اللوجوهات وصورة كود الدفع (كانت جوه index.html كـ base64)
  './assets/brand/default-logo.webp', './assets/brand/header-logo.webp', './assets/brand/dock-logo.webp',
  './assets/brand/nav-mascot.webp', './assets/brand/parent-logo.webp', './assets/brand/pay-qr.png'];
// مكتبات خارجية بتتخزن من أول تثبيت عشان التطبيق يفتح كامل حتى أوفلاين
const CDN = ['https://cdn.tailwindcss.com', 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.78.0/dist/umd/supabase.js'];
const MAX_ENTRIES = 80;
const abs = (u) => new URL(u, self.location.href).href;
const PROTECTED = new Set([...SHELL.map(abs), ...CDN]);

self.addEventListener('install', (e) => {
  // كل ملف لوحده: لو ملف ناقص ما يوقفش تثبيت الـ service worker كله
  e.waitUntil((async () => {
    const c = await caches.open(CACHE);
    await Promise.all([
      ...SHELL.map((u) => c.add(new Request(abs(u), { cache: 'reload' })).catch(() => null)),
      ...CDN.map((u) => fetch(new Request(u, { mode: 'no-cors' })).then((r) => c.put(u, r)).catch(() => null)),
    ]);
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('speakup-') && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

async function tell(msg) {
  const cs = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  cs.forEach((c) => c.postMessage(msg));
}
const sigOf = (r) => (r.headers.get('etag') || '') + '|' + (r.headers.get('last-modified') || '') + '|' + (r.headers.get('content-length') || '');
async function hashOf(r) {
  const d = await crypto.subtle.digest('SHA-1', await r.clone().arrayBuffer());
  return Array.from(new Uint8Array(d)).map((x) => x.toString(16).padStart(2, '0')).join('');
}
async function shellChanged(a, b) {
  const sa = sigOf(a), sb = sigOf(b);
  if (sa !== '||' && sb !== '||') return sa !== sb;
  return (await hashOf(a)) !== (await hashOf(b));
}
async function trim(cache) {
  const ks = await cache.keys();
  for (let i = 0, extra = ks.length - MAX_ENTRIES; i < ks.length && extra > 0; i++) {
    if (PROTECTED.has(ks[i].url)) continue;
    await cache.delete(ks[i]); extra--;
  }
}

// تحديث الصفحة المخزنة في الخلفية. بيرجّع النسخة الجديدة، ولو اتغيّرت بيبلّغ الصفحة المفتوحة
async function refreshShell(cache) {
  const key = abs('./index.html');
  const res = await fetch(key, { cache: 'no-cache' });
  if (!res || !res.ok || res.redirected) return null;                    // 404/500 ما تبدّلش النسخة السليمة
  const txt = await res.clone().text();
  if (txt.indexOf('suSplash') < 0 || txt.indexOf('</html>') < 0) return null;   // صفحة دخول واي فاي أو ملف ناقص
  const old = await cache.match(key);
  const changed = old ? await shellChanged(old, res) : false;
  await cache.put(key, res.clone());
  if (changed) await tell({ type: 'SU_UPDATE_AVAILABLE', version: VERSION });
  return res;
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || req.headers.has('range')) return;
  const url = new URL(req.url);
  if (!/^https?:$/.test(url.protocol)) return;
  // Supabase (API / auth / functions): لا تخزين أبداً
  if (url.hostname.endsWith('.supabase.co') || url.hostname.endsWith('.supabase.in')) return;

  // فتح الصفحة: من المخزن فوراً، وبيتحدّث في الخلفية. لو في نسخة أحدث، بيظهر شريط «تحديث الآن»
  if (req.mode === 'navigate') {
    e.respondWith((async () => {
      const cache = await caches.open(CACHE);
      const cached = await cache.match(abs('./index.html'));
      const update = refreshShell(cache).catch(() => null);
      e.waitUntil(update);
      return cached || (await update) || Response.error();
    })());
    return;
  }

  // باقي الملفات (أيقونات، Tailwind، Supabase JS، الخطوط): من المخزن فوراً وتتحدث في الخلفية
  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const cached = await cache.match(req);
    const net = fetch(req).then(async (res) => {
      if (res && (res.ok || res.type === 'opaque')) { await cache.put(req, res.clone()); await trim(cache); }
      return res;
    }).catch(() => cached || Response.error());
    if (cached) { e.waitUntil(net); return cached; }
    return net;
  })());
});
