/**
 * artifact-proxy.test.js — `/a/<id>` on the web origin (web/artifact-proxy.mjs;
 * his order, 2026-10-05): the viewer page for a link, the bytes and the row
 * proxied to the API with the /a-scoped session cookie as the bearer (or the
 * public share token), a CSP fence on the framed bytes, and the shell's
 * framing refusal lifted for them.
 */
import { describe, it, expect } from 'vitest';
import { EventEmitter } from 'node:events';
import { ARTIFACT_PREFIX, artifactRoute, apiPathFor, proxyRequestHeaders, rawResponseHeaders, RAW_CSP, proxyArtifact, viewerPage } from '../artifact-proxy.mjs';
import { resolveRoute, isArtifactPath } from '../serve-routes.mjs';

describe('the route', () => {
  it('/a/<id> is the page, /raw the bytes, /meta the row; anything else is nothing', () => {
    expect(ARTIFACT_PREFIX).toBe('/a/');
    expect(artifactRoute('/a/art_1')).toEqual({ id: 'art_1', part: 'page' });
    expect(artifactRoute('/a/art_1/raw')).toEqual({ id: 'art_1', part: 'raw' });
    expect(artifactRoute('/a/art_1/meta')).toEqual({ id: 'art_1', part: 'meta' });
    expect(artifactRoute('/a/art_1/other')).toBeNull();
    expect(artifactRoute('/a/')).toBeNull();
    expect(artifactRoute('/a/x/raw/more')).toBeNull();
    expect(artifactRoute('/home')).toBeNull();
  });
  it('an id is a safe token — no slashes, no tricks', () => {
    expect(artifactRoute('/a/..%2F..%2Fetc')).toBeNull();
    expect(artifactRoute('/a/%zz')).toBeNull();
    expect(artifactRoute(`/a/${'x'.repeat(129)}`)).toBeNull();
    expect(artifactRoute('/a/a.b-c_D')).toEqual({ id: 'a.b-c_D', part: 'page' });
  });
  it('serve-routes hands every /a/ path to the artifact branch on every device, signed in or not', () => {
    const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Mobile/15E148';
    expect(isArtifactPath('/a/x')).toBe(true);
    expect(isArtifactPath('/a/')).toBe(false);
    expect(resolveRoute({ path: '/a/art_1' })).toEqual({ kind: 'artifact' });
    expect(resolveRoute({ path: '/a/art_1/raw', ua: IPHONE, cookie: 'glyphh_logged_in=1' })).toEqual({ kind: 'artifact' });
    expect(resolveRoute({ path: '/a/art_1', mobileOnly: true })).toEqual({ kind: 'artifact' });
    expect(resolveRoute({ path: '/about' })).toEqual({ kind: 'static' });
  });
});

describe('what the API gets', () => {
  it('the content route for /raw, the row for /meta, the share token riding along', () => {
    expect(apiPathFor({ id: 'art_1', part: 'raw' })).toBe('/api/artifacts/art_1/content');
    expect(apiPathFor({ id: 'art_1', part: 'meta' })).toBe('/api/artifacts/art_1');
    expect(apiPathFor({ id: 'art_1', part: 'raw' }, 'tok/1')).toBe('/api/artifacts/art_1/content?t=tok%2F1');
  });
  it('the /a-scoped session cookie becomes the bearer; nothing else of the browser\'s rides', () => {
    expect(proxyRequestHeaders({ cookie: 'glyphh_session=tok%201; other=1', authorization: 'Bearer forged', 'x-glyphh-member': 'x', host: 'app' }, 'api.glyphh.ai'))
      .toEqual({ host: 'api.glyphh.ai', accept: '*/*', authorization: 'Bearer tok 1' });
    expect(proxyRequestHeaders({}, 'api.test')).toEqual({ host: 'api.test', accept: '*/*' });
    expect(proxyRequestHeaders({ 'if-none-match': '"e1"' }, 'api.test')['if-none-match']).toBe('"e1"');
  });
});

