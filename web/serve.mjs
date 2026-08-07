// serve.mjs — static-serve the built renderer (dist/renderer) as a web app,
// injecting the SDK-backed bridge bundle so window.glyphh exists (and boots the
// SDK client) before any renderer script runs. No Electron; cloud is SDK-direct,
// local/native degrade until a machine attaches.
//
//   node web/serve.mjs   ->   http://localhost:3002  (same port platform used, so the
//   existing localhost:3002 Google OAuth origin works in dev with no console change)
//
// The bridge is served as a normal static asset from dist/renderer; we only need
// to inject a <script> for it as the first thing in <head>.
import http from 'node:http';
import { readFile, access } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

// ── Env (web/.env) ────────────────────────────────────────────────────────────
// A tiny dependency-free .env parse of the CLIENT-SAFE web config. These are
// injected into the page as window.__GLYPHH_* BEFORE the bridge runs, so the SDK
// client (API url) and the login screen (Google client id) read them at boot.
// Anything already in process.env wins, so `PORT=… node web/serve.mjs` still works.
function loadEnv() {
  const out = {};
  try {
    const raw = readFileSync(fileURLToPath(new URL('./.env', import.meta.url)), 'utf8');
    for (const line of raw.split('\n')) {
      const s = line.trim();
      if (!s || s.startsWith('#')) continue;
      const eq = s.indexOf('=');
      if (eq === -1) continue;
      const key = s.slice(0, eq).trim();
      let val = s.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
      out[key] = val;
    }
  } catch {
    /* no .env — fall back to process.env + client defaults */
  }
  return { ...out, ...process.env };
}
const ENV = loadEnv();

const ROOT = fileURLToPath(new URL('../dist/renderer/', import.meta.url));
const PORT = ENV.PORT || 3002;
const BRIDGE = '/glyphh-web-bundle.js';

// SPA fallback paths — client-side routes with no file on disk, mirroring the
// platform's: /auth/callback (OAuth + magic-link return) and /auth/device (the
// device-grant approval page). They serve the LOGIN SHELL (index.html) IN PLACE,
// so the browser STAYS on the URL the boot script routes off. That is the whole
// point for /auth/device: a 302 to /?code=… made the device code arrive looking
// exactly like an OAuth callback code, and web-boot exchanged it as one.
// index.html's asset URLs are relative, so a shell served at a NESTED path also
// gets `<base href="/">` injected — that, not a redirect, is what keeps
// styles.css / brand/* resolving (the ENOENT + naked-page problem).
const SHELL_ROUTES = new Set([
  '/', '/login', '/auth', '/auth/',
  '/auth/callback', '/auth/callback/',
  '/auth/device', '/auth/device/',
]);
/** A shell route BELOW the root needs <base href="/"> for its relative assets. */
const isNestedShellRoute = (p) => SHELL_ROUTES.has(p) && p !== '/' && p !== '/login';

// Client-safe config script, injected before the bridge so window.__GLYPHH_* exist
// when the SDK client + login screen initialise. Only public values are exposed.
function configScript() {
  const cfg = {
    // The SDK talks to the control-plane API DIRECTLY — no proxy. Dev points at
    // GLYPHH_SERVER_URL (localhost:3001); prod defaults to https://api.glyphh.ai.
    __GLYPHH_API_URL__: ENV.GLYPHH_SERVER_URL || 'https://api.glyphh.ai',
    __GLYPHH_GOOGLE_CLIENT_ID__: ENV.GLYPHH_GOOGLE_CLIENT_ID || '',
    __GLYPHH_WEB_URL__: ENV.GLYPHH_WEB_URL || 'https://glyphh.ai',
  };
  const assigns = Object.entries(cfg)
    .map(([k, v]) => `window.${k}=${JSON.stringify(v)};`)
    .join('');
  return `<script>${assigns}</script>`;
}

const TYPES = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.css': 'text/css', '.json': 'application/json', '.map': 'application/json',
  '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.gif': 'image/gif', '.ico': 'image/x-icon', '.wasm': 'application/wasm',
  '.webmanifest': 'application/manifest+json',
};

// The mobile web app (web/src/mobile.tsx → /glyphh-mobile.js) is its own React
// surface, served at /m. Unlike the desktop shells it does NOT get the renderer
// bridge injected — it loads its own bundle — but it still needs the client-safe
// config so the SDK knows the API url.
const MOBILE_ROUTES = new Set(['/m', '/m/']);

// Baseline security headers (mirror platform's middleware). A strict CSP is the
// real XSS mitigation but must be audited against the renderer's inline scripts +
// monaco/xterm before it can go on without bricking the app — tracked for the
// hardening pass, deliberately not shipped half-configured here.
function securityHeaders(res, isHttps) {
  // DEV SERVER LAW: nothing is EVER cacheable. Stale layers (browser HTTP
  // cache, SW caches, heuristic caching on unversioned assets) served
  // yesterday's modules and yesterday's 404s while the code on disk was
  // fixed — hours of "still broken" that no code change could reach. Fresh
  // bytes on every request, every time.
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  if (isHttps) res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
}

const exists = async (f) => { try { await access(f); return true; } catch { return false; } };

