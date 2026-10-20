/**
 * app-host-proxy.test.js — `/app-host/<key>/*` on the web origin
 * (web/app-host-proxy.mjs): the panel cookie becomes the bearer the API
 * honors and never reaches the pod as a cookie; forged identity headers are
 * dropped; the framing refusal is stripped so the panel can be an iframe;
 * the pod's `fetch('/call'` is rewritten to the prefixed path.
 */
import { describe, it, expect } from 'vitest';
import { EventEmitter } from 'node:events';
import {
  APP_HOST_PREFIX, appHostKeyOf, bearerFromCookie, isAppHostPath, isHtml, proxyAppHost, proxyRequestHeaders, proxyResponseHeaders,
  rewriteShim, stripSessionCookie,
} from '../app-host-proxy.mjs';

describe('the pure helpers', () => {
  it('recognizes the proxy path and reads the key out of it', () => {
    expect(isAppHostPath('/app-host/expense-desk/ui/index.html')).toBe(true);
    expect(isAppHostPath('/app-host/')).toBe(false);
    expect(isAppHostPath('/home')).toBe(false);
    expect(appHostKeyOf('/app-host/expense-desk/ui/index.html')).toBe('expense-desk');
    expect(appHostKeyOf('/app-host/notes~u1/call')).toBe('notes~u1');
    expect(appHostKeyOf('/app-host/a%20b/ui/')).toBe('a b');
    expect(appHostKeyOf('/x')).toBe('');
  });
  it('turns the panel cookie into the bearer and keeps it off the pod', () => {
    const h = proxyRequestHeaders({
      cookie: 'other=1; glyphh_session=tok%201; more=2', host: 'app.glyphh.ai', authorization: 'Bearer forged',
      'x-glyphh-member': 'forged', 'x-forwarded-host': 'evil', 'accept-encoding': 'gzip', accept: 'text/html', connection: 'keep-alive',
    }, 'api.glyphh.ai');
    expect(h).toEqual({ accept: 'text/html', host: 'api.glyphh.ai', authorization: 'Bearer tok 1', cookie: 'other=1; more=2' });
    expect(bearerFromCookie('glyphh_session=abc')).toBe('abc');
    expect(bearerFromCookie('nothing=1')).toBe('');
    expect(stripSessionCookie('glyphh_session=abc')).toBe('');
  });
  it('with no cookie there is no bearer: the API answers 401 itself', () => {
    expect(proxyRequestHeaders({ accept: '*/*' }, 'api.test')).toEqual({ accept: '*/*', host: 'api.test' });
  });
  it('strips hop-by-hop and the framing refusal from the pod\'s answer', () => {
    expect(proxyResponseHeaders({ 'content-type': 'text/html', 'x-frame-options': 'DENY', 'transfer-encoding': 'chunked', 'content-security-policy': "connect-src 'self'" }))
      .toEqual({ 'content-type': 'text/html', 'content-security-policy': "connect-src 'self'" });
  });
  it('rewrites the shim\'s /call to the prefixed path, and only that', () => {
    const html = "<head><script>window.glyphh={call:(method,args)=>fetch('/call',{method:'POST'})}</script></head><body>fetch('/calls')</body>";
    expect(rewriteShim(html, 'notes~u1')).toBe(`<head><script>window.glyphh={call:(method,args)=>fetch('${APP_HOST_PREFIX}notes~u1/call',{method:'POST'})}</script></head><body>fetch('/calls')</body>`);
    expect(isHtml('text/html; charset=utf-8')).toBe(true);
    expect(isHtml('application/json')).toBe(false);
  });
});

/** A fake upstream: records the request, answers what the test says. */
function fakeUpstream(answer) {
  const seen = [];
  const request = (opts, onRes) => {
    const pr = new EventEmitter();
    const chunks = [];
    pr.write = (c) => chunks.push(c);
    pr.end = () => {
      seen.push({ opts, body: Buffer.concat(chunks.map((c) => Buffer.from(c))).toString('utf8') });
      const pres = new EventEmitter();
      pres.statusCode = answer.status;
      pres.headers = answer.headers;
      pres.pipe = (dst) => { dst.end(answer.body); return dst; };
      onRes(pres);
      process.nextTick(() => { pres.emit('data', Buffer.from(answer.body)); pres.emit('end'); });
    };
    return pr;
  };
  return { request, seen };
}
function fakeReq(url, headers = {}, body = '') {
  const req = new EventEmitter();
  req.url = url; req.method = body ? 'POST' : 'GET'; req.headers = headers;
  req.pipe = (dst) => { if (body) dst.write(body); dst.end(); return dst; };
  return req;
}
function fakeRes() {
  const res = { statusCode: 0, headers: null, chunks: [], done: null };
  res.finished = new Promise((r) => { res.done = r; });
  res.writeHead = (s, h) => { res.statusCode = s; res.headers = h; };
  res.end = (b) => { if (b) res.chunks.push(Buffer.from(b)); res.done(); };
  res.write = (b) => res.chunks.push(Buffer.from(b));
  return res;
}

