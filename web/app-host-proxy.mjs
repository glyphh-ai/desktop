/**
 * app-host-proxy.mjs — `/app-host/<key>/*` ON THE WEB ORIGIN → the API's
 * instance proxy (server: `ANY /app-host/{key}/{path}`, docs/app-instances.md).
 *
 * Why a proxy here at all: a Glyphh-app panel on app.glyphh.ai is an iframe,
 * and an iframe carries no Authorization header. The web keeps the session
 * bearer in the SDK, not in a cookie on the API origin; so the panel open
 * sets a same-origin cookie (`glyphh_session`, path /app-host only —
 * app-instances-web.js) and THIS proxy turns it into the bearer the API
 * honors. The cookie never leaves this origin and never rides the app's own
 * pages.
 *
 * The pod's injected shim POSTs `/call` (rrotor app-host/server.ts), which is
 * right on an app's own hostname and wrong under a path prefix; the entry
 * page is rewritten to the prefixed path on the way through until the shim
 * is relative (`../call`). Pure helpers are exported for the tests.
 */
import http from 'node:http';
import https from 'node:https';

export const APP_HOST_PREFIX = '/app-host/';
export const SESSION_COOKIE = 'glyphh_session';
const HOP_BY_HOP = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade']);

export const isAppHostPath = (p) => String(p || '').startsWith(APP_HOST_PREFIX) && String(p).length > APP_HOST_PREFIX.length;

/** The instance key a proxied path names (`/app-host/<key>/ui/x` → key), decoded. */
export function appHostKeyOf(p) {
  if (!isAppHostPath(p)) return '';
  const rest = String(p).slice(APP_HOST_PREFIX.length);
  const key = rest.split('/', 1)[0];
  try { return decodeURIComponent(key); } catch { return key; }
}

/** The session cookie's value out of a Cookie header, or ''. */
export function bearerFromCookie(cookie) {
  const m = new RegExp(`(?:^|;\\s*)${SESSION_COOKIE}=([^;]*)`).exec(String(cookie || ''));
  if (!m) return '';
  try { return decodeURIComponent(m[1]); } catch { return m[1]; }
}

/** The Cookie header without the session cookie (the pod sees no credential of ours). */
export function stripSessionCookie(cookie) {
  return String(cookie || '').split(';').map((s) => s.trim()).filter((s) => s && !s.startsWith(`${SESSION_COOKIE}=`)).join('; ');
}

/** The request headers the API gets: ours minus the cookie-as-credential and
 *  anything a client could use to forge identity, plus the bearer. */
export function proxyRequestHeaders(headers, targetHost) {
  const out = {};
  for (const [k, v] of Object.entries(headers || {})) {
    const key = k.toLowerCase();
    if (HOP_BY_HOP.has(key) || key === 'host' || key === 'cookie' || key === 'authorization' || key.startsWith('x-glyphh-') || key === 'x-forwarded-host') continue;
    if (key === 'accept-encoding') continue;   // the entry page is rewritten in the clear
    out[key] = v;
  }
  out.host = targetHost;
  const bearer = bearerFromCookie(headers?.cookie);
  if (bearer) out.authorization = `Bearer ${bearer}`;
  const rest = stripSessionCookie(headers?.cookie);
  if (rest) out.cookie = rest;
  return out;
}

/** The response headers the browser gets: the pod's, minus hop-by-hop and the
 *  framing refusal (the panel IS a frame on this origin). */
export function proxyResponseHeaders(headers) {
  const out = {};
  for (const [k, v] of Object.entries(headers || {})) {
    const key = k.toLowerCase();
    if (HOP_BY_HOP.has(key) || key === 'x-frame-options') continue;
    out[key] = v;
  }
  return out;
}

/** The entry page's `fetch('/call'` → the prefixed path this proxy serves. */
export function rewriteShim(html, key) {
  return String(html).split("fetch('/call'").join(`fetch('${APP_HOST_PREFIX}${encodeURIComponent(key)}/call'`);
}

export const isHtml = (contentType) => /text\/html/i.test(String(contentType || ''));

/**
 * Stream one request through. `apiBase` is the API origin
 * (window.__GLYPHH_API_URL__'s source); `request` is injectable for tests.
 */
export function proxyAppHost(req, res, apiBase, { request } = {}) {
  const target = new URL(apiBase);
  const key = appHostKeyOf(new URL(req.url, 'http://x').pathname);
  const doRequest = request ?? (target.protocol === 'https:' ? https.request : http.request);
  const headers = proxyRequestHeaders(req.headers, target.host);
  const pr = doRequest({
    protocol: target.protocol, hostname: target.hostname, port: target.port || undefined,
    method: req.method, path: req.url, headers,
  }, (pres) => {
    const out = proxyResponseHeaders(pres.headers);
    if (!isHtml(pres.headers['content-type'])) {
      res.writeHead(pres.statusCode || 502, out);
      pres.pipe(res);
      return;
    }
    const chunks = [];
    pres.on('data', (c) => chunks.push(c));
    pres.on('end', () => {
      const body = Buffer.from(rewriteShim(Buffer.concat(chunks).toString('utf8'), key), 'utf8');
      delete out['content-length']; delete out['content-encoding'];
      res.writeHead(pres.statusCode || 502, { ...out, 'content-length': String(body.length) });
      res.end(body);
    });
  });
  pr.on('error', (e) => { res.statusCode = 502; res.end('app proxy error: ' + e.message); });
  req.pipe(pr);
}
