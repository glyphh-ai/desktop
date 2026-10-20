// serve.mjs — static-serve the built renderer (dist/renderer) as a web app,
// injecting the SDK-backed bridge bundle so window.glyphh exists (and boots the
// SDK client) before any renderer script runs. No Electron; cloud is SDK-direct,
// local/native degrade until a machine attaches.
//
// app.glyphh.ai (his order, 2026-10-04) = the IDENTICAL desktop app on the web:
// a signed-in desktop browser lands on the command center at /home; phones get
// the mobile shell; with GLYPHH_MOBILE_ONLY (mobile.glyphh.ai) every page is the
// mobile app. The route decision itself is pure (serve-routes.mjs, unit-tested).
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
import { resolveRoute, isNestedShellRoute } from './serve-routes.mjs';
import { WEB_ICON_ROUTE, webIconResponse } from './webicon.mjs';
import { isAppHostPath, proxyAppHost } from './app-host-proxy.mjs';
import { artifactRoute, proxyArtifact, viewerPage } from './artifact-proxy.mjs';

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
// MOBILE-ONLY (mobile.glyphh.ai, 2026-09-30): every page is the mobile app —
// its own sign-in included — and nothing from the desktop renderer's web shell
// (index.html, home.html, the bridge) is served or needed in the build.
const MOBILE_ONLY = ENV.GLYPHH_MOBILE_ONLY === '1' || ENV.GLYPHH_MOBILE_ONLY === 'true';

// ── LOCAL DEV runtime tunnel (opt-in via LOCAL_RUNTIME_PROXY=1) ────────────────
// A phone loading this over ngrok can't reach the control plane or the rrotor
// harness on the host's localhost. When enabled, we reverse-proxy them through
// THIS one tunnel so everything is same-origin (no CORS, one ngrok):
//   /api/*  → the local control plane   (API_TARGET, default :3001)
//   /rt/*   → the local rrotor HARNESS   (RT_TARGET,  default :8081; /rt stripped)
// The mobile app is then pointed at same-origin, and the server is configured to
// hand back `<public-origin>/rt` as the runtime URL. OFF by default → prod is
// unaffected (SDK stays direct-to-API).
const PROXY = ENV.LOCAL_RUNTIME_PROXY === '1' || ENV.LOCAL_RUNTIME_PROXY === 'true';
const API_TARGET = ENV.API_TARGET || 'http://localhost:3001';
const RT_TARGET = ENV.RT_TARGET || 'http://localhost:8081';
function proxyHttp(req, res, targetBase, strip, rewrite) {
  const target = new URL(targetBase);
  const path = (strip ? req.url.slice(strip.length) : req.url) || '/';
  const headers = { ...req.headers, host: target.host };
  if (rewrite) delete headers['accept-encoding'];   // need uncompressed JSON to rewrite
  const pr = http.request({
    protocol: target.protocol, hostname: target.hostname, port: target.port,
    method: req.method, path: path.startsWith('/') ? path : '/' + path, headers,
  }, (pres) => {
    if (!rewrite) { res.writeHead(pres.statusCode || 502, pres.headers); pres.pipe(res); return; }
    const chunks = [];
    pres.on('data', (c) => chunks.push(c));
    pres.on('end', () => {
      let body = Buffer.concat(chunks);
      if ((pres.headers['content-type'] || '').includes('application/json')) {
        try { const j = JSON.parse(body.toString('utf8')); rewrite(j); body = Buffer.from(JSON.stringify(j)); } catch { /* leave as-is */ }
      }
      const h = { ...pres.headers }; delete h['content-length']; delete h['content-encoding'];
      res.writeHead(pres.statusCode || 502, h);
      res.end(body);
    });
  });
  pr.on('error', (e) => { res.statusCode = 502; res.end('proxy error: ' + e.message); });
  req.pipe(pr);
}
// Rewrite a provisioned session's runtimeUrl to point back through THIS tunnel's
// /rt proxy — so the phone streams to a reachable URL WITHOUT restarting the server
// (which keeps handing back whatever localhost address it's configured with).
function rewriteRuntimeUrl(j, url) {
  const fix = (o) => { if (o && typeof o === 'object' && typeof o.runtimeUrl === 'string' && o.runtimeUrl) { o.runtimeUrl = url; if (o.status && o.status !== 'ready') o.status = 'ready'; } };
  // Server responses are enveloped as { data: … } — unwrap before rewriting.
  const d = j && typeof j === 'object' && 'data' in j ? j.data : j;
  if (Array.isArray(d)) d.forEach(fix);
  else if (d && typeof d === 'object') { fix(d); fix(d.session); }
}

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
  // Allow the app's OWN page to use the mic + camera (voice input, and camera
  // capture for attachments) — `(self)`, not the blanket `()` which disabled
  // them outright. Geolocation stays off; nothing needs it.
  res.setHeader('Permissions-Policy', 'camera=(self), microphone=(self), geolocation=()');
  if (isHttps) res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
}

