/* sw.js — makes the app work fully offline.
 * Cache-first from a versioned cache. IMPORTANT: bump VERSION every time you redeploy changed files,
 * otherwise phones keep serving the old cached copy. */
const VERSION = 'v1.0.0';
const CACHE = 'store-pos-' + VERSION;

const CORE = [
  './', 'index.html', 'styles.css', 'core.js', 'db.js', 'scanner.js', 'app.js',
  'manifest.webmanifest', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/icon-maskable-512.png'
];
// Optional scanner fallback for browsers without BarcodeDetector. Cached only if you added the file.
const OPTIONAL = ['lib/html5-qrcode.min.js'];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    await cache.addAll(CORE);
    await Promise.all(OPTIONAL.map((u) => cache.add(u).catch(() => {})));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k.startsWith('store-pos-') && k !== CACHE).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    if (req.mode === 'navigate') {
      return (await cache.match('index.html')) || (await cache.match('./')) || fetch(req);
    }
    const hit = await cache.match(req, { ignoreSearch: true });
    if (hit) return hit;
    try {
      const res = await fetch(req);
      if (res && res.ok) cache.put(req, res.clone());
      return res;
    } catch (e) {
      return new Response('Offline and not cached.', { status: 503, statusText: 'Offline' });
    }
  })());
});