describe('proxyAppHost', () => {
  it('forwards the entry page to the API with the bearer, rewrites the shim, keeps the path', async () => {
    const up = fakeUpstream({ status: 200, headers: { 'content-type': 'text/html', 'x-frame-options': 'DENY', 'content-length': '5' }, body: "<head></head>fetch('/call'" });
    const res = fakeRes();
    proxyAppHost(fakeReq('/app-host/expense-desk/ui/index.html?x=1', { cookie: 'glyphh_session=tok', host: 'app.glyphh.ai' }), res, 'https://api.glyphh.ai', { request: up.request });
    await res.finished;
    expect(up.seen[0].opts).toMatchObject({ protocol: 'https:', hostname: 'api.glyphh.ai', method: 'GET', path: '/app-host/expense-desk/ui/index.html?x=1' });
    expect(up.seen[0].opts.headers).toMatchObject({ authorization: 'Bearer tok', host: 'api.glyphh.ai' });
    expect(up.seen[0].opts.headers.cookie).toBeUndefined();
    expect(res.statusCode).toBe(200);
    expect(res.headers['x-frame-options']).toBeUndefined();
    expect(Buffer.concat(res.chunks).toString()).toBe("<head></head>fetch('/app-host/expense-desk/call'");
    expect(res.headers['content-length']).toBe(String(Buffer.byteLength("<head></head>fetch('/app-host/expense-desk/call'")));
  });
  it("streams the Next.js export's assets under ui/ through untouched (a page's relative ./_next/ resolves under /app-host/<key>/ui/)", async () => {
    const up = fakeUpstream({ status: 200, headers: { 'content-type': 'application/javascript', 'cache-control': 'private, max-age=300' }, body: 'fetch("/call")//js' });
    const res = fakeRes();
    proxyAppHost(fakeReq('/app-host/expense-desk/ui/_next/static/chunks/main.js', { cookie: 'glyphh_session=tok' }), res, 'https://api.glyphh.ai', { request: up.request });
    await res.finished;
    expect(up.seen[0].opts).toMatchObject({ method: 'GET', path: '/app-host/expense-desk/ui/_next/static/chunks/main.js' });
    expect(up.seen[0].opts.headers.authorization).toBe('Bearer tok');
    expect(res.headers['cache-control']).toBe('private, max-age=300');
    expect(Buffer.concat(res.chunks).toString()).toBe('fetch("/call")//js');
  });
  it('streams a /call POST through untouched (JSON is not rewritten)', async () => {
    const up = fakeUpstream({ status: 200, headers: { 'content-type': 'application/json' }, body: '{"ok":true}' });
    const res = fakeRes();
    proxyAppHost(fakeReq('/app-host/expense-desk/call', { cookie: 'glyphh_session=tok', 'content-type': 'application/json' }, '{"method":"ping"}'), res, 'http://localhost:3001', { request: up.request });
    await res.finished;
    expect(up.seen[0].opts).toMatchObject({ protocol: 'http:', hostname: 'localhost', port: '3001', method: 'POST', path: '/app-host/expense-desk/call' });
    expect(up.seen[0].body).toBe('{"method":"ping"}');
    expect(Buffer.concat(res.chunks).toString()).toBe('{"ok":true}');
  });
  it('an upstream error is a 502 with its reason', async () => {
    const request = () => { const pr = new EventEmitter(); pr.write = () => {}; pr.end = () => process.nextTick(() => pr.emit('error', new Error('ECONNREFUSED'))); return pr; };
    const res = fakeRes();
    proxyAppHost(fakeReq('/app-host/x/ui/index.html', {}), res, 'https://api.test', { request });
    await res.finished;
    expect(res.statusCode).toBe(502);
    expect(Buffer.concat(res.chunks).toString()).toContain('ECONNREFUSED');
  });
});
