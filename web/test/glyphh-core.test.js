import { describe, it, expect, vi } from 'vitest';
import {
  resolveApiUrl,
  gatingCookieStrings,
  makeTokenStore,
  toLegacyUser,
  classifyMethod,
  parseCallbackParams,
  decideBootState,
  shouldShowFirstRun,
  CALLBACK_PATH,
  isPhoneViewport,
  applyPhoneClass,
  PHONE_MAX,
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
  toDashboardData,
  emptyDashboardData,
  isWebAuthedFromCookie,
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

describe('parseCallbackParams / decideBootState (web boot)', () => {
  it('CALLBACK_PATH is the platform-parity /auth/callback', () => {
    expect(CALLBACK_PATH).toBe('/auth/callback');
  });
  it('parses token, code, and a safe in-app redirect', () => {
    expect(parseCallbackParams('?token=t')).toMatchObject({ token: 't', code: null });
    expect(parseCallbackParams('?code=c&redirect=%2Fapps')).toMatchObject({ code: 'c', redirect: '/apps' });
    expect(parseCallbackParams('?redirect=https://x.com').redirect).toBe(null);
  });
  it('routes authed→app, unauthed→login, and a token on the callback path→callback', () => {
    expect(decideBootState({ pathname: '/', search: '', authenticated: true })).toBe('app');
    expect(decideBootState({ pathname: '/', search: '', authenticated: false })).toBe('login');
    expect(decideBootState({ pathname: CALLBACK_PATH, search: '?token=t', authenticated: false })).toBe('callback');
    expect(decideBootState({ pathname: CALLBACK_PATH, search: '', authenticated: true })).toBe('app');
  });
});

describe('isPhoneViewport (min-dimension phone detection)', () => {
  it('phone PORTRAIT is a phone (narrow shorter edge)', () => {
    // iPhone 14/15 portrait ~390x844.
    expect(isPhoneViewport({ innerWidth: 390, innerHeight: 844, coarse: true })).toBe(true);
    // Small phone.
    expect(isPhoneViewport({ innerWidth: 360, innerHeight: 780, coarse: true })).toBe(true);
  });
  it('phone LANDSCAPE is still a phone (wide but SHORT) — width alone would miss it', () => {
    // Same device rotated: 844x390. A raw max-width test would call this desktop.
    expect(isPhoneViewport({ innerWidth: 844, innerHeight: 390, coarse: true })).toBe(true);
    // Largest phone landscape ~932x430 — shorter edge 430 < 600.
    expect(isPhoneViewport({ innerWidth: 932, innerHeight: 430, coarse: true })).toBe(true);
  });
  it('iPad PORTRAIT and LANDSCAPE are NOT a phone (shorter edge ≥ 768)', () => {
    expect(isPhoneViewport({ innerWidth: 768, innerHeight: 1024, coarse: true })).toBe(false); // portrait
    expect(isPhoneViewport({ innerWidth: 1024, innerHeight: 768, coarse: true })).toBe(false); // landscape
    expect(isPhoneViewport({ innerWidth: 834, innerHeight: 1194, coarse: true })).toBe(false); // iPad Air portrait
  });
  it('desktop is NOT a phone', () => {
    expect(isPhoneViewport({ innerWidth: 1440, innerHeight: 900, coarse: false })).toBe(false);
    // Even a NARROW desktop window (mouse pointer) is not a phone.
    expect(isPhoneViewport({ innerWidth: 500, innerHeight: 800, coarse: false })).toBe(false);
  });
  it('a touch device right at a borderline size uses the full threshold', () => {
    expect(PHONE_MAX).toBe(600);
    expect(isPhoneViewport({ innerWidth: 599, innerHeight: 900, coarse: true })).toBe(true);
    expect(isPhoneViewport({ innerWidth: 601, innerHeight: 900, coarse: true })).toBe(false);
  });
  it('is false for missing / degenerate measurements', () => {
    expect(isPhoneViewport({})).toBe(false);
    expect(isPhoneViewport({ innerWidth: 0, innerHeight: 0 })).toBe(false);
    expect(isPhoneViewport()).toBe(false);
  });
});

describe('applyPhoneClass', () => {
  const fakeList = () => {
    const set = new Set();
    return { add: (c) => set.add(c), remove: (c) => set.delete(c), has: (c) => set.has(c) };
  };
  it('adds glyphh-phone for a phone viewport and returns true', () => {
    const list = fakeList();
    expect(applyPhoneClass(list, { innerWidth: 390, innerHeight: 844, coarse: true })).toBe(true);
    expect(list.has('glyphh-phone')).toBe(true);
  });
  it('removes glyphh-phone for a non-phone (iPad/desktop) and returns false', () => {
    const list = fakeList();
    list.add('glyphh-phone');
    expect(applyPhoneClass(list, { innerWidth: 1024, innerHeight: 768, coarse: true })).toBe(false);
    expect(list.has('glyphh-phone')).toBe(false);
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
  it('surfaces the server per-user regionChosen flag (defaults false when absent)', () => {
    expect(toLegacyUser({ userId: 'u1', email: 'a@b.co', regionChosen: true }).regionChosen).toBe(true);
    expect(toLegacyUser({ userId: 'u1', email: 'a@b.co', regionChosen: false }).regionChosen).toBe(false);
    expect(toLegacyUser({ userId: 'u1', email: 'a@b.co' }).regionChosen).toBe(false);
  });
});

describe('shouldShowFirstRun (server regionChosen gate)', () => {
  it('pre-auth → NEVER first-run (login only), regardless of regionChosen', () => {
    expect(shouldShowFirstRun({ authenticated: false, regionChosen: false })).toBe(false);
    expect(shouldShowFirstRun({ authenticated: false, regionChosen: true })).toBe(false);
  });
  it('authed + regionChosen=false (NEW user) → show first-run once', () => {
    expect(shouldShowFirstRun({ authenticated: true, regionChosen: false })).toBe(true);
  });
  it('authed + regionChosen=true (RETURNING user) → skip first-run', () => {
    expect(shouldShowFirstRun({ authenticated: true, regionChosen: true })).toBe(false);
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
  it('yields the desktop layout shape and derives splits from cells (rail reads l.splits)', () => {
    const [out] = toLegacyLayouts([{ name: 'Grid A', data: {
      cols: 2, rows: 1, name: 'stale',
      cells: [{ panelId: 'p1', col: 0, row: 0 }, { panelId: 'p2', col: 1, row: 0 }],
    } }]);
    expect(out.name).toBe('Grid A');
    expect(out.cols).toBe(2);
    // splits MUST exist as an array so renderRailLayouts' `.splits.map` never throws.
    expect(Array.isArray(out.splits)).toBe(true);
    expect(out.splits.map((s) => s.panelId)).toEqual(['p1', 'p2']);
    // safe defaults for the fields the renderer reads.
    expect(out).toMatchObject({ target: 'glyphh', sessionMode: 'keep', modelSelections: {} });
  });
  it('parses data when it is a JSON STRING (spreading a string would give char-indices)', () => {
    const json = JSON.stringify({ cols: 1, rows: 1, cells: [{ panelId: 'only' }] });
    const [out] = toLegacyLayouts([{ name: 'S', data: json }]);
    expect(out.name).toBe('S');
    expect(out.splits.map((s) => s.panelId)).toEqual(['only']);
  });
  it('prefers an already-present splits array over deriving from cells', () => {
    const [out] = toLegacyLayouts([{ name: 'S', data: { splits: [{ panelId: 'x' }], cells: [{ panelId: 'y' }] } }]);
    expect(out.splits.map((s) => s.panelId)).toEqual(['x']);
  });
  it('degrades a corrupt/missing/unparseable row to a valid layout with EMPTY splits (never throws, never dropped)', () => {
    const out = toLegacyLayouts([
      { name: 'null', data: null },       // dropped (no data)
      { name: 'bad-json', data: '{not json' },
      { name: 'no-cells', data: {} },
    ]);
    // the null-data row is filtered; the other two survive with empty splits.
    expect(out.map((l) => l.name)).toEqual(['bad-json', 'no-cells']);
    for (const l of out) expect(l.splits).toEqual([]);
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
  it('derives the desktop shape from a mine() wire row by kind', () => {
    const out = toLegacyPanelApps([
      // an UNDEPLOYED glyphh app: no url, no prodUrl — must still be tagged so
      // the rail (isBrowser===false) and wall (archetype glyphh-app) keep it
      { id: 'u1', slug: 'my-app', name: 'My App', kind: 'glyphh', prodUrl: null, config: { a: 1 } },
      { id: 'u2', slug: 'live-app', name: 'Live App', kind: 'glyphh', prodUrl: 'https://live-app.glyphh.app' },
      { id: 'u3', slug: 'tool', name: 'Tool', kind: 'native', nativeRef: '/Applications/Tool.app' },
      { id: 'u4', slug: 'site', name: 'Site', kind: 'web', prodUrl: 'https://site' },
    ]);
    expect(out[0]).toMatchObject({ url: null, isBrowser: false, appArchetype: 'glyphh-app', launchConfig: { a: 1 } });
    expect(out[1]).toMatchObject({ url: 'https://live-app.glyphh.app', isBrowser: false, appArchetype: 'glyphh-app' });
    expect(out[2]).toMatchObject({ isBrowser: false, appArchetype: 'native', execPath: '/Applications/Tool.app' });
    expect(out[3]).toMatchObject({ url: 'https://site', isBrowser: true, appArchetype: 'web' });
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

describe('isWebAuthedFromCookie (sync gating-cookie read)', () => {
  it('true only when glyphh_logged_in=1 is present', () => {
    expect(isWebAuthedFromCookie('glyphh_logged_in=1')).toBe(true);
    expect(isWebAuthedFromCookie('glyphh_role=org_admin; glyphh_logged_in=1; x=y')).toBe(true);
  });
  it('false when the cookie is empty, absent, or cleared', () => {
    expect(isWebAuthedFromCookie('glyphh_logged_in=')).toBe(false);
    expect(isWebAuthedFromCookie('glyphh_role=org_admin')).toBe(false);
    expect(isWebAuthedFromCookie('')).toBe(false);
    expect(isWebAuthedFromCookie(undefined)).toBe(false);
    expect(isWebAuthedFromCookie(null)).toBe(false);
  });
  it('does not match a look-alike cookie name', () => {
    expect(isWebAuthedFromCookie('not_glyphh_logged_in=1')).toBe(false);
  });
});

describe('emptyDashboardData / toDashboardData (Chat-tab landing shape)', () => {
  // The Chat-tab landing renders ONLY when dashboardData() resolves truthy, so the
  // empty shape must be a FULL object with every field the DashboardData contract reads.
  it('emptyDashboardData is a complete zeroed shape (never null/partial)', () => {
    expect(emptyDashboardData()).toEqual({
      name: '', plan: '', orgCredits: false, me: null,
      credits: 0, allowance: 0, spendCredits: 0, requests: 0, appsCount: 0,
    });
  });
  // A fresh object each call — a caller can never mutate a shared instance.
  it('emptyDashboardData returns a fresh object', () => {
    expect(emptyDashboardData()).not.toBe(emptyDashboardData());
  });
  // Logged out: no identity → the empty shape (the front door still renders).
  it('toDashboardData(null,…) → emptyDashboardData()', () => {
    expect(toDashboardData(null, null, null, null, null)).toEqual(emptyDashboardData());
  });
  // Authed member: no org pool (403 → null) but a personal allocation → member card.
  it('member with allocation, no org pool → orgCredits false, me populated', () => {
    const out = toDashboardData(
      { name: 'Ada Lovelace', tier: 'pro' },
      null,
      { uncapped: false, capCredits: 100, spentCredits: 30, remainingCredits: 70, windowEnd: '2026-09-01', workspaceName: 'Growth' },
      { credits: 30, events: 12 },
      [{ system: true, url: 'x' }, { system: false, url: 'https://a' }, { system: false, url: null }],
    );
    expect(out.name).toBe('Ada');           // first token of the display name
    expect(out.plan).toBe('pro');
    expect(out.orgCredits).toBe(false);      // null org pool → member card
    expect(out.me).toEqual({
      roleName: 'Growth', uncapped: false, capCredits: 100,
      spentCredits: 30, remainingCredits: 70, windowEnd: '2026-09-01',
    });
    expect(out.spendCredits).toBe(30);
    expect(out.requests).toBe(12);
    expect(out.appsCount).toBe(1);           // only the non-system app WITH a url
  });
  // Admin with an org pool: credits/allowance are micro-credits → whole credits.
  it('admin with org pool → orgCredits true, micro→whole credit math', () => {
    const out = toDashboardData(
      { name: 'Sam', tier: 'advanced' },
      { balance: 5_500_000, allowance: 10_000_000 },
      null,
      null,
      null,
    );
    expect(out.orgCredits).toBe(true);
    expect(out.credits).toBe(5);             // floor(5.5M / 1M)
    expect(out.allowance).toBe(10);
    expect(out.me).toBe(null);
    expect(out.appsCount).toBe(0);           // apps null → 0, never a throw
  });
});

// LOGIN-FIRST (2026-08-03): per-tab Work/Code sign-in gating was removed — the app
// is only reachable with a session, so gateModeSwitch/GATED_TABS no longer exist.
// The wall itself is exercised in the bridge (anonymous /home → login redirect).
describe('login-first wall replaced per-tab gating', () => {
  it('gating primitives are gone from the core surface', async () => {
    const core = await import('../src/glyphh-core.js');
    expect(core.gateModeSwitch).toBeUndefined();
    expect(core.GATED_TABS).toBeUndefined();
  });
});
