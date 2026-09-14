/**
 * web-contract.test.js — the renderer↔SDK contract layer (web-contract.js).
 *
 * buildContract() is pure over an injected SDK client, so it tests with NO browser and
 * NO server against a fake client. Two axes are covered for every boot-surface method:
 *   • AUTHED  — the fake resolves real SDK shapes → the method returns the contract shape
 *   • LOGGED-OUT / offline — the fake REJECTS (a 401 for an anonymous visitor) → the
 *     method still resolves to the CORRECT EMPTY shape of its contract type (never
 *     undefined, never a throw). This is the whole point of the contract layer.
 *
 * A final boot-render-path test drives the exact methods the Chat front door + rail +
 * landing fire at boot and asserts each returns a valid shape with no throw — the
 * regression guard for the blank-screen class of bug.
 */
import { describe, it, expect, vi } from 'vitest';
import { buildContract, EMPTY } from '../src/web-contract.js';

/** A fake SDK client whose domain methods resolve canned SDK shapes (the AUTHED path). */
function authedClient() {
  return {
    me: vi.fn(async () => ({ email: 'a@b.co', name: 'Ada Lovelace', role: 'org_admin', tier: 'pro' })),
    org: { get: vi.fn(async () => ({ name: 'Acme' })) },
    billing: {
      status: vi.fn(async () => ({ tier: 'pro', billingStatus: 'active' })),
      credits: vi.fn(async () => ({ balance: 5_000_000, allowance: 10_000_000 })),
      // The plan catalog — dashboardData reads the plan's name + allowance here.
      plans: vi.fn(async () => ([{ tier: 'pro', displayName: 'Glyphh Pro', monthlyCredits: 10_000, maxSeats: 25, sso: false, monthlyUsdCents: 5000 }])),
    },
    usage: {
      allocation: vi.fn(async () => ({ uncapped: true, capCredits: 0, spentCredits: 0, remainingCredits: 0, workspaceName: 'Main', windowEnd: '' })),
      summary: vi.fn(async () => ({ credits: 7, events: 3 })),
    },
    profile: { get: vi.fn(async () => ({ timezone: 'UTC' })), update: vi.fn(async () => ({})), prefs: vi.fn(async () => ({ theme: 'nord' })), setPrefs: vi.fn(async (p) => p) },
    connections: {
      // connectionsList calls this FIRST for its org-sync side-effect
      // (web-contract.js) — without it the double throws and the whole
      // read falls back to empty, which is what broke this suite.
      pipedreamList: vi.fn(async () => []),
      // The management list builds from the RAW rows now (his rule,
      // 2026-09-13): real ids + the governed `enabled` bit; resolvedTools
      // only hydrates the tool counts.
      personalList: vi.fn(async () => [{ id: 'gmail', appSlug: 'gmail', appName: 'Gmail', name: 'Gmail', enabled: true, healthy: true }]),
      resolvedTools: vi.fn(async () => ({ connections: [{ slug: 'gmail', name: 'Gmail', scope: 'personal', tools: [{ name: 'send' }], availableTools: [{ name: 'send' }, { name: 'find' }] }] })),
      apps: vi.fn(async () => ({ apps: [{ id: 'slack', name: 'Slack', icon: null }] })),
      personalMcpList: vi.fn(async () => [{ slug: 'p', name: 'P', url: 'u', enabled: true }]),
      orgMcpList: vi.fn(async () => [{ slug: 'o', name: 'O', url: 'u', enabled: true }]),
    },
    tasks: {
      list: vi.fn(async () => ({ tasks: [{ id: '1', name: 'Default', description: 'd', builtIn: true }] })),
      roles: vi.fn(async () => [{ name: 'planner', modelId: 'm', choices: [] }]),
      get: vi.fn(async () => ({ id: '1' })),
    },
    skills: { list: vi.fn(async () => [{ id: 's' }]), get: vi.fn(async () => ({ id: 's' })) },
    agents: { list: vi.fn(async () => [{ id: 'a' }]), get: vi.fn(async () => ({ id: 'a' })), tasks: vi.fn(async () => [{ id: 't' }]), taskRuns: vi.fn(async () => [{ id: 'r' }]) },
    layouts: { list: vi.fn(async () => [{ name: 'Grid', data: { cols: 2, rows: 1, cells: [{ panelId: 'p', col: 0, row: 0, colSpan: 1, rowSpan: 1 }] } }]) },
    drips: { list: vi.fn(async () => [{ name: 'd', data: 'confetti' }]) },
    apps: { deployed: vi.fn(async () => []), mine: vi.fn(async () => [{ slug: 'crm', name: 'CRM', url: 'https://crm' }]) },
    orgModels: { list: vi.fn(async () => [{ id: 'm1' }]), listCustom: vi.fn(async () => [{ id: 'c1' }]) },
    catalog: { providers: vi.fn(async () => [{ slug: 'anthropic' }]) },
    support: { ticket: vi.fn(async () => ({ ok: true })) },
  };
}