const exists = async (f) => { try { await access(f); return true; } catch { return false; } };

// APPS LIVE IN THE CLOUD (his decision, 2026-10-04): a Glyphh-app panel is an
// iframe of `/app-host/<key>/ui/index.html` on THIS origin, forwarded to the
// API's instance proxy with the panel cookie turned into the bearer
// (app-host-proxy.mjs). Same API the SDK talks to; always on.
const APP_HOST_API = ENV.GLYPHH_SERVER_URL || 'https://api.glyphh.ai';

const server = http.createServer(async (req, res) => {
  if (isAppHostPath(new URL(req.url, 'http://x').pathname)) return proxyAppHost(req, res, APP_HOST_API);
  // DEV tunnel: forward API + harness through this origin before anything else.
  if (PROXY) {
    const rp = new URL(req.url, 'http://x').pathname;
    // Session provision/get: rewrite runtimeUrl → <this-origin>/rt so the phone
    // reaches the harness through this tunnel (no server restart needed).
    if (rp.startsWith('/api/sessions') && !rp.startsWith('/api/sessions/threads')) {
      const proto = (req.headers['x-forwarded-proto'] || 'http').split(',')[0].trim();
      const rtUrl = `${proto}://${req.headers.host}/rt`;
      return proxyHttp(req, res, API_TARGET, '', (j) => rewriteRuntimeUrl(j, rtUrl));
    }
    if (rp.startsWith('/api/')) return proxyHttp(req, res, API_TARGET, '');
    if (rp === '/rt' || rp.startsWith('/rt/')) return proxyHttp(req, res, RT_TARGET, '/rt');
  }
  securityHeaders(res, (req.headers['x-forwarded-proto'] || '').includes('https'));
  try {
    const reqUrl = new URL(req.url, 'http://x');
    let p = decodeURIComponent(reqUrl.pathname);
    // VENDOR MARKS from our own origin (webicon.mjs): the CLI tiles' favicons
    // the browser cannot fetch cross-origin. Allowlisted, cached a day, and
    // served with its own cache-control (the no-store above is for the app).
    // Not under /api, so the dev tunnel's /api proxy never swallows it.
    if (p === WEB_ICON_ROUTE) {
      const r = await webIconResponse(reqUrl.searchParams.get('u'));
      res.statusCode = r.status;
      for (const [k, v] of Object.entries(r.headers)) res.setHeader(k, v);
      res.end(r.body);
      return;
    }
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
    // the login. home.html (the command center) is the AUTHED app surface at /home;
    // the bridge bounces an anonymous visitor there back here.
    // The nested client-side routes (/auth/callback, /auth/device) serve the SAME
    // shell IN PLACE — no redirect — with <base href="/"> injected below so their
    // relative assets still resolve from the root. web-boot then routes off the
    // real pathname + query (device vs. callback).
    // Device routing, phones vs desktop browsers vs the mobile-only deploy, is
    // ONE pure decision (serve-routes.mjs resolveRoute) — see its tests.
    const nested = isNestedShellRoute(p);
    const route = resolveRoute({
      path: p,
      ua: req.headers['user-agent'] || '',
      cookie: req.headers.cookie || '',
      mobileOnly: MOBILE_ONLY,
    });
    // THE ARTIFACT PAGES (his order, 2026-10-05): /a/<id> serves the viewer
    // page with the id stamped in; /raw and /meta ride the proxy to the API
    // with the /a-scoped session cookie as the bearer (artifact-proxy.mjs).
    if (route.kind === 'artifact') {
      const art = artifactRoute(p);
      if (!art) { res.statusCode = 404; res.end('not found'); return; }
      if (art.part !== 'page') return proxyArtifact(req, res, APP_HOST_API, art);
      const html = await readFile(join(ROOT, 'artifact.html'), 'utf8');
      res.setHeader('content-type', 'text/html; charset=utf-8');
      res.setHeader('cache-control', 'no-store');
      res.end(viewerPage(html, art, reqUrl.searchParams.get('t') || ''));
      return;
    }
    if (route.kind === 'redirect') {
      // Stripe returns to the OLD platform's /billing route (success/cancel and
      // top-up redirects) — bounce it into the shell with the query intact; the
      // shell opens the Billing tab from those params.
      const qs = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
      res.statusCode = 302;
      res.setHeader('Location', `${route.location}${qs}`);
      res.end();
      return;
    }
    const isMobileShell = route.kind === 'mobile';
    if (isMobileShell) {
      p = '/mobile.html';
    } else if (route.kind === 'github-done') {
      p = '/github-done.html';
    } else if (route.kind === 'login') {
      p = (await exists(join(ROOT, 'index.html'))) ? '/index.html' : '/home.html';
    } else if (route.kind === 'app' || route.kind === 'platform') {
      // /home (the command center) and /platform (the admin surface) are the
      // same home.html document; home.ts branches on the pathname client-side.
      p = (await exists(join(ROOT, 'home.html'))) ? '/home.html' : '/index.html';
    }
    const file = normalize(join(ROOT, p));
    if (!file.startsWith(ROOT)) { res.statusCode = 403; res.end('forbidden'); return; }

    let body = await readFile(file);
    const ext = extname(file);
    if (ext === '.html') {
      body = body.toString();
      // MOBILE shell only: opt into the safe-area insets so the phone splash/
      // login can pad around the notch via env(safe-area-*). The DESKTOP shells
      // must NOT get viewport-fit=cover — in an iPad browser tab, cover makes
      // the page paint its own (dark) background into the zone around the
      // floating browser toolbar, which read as an unremovable dark band above
      // the app (the page's y=0 proved to sit BELOW the band; a lime-ruler test
      // pinned it). Plain width=device-width for desktop shells.
      const wantsCover = /mobile\.html$/.test(file);
      if (/viewport-fit\s*=\s*cover/i.test(body)) {
        if (!wantsCover) body = body.replace(/,?\s*viewport-fit\s*=\s*cover/gi, '');
      } else if (/<meta\s+name=["']viewport["'][^>]*>/i.test(body)) {
        if (wantsCover) body = body.replace(
          /(<meta\s+name=["']viewport["']\s+content=["'])([^"']*)(["'][^>]*>)/i,
          (_m, pre, content, post) => `${pre}${content.replace(/\s*$/, '')}, viewport-fit=cover${post}`,
        );
      } else {
        body = body.replace(
          /<head(\s[^>]*)?>/i,
          (m) => `${m}\n  <meta name="viewport" content="width=device-width, initial-scale=1.0${wantsCover ? ', viewport-fit=cover' : ''}">`,
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
      // Device routing, part 2 (the client-side half). Server UA sniffing catches
      // phones but NOT tablets — an iPad reports as "Macintosh". So on the desktop
      // shells we run a tiny pre-bridge script: any TOUCH device (coarse primary
      // pointer = phone or tablet, incl. iPad-as-Mac) that is signed in replaces
      // to the mobile app. Desktops (fine pointer) and signed-out users stay put.
      // The `glyphh_force_desktop` localStorage flag (set by the mobile app's
      // Appearance → "Desktop site" toggle) is the escape hatch: a tablet that
      // opted into the full desktop layout must NOT be bounced back to /m.
      const touchRedirect =
        "<script>try{if(matchMedia('(pointer: coarse)').matches"
        + "&&document.cookie.indexOf('glyphh_logged_in=1')>=0"
        + "&&localStorage.getItem('glyphh_force_desktop')!=='1')"
        + "location.replace('/m')}catch(e){}</script>";
      // The mobile shell loads its OWN React bundle (declared in mobile.html) and
      // must not get the desktop renderer bridge — only the client-safe config.
      // DEV tunnel: point the SDK at THIS origin so /api rides the proxy → the
      // LOCAL server. Applies to EVERY shell (mobile + the desktop/app-web site),
      // not just mobile — otherwise the full site talks to the configured
      // GLYPHH_SERVER_URL (e.g. Fly) while the desktop talks to localhost, and the
      // device-auth codes created on one can't be approved on the other.
      const apiOverride = PROXY
        ? '\n  <script>window.__GLYPHH_API_URL__=location.origin;</script>' : '';
      const inject = isMobileShell
        ? configScript() + apiOverride
        : `${touchRedirect}\n  ${configScript()}${apiOverride}\n  <script src="${BRIDGE}"></script>`;
      body = body.replace(
        /<head(\s[^>]*)?>/i,
        (m) => `${m}${base}\n  ${inject}`,
      );
      // Social-card meta needs ABSOLUTE urls — fill the templates' placeholder
      // with this request's real origin (scrapers fetch og:image blindly).
      {
        const proto = String(req.headers['x-forwarded-proto'] || 'http').split(',')[0];
        body = body.replace(/__PUBLIC_ORIGIN__/g, `${proto}://${req.headers.host || 'localhost'}`);
      }
      // Cache-bust the shell's OWN assets: every load references a fresh URL, so
      // NO shell (mobile OR the desktop app-web) can serve a stale css/js copy
      // (SW or HTTP cache). This is why web fixes appeared "not applied" — the
      // desktop shell's styles.css was cached. Dev preview; prod uses hashes.
      {
        const v = Date.now();
        // The shells link assets WITHOUT a leading slash (href="styles.css") —
        // the old slash-only replace never matched, so browsers kept STALE css
        // forever and shipped fixes never appeared. Match both forms.
        body = body
          .replace(/href="\/?styles\.css"/, `href="/styles.css?v=${v}"`)
          .replace(/src="\/?code-workbench-bundle\.js"/, `src="/code-workbench-bundle.js?v=${v}"`);
        if (isMobileShell) {
          body = body
            .replace('href="/mobile.css"', `href="/mobile.css?v=${v}"`)
            .replace('src="/glyphh-mobile.js"', `src="/glyphh-mobile.js?v=${v}"`);
        }
      }
    }
    res.setHeader('content-type', TYPES[ext] || 'application/octet-stream');
    res.end(body);
  } catch (e) {
    res.statusCode = 404;
    res.end('not found');
  }
});

// DEV tunnel: proxy the harness WS stream (/rt/ws → RT_TARGET/ws). The harness
// falls back to HTTP frame-polling if the socket path is unavailable, but WS
// keeps the stream live end-to-end through the one tunnel.
if (PROXY) {
  server.on('upgrade', (req, socket, head) => {
    const rp = new URL(req.url, 'http://x').pathname;
    // /rt/* → the runtime pod (legacy direct path); /api/* → the local server
    // (the front door's /api/harness/ws live frame pipe); /ws/* → the local
    // server too (/ws/panel = streamed app panels, /ws/attach = desktop link).
    // Without /ws here the panel socket got destroyed and streamed panels never
    // rendered over the tunnel. Anything else drops.
    const isApi = rp.startsWith('/api/');
    const isWs = rp.startsWith('/ws/');
    const toLocal = isApi || isWs;
    if (!rp.startsWith('/rt/') && !toLocal) { socket.destroy(); return; }
    const target = new URL(toLocal ? API_TARGET : RT_TARGET);
    const preq = http.request({
      hostname: target.hostname, port: target.port,
      path: toLocal ? req.url : (req.url.slice('/rt'.length) || '/'),
      method: req.method, headers: { ...req.headers, host: target.host },
    });
    preq.on('upgrade', (pres, psock, phead) => {
      socket.write('HTTP/1.1 101 Switching Protocols\r\n'
        + Object.entries(pres.headers).map(([k, v]) => `${k}: ${v}`).join('\r\n') + '\r\n\r\n');
      if (phead && phead.length) psock.unshift(phead);
      psock.pipe(socket); socket.pipe(psock);
      psock.on('error', () => socket.destroy());
      socket.on('error', () => psock.destroy());
    });
    preq.on('error', () => socket.destroy());
    if (head && head.length) preq.write(head);
    preq.end();
  });
}

server.listen(PORT, () => console.log(`app web target on http://localhost:${PORT}${PROXY ? ` · dev proxy ON (/api→${API_TARGET}, /rt→${RT_TARGET})` : ''}`));
