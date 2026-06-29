const CACHE_NAME = 'dropbeam-wifi-v2';
const ASSETS = [
  '/',
  '/index.html',
  '/style.css',
  '/app.js',
  '/manifest.json',
  'https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;500;600;700&display=swap',
  'https://unpkg.com/lucide@latest',
  'https://cdn.jsdelivr.net/npm/qrcode@1.5.3/build/qrcode.min.js'
];

self.addEventListener('install', (e) => {
  self.skipWaiting();
  e.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      // Use catch to prevent install failure if any third-party asset changes/fails
      return cache.addAll(ASSETS).catch(err => {
        console.warn('PWA: Some static assets failed to cache during install, ignoring to allow offline shell: ', err);
      });
    })
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.map((key) => {
          if (key !== CACHE_NAME) {
            return caches.delete(key);
          }
        })
      );
    })
  );
  self.clients.claim();
});

self.addEventListener('fetch', (e) => {
  // Only handle GET requests and local HTTP/HTTPS requests (ignore socket.io and external APIs)
  if (e.request.method !== 'GET' || !e.request.url.startsWith(self.location.origin)) {
    return;
  }
  
  e.respondWith(
    fetch(e.request).then((networkResponse) => {
      // If network is available, update cache and serve latest content
      if (networkResponse.status === 200 && !e.request.url.includes('/api/') && !e.request.url.includes('/socket.io/')) {
        const responseToCache = networkResponse.clone();
        caches.open(CACHE_NAME).then((cache) => {
          cache.put(e.request, responseToCache);
        });
      }
      return networkResponse;
    }).catch(() => {
      // Fallback to cache if network is offline
      return caches.match(e.request).then((cachedResponse) => {
        return cachedResponse || new Response('Offline: Page not cached', { status: 503, statusText: 'Service Unavailable' });
      });
    })
  );
});
