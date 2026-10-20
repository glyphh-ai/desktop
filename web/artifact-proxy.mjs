/**
 * artifact-proxy.mjs — `/a/<id>` ON THE WEB ORIGIN (his order, 2026-10-05:
 * artifacts open full screen in a sandboxed frame; a shared link opens the
 * viewer page).
 *
 *   /a/<id>        the viewer page (artifact.html) for a direct / shared link
 *   /a/<id>/raw    the bytes — GET /api/artifacts/<id>/content on the API,
 *                  the `/a`-scoped session cookie turned into the bearer
 *                  (web-contract.js artifactsViewerPrepare), or `?t=<token>`
 *                  forwarded for a public link
 *   /a/<id>/meta   the row — GET /api/artifacts/<id> (the viewer page's title)
 *
 * The bytes never run on the app origin's auth: the viewer frames /raw with
 * `sandbox="allow-scripts"` and no allow-same-origin, and the response
 * carries a CSP that keeps a page from framing or reaching anything else.
 * Pure helpers are exported for the tests; the stream is injectable.
 */
import http from 'node:http';
import https from 'node:https';
import { bearerFromCookie } from './app-host-proxy.mjs';

export const ARTIFACT_PREFIX = '/a/';
const ID_RE = /^[A-Za-z0-9_.-]{1,128}$/;

/** What an /a path names: { id, part: 'page' | 'raw' | 'meta' }, or null. */
export function artifactRoute(p) {
  const s = String(p || '');
  if (!s.startsWith(ARTIFACT_PREFIX)) return null;
  const parts = s.slice(ARTIFACT_PREFIX.length).split('/').filter(Boolean);
  if (parts.length < 1 || parts.length > 2) return null;
  let id;
  try { id = decodeURIComponent(parts[0]); } catch { return null; }
  if (!ID_RE.test(id)) return null;
  if (parts.length === 1) return { id, part: 'page' };
  if (parts[1] === 'raw') return { id, part: 'raw' };
  if (parts[1] === 'meta') return { id, part: 'meta' };
  return null;
}

/** The API path one part forwards to, the share token riding along. */
export function apiPathFor(route, shareToken = '') {
  const base = `/api/artifacts/${encodeURIComponent(route.id)}`;
  const q = shareToken ? `?t=${encodeURIComponent(shareToken)}` : '';
  return route.part === 'raw' ? `${base}/content${q}` : `${base}${q}`;
}

/** The headers the API gets: just the bearer (cookie or none) and an accept. */
export function proxyRequestHeaders(headers, targetHost) {
  const out = { host: targetHost, accept: '*/*' };
  const bearer = bearerFromCookie(headers?.cookie);
  if (bearer) out.authorization = `Bearer ${bearer}`;
  if (headers?.['if-none-match']) out['if-none-match'] = headers['if-none-match'];
  return out;
}

/** The CSP a framed artifact runs under: itself only — no fetch, no frames,
 *  no forms out; inline scripts and styles stay (it is a built page). */
export const RAW_CSP = "default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval'; style-src 'unsafe-inline'; img-src data: blob: https:; font-src data: https:; media-src data: blob:; connect-src 'none'; frame-src 'none'; form-action 'none'; base-uri 'none'";

/** The response headers the browser gets for the bytes. */
export function rawResponseHeaders(headers) {
  const out = {};
  for (const k of ['content-type', 'content-length', 'etag', 'last-modified']) if (headers?.[k]) out[k] = headers[k];
  // A text type with no charset decodes as Latin-1 inside the frame (an em
  // dash came out as "â€”"): the bytes are UTF-8 — say so.
  if (/^text\//i.test(String(out['content-type'] || '')) && !/charset=/i.test(out['content-type'])) out['content-type'] = `${out['content-type']}; charset=utf-8`;
  out['content-security-policy'] = RAW_CSP;
  out['x-content-type-options'] = 'nosniff';
  out['cache-control'] = 'private, no-store';
  out['referrer-policy'] = 'no-referrer';
  return out;
}

/** Stream /raw or /meta through to the API. `request` is injectable for tests. */
export function proxyArtifact(req, res, apiBase, route, { request } = {}) {
  const target = new URL(apiBase);
  const url = new URL(req.url, 'http://x');
  const doRequest = request ?? (target.protocol === 'https:' ? https.request : http.request);
  const pr = doRequest({
    protocol: target.protocol, hostname: target.hostname, port: target.port || undefined,
    method: 'GET', path: apiPathFor(route, url.searchParams.get('t') || ''),
    headers: proxyRequestHeaders(req.headers, target.host),
  }, (pres) => {
    const out = route.part === 'raw' ? rawResponseHeaders(pres.headers) : { 'content-type': 'application/json', 'cache-control': 'no-store' };
    // The bytes ARE a frame on this origin: the shell's X-Frame-Options: DENY
    // (serve.mjs securityHeaders) would blank it — the CSP above is the fence.
    if (route.part === 'raw') res.removeHeader?.('X-Frame-Options');
    res.writeHead(pres.statusCode || 502, out);
    pres.pipe(res);
  });
  pr.on('error', (e) => { res.statusCode = 502; res.end('artifact proxy error: ' + e.message); });
  pr.end();
}

/** The viewer page with its id and share token stamped in (artifact.html). */
export function viewerPage(html, route, shareToken = '') {
  const cfg = JSON.stringify({ id: route.id, t: shareToken || '' });
  return String(html).replace('__ARTIFACT__', () => cfg);
}