/** A fake whose EVERY method rejects — the anonymous-visitor / offline path (401s). */
function rejectingClient() {
  const boom = vi.fn(async () => { throw new Error('401 Unauthorized'); });
  const rej = { get: boom, list: boom, roles: boom, apps: boom, resolvedTools: boom, personalMcpList: boom, orgMcpList: boom, deployed: boom, mine: boom, listCustom: boom, providers: boom, status: boom, credits: boom, allocation: boom, summary: boom, update: boom, prefs: boom, setPrefs: boom, ticket: boom };
  return {
    me: boom,
    org: rej, billing: rej, usage: rej, profile: rej, connections: rej, tasks: rej,
    skills: rej, agents: rej, layouts: rej, drips: rej, apps: rej, orgModels: rej,
    catalog: rej, support: rej,
  };
}

const deps = { apiUrl: 'https://api.glyphh.ai', isAuthenticated: async () => true, signOut: async () => {} };

describe('buildContract — AUTHED shapes', () => {
  const c = buildContract(authedClient(), deps);

  it('dashboardData composes the full DashboardData shape', async () => {
    const d = await c.dashboardData();
    expect(d).toMatchObject({ name: 'Ada', plan: 'Glyphh Pro', orgCredits: true, credits: 5, allowance: 10000, spendCredits: 7, requests: 3, appsCount: 0 });
    expect(d.me).toMatchObject({ roleName: 'Main', uncapped: true });
  });
  it('getAccountInfo → identity ⊕ org ⊕ billing', async () => {
    expect(await c.getAccountInfo()).toMatchObject({ email: 'a@b.co', orgName: 'Acme', tier: 'pro', billingStatus: 'active' });
  });
  it('connectionsList → adapted rows', async () => {
    expect((await c.connectionsList()).connections[0]).toMatchObject({ id: 'gmail', agentTools: 1, agentAvailable: 2 });
  });
  it('connectionToolsList(id) → per-tool hidden flags', async () => {
    expect((await c.connectionToolsList('gmail')).tools).toEqual([
      { name: 'send', description: '', hidden: false },
      { name: 'find', description: '', hidden: true },
    ]);
  });
  it('loopsList / loopRoles envelopes', async () => {
    expect(await c.loopsList()).toMatchObject({ ok: true, canBuild: true });
    expect(await c.loopRoles('web')).toEqual({ ok: true, loop: 'web', roles: [{ name: 'planner', modelId: 'm', choices: [] }] });
  });
  it('layoutsList derives a splits array from cells', async () => {
    const [l] = await c.layoutsList();
    expect(Array.isArray(l.splits)).toBe(true);
    expect(l.splits[0]).toMatchObject({ panelId: 'p' });
  });
  it('panelAppsList → SavedPanelApp rows', async () => {
    expect((await c.panelAppsList())[0]).toMatchObject({ id: 'crm', slug: 'crm', isBrowser: true, mcp: null });
  });
  it('library envelopes (skills/agents/models)', async () => {
    expect(await c.librarySkillsList()).toEqual({ ok: true, data: [{ id: 's' }] });
    expect(await c.libraryAgentsList()).toEqual({ ok: true, data: [{ id: 'a' }] });
    expect(await c.orgModelsList()).toEqual({ ok: true, data: [{ id: 'm1' }] });
    expect(await c.orgProvidersList()).toEqual({ ok: true, data: [{ slug: 'anthropic' }] });
  });
  it('getPreference reads the server map, falls back to the default for absent keys', async () => {
    expect(await c.getPreference('glyphhMode', 'ask')).toBe('ask'); // absent → default
    expect(await c.getPreference('missing')).toBe(null);            // absent, no default
    expect(await c.getTheme()).toBe('nord');                        // present in the server map
  });
});

