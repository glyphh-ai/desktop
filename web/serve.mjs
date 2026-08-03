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
import https from 'node:https';
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

// The real control-plane server. In dev the web + API are separate processes
// (:3002 static here, :3001 the API). We proxy <origin>/api/* → here so the
// browser talks to ONE origin — no CORS, and a single tunnel (ngrok) covers the
// whole app end-to-end (page load + the sign-in call after Google/magic-link).
const API_UPSTREAM = new URL(ENV.GLYPHH_SERVER_URL || 'http://localhost:3001');

function proxyApi(req, res) {
  const isHttps = API_UPSTREAM.protocol === 'https:';
  const lib = isHttps ? https : http;
  const upstream = lib.request(
    {
      hostname: API_UPSTREAM.hostname,
      port: API_UPSTREAM.port || (isHttps ? 443 : 80),
      method: req.method,
      path: req.url, // keeps the /api/... prefix the server serves
      headers: { ...req.headers, host: API_UPSTREAM.host },
    },
    (pres) => {
      res.writeHead(pres.statusCode || 502, pres.headers);
      pres.pipe(res);
    },
  );
  upstream.on('error', (e) => {
    res.statusCode = 502;
    res.end('api proxy error: ' + e.message);
  });
  req.pipe(upstream);
}

// SPA fallback paths: the OAuth/magic-link redirect returns to /auth/callback so
// the boot script can exchange the code — serve the app shell there (no such file
// exists on disk). Mirrors platform's /auth/callback route.
const SPA_FALLBACK = new Set(['/auth/callback']);

// Client-safe config script, injected before the bridge so window.__GLYPHH_* exist
// when the SDK client + login screen initialise. Only public values are exposed.
function configScript(origin) {
  const cfg = {
    // Same-origin base: the SDK calls <origin>/api/* which we proxy to API_UPSTREAM,
    // so web + API share one host (works on localhost AND behind a single tunnel).
    __GLYPHH_API_URL__: origin,
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
};

// Baseline security headers (mirror platform's middleware). A strict CSP is the
// real XSS mitigation but must be audited against the renderer's inline scripts +
// monaco/xterm before it can go on without bricking the app — tracked for the
// hardening pass, deliberately not shipped half-configured here.
function securityHeaders(res, isHttps) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  if (isHttps) res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
}

const exists = async (f) => { try { await access(f); return true; } catch { return false; } };

const server = http.createServer(async (req, res) => {
  // Same-origin API proxy: everything under /api/* goes to the real server, so the
  // browser only ever talks to this origin (one tunnel, no CORS, cookies same-site).
  if ((req.url || '').startsWith('/api/')) return proxyApi(req, res);
  securityHeaders(res, (req.headers['x-forwarded-proto'] || '').includes('https'));
  try {
    let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    // INPUT-FIRST front door: the base page is the Chat tab (home.html), rendered
    // LOGGED-OUT — no login wall. home.html boots standalone under the bridge and the
    // composer + starters render for an anonymous visitor; auth-gated data degrades to
    // empty. (The native-panel workspace that index.html frames is empty in a browser,
    // so index.html is NOT the base page here.)
    if (p === '/' || p === '/home' || p === '/home/') {
      p = (await exists(join(ROOT, 'home.html'))) ? '/home.html' : '/index.html';
    }
    // The DELIBERATE auth page (index.html carries the onboarding overlay) is a real,
    // reachable destination — a "Sign in" affordance and the magic-link/OAuth callback
    // land here, NOT a forced first screen. /auth/callback has no file on disk; serve
    // the shell so the boot script exchanges the returning code.
    if (p === '/auth' || p === '/auth/' || p === '/login' || SPA_FALLBACK.has(p)) {
      p = (await exists(join(ROOT, 'index.html'))) ? '/index.html' : '/home.html';
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
      // Inject the client-safe config THEN the bridge as the first things in <head>,
      // so window.__GLYPHH_* and window.glyphh (the SDK client) exist before any
      // renderer script executes. Config must precede the bridge — the SDK reads
      // window.__GLYPHH_API_URL__ at import time.
      const proto = (req.headers['x-forwarded-proto'] || '').includes('https') ? 'https' : 'http';
      const origin = `${proto}://${req.headers.host || `localhost:${PORT}`}`;
      body = body.replace(
        /<head(\s[^>]*)?>/i,
        (m) => `${m}\n  ${configScript(origin)}\n  <script src="${BRIDGE}"></script>`,
      );
    }
    res.setHeader('content-type', TYPES[ext] || 'application/octet-stream');
    res.end(body);
  } catch (e) {
    res.statusCode = 404;
    res.end('not found: ' + e.message);
  }
});

server.listen(PORT, () => console.log(`app web target on http://localhost:${PORT}`));
