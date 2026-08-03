import { describe, it, expect, vi } from 'vitest';
import {
  resolveApiUrl,
  gatingCookieStrings,
  makeTokenStore,
  toLegacyUser,
  classifyMethod,
  SESSION_KEY,
  libEnvelope,
  libError,
  toLegacyConnections,
  toLegacyConnectionTools,
  toLegacyConnectorApps,
  toLegacyMcpConnections,
  toLegacyLoops,
  toLegacyLoopRoles,
  toLegacyLayouts,
  toLegacyDrips,
  toLegacyPanelApps,
  toAccountInfo,
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
  it('routes local file/exec pickers as local (attach in P6, not cloud no-ops)', () => {
    for (const n of ['pickExecutable', 'glyphhPickAttachments', 'glyphhClassifyPaths', 'getPathForFile']) {
      // getPathForFile is NATIVE (a sync OS call); the rest are local.
      expect(['native', 'local']).toContain(classifyMethod(n));
    }
    expect(classifyMethod('pickExecutable')).toBe('local');
    expect(classifyMethod('glyphhPickAttachments')).toBe('local');
    expect(classifyMethod('getPathForFile')).toBe('native');
  });
  it('routes the auto-updater/relaunch as native no-ops (no installer in a tab)', () => {
    for (const n of ['checkForUpdates', 'updateInstall', 'getUpdateStatus', 'relaunch']) {
      expect(classifyMethod(n)).toBe('native');
    }
  });
  it('treats Ada / memory as CLOUD so sessions stay portable across surfaces', () => {
    for (const n of ['adaRecall', 'adaAsk']) {
      expect(classifyMethod(n)).toBe('cloud');
    }
  });
  it('keeps product-critical reads as cloud (not silently native/local)', () => {
    for (const n of [
      'appsBrowse', 'modelsList', 'billingStatus', 'dashboardData',
      'connectionsList', 'panelAppsList', 'orgModelsList', 'loopRoles',
      'librarySkillsList', 'submitSupportTicket', 'execCommand', 'refreshAuth',
    ]) {
      expect(classifyMethod(n)).toBe('cloud');
    }
  });
});

describe('libEnvelope / libError', () => {
  it('wraps a value as an ok envelope', () => {
    expect(libEnvelope([1, 2])).toEqual({ ok: true, data: [1, 2] });
  });
  it('carries an Error message as a failed envelope', () => {
    expect(libError(new Error('boom'))).toEqual({ ok: false, error: 'boom' });
  });
  it('stringifies a non-Error', () => {
    expect(libError('nope')).toEqual({ ok: false, error: 'nope' });
  });
});

describe('toLegacyConnections', () => {
  it('maps resolved connections to first-class Connection rows keyed by slug', () => {
    const out = toLegacyConnections({
      connections: [{
        slug: 'gmail', name: 'Gmail', kind: 'pipedream', scope: 'personal',
        tools: [{ name: 'send' }], availableTools: [{ name: 'send' }, { name: 'find' }],
      }],
    });
    expect(out.ok).toBe(true);
    expect(out.connections[0]).toMatchObject({
      id: 'gmail', accountId: 'gmail', appSlug: 'gmail', appName: 'Gmail',
      org: false, agentAllowed: true, agentTools: 1, agentAvailable: 2,
    });
  });
  it('flags org-scoped connections and handles empty input', () => {
    const out = toLegacyConnections({ connections: [{ slug: 's', name: 'S', scope: 'org' }] });
    expect(out.connections[0].org).toBe(true);
    expect(out.connections[0].agentTools).toBe(0);
    expect(toLegacyConnections(undefined)).toEqual({ ok: true, connections: [] });
  });
});

describe('toLegacyConnectionTools', () => {
  const resolved = {
    connections: [{
      slug: 'gmail',
      tools: [{ name: 'send' }],
      availableTools: [
        { name: 'send', description: 'Send mail' },
        { name: 'find', description: null },
      ],
    }],
  };
  it('marks tools not in the allowed set as hidden', () => {
    const out = toLegacyConnectionTools(resolved, 'gmail');
    expect(out.ok).toBe(true);
    expect(out.tools).toEqual([
      { name: 'send', description: 'Send mail', hidden: false },
      { name: 'find', description: '', hidden: true },
    ]);
  });
  it('returns an empty list for an unknown connection', () => {
    expect(toLegacyConnectionTools(resolved, 'nope')).toEqual({ ok: true, tools: [] });
  });
});

