/* push-sw.js — بيستقبل Web Push ويعرضه كإشعار على الجهاز، وبيفتح التطبيق لما تضغط عليه.
   بيتحمّل من service-worker.js الموجود بسطر واحد:  importScripts('push-sw.js');  */
self.addEventListener('push', function (e) {
  var d = {};
  try { d = e.data ? e.data.json() : {}; } catch (_) { d = { title: 'Speak Up', body: e.data ? e.data.text() : '' }; }
 var opt = {
  body: d.body || '',
  icon: 'icons/notif-icon-192.png',
  badge: 'icons/notif-badge-96.png',
  dir: 'rtl', lang: 'ar',
  data: { url: d.url || './' }
};
  if (d.tag) { opt.tag = d.tag; opt.renotify = true; }
  e.waitUntil(self.registration.showNotification(d.title || 'Speak Up', opt));
});
self.addEventListener('notificationclick', function (e) {
  e.notification.close();
  var url = new URL((e.notification.data && e.notification.data.url) || './', self.registration.scope).href;
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (list) {
    for (var i = 0; i < list.length; i++) { if ('focus' in list[i]) return list[i].focus(); }
    return self.clients.openWindow(url);
  }));
});
