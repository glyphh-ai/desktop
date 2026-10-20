/**
 * serve-routes.test.js — the web front door's route decision (web/serve-routes.mjs).
 *
 * app.glyphh.ai = the identical desktop app on the web (his order, 2026-10-04):
 *   • a desktop browser's /home is the COMMAND CENTER (no 302 to /platform any more)
 *   • a signed-in phone gets the mobile shell for the app routes
 *   • GLYPHH_MOBILE_ONLY (mobile.glyphh.ai) makes every page the mobile shell
 *   • /platform stays reachable, the login/auth shell routes stay in place
 */
import { describe, it, expect } from 'vitest';
import { resolveRoute, isPhoneUserAgent, hasAuthedCookie, isNestedShellRoute } from '../serve-routes.mjs';

const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1';
const ANDROID = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/120 Mobile Safari/537.36';
const MAC = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120 Safari/537.36';
const AUTHED = 'glyphh_logged_in=1; other=x';

describe('user-agent + cookie helpers', () => {
  it('flags phones, not desktops or tablets', () => {
    expect(isPhoneUserAgent(IPHONE)).toBe(true);
    expect(isPhoneUserAgent(ANDROID)).toBe(true);
    expect(isPhoneUserAgent(MAC)).toBe(false);
    expect(isPhoneUserAgent('')).toBe(false);
  });
  it('reads the gating cookie exactly', () => {
    expect(hasAuthedCookie(AUTHED)).toBe(true);
    expect(hasAuthedCookie('glyphh_logged_in=0')).toBe(false);
    expect(hasAuthedCookie('xglyphh_logged_in=1')).toBe(false);
    expect(hasAuthedCookie('')).toBe(false);
  });
  it('nested shell routes need <base>; the root and /login do not', () => {
    expect(isNestedShellRoute('/auth/device')).toBe(true);
    expect(isNestedShellRoute('/settings/mcp')).toBe(true);
    expect(isNestedShellRoute('/')).toBe(false);
    expect(isNestedShellRoute('/login')).toBe(false);
    expect(isNestedShellRoute('/home')).toBe(false);
  });
});

describe('desktop browser (app.glyphh.ai)', () => {
  it('/home is the command center — no redirect to /platform', () => {
    expect(resolveRoute({ path: '/home', ua: MAC, cookie: AUTHED })).toEqual({ kind: 'app' });
    expect(resolveRoute({ path: '/home/', ua: MAC, cookie: AUTHED })).toEqual({ kind: 'app' });
    // Signed-out too: the bridge bounces an anonymous /home to the login client-side.
    expect(resolveRoute({ path: '/home', ua: MAC })).toEqual({ kind: 'app' });
  });
  it('/platform stays reachable', () => {
    expect(resolveRoute({ path: '/platform', ua: MAC, cookie: AUTHED })).toEqual({ kind: 'platform' });
  });
  it('the login shell serves / and the auth routes in place', () => {
    expect(resolveRoute({ path: '/', ua: MAC })).toEqual({ kind: 'login', nested: false });
    expect(resolveRoute({ path: '/auth/callback', ua: MAC })).toEqual({ kind: 'login', nested: true });
    expect(resolveRoute({ path: '/auth/device', ua: MAC, cookie: AUTHED })).toEqual({ kind: 'login', nested: true });
    expect(resolveRoute({ path: '/settings/mcp', ua: MAC, cookie: AUTHED })).toEqual({ kind: 'login', nested: true });
  });
  it('/billing bounces into the platform (Stripe return)', () => {
    expect(resolveRoute({ path: '/billing', ua: MAC })).toEqual({ kind: 'redirect', location: '/platform' });
  });
  it('/m is always the mobile shell; files are static', () => {
    expect(resolveRoute({ path: '/m', ua: MAC })).toEqual({ kind: 'mobile' });
    expect(resolveRoute({ path: '/github/done', ua: MAC })).toEqual({ kind: 'github-done' });
    expect(resolveRoute({ path: '/github/done', ua: IPHONE, cookie: 'glyphh_logged_in=1' })).toEqual({ kind: 'github-done' });
    expect(resolveRoute({ path: '/styles.css', ua: MAC })).toEqual({ kind: 'static' });
    expect(resolveRoute({ path: '/brand/logo.svg', ua: MAC, cookie: AUTHED })).toEqual({ kind: 'static' });
  });
});

describe('phone', () => {
  it('a signed-in phone gets the mobile shell for the app routes', () => {
    for (const path of ['/', '/home', '/home/', '/platform', '/login']) {
      expect(resolveRoute({ path, ua: IPHONE, cookie: AUTHED })).toEqual({ kind: 'mobile' });
      expect(resolveRoute({ path, ua: ANDROID, cookie: AUTHED })).toEqual({ kind: 'mobile' });
    }
  });
  it('a signed-out phone still sees the login shell (it has to sign in somewhere)', () => {
    expect(resolveRoute({ path: '/', ua: IPHONE })).toEqual({ kind: 'login', nested: false });
    expect(resolveRoute({ path: '/home', ua: IPHONE })).toEqual({ kind: 'app' });
  });
  it('auth + consent routes stay on the shell even when signed in (token exchange / MCP consent)', () => {
    expect(resolveRoute({ path: '/auth/device', ua: IPHONE, cookie: AUTHED })).toEqual({ kind: 'login', nested: true });
    expect(resolveRoute({ path: '/auth/callback', ua: IPHONE, cookie: AUTHED })).toEqual({ kind: 'login', nested: true });
    expect(resolveRoute({ path: '/settings/mcp', ua: IPHONE, cookie: AUTHED })).toEqual({ kind: 'login', nested: true });
  });
});

describe('GLYPHH_MOBILE_ONLY (mobile.glyphh.ai)', () => {
  it('every page is the mobile shell, on any device, signed in or not', () => {
    for (const path of ['/', '/home', '/platform', '/auth/callback', '/anything']) {
      expect(resolveRoute({ path, ua: MAC, mobileOnly: true })).toEqual({ kind: 'mobile' });
      expect(resolveRoute({ path, ua: IPHONE, cookie: AUTHED, mobileOnly: true })).toEqual({ kind: 'mobile' });
    }
  });
  it('files still serve from disk', () => {
    expect(resolveRoute({ path: '/mobile.css', ua: MAC, mobileOnly: true })).toEqual({ kind: 'static' });
    expect(resolveRoute({ path: '/glyphh-mobile.js', ua: IPHONE, mobileOnly: true })).toEqual({ kind: 'static' });
  });
  it('/billing still bounces first', () => {
    expect(resolveRoute({ path: '/billing', ua: MAC, mobileOnly: true })).toEqual({ kind: 'redirect', location: '/platform' });
  });
});
