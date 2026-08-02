import { describe, it, expect, vi } from 'vitest';
import {
  resolveApiUrl,
  gatingCookieStrings,
  makeTokenStore,
  toLegacyUser,
  classifyMethod,
  SESSION_KEY,
} from '../src/glyphh-core.js';

describe('resolveApiUrl', () => {
  it('returns the env url when no location (server-side)', () => {
    expect(resolveApiUrl('https://api.glyphh.ai', null)).toBe('https://api.glyphh.ai');
  });
  it('defaults when env is empty', () => {
    expect(resolveApiUrl('', null)).toBe('https://api.glyphh.ai');
  });
  it('rewrites a localhost api to the page host for cross-device dev', () => {
    expect(resolveApiUrl('http://localhost:3001', { hostname: '192.168.1.41' }))
      .toBe('http://192.168.1.41:3001');
  });
  it('leaves a localhost api untouched when the page is also local', () => {
    expect(resolveApiUrl('http://127.0.0.1:3001', { hostname: 'localhost' }))
      .toBe('http://127.0.0.1:3001');
  });
  it('never rewrites a real remote api host', () => {
    expect(resolveApiUrl('https://api.glyphh.ai', { hostname: '192.168.1.41' }))
      .toBe('https://api.glyphh.ai');
  });
  it('falls back to env on an unparseable url', () => {
    expect(resolveApiUrl('not a url', { hostname: 'x' })).toBe('not a url');
  });
});

describe('gatingCookieStrings', () => {
  const prod = { hostname: 'platform.glyphh.ai', protocol: 'https:' };
  const dev = { hostname: 'localhost', protocol: 'http:' };

  it('emits four cookies', () => {
    expect(gatingCookieStrings(true, 'admin', false, false, prod)).toHaveLength(4);
  });
  it('sets logged_in + role and a 30-day max-age when signed in', () => {
    const [loggedIn, role] = gatingCookieStrings(true, 'org_admin', false, false, prod);
    expect(loggedIn).toContain('glyphh_logged_in=1');
    expect(role).toContain('glyphh_role=org_admin');
    expect(loggedIn).toContain(`max-age=${60 * 60 * 24 * 30}`);
  });
  it('clears values and sets max-age=0 when signed out', () => {
    const [loggedIn, role] = gatingCookieStrings(false, 'admin', true, true, prod);
    expect(loggedIn).toContain('glyphh_logged_in=;');
    expect(role).toContain('glyphh_role=;');
    expect(loggedIn).toContain('max-age=0');
  });
  it('scopes to .glyphh.ai and marks Secure on a glyphh.ai https host', () => {
    const [c] = gatingCookieStrings(true, 'user', false, false, prod);
    expect(c).toContain('domain=.glyphh.ai');
    expect(c).toContain('Secure');
  });
  it('stays host-only (no domain, no Secure) on localhost dev', () => {
    const [c] = gatingCookieStrings(true, 'user', false, false, dev);
    expect(c).not.toContain('domain=');
    expect(c).not.toContain('Secure');
  });
  it('only sets the platform_admin cookie when both signed-in and admin', () => {
    const [, , admin] = gatingCookieStrings(true, 'user', true, false, prod);
    expect(admin).toContain('glyphh_platform_admin=1');
    const [, , notAdmin] = gatingCookieStrings(true, 'user', false, false, prod);
    expect(notAdmin).toContain('glyphh_platform_admin=;');
  });
});

describe('makeTokenStore', () => {
  function fakeStorage(initial = {}) {
    const m = new Map(Object.entries(initial));
    return {
      getItem: (k) => (m.has(k) ? m.get(k) : null),
      setItem: (k, v) => m.set(k, v),
      removeItem: (k) => m.delete(k),
      _map: m,
    };
  }

  it('loads null when empty', async () => {
    const s = makeTokenStore({ storage: fakeStorage() });
    expect(await s.load()).toBeNull();
  });
  it('round-trips a session and invokes onSave', async () => {
    const storage = fakeStorage();
    const onSave = vi.fn();
    const s = makeTokenStore({ storage, onSave });
    const session = { accessToken: 'a', refreshToken: 'r', expiresAt: 123 };
    await s.save(session);
    expect(JSON.parse(storage.getItem(SESSION_KEY))).toEqual(session);
    expect(onSave).toHaveBeenCalledWith(session);
    expect(await s.load()).toEqual(session);
  });
  it('returns null (not throw) on corrupt json', async () => {
    const s = makeTokenStore({ storage: fakeStorage({ [SESSION_KEY]: '{bad' }) });
    expect(await s.load()).toBeNull();
  });
  it('clears storage and invokes onClear', async () => {
    const storage = fakeStorage({ [SESSION_KEY]: '{}' });
    const onClear = vi.fn();
    const s = makeTokenStore({ storage, onClear });
    await s.clear();
    expect(storage.getItem(SESSION_KEY)).toBeNull();
    expect(onClear).toHaveBeenCalled();
  });
});

describe('toLegacyUser', () => {
  it('splits name into first/last and carries flags', () => {
    const u = toLegacyUser({
      userId: 'u1', email: 'a@b.co', name: 'Ada Lovelace', role: 'org_admin',
      orgId: 'o1', tier: 'pro', isPlatformAdmin: true, impersonating: 'o9',
    });
    expect(u).toMatchObject({
      id: 'u1', userId: 'u1', firstName: 'Ada', lastName: 'Lovelace',
      role: 'org_admin', isPlatformAdmin: true, impersonating: 'o9',
    });
  });
  it('handles a missing/blank name safely', () => {
    const u = toLegacyUser({ userId: 'u1', email: 'a@b.co' });
    expect(u.firstName).toBe('');
    expect(u.lastName).toBe('');
    expect(u.isPlatformAdmin).toBe(false);
    expect(u.impersonating).toBeNull();
  });
});

describe('classifyMethod', () => {
  it('flags OS-only methods as native', () => {
    for (const n of ['windowClose', 'panelsHide', 'copyToClipboard', 'openExternal']) {
      expect(classifyMethod(n)).toBe('native');
    }
  });
  it('flags on* as event subscriptions', () => {
    expect(classifyMethod('onGlyphhAgentDelta')).toBe('subscribe');
    expect(classifyMethod('onSplashStatus')).toBe('subscribe');
  });
  it('flags machine-only methods as local', () => {
    for (const n of ['files:read-file', 'getWorkingDir', 'git:diff']) {
      expect(classifyMethod(n)).toBe('local');
    }
  });
  it('treats Ada / memory as CLOUD so sessions stay portable across surfaces', () => {
    for (const n of ['adaRecall', 'adaAsk']) {
      expect(classifyMethod(n)).toBe('cloud');
    }
  });
  it('defaults everything else to cloud', () => {
    for (const n of ['appsBrowse', 'modelsList', 'billingStatus', 'dashboardData']) {
      expect(classifyMethod(n)).toBe('cloud');
    }
  });
});
