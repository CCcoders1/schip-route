// Service worker: alles offline beschikbaar (cache-first + achtergrond-update) + Background Sync voor de outbox.
importScripts('./js/outbox-core.js');
const VERSION = 'schiproute-v1.16.0';
const ASSETS = [
  './', './index.html', './manifest.webmanifest', './css/app.css',
  './js/app.js', './js/outbox-core.js', './js/i18n.js', './js/i18n-dict.js', './js/marad.js', './js/maint.js', './js/oil.js', './js/ranks.js', './js/dist.js', './js/link.js', './js/suggest.js', './vendor/xlsx.mini.min.js', './data/marad.enc.json', './js/store.js', './js/seed.js', './js/planner.js', './js/share.js', './js/shipmap.js',
  './icons/icon-192.png', './icons/icon-512.png', './icons/icon-maskable-512.png', './icons/apple-touch-icon.png',
];
self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== VERSION).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;
  if (req.mode === 'navigate') {
    e.respondWith(caches.match('./index.html').then((hit) => {
      const net = fetch(req).then((res) => { if (res.ok) caches.open(VERSION).then((c) => c.put('./index.html', res.clone())); return res; }).catch(() => hit || Response.error());
      return hit || net;
    }));
    return;
  }
  e.respondWith(caches.match(req, { ignoreSearch: true }).then((hit) => {
    const net = fetch(req).then((res) => { if (res.ok) { const copy = res.clone(); caches.open(VERSION).then((c) => c.put(req, copy)); } return res; }).catch(() => hit || Response.error());
    return hit || net;
  }));
});

// Background Sync (Chrome/Android): outbox versturen zodra er weer verbinding is, ook als de app dicht is.
self.addEventListener('sync', (e) => {
  if (e.tag === 'outbox') e.waitUntil(self.OutboxCore.flush().then(async (r) => {
    const cs = await self.clients.matchAll(); cs.forEach((c) => c.postMessage({ type: 'outbox', result: r }));
    if (r && r.pending) throw new Error('nog niet alles verzonden');
  }));
});
self.addEventListener('message', (e) => { if (e.data === 'flush') e.waitUntil(self.OutboxCore.flush()); });
