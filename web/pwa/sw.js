// sw.js — Glyphh mobile service worker (mobile.glyphh.ai).
//
// NETWORK-FIRST by design (restored from 2026-08-06, when a kill-switch stub
// replaced it for dev): every request goes to the network first and the cache
// is only an OFFLINE fallback, so a deploy is live on the next load. That keeps
// the app installable (manifest + icons + a fetch-handling SW) without the
// stale-module pain the kill-switch was built to cure.
//
// Entries are keyed by PATH: serve.mjs cache-busts the shell's assets with
// ?v=<build>, and keying on the full URL would keep every build forever.
//
// The API and auth flows are never touched — they must always hit the live origin
// (the API is cross-origin anyway).

const CACHE = 'glyphh-mobile-v3';
const SHELL = [
  '/m',
  '/glyphh-mobile.js',
  '/mobile.css',
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
  if (url.origin !== self.location.origin) return;                 // the API / cross-origin: pass through
  if (url.pathname.startsWith('/api') || url.pathname.startsWith('/auth')) return; // never cache auth/data
  const key = req.mode === 'navigate' ? '/m' : url.pathname;       // every page is the one shell

  event.respondWith((async () => {
    try {
      const fresh = await fetch(req);                              // network-first
      if (fresh.ok) caches.open(CACHE).then((c) => c.put(key, fresh.clone()).catch(() => {}));
      return fresh;
    } catch {
      const cached = await caches.match(key);
      if (cached) return cached;
      throw new Error('offline and uncached');
    }
  })());
});

// A "needs your input" notification (mobile.tsx notifyNeedsInput): focus the app
// and hand it the session to open, or open the app when none is running.
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const sessionId = event.notification.data && event.notification.data.sessionId;
  event.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const client = all[0];
    if (client) {
      await client.focus();
      if (sessionId) client.postMessage({ type: 'glyphh-open-session', sessionId });
      return;
    }
    await self.clients.openWindow('/m');
  })());
});
