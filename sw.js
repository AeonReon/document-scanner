// Document Scanner service worker.
// Network-first for HTML so deploys land. SWR for static assets.
const VERSION = 'docscan-v2';
const PRECACHE = [
  '/',
  '/index.html',
  '/styles.css?v=2',
  '/manifest.json',
  '/images/favicon-32.png?v=1',
  '/images/apple-touch-icon.png?v=1',
  '/images/icon-192.png?v=1',
  '/images/icon-512.png?v=1',
  '/images/icon-maskable.png?v=1',
  '/js/util.js?v=2',
  '/js/imaging.js?v=2',
  '/js/pdf.js?v=2',
  '/js/db.js?v=2',
  '/js/annotate.js?v=2',
  '/js/app.js?v=2',
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

  if (url.pathname === '/build-stamp.json') {
    e.respondWith(fetch(req, { cache: 'no-store' }).catch(() => new Response('{"stamp":0}', { headers: { 'Content-Type': 'application/json' } })));
    return;
  }

  const isHTML = req.mode === 'navigate' ||
                 (req.headers.get('accept') || '').includes('text/html');
  if (isHTML) {
    e.respondWith(
      fetch(req).then(r => {
        const copy = r.clone();
        caches.open(VERSION).then(c => c.put('/index.html', copy)).catch(() => {});
        return r;
      }).catch(() => caches.match('/index.html') || caches.match('/'))
    );
    return;
  }

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
