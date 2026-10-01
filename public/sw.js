/*
 * Service worker: makes the app installable and opens it instantly.
 * - The app's own files: network first (always the latest deploy), cached copy when offline.
 * - CDN libraries and fonts (versioned URLs): served from cache, refreshed in the background.
 * - /api/* and anything that is not GET: never cached, always the network.
 * Bump VERSION to drop old caches.
 */
const VERSION = 'pcs-v1';
const SHELL = ['/', '/plan-parser.js', '/demo-data.js', '/manifest.webmanifest', '/icons/icon-192.png', '/icons/icon-512.png'];
const CDN = /^https:\/\/(cdnjs\.cloudflare\.com|fonts\.googleapis\.com|fonts\.gstatic\.com|www\.gstatic\.com\/firebasejs)\//;

self.addEventListener('install', e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(SHELL)).catch(() => {}));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k)))).then(() => self.clients.claim()),
  );
});

self.addEventListener('message', e => { if (e.data === 'skipWaiting') self.skipWaiting(); });

async function networkFirst(req, key) {
  const cache = await caches.open(VERSION);
  try {
    const res = await fetch(req);
    if (res.ok) cache.put(key, res.clone());
    return res;
  } catch (err) {
    return (await cache.match(key, { ignoreSearch: true })) || Response.error();
  }
}

async function staleWhileRevalidate(req, event) {
  const cache = await caches.open(VERSION);
  const hit = await cache.match(req);
  const fresh = fetch(req).then(res => {
    if (res.ok || res.type === 'opaque') cache.put(req, res.clone());
    return res;
  }).catch(() => hit);
  if (hit) { event.waitUntil(fresh.catch(() => {})); return hit; }
  return fresh;
}

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin === location.origin) {
    if (url.pathname.startsWith('/api/') || url.pathname === '/sw.js') return;
    e.respondWith(networkFirst(req, req.mode === 'navigate' ? '/' : url.pathname));
    return;
  }
  if (CDN.test(req.url)) e.respondWith(staleWhileRevalidate(req, e));
});
