/* Speak Up - Service Worker
   - بيخزّن شكل البرنامج (الصفحة + المكتبات) عشان يفتح بسرعة ويفتح حتى من غير نت.
   - بيانات Supabase (تسجيل الدخول والبيانات) عمره ما بيخزنها: دايماً من النت.
   - لما تنزّل نسخة جديدة من index.html بتوصل تلقائياً أول ما النت يكون موجود.
   لو غيّرت ملفات التطبيق وعايز تجبر التحديث: غيّر رقم VERSION. */
const VERSION = 'v1';
const CACHE = 'speakup-' + VERSION;
const SHELL = ['./', './index.html', './manifest.json',
  './icons/icon-192.png', './icons/icon-512.png', './icons/apple-touch-icon.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('speakup-') && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (!/^https?:$/.test(url.protocol)) return;
  // Supabase (API / auth / functions): لا تخزين أبداً
  if (url.hostname.endsWith('.supabase.co') || url.hostname.endsWith('.supabase.in')) return;

  // فتح الصفحة: النت أولاً (عشان التحديثات)، ولو مفيش نت النسخة المخزنة
  if (req.mode === 'navigate') {
    e.respondWith(
      fetch(req).then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put('./index.html', copy));
        return res;
      }).catch(() => caches.match('./index.html').then((r) => r || caches.match('./')))
    );
    return;
  }

  // باقي الملفات (أيقونات، Tailwind، Supabase JS، الخطوط): من المخزن فوراً وتتحدث في الخلفية
  e.respondWith(
    caches.match(req).then((cached) => {
      const net = fetch(req).then((res) => {
        if (res && (res.ok || res.type === 'opaque')) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy));
        }
        return res;
      }).catch(() => cached);
      return cached || net;
    })
  );
});
