/* upmypdf service worker — offline-capable shell + cached libraries.
 * Bump CACHE when shipping changes so clients pick up new app.js/tailwind. */
const CACHE = 'upmypdf-v2026-06-19';
const CORE = [
  '/',
  '/app.js',
  '/tailwind.css',
  '/manifest.webmanifest',
  '/favicon.png',
  '/icon-192.png',
  '/apple-touch-icon.png',
  'https://cdn.jsdelivr.net/npm/pdf-lib@1.17.1/dist/pdf-lib.min.js',
  'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.min.js',
  'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.worker.min.js',
  'https://cdn.jsdelivr.net/npm/@pdf-lib/fontkit@1.1.1/dist/fontkit.umd.min.js',
  'https://cdn.jsdelivr.net/npm/jszip@3.10.1/dist/jszip.min.js',
  'https://cdn.jsdelivr.net/npm/mammoth@1.6.0/mammoth.browser.min.js',
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE)
      // Cache best-effort: one missing CDN asset must not abort the whole install.
      .then((c) => Promise.all(CORE.map((u) =>
        fetch(new Request(u, { mode: u.startsWith('http') ? 'cors' : 'same-origin' }))
          .then((r) => (r && (r.ok || r.type === 'opaque')) ? c.put(u, r) : null)
          .catch(() => null))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // Page navigations: network-first (fresh content), fall back to cache, then
  // to the cached home page so the app still opens offline.
  if (req.mode === 'navigate') {
    e.respondWith(
      fetch(req)
        .then((r) => { const cp = r.clone(); caches.open(CACHE).then((c) => c.put(req, cp)); return r; })
        .catch(() => caches.match(req).then((r) => r || caches.match('/')))
    );
    return;
  }

  // Same-origin assets and the jsdelivr libraries: cache-first for instant,
  // offline-capable loads; update the cache in the background when online.
  if (url.origin === location.origin || url.host === 'cdn.jsdelivr.net') {
    e.respondWith(
      caches.match(req).then((cached) =>
        cached ||
        fetch(req).then((r) => {
          if (r && (r.ok || r.type === 'opaque')) { const cp = r.clone(); caches.open(CACHE).then((c) => c.put(req, cp)); }
          return r;
        }).catch(() => cached)
      )
    );
  }
});
