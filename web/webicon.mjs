/**
 * webicon.mjs — the web front door's VENDOR-MARK PROXY (his report, 2026-10-04:
 * on app.glyphh.ai the CLI tiles showed letter fallbacks — "C" for Claude, "G"
 * for Gemini — in the dock and on the wall).
 *
 * On the desktop `webIconFetch` runs in main, where there is no CORS. The web
 * shim fetched the vendor URL from the browser in CORS mode and the vendors
 * refuse, so it answered "" and the letter showed. So the marks come from OUR
 * origin: `GET /webicon?u=<url>`, allowlisted to the exact URLs the renderer's
 * CLI mark table names (src/renderer/help/cli-marks.ts — the test keeps the two
 * identical), fetched server-side with a short timeout, cached in memory for a
 * day, served with the upstream content-type and a day of browser cache.
 * Anything off the list is a 404 — this is a mark proxy, not an open fetch.
 * One RULE sits beside the list (below): the favicon-service URL for a plain
 * hostname, so every app tab's favicon rides the same proxy.
 *
 * Pure over an injected fetch + clock + cache (web/test/webicon.test.js);
 * serve.mjs wires the real ones.
 */

/** The allowlist: the marks the proxy may fetch (fixed; the favicon rule below is what app tabs ride). */
export const WEB_ICON_URLS = Object.freeze([
  'https://claude.ai/favicon.ico',
  'https://openai.com/favicon.ico',
  'https://www.google.com/s2/favicons?domain=gemini.google.com&sz=64',
  'https://github.com/favicon.ico',
  'https://cursor.com/favicon.ico',
]);
const ALLOWED = new Set(WEB_ICON_URLS);

/** The proxy's path on this origin. */
export const WEB_ICON_ROUTE = '/webicon';

/**
 * THE SECOND ALLOWANCE — a RULE, for every app tab's favicon (his report,
 * 2026-10-04: on app.glyphh.ai every URL tab — Reddit, Gmail, Slack, Zoom —
 * showed its letter). The desktop fetches a tab's favicon in main from
 * Google's s2 service by hostname (src/renderer/help/app-icon.ts), a URL the
 * browser cannot fetch cross-origin, so the proxy admits exactly that shape:
 *
 *   https://www.google.com/s2/favicons?domain=<host>&sz=64
 *
 * where <host> is a PLAIN hostname — lowercase labels of letters, digits and
 * inner hyphens, at least two of them — never userinfo, a port, a path, an
 * IP, or anything percent-encoded. The upstream is still only Google's
 * favicon service; the host is the one variable. Everything else keeps the
 * exact-match list above. (The same expression lives in
 * src/main/app-icon-file.ts, where the relay row carries the URL; the main
 * test keeps the two identical.)
 */
export const FAVICON_HOST = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const FAVICON_URL = /^https:\/\/www\.google\.com\/s2\/favicons\?domain=([^&=?#/]+)&sz=64$/;

/** True for a plain hostname as defined above. */
export const isPlainHost = (h) => typeof h === 'string' && FAVICON_HOST.test(h);

/** The favicon-service URL for a plain hostname, or null for anything else. */
export const faviconUrlForHost = (host) => (isPlainHost(host) ? `https://www.google.com/s2/favicons?domain=${host}&sz=64` : null);

/** The favicon-service URL for a PAGE URL (an app tab's url): http(s) on a
 *  plain hostname, else null (yo://, file:, localhost, an IP). */
export function faviconUrlForPage(pageUrl) {
  if (typeof pageUrl !== 'string' || !pageUrl) return null;
  try {
    const u = new URL(pageUrl);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    return faviconUrlForHost(u.hostname.toLowerCase());
  } catch { return null; }
}

/** The host a favicon-service URL names when it fits the rule exactly, else null. */
export function faviconHostOf(u) {
  const m = typeof u === 'string' ? FAVICON_URL.exec(u) : null;
  return m && isPlainHost(m[1]) ? m[1] : null;
}

/** The exact list, or the favicon rule: no prefixes, no other hosts, no
 *  normalisation games. */
export const isAllowedIconUrl = (u) => typeof u === 'string' && (ALLOWED.has(u) || faviconHostOf(u) !== null);

/** The same-origin URL the browser asks for a mark, or null off the list. */
export function webIconProxyPath(u) {
  return isAllowedIconUrl(u) ? `${WEB_ICON_ROUTE}?u=${encodeURIComponent(u)}` : null;
}

/** One day, in ms and in seconds (the cache-control the response carries). */
export const WEB_ICON_TTL_MS = 86_400_000;
export const WEB_ICON_MAX_AGE = 86_400;
/** A favicon is kilobytes; anything bigger is not a mark. */
export const WEB_ICON_MAX_BYTES = 1_048_576;
export const WEB_ICON_TIMEOUT_MS = 5_000;

const IMAGE_TYPE = /^image\//i;

/**
 * Answer one proxy request.
 * @param {string|null|undefined} u the `u` query value
 * @param {{ fetchImpl?: typeof fetch, cache?: Map<string, {body: Uint8Array, type: string, at: number}>, now?: () => number, timeoutMs?: number }} [deps]
 * @returns {Promise<{ status: number, headers: Record<string, string>, body: Uint8Array|string }>}
 */
export async function webIconResponse(u, deps = {}) {
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch;
  const cache = deps.cache ?? defaultCache;
  const now = deps.now ?? Date.now;
  const timeoutMs = deps.timeoutMs ?? WEB_ICON_TIMEOUT_MS;
  if (!isAllowedIconUrl(u)) return { status: 404, headers: { 'content-type': 'text/plain', 'cache-control': 'no-store' }, body: 'not found' };
  const hit = cache.get(u);
  if (hit && now() - hit.at < WEB_ICON_TTL_MS) return ok(hit);
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(u, { signal: ctl.signal, redirect: 'follow', headers: { accept: 'image/*,*/*;q=0.8' } });
    if (!res || !res.ok) return bad(502);
    const type = String(res.headers?.get?.('content-type') || '').split(';')[0].trim();
    const buf = new Uint8Array(await res.arrayBuffer());
    if (!buf.byteLength || buf.byteLength > WEB_ICON_MAX_BYTES) return bad(502);
    const entry = { body: buf, type: IMAGE_TYPE.test(type) ? type : 'image/x-icon', at: now() };
    cache.set(u, entry);
    return ok(entry);
  } catch {
    // A timeout or a refused upstream: the renderer falls back to its letter.
    return bad(502);
  } finally {
    clearTimeout(timer);
  }
}

const defaultCache = new Map();

function ok(entry) {
  return {
    status: 200,
    headers: {
      'content-type': entry.type,
      'cache-control': `public, max-age=${WEB_ICON_MAX_AGE}`,
      'x-content-type-options': 'nosniff',
    },
    body: entry.body,
  };
}
function bad(status) {
  return { status, headers: { 'content-type': 'text/plain', 'cache-control': 'no-store' }, body: 'icon unavailable' };
}
