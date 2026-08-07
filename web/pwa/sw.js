// sw.js — SELF-DESTRUCTING during the mock/dev phase.
//
// We run NO caching layer while iterating: the dev server is `no-store`, so the
// tunnel must always serve fresh bytes. Any previously-installed service worker
// re-fetches this file on its next check, installs it, and immediately wipes all
// caches + unregisters itself — so nothing can ever serve a stale build again.
// (A real network-first SW can come back for PWA install once the UI settles.)

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    try {
      const keys = await caches.keys();
      await Promise.all(keys.map((k) => caches.delete(k)));
      await self.registration.unregister();
    } catch (e) { /* best effort */ }
  })());
});