describe('what the browser gets for the bytes', () => {
  it('the type and length, a CSP that keeps the page to itself, no sniffing, no caching, no referrer', () => {
    const h = rawResponseHeaders({ 'content-type': 'text/html', 'content-length': '12', etag: '"e"', 'set-cookie': 'x=1', 'x-frame-options': 'DENY' });
    expect(h).toEqual({
      'content-type': 'text/html; charset=utf-8', 'content-length': '12', etag: '"e"',
      'content-security-policy': RAW_CSP, 'x-content-type-options': 'nosniff', 'cache-control': 'private, no-store', 'referrer-policy': 'no-referrer',
    });
    expect(rawResponseHeaders({ 'content-type': 'text/markdown' })['content-type']).toBe('text/markdown; charset=utf-8');
    expect(rawResponseHeaders({ 'content-type': 'text/html; charset=iso-8859-1' })['content-type']).toBe('text/html; charset=iso-8859-1');
    expect(rawResponseHeaders({ 'content-type': 'image/png' })['content-type']).toBe('image/png');
    expect(RAW_CSP).toContain("connect-src 'none'");
    expect(RAW_CSP).toContain("frame-src 'none'");
    expect(RAW_CSP).toContain("default-src 'none'");
  });
});

function fakeUpstream(answer) {
  const seen = [];
  const request = (opts, onRes) => {
    const pr = new EventEmitter();
    pr.end = () => {
      seen.push({ opts });
      const pres = new EventEmitter();
      pres.statusCode = answer.status;
      pres.headers = answer.headers;
      pres.pipe = (dst) => { dst.end(answer.body); return dst; };
      onRes(pres);
    };
    return pr;
  };
  return { request, seen };
}
function fakeRes() {
  const res = { statusCode: 0, headers: null, chunks: [], removed: [], done: null };
  res.finished = new Promise((r) => { res.done = r; });
  res.writeHead = (s, h) => { res.statusCode = s; res.headers = h; };
  res.removeHeader = (k) => res.removed.push(k);
  res.end = (b) => { if (b) res.chunks.push(Buffer.from(b)); res.done(); };
  return res;
}

describe('proxyArtifact', () => {
  it('/raw: GET the content with the cookie bearer, the share token forwarded; the frame refusal lifted', async () => {
    const up = fakeUpstream({ status: 200, headers: { 'content-type': 'text/html', 'content-length': '5' }, body: '<p>x' });
    const res = fakeRes();
    proxyArtifact({ url: '/a/art_1/raw?t=pub', headers: { cookie: 'glyphh_session=tok' } }, res, 'https://api.glyphh.ai', { id: 'art_1', part: 'raw' }, { request: up.request });
    await res.finished;
    expect(up.seen[0].opts).toMatchObject({ protocol: 'https:', hostname: 'api.glyphh.ai', method: 'GET', path: '/api/artifacts/art_1/content?t=pub' });
    expect(up.seen[0].opts.headers).toMatchObject({ authorization: 'Bearer tok' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-security-policy']).toBe(RAW_CSP);
    expect(res.removed).toEqual(['X-Frame-Options']);
    expect(Buffer.concat(res.chunks).toString()).toBe('<p>x');
  });
  it('/meta: the row as JSON, the frame refusal kept', async () => {
    const up = fakeUpstream({ status: 200, headers: { 'content-type': 'application/json' }, body: '{"data":{"id":"art_1"}}' });
    const res = fakeRes();
    proxyArtifact({ url: '/a/art_1/meta', headers: {} }, res, 'http://localhost:3001', { id: 'art_1', part: 'meta' }, { request: up.request });
    await res.finished;
    expect(up.seen[0].opts).toMatchObject({ protocol: 'http:', hostname: 'localhost', port: '3001', path: '/api/artifacts/art_1' });
    expect(up.seen[0].opts.headers.authorization).toBeUndefined();
    expect(res.headers).toEqual({ 'content-type': 'application/json', 'cache-control': 'no-store' });
    expect(res.removed).toEqual([]);
  });
  it('an upstream error is a 502 with its reason', async () => {
    const request = () => { const pr = new EventEmitter(); pr.end = () => process.nextTick(() => pr.emit('error', new Error('ECONNREFUSED'))); return pr; };
    const res = fakeRes();
    proxyArtifact({ url: '/a/x/raw', headers: {} }, res, 'https://api.test', { id: 'x', part: 'raw' }, { request });
    await res.finished;
    expect(res.statusCode).toBe(502);
    expect(Buffer.concat(res.chunks).toString()).toContain('ECONNREFUSED');
  });
});

describe('the viewer page', () => {
  it('stamps the id and the share token into the page, as JSON', () => {
    expect(viewerPage('<script>const cfg = __ARTIFACT__;</script>', { id: 'art_1', part: 'page' }, 'p"q'))
      .toBe('<script>const cfg = {"id":"art_1","t":"p\\"q"};</script>');
    expect(viewerPage('x __ARTIFACT__ y', { id: 'a', part: 'page' })).toBe('x {"id":"a","t":""} y');
  });
});
