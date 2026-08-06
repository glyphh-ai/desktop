// sw.js — Glyphh mobile service worker.
//
// NETWORK-FIRST by design. During active development the dev server ships
// `Cache-Control: no-store` and we must never serve yesterday's bundle, so every
// request goes to the network first and the cache is only a FALLBACK for offline.
// That keeps the app installable (a fetch-handling SW + manifest + icons) without
// reintroducing the stale-module pain the kill-switch SW was built to cure.
//
// The API and auth flows are never touched — they must always hit the live origin.

const CACHE = 'glyphh-mobile-v1';
const SHELL = [
  '/m',
  '/glyphh-mobile.js',
  '/manifest.webmanifest',
  '/brand/icons/icon-192.png',
  '/brand/icons/icon-512.png',
];

self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL).catch(() => {})));
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;                 // cloud API / cross-origin: pass through
  if (url.pathname.startsWith('/api') || url.pathname.startsWith('/auth')) return; // never cache auth/data

  event.respondWith((async () => {
    try {
      const fresh = await fetch(req);                              // network-first
      caches.open(CACHE).then((c) => c.put(req, fresh.clone()).catch(() => {}));
      return fresh;
    } catch {
      const cached = await caches.match(req);
      if (cached) return cached;
      if (req.mode === 'navigate') return caches.match('/m');      // offline → app shell
      throw new Error('offline and uncached');
    }
  })());
});
