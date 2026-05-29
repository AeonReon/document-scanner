// Document Scanner service worker.
// Strategy: network-first for HTML (so deploys land), stale-while-revalidate
// for everything else. Pre-cache the app shell so it works fully offline.
const VERSION = 'docscan-v1';
const PRECACHE = [
  '/',
  '/index.html',
  '/styles.css?v=1',
  '/manifest.json',
  '/images/favicon-32.png?v=1',
  '/images/apple-touch-icon.png?v=1',
  '/images/icon-192.png?v=1',
  '/images/icon-512.png?v=1',
  '/images/icon-maskable.png?v=1',
  '/js/util.js?v=1',
  '/js/imaging.js?v=1',
  '/js/pdf.js?v=1',
  '/js/db.js?v=1',
  '/js/app.js?v=1',
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(VERSION).then(c => c.addAll(PRECACHE)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // Always bypass cache for the build-stamp probe.
  if (url.pathname === '/build-stamp.json') {
    e.respondWith(fetch(req, { cache: 'no-store' }).catch(() => new Response('{"stamp":0}', { headers: { 'Content-Type': 'application/json' } })));
    return;
  }

  const isHTML = req.mode === 'navigate' ||
                 (req.headers.get('accept') || '').includes('text/html');
  if (isHTML) {
    // Network first for HTML.
    e.respondWith(
      fetch(req).then(r => {
        const copy = r.clone();
        caches.open(VERSION).then(c => c.put('/index.html', copy)).catch(() => {});
        return r;
      }).catch(() => caches.match('/index.html') || caches.match('/'))
    );
    return;
  }

  // Cache-first with revalidation for static assets.
  e.respondWith(
    caches.match(req).then(hit => {
      const fetchPromise = fetch(req).then(r => {
        if (r && r.ok) {
          const copy = r.clone();
          caches.open(VERSION).then(c => c.put(req, copy)).catch(() => {});
        }
        return r;
      }).catch(() => hit);
      return hit || fetchPromise;
    })
  );
});