describe('buildContract — LOGGED-OUT / offline empty shapes (401 → correct empty)', () => {
  const c = buildContract(rejectingClient(), deps);

  it('dashboardData → emptyDashboardData (front door still renders)', async () => {
    expect(await c.dashboardData()).toEqual(EMPTY.dashboardData());
  });
  it('getAccountInfo → null', async () => {
    expect(await c.getAccountInfo()).toBe(null);
  });
  it('connectionsList → {ok:false, connections:[]}', async () => {
    const out = await c.connectionsList();
    expect(out.ok).toBe(false);
    expect(out.connections).toEqual([]);
  });
  it('connectionToolsList → {ok:false, tools:[]}', async () => {
    expect(await c.connectionToolsList('x')).toMatchObject({ ok: false, tools: [] });
  });
  it('loopsList → {ok:false, loops:[], canBuild:false}', async () => {
    expect(await c.loopsList()).toEqual({ ok: false, loops: [], canBuild: false });
  });
  it('loopRoles → {ok:false, loop, roles:[]}', async () => {
    const out = await c.loopRoles('web');
    expect(out).toMatchObject({ ok: false, loop: 'web', roles: [] });
  });
  it('mcpConnectionsList → {ok:false, connections:[]}', async () => {
    // personal/org lists are inner-caught to [] so the OUTER never rejects → ok:true,[].
    expect(await c.mcpConnectionsList()).toMatchObject({ ok: true, connections: [] });
  });
  it('list-shaped reads → [] (never undefined)', async () => {
    expect(await c.layoutsList()).toEqual([]);
    expect(await c.dripsList()).toEqual([]);
    expect(await c.panelAppsList()).toEqual([]);
    expect(await c.recentsList()).toEqual([]);
  });
  it('library envelopes → {ok:false, error}', async () => {
    expect(await c.librarySkillsList()).toMatchObject({ ok: false });
    expect(await c.orgModelsList()).toMatchObject({ ok: false });
  });
  it('connectorsGetApps → {apps:[], hasMore:false}', async () => {
    expect(await c.connectorsGetApps('x')).toEqual({ apps: [], hasMore: false });
  });
  it('glyphhSessionsLoad → {chats:[], currentId:""}', async () => {
    expect(await c.glyphhSessionsLoad()).toEqual({ chats: [], currentId: '' });
  });
});

describe('boot render path — the Chat front door + rail + landing fire the contract with no throw', () => {
  // The exact methods the boot sequence calls automatically (home.ts top-level,
  // initHelp/initCode, loadRecentApps, loadDashboard, model-picker). Each must resolve
  // to a valid shape — logged-out AND authed — or the front door blanks.
  const BOOT_LIST_METHODS = ['panelAppsList', 'layoutsList', 'recentsList'];

  for (const [label, makeClient] of [['authed', authedClient], ['logged-out', rejectingClient]]) {
    it(`${label}: dashboardData resolves a full object (composer + starters render)`, async () => {
      const c = buildContract(makeClient(), deps);
      const d = await c.dashboardData();
      // Truthy object with the shape help/dashboard.ts reads — never null/undefined.
      expect(d).toBeTruthy();
      for (const k of ['name', 'plan', 'orgCredits', 'me', 'credits', 'allowance', 'spendCredits', 'requests', 'appsCount']) {
        expect(d).toHaveProperty(k);
      }
    });

    it(`${label}: rail lists resolve arrays (l.splits.map / recents never throw)`, async () => {
      const c = buildContract(makeClient(), deps);
      const [apps, layouts, recents] = await Promise.all(BOOT_LIST_METHODS.map((m) => c[m]()));
      expect(Array.isArray(apps)).toBe(true);
      expect(Array.isArray(layouts)).toBe(true);
      expect(Array.isArray(recents)).toBe(true);
      // The rail reads l.splits.map on each layout — every row must carry a splits array.
      for (const l of layouts) expect(Array.isArray(l.splits)).toBe(true);
    });

    it(`${label}: loopRoles + prefs the composer reads resolve valid shapes`, async () => {
      const c = buildContract(makeClient(), deps);
      const roles = await c.loopRoles('default');
      expect(Array.isArray(roles.roles)).toBe(true);           // model-picker reads r.roles
      expect(await c.getPreference('glyphhMode', 'ask')).toBe('ask'); // default, not undefined
      const sess = await c.glyphhSessionsLoad();
      expect(sess).toHaveProperty('chats');                    // destructured at boot
      expect(sess).toHaveProperty('currentId');
    });
  }
});
