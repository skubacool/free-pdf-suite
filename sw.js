/* upmypdf service worker — offline-capable, but update-safe.
 * Strategy:
 *  - Same-origin (pages, app.js, tailwind.css, icons): NETWORK-FIRST so every
 *    deploy is picked up immediately; fall back to cache only when offline.
 *  - jsdelivr libraries (version-pinned, immutable): cache-first for speed/offline.
 * This avoids the classic PWA trap where cache-first serves stale app.js forever. */
const CACHE = 'upmypdf-v2';
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

  // Version-pinned CDN libraries are immutable — cache-first.
  if (url.host === 'cdn.jsdelivr.net') {
    e.respondWith(
      caches.match(req).then((cached) => cached ||
        fetch(req).then((r) => {
          if (r && (r.ok || r.type === 'opaque')) { const cp = r.clone(); caches.open(CACHE).then((c) => c.put(req, cp)); }
          return r;
        }))
    );
    return;
  }

  // Same-origin (pages, app.js, tailwind.css, icons): network-first so deploys
  // are live instantly; fall back to cache (then home page) when offline.
  if (url.origin === location.origin) {
    e.respondWith(
      fetch(req)
        .then((r) => { if (r && r.ok) { const cp = r.clone(); caches.open(CACHE).then((c) => c.put(req, cp)); } return r; })
        .catch(() => caches.match(req).then((r) => r || (req.mode === 'navigate' ? caches.match('/') : undefined)))
    );
  }
});
