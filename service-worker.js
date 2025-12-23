const CACHE_NAME = 'rotateio-assets-v1';
const ESSENTIALS = [
  '/assets/manifest.json',
  '/assets/ui/sprites.png',
  '/assets/players/player.png',
  '/assets/maps/city-1/chunk0.json'
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(ESSENTIALS)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  // Try cache first for assets, then network fallback
  if (req.method !== 'GET') return;
  e.respondWith(
    caches.match(req).then(r => r || fetch(req).then(nr => {
      // cache on the fly for static assets
      if (req.url.endsWith('.png') || req.url.endsWith('.json') || req.url.endsWith('.ogg')) {
        caches.open(CACHE_NAME).then(c => c.put(req, nr.clone()));
      }
      return nr;
    }).catch(() => new Response('', { status: 404 })))
  );
});
