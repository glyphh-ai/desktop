/**
 * webicon.test.js — the front door's vendor-mark proxy (web/webicon.mjs): the
 * allowlist is exactly the renderer's CLI mark table, off-list is a 404, a
 * hit is served with the upstream type and a day of cache, the memory cache
 * answers the second ask, and a refused or slow upstream is a 502 (the
 * renderer's letter fallback), never a throw.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  WEB_ICON_URLS, WEB_ICON_ROUTE, isAllowedIconUrl, webIconProxyPath, webIconResponse,
  WEB_ICON_MAX_AGE, WEB_ICON_TTL_MS, WEB_ICON_MAX_BYTES,
  isPlainHost, faviconUrlForHost, faviconUrlForPage, faviconHostOf,
} from '../webicon.mjs';

const CLAUDE = 'https://claude.ai/favicon.ico';

function fakeFetch(bytes = new Uint8Array([0, 0, 1, 0]), type = 'image/x-icon', ok = true) {
  return vi.fn(async () => ({
    ok,
    headers: { get: (k) => (k.toLowerCase() === 'content-type' ? `${type}; charset=binary` : null) },
    arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  }));
}

describe('the allowlist', () => {
  it('matches exact URLs only — no hosts, no prefixes, no near misses', () => {
    expect(isAllowedIconUrl(CLAUDE)).toBe(true);
    expect(isAllowedIconUrl('https://claude.ai/favicon.ico?x=1')).toBe(false);
    expect(isAllowedIconUrl('https://claude.ai/')).toBe(false);
    expect(isAllowedIconUrl('http://claude.ai/favicon.ico')).toBe(false);
    expect(isAllowedIconUrl('https://evil.example/favicon.ico')).toBe(false);
    expect(isAllowedIconUrl(undefined)).toBe(false);
    expect(isAllowedIconUrl(null)).toBe(false);
  });
  it('builds the same-origin path for a listed mark and nothing for anything else', () => {
    expect(webIconProxyPath(CLAUDE)).toBe(`${WEB_ICON_ROUTE}?u=${encodeURIComponent(CLAUDE)}`);
    expect(WEB_ICON_ROUTE).toBe('/webicon');
    expect(webIconProxyPath('https://api.glyphh.ai/icons/app.png')).toBe(null);
  });
});

// The second allowance: every app tab's favicon through the same proxy (his
// report, 2026-10-04 — Reddit, Gmail, Slack, Zoom all on their letters).
describe('the favicon rule', () => {
  const FAV = (h) => `https://www.google.com/s2/favicons?domain=${h}&sz=64`;
  it('admits a plain hostname: lowercase labels, digits, inner hyphens, two labels or more', () => {
    for (const h of ['reddit.com', 'mail.google.com', 'a-b.co.uk', 'x1.example', 'monday.com', 'us02web.zoom.us']) {
      expect(isPlainHost(h), h).toBe(true);
      expect(isAllowedIconUrl(FAV(h)), h).toBe(true);
      expect(faviconHostOf(FAV(h)), h).toBe(h);
      expect(webIconProxyPath(FAV(h)), h).toBe(`${WEB_ICON_ROUTE}?u=${encodeURIComponent(FAV(h))}`);
    }
  });
  it('rejects userinfo, a port, a path, an IP, a single label, casing, encoding and bad hyphens', () => {
    for (const h of [
      'user@reddit.com', 'reddit.com:443', 'reddit.com/x', '10.0.0.1', 'localhost', 'Reddit.com',
      'reddit%2ecom', '-reddit.com', 'reddit-.com', 'reddit..com', 'reddit.com.', '', 'reddit.123',
      'a'.repeat(64) + '.com', 'a.' + 'b'.repeat(250) + '.com',
    ]) {
      expect(isPlainHost(h), h).toBe(false);
      expect(isAllowedIconUrl(FAV(h)), h).toBe(false);
      expect(faviconHostOf(FAV(h)), h).toBe(null);
      expect(faviconUrlForHost(h), h).toBe(null);
    }
  });
  it('admits ONLY the exact favicon-service shape — no other size, parameter order, host or scheme', () => {
    for (const u of [
      'https://www.google.com/s2/favicons?domain=reddit.com&sz=32',
      'https://www.google.com/s2/favicons?sz=64&domain=reddit.com',
      'https://www.google.com/s2/favicons?domain=reddit.com&sz=64&x=1',
      'https://www.google.com/s2/favicons?domain=reddit.com',
      'http://www.google.com/s2/favicons?domain=reddit.com&sz=64',
      'https://google.com/s2/favicons?domain=reddit.com&sz=64',
      'https://www.google.com/s2/favicons?domain=&sz=64',
      'https://www.google.com/s2/favicons?domain=reddit.com&sz=64#f',
      'https://evil.example/s2/favicons?domain=reddit.com&sz=64',
    ]) {
      expect(isAllowedIconUrl(u), u).toBe(false);
      expect(webIconProxyPath(u), u).toBe(null);
    }
  });
  it('builds the URL from a page URL by hostname, lowercased, http(s) only', () => {
    expect(faviconUrlForPage('https://www.reddit.com/r/all')).toBe(FAV('www.reddit.com'));
    expect(faviconUrlForPage('http://Monday.com')).toBe(FAV('monday.com'));
    expect(faviconUrlForPage('https://user:pw@slack.com:8443/x')).toBe(FAV('slack.com'));
    expect(faviconUrlForPage('yo://home')).toBe(null);
    expect(faviconUrlForPage('file:///Users/me/app/index.html')).toBe(null);
    expect(faviconUrlForPage('http://localhost:3000')).toBe(null);
    expect(faviconUrlForPage('https://127.0.0.1')).toBe(null);
    expect(faviconUrlForPage('not a url')).toBe(null);
    expect(faviconUrlForPage(null)).toBe(null);
    expect(faviconUrlForPage(undefined)).toBe(null);
  });
  it('is fetched by the proxy like a listed mark — same cache, same cap', async () => {
    const fetchImpl = fakeFetch(new Uint8Array([9, 9]), 'image/png');
    const cache = new Map();
    const r = await webIconResponse(FAV('reddit.com'), { fetchImpl, cache });
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toBe('image/png');
    expect(fetchImpl.mock.calls[0][0]).toBe(FAV('reddit.com'));
    await webIconResponse(FAV('reddit.com'), { fetchImpl, cache });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const r2 = await webIconResponse(FAV('user@reddit.com'), { fetchImpl, cache });
    expect(r2.status).toBe(404);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe('webIconResponse', () => {
  it('refuses an off-list url with a 404 and never fetches', async () => {
    const fetchImpl = fakeFetch();
    const r = await webIconResponse('https://evil.example/favicon.ico', { fetchImpl, cache: new Map() });
    expect(r.status).toBe(404);
    expect(fetchImpl).not.toHaveBeenCalled();
    const r2 = await webIconResponse(null, { fetchImpl, cache: new Map() });
    expect(r2.status).toBe(404);
  });
  it('serves a listed mark with the upstream content-type and a day of browser cache', async () => {
    const fetchImpl = fakeFetch(new Uint8Array([1, 2, 3]), 'image/png');
    const r = await webIconResponse(CLAUDE, { fetchImpl, cache: new Map() });
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toBe('image/png');
    expect(r.headers['cache-control']).toBe(`public, max-age=${WEB_ICON_MAX_AGE}`);
    expect(WEB_ICON_MAX_AGE).toBe(86_400);
    expect(Array.from(r.body)).toEqual([1, 2, 3]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0][0]).toBe(CLAUDE);
  });
  it('answers the second ask from memory for a day, then fetches again', async () => {
    const fetchImpl = fakeFetch();
    const cache = new Map();
    let t = 1_000;
    const now = () => t;
    await webIconResponse(CLAUDE, { fetchImpl, cache, now });
    await webIconResponse(CLAUDE, { fetchImpl, cache, now });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    t += WEB_ICON_TTL_MS + 1;
    await webIconResponse(CLAUDE, { fetchImpl, cache, now });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
  it('falls back to an image type when the vendor sends none', async () => {
    const fetchImpl = fakeFetch(new Uint8Array([1]), 'text/html');
    const r = await webIconResponse(CLAUDE, { fetchImpl, cache: new Map() });
    expect(r.headers['content-type']).toBe('image/x-icon');
    expect(r.headers['x-content-type-options']).toBe('nosniff');
  });
  it('is a 502 (not a throw) when the vendor refuses, sends nothing, or sends too much', async () => {
    expect((await webIconResponse(CLAUDE, { fetchImpl: fakeFetch(new Uint8Array([1]), 'image/png', false), cache: new Map() })).status).toBe(502);
    expect((await webIconResponse(CLAUDE, { fetchImpl: fakeFetch(new Uint8Array(0)), cache: new Map() })).status).toBe(502);
    expect((await webIconResponse(CLAUDE, { fetchImpl: fakeFetch(new Uint8Array(WEB_ICON_MAX_BYTES + 1)), cache: new Map() })).status).toBe(502);
    const thrower = vi.fn(async () => { throw new Error('ECONNRESET'); });
    expect((await webIconResponse(CLAUDE, { fetchImpl: thrower, cache: new Map() })).status).toBe(502);
  });
  it('gives up on a slow vendor after the timeout', async () => {
    const slow = vi.fn((_u, { signal }) => new Promise((_res, rej) => { signal.addEventListener('abort', () => rej(new Error('aborted'))); }));
    const r = await webIconResponse(CLAUDE, { fetchImpl: slow, cache: new Map(), timeoutMs: 10 });
    expect(r.status).toBe(502);
    expect(r.headers['cache-control']).toBe('no-store');
  });
});