const server = http.createServer(async (req, res) => {
  securityHeaders(res, (req.headers['x-forwarded-proto'] || '').includes('https'));
  try {
    let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    // KILL-SWITCH service worker: a stale SW from the old PWA install caches old
    // modules and serves them forever (e.g. a CommonJS app-icon.js against an ESM
    // importer → "binding not found"). This build ships NO SW; serving a
    // self-destructing one at /sw.js makes any registered ghost unregister itself
    // + wipe its caches on its next update check, so clients self-heal.
    if (p === '/sw.js' && !(await exists(join(ROOT, 'sw.js')))) {
      // No real SW shipped yet → self-destruct any ghost from a prior PWA install.
      // Once the mobile build drops dist/renderer/sw.js, we fall through and serve
      // that real (network-first) worker as a normal static asset instead.
      res.setHeader('content-type', 'text/javascript');
      res.setHeader('cache-control', 'no-store');
      // NOTE: no clients.navigate() here — a stale page that still registers
      // /sw.js would re-install this on every load, and navigate() turned that
      // into an infinite reload loop (frantic flicker). Unregister + clear
      // caches only; the user's next natural reload gets fresh content.
      res.end("self.addEventListener('install',()=>self.skipWaiting());self.addEventListener('activate',async()=>{try{const ks=await caches.keys();await Promise.all(ks.map(k=>caches.delete(k)));await self.registration.unregister();}catch(e){}});");
      return;
    }
    // LOGIN-FIRST front door (decided 2026-08-03, Claude model — no anonymous app
    // access): the base page is the LOGIN SHELL (index.html carries the splash→auth→
    // login flow: Google + magic-link, same as platform's). web-boot sends an
    // already-authed session straight through to /home, so returning users never see
    // the login. home.html (the Chat tab) is the AUTHED app surface at /home; the
    // bridge bounces an anonymous visitor there back here.
    // The nested client-side routes (/auth/callback, /auth/device) serve the SAME
    // shell IN PLACE — no redirect — with <base href="/"> injected below so their
    // relative assets still resolve from the root. web-boot then routes off the
    // real pathname + query (device vs. callback).
    const nested = isNestedShellRoute(p);
    // Device routing: the mobile app owns the authed experience on PHONES. /m is
    // always the mobile app; a SIGNED-IN phone (glyphh_logged_in cookie) also
    // gets it for the app shell + /home, so login lands in the mobile ui instead
    // of the desktop rail. Signed-out phones still see the working login shell,
    // and /auth/* stays on the shell so magic-link/device token exchange runs.
    const ua = req.headers['user-agent'] || '';
    const isPhoneUA = /iPhone|iPod|Android.+Mobile/i.test(ua);
    const authedCookie = /(?:^|;\s*)glyphh_logged_in=1\b/.test(req.headers.cookie || '');
    const isAuthRoute = p === '/auth' || p.startsWith('/auth/');
    const phoneWantsApp = isPhoneUA && authedCookie && !isAuthRoute
      && (SHELL_ROUTES.has(p) || p === '/home' || p === '/home/');
    const isMobileShell = MOBILE_ROUTES.has(p) || phoneWantsApp;
    if (isMobileShell) {
      p = '/mobile.html';
    } else if (SHELL_ROUTES.has(p)) {
      p = (await exists(join(ROOT, 'index.html'))) ? '/index.html' : '/home.html';
    } else if (p === '/home' || p === '/home/') {
      p = (await exists(join(ROOT, 'home.html'))) ? '/home.html' : '/index.html';
    }
    const file = normalize(join(ROOT, p));
    if (!file.startsWith(ROOT)) { res.statusCode = 403; res.end('forbidden'); return; }

    let body = await readFile(file);
    const ext = extname(file);
    if (ext === '.html') {
      body = body.toString();
      // Web-only: ensure the viewport opts into the safe-area insets so the phone
      // splash/login can pad around the notch + home indicator via env(safe-area-*).
      // Desktop Electron loads the template directly and never sees this rewrite.
      if (/viewport-fit\s*=\s*cover/i.test(body)) {
        /* already opted in */
      } else if (/<meta\s+name=["']viewport["'][^>]*>/i.test(body)) {
        body = body.replace(
          /(<meta\s+name=["']viewport["']\s+content=["'])([^"']*)(["'][^>]*>)/i,
          (_m, pre, content, post) => `${pre}${content.replace(/\s*$/, '')}, viewport-fit=cover${post}`,
        );
      } else {
        body = body.replace(
          /<head(\s[^>]*)?>/i,
          (m) => `${m}\n  <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">`,
        );
      }
      // Inject, as the FIRST things in <head>: (1) on a nested shell route, a
      // <base href="/"> so index.html's relative asset URLs (styles.css, brand/*,
      // the renderer module) resolve from the root instead of /auth/… — this is
      // what makes serving the shell in place at /auth/device work; (2) the
      // client-safe config; (3) the bridge. Config must precede the bridge — the
      // SDK reads window.__GLYPHH_API_URL__ at import time — and <base> must
      // precede everything relative.
      const base = nested ? '\n  <base href="/">' : '';
      // The mobile shell loads its OWN React bundle (declared in mobile.html) and
      // must not get the desktop renderer bridge — only the client-safe config.
      const inject = isMobileShell
        ? configScript()
        : `${configScript()}\n  <script src="${BRIDGE}"></script>`;
      body = body.replace(
        /<head(\s[^>]*)?>/i,
        (m) => `${m}${base}\n  ${inject}`,
      );
    }
    res.setHeader('content-type', TYPES[ext] || 'application/octet-stream');
    res.end(body);
  } catch (e) {
    res.statusCode = 404;
    res.end('not found');
  }
});

server.listen(PORT, () => console.log(`app web target on http://localhost:${PORT}`));