describe('toLegacyConnectorApps', () => {
  it('maps catalog apps and reports no further pages', () => {
    const out = toLegacyConnectorApps({ apps: [{ id: 'slack', name: 'Slack', icon: 'x.png' }] });
    expect(out).toEqual({
      apps: [{ id: 'slack', name: 'Slack', description: '', icon: 'x.png' }],
      hasMore: false,
    });
  });
});

describe('toLegacyMcpConnections', () => {
  it('tags org before personal and builds the icon URL from iconSha', () => {
    const out = toLegacyMcpConnections(
      [{ slug: 'p', name: 'P', url: 'u', enabled: true }],
      [{ slug: 'o', name: 'O', url: 'u', enabled: false, iconSha: 'abc', headerKeys: ['X'] }],
      'https://api.glyphh.ai',
    );
    expect(out.ok).toBe(true);
    expect(out.connections[0]).toMatchObject({ slug: 'o', kind: 'org', iconUrl: 'https://api.glyphh.ai/api/mcp-icons/abc' });
    expect(out.connections[1]).toMatchObject({ slug: 'p', kind: 'personal', iconUrl: null });
  });
});

describe('toLegacyLoops', () => {
  it('maps loops and optimistically allows building', () => {
    const out = toLegacyLoops({ loops: [{ id: '1', name: 'Default', description: 'd', builtIn: true }] });
    expect(out).toEqual({
      ok: true, canBuild: true,
      loops: [{ id: '1', name: 'Default', description: 'd', builtIn: true }],
    });
  });
});

describe('toLegacyLoopRoles', () => {
  it('wraps resolved roles in the loop envelope', () => {
    const roles = [{ name: 'planner', modelId: 'm', choices: [] }];
    expect(toLegacyLoopRoles('web', roles)).toEqual({ ok: true, loop: 'web', roles });
  });
  it('defaults roles to an empty array', () => {
    expect(toLegacyLoopRoles('web', undefined)).toEqual({ ok: true, loop: 'web', roles: [] });
  });
});

describe('toLegacyLayouts', () => {
  it('spreads the grid from data and overrides name from the item', () => {
    const out = toLegacyLayouts([{ name: 'Grid A', data: { cols: 2, rows: 1, name: 'stale' } }]);
    expect(out).toEqual([{ cols: 2, rows: 1, name: 'Grid A' }]);
  });
  it('skips rows whose data is not an object', () => {
    expect(toLegacyLayouts([{ name: 'x', data: null }, { name: 'y', data: 'z' }])).toEqual([]);
  });
});

describe('toLegacyDrips', () => {
  it('reads a recipe from a string or a {recipe} object', () => {
    const out = toLegacyDrips([
      { name: 'a', data: 'confetti' },
      { name: 'b', data: { recipe: 'hearts' } },
    ]);
    expect(out).toEqual([
      { name: 'a', recipe: 'confetti' },
      { name: 'b', recipe: 'hearts' },
    ]);
  });
});

describe('toLegacyPanelApps', () => {
  it('fills legacy defaults for a lean PanelApp', () => {
    const out = toLegacyPanelApps([{ slug: 'crm', name: 'CRM', url: 'https://crm' }]);
    expect(out[0]).toMatchObject({
      id: 'crm', slug: 'crm', name: 'CRM', url: 'https://crm',
      isBrowser: true, access: 'members', mcp: null, commands: {}, connectionIds: [],
    });
  });
});

describe('toAccountInfo', () => {
  it('composes identity + org + subscription', () => {
    const out = toAccountInfo(
      { email: 'a@b.co', name: 'Ada Lovelace', role: 'org_admin', tier: 'free' },
      { name: 'Acme' },
      { tier: 'pro', billingStatus: 'active' },
    );
    expect(out).toEqual({
      email: 'a@b.co', firstName: 'Ada', lastName: 'Lovelace',
      role: 'org_admin', orgName: 'Acme', tier: 'pro', billingStatus: 'active',
    });
  });
  it('degrades safely when org/billing are missing', () => {
    const out = toAccountInfo({ email: 'a@b.co', name: '', role: 'member', tier: 'basic' }, null, null);
    expect(out).toMatchObject({ orgName: '', tier: 'basic', billingStatus: 'none', firstName: '' });
  });
  it('returns null with no identity', () => {
    expect(toAccountInfo(null, null, null)).toBeNull();
  });
});
