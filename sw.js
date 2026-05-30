// NSE Delivery Scanner — Service Worker
// SDK Fintech
const CACHE_NAME = 'nse-scanner-v1';
const STATIC_ASSETS = [
  './',
  './index.html',
  './manifest.json',
  './icon-192.png',
  './icon-512.png',
  'https://cdnjs.cloudflare.com/ajax/libs/PapaParse/5.4.1/papaparse.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/jspdf-autotable/3.8.2/jspdf.plugin.autotable.min.js',
];

// Install — cache static assets
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(STATIC_ASSETS))
      .then(() => self.skipWaiting())
  );
});

// Activate — remove old caches
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

// Fetch strategy:
//   - Static assets (CDN + own files): cache-first
//   - Google Drive API calls (googleapis.com): network-first, fallback to cache (4hr TTL)
//   - Everything else: network-first
self.addEventListener('fetch', event => {
  const url = event.request.url;

  // CDN and own static assets — cache first
  if (STATIC_ASSETS.some(a => url.includes(a)) || url.includes('cdnjs.cloudflare.com')) {
    event.respondWith(
      caches.match(event.request).then(cached => cached || fetch(event.request))
    );
    return;
  }

  // Drive API calls — network first with cache fallback
  if (url.includes('googleapis.com')) {
    event.respondWith(
      fetch(event.request).then(resp => {
        if (resp.ok) {
          const clone = resp.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
        }
        return resp;
      }).catch(() => caches.match(event.request))
    );
    return;
  }

  // Default — network first
  event.respondWith(
    fetch(event.request).catch(() => caches.match(event.request))
  );
});
