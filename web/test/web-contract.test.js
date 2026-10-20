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
import { buildContract, buildArtifactsWeb, artifactCookieOf, ARTIFACT_COOKIE_PATH, NEEDS_DESKTOP, EMPTY, toLoopModels, trimWsState } from '../src/web-contract.js';
import { mergeServerFirst } from '../../src/shared/member-library';
import { seededLibrary } from './helpers/member-library.js';

/** A fake SDK client whose domain methods resolve canned SDK shapes (the AUTHED path). */
function authedClient() {
  return {
    memberLibrary: seededLibrary(),
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
      resolvedTools: vi.fn(async () => ({ connections: [{ slug: 'gmail', name: 'Gmail', scope: 'personal', tools: [{ name: 'send' }], availableTools: [{ name: 'send' }, { name: 'find' }] }] })),
      apps: vi.fn(async () => ({ apps: [{ id: 'slack', name: 'Slack', icon: null }] })),
      personalMcpList: vi.fn(async () => [{ slug: 'p', name: 'P', url: 'u', enabled: true }]),
      orgMcpList: vi.fn(async () => [{ slug: 'o', name: 'O', url: 'u', enabled: true }]),
    },
    loops: {
      list: vi.fn(async () => ({ loops: [{ id: '1', name: 'Default', description: 'd', builtIn: true }] })),
      roles: vi.fn(async () => [{ name: 'planner', modelId: 'm', choices: [] }]),
      get: vi.fn(async () => ({ id: '1' })),
    },
    skills: { list: vi.fn(async () => [{ id: 's' }]), get: vi.fn(async () => ({ id: 's' })) },
    agents: { list: vi.fn(async () => [{ id: 'a' }]), get: vi.fn(async () => ({ id: 'a' })), tasks: vi.fn(async () => [{ id: 't' }]), taskRuns: vi.fn(async () => [{ id: 'r' }]) },
    layouts: { list: vi.fn(async () => [{ name: 'Grid', data: { cols: 2, rows: 1, cells: [{ panelId: 'p', col: 0, row: 0, colSpan: 1, rowSpan: 1 }] } }]) },
    appInstances: { list: vi.fn(async () => []) },
    orgModels: { list: vi.fn(async () => [{ id: 'm1' }]), listCustom: vi.fn(async () => [{ id: 'c1' }]) },
    catalog: { providers: vi.fn(async () => [{ slug: 'anthropic' }]) },
    support: { ticket: vi.fn(async () => ({ ok: true })) },
  };
}

/** A fake whose EVERY method rejects — the anonymous-visitor / offline path (401s). */
function rejectingClient() {
  const boom = vi.fn(async () => { throw new Error('401 Unauthorized'); });
  const rej = { get: boom, list: boom, roles: boom, apps: boom, resolvedTools: boom, personalMcpList: boom, orgMcpList: boom, listCustom: boom, providers: boom, status: boom, credits: boom, allocation: boom, summary: boom, update: boom, prefs: boom, setPrefs: boom, ticket: boom };
  return {
    me: boom,
    org: rej, billing: rej, usage: rej, profile: rej, connections: rej, loops: rej,
    skills: rej, agents: rej, layouts: rej, apps: rej, appInstances: rej, orgModels: rej,
    catalog: rej, support: rej,
    memberLibrary: { list: boom, get: boom, put: boom, remove: boom, files: boom },
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
  it("there are no default apps to ask for: the contract has no appsDefaults (his order, 2026-10-09)", () => {
    const c = buildContract(authedClient(), deps);
    expect(c.appsDefaults).toBeUndefined();
  });
  it("the dead /api/apps lane has no contract methods — client.apps / client.hosting / client.appServers left the SDK (2026-10-06)", () => {
    const client = authedClient();
    delete client.apps;
    const c = buildContract(client, deps);
    for (const name of [
      'appSecretsList', 'appSecretsSet', 'appSecretsDelete', 'appBuildDeploy',
      'appsSchedulesList', 'appsScheduleCreate', 'appsScheduleUpdate', 'appsScheduleDelete', 'appsScheduleRun',
      'appReleases', 'appReleaseNotes', 'appReleasePromote',
      'appCollaborators', 'appCollaboratorSet', 'appCollaboratorRemove', 'appReleaseOrgReview', 'appOrgPendingReleases',
      'appTraffic', 'appClone', 'appSourceHistory', 'appSourceRestore', 'appVersionSet',
      'hostingStatus', 'hostingDeploy', 'hostingDestroy',
      'appServersList', 'appServerDeploy', 'appServerDeployments', 'appServerDestroy',
      'appDomainsList', 'appDomainAdd', 'appDomainRemove',
    ]) expect(c[name], name).toBeUndefined();
  });
  it('panelAppsList → SavedPanelApp rows', async () => {
    expect((await c.panelAppsList())[0]).toMatchObject({ id: 'crm', slug: 'crm', isBrowser: true, mcp: null });
  });
  it('library envelopes (skills/agents/models)', async () => {
    expect(await c.librarySkillsList()).toEqual({ ok: true, data: [{ id: 's' }] });
    // Agents are the MEMBER LIBRARY's now (database-as-truth): the record rides whole.
    expect(await c.libraryAgentsList()).toMatchObject({ ok: true, data: [{ id: 'a', slug: 'a', name: 'Ada' }] });
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

describe('the composer model list + plan gates on web (main/loop-models.ts parity)', () => {
  const rows = [
    { id: 'm1', name: 'gpt-5', providerSlug: 'openai', modality: 'chat', reasoning: true, freePlan: false },
    { id: 'm2', name: 'auto', providerSlug: 'glyphh', modality: 'chat', autoRouter: true },
    { id: 'm3', name: 'claude-sonnet-4-5', providerSlug: 'anthropic', modality: 'chat' },
    { id: 'm4', name: 'claude-sonnet-4-5', providerSlug: 'anthropic', modality: 'chat' },   // duplicate name
    { id: 'm5', name: 'gpt-image-1', providerSlug: 'openai', modality: 'image' },
  ];
  it('toLoopModels: chat only, Auto named, deduped, provider-then-name order, flags kept', () => {
    expect(toLoopModels(rows)).toEqual([
      { id: 'claude-sonnet-4-5', name: 'claude-sonnet-4-5', providerSlug: 'anthropic', modality: 'chat' },
      { id: 'auto', name: 'Auto', providerSlug: 'auto', modality: 'chat' },
      { id: 'gpt-5', name: 'gpt-5', providerSlug: 'openai', reasoning: true, freePlan: false, modality: 'chat' },
    ]);
    expect(toLoopModels(null)).toEqual([]);
  });
  // The utility-model rule (his order, 2026-10-05) reads the console's flag and
  // the prices off the composer's own rows — carried through, never re-fetched.
  it('toLoopModels carries utility + prices for the utility-model rule', () => {
    const priced = [
      { id: 'm1', name: 'claude-haiku-4-5', providerSlug: 'anthropic', modality: 'chat', inputUsdPerMTok: 0.8, outputUsdPerMTok: 4, utility: true },
      { id: 'm2', name: 'claude-sonnet-4-5', providerSlug: 'anthropic', modality: 'chat', inputUsdPerMTok: 3, outputUsdPerMTok: 15 },
    ];
    expect(toLoopModels(priced)).toEqual([
      { id: 'claude-haiku-4-5', name: 'claude-haiku-4-5', providerSlug: 'anthropic', modality: 'chat', utility: true, inputUsdPerMTok: 0.8, outputUsdPerMTok: 4 },
      { id: 'claude-sonnet-4-5', name: 'claude-sonnet-4-5', providerSlug: 'anthropic', modality: 'chat', inputUsdPerMTok: 3, outputUsdPerMTok: 15 },
    ]);
  });
  it('loopModels answers the preload shape, cached 60 s, force bypasses', async () => {
    const available = vi.fn(async () => rows);
    const c = buildContract({ ...authedClient(), models: { available } }, deps);
    const a = await c.loopModels('glyphh', true);
    expect(a.ok).toBe(true);
    expect(a.source).toBe('gateway');
    expect(a.baseUrl).toBeNull();
    expect(a.models.map((m) => m.name)).toEqual(['claude-sonnet-4-5', 'Auto', 'gpt-5']);
    await c.loopModels('glyphh');
    expect(available).toHaveBeenCalledTimes(1);
    await c.loopModels('glyphh', true);
    expect(available).toHaveBeenCalledTimes(2);
  });
  it('loopModels offline → the honest none shape (never throws)', async () => {
    const c = buildContract({ ...authedClient(), models: { available: vi.fn(async () => { throw new Error('401'); }) } }, deps);
    const r = await c.loopModels('glyphh', true);
    expect(r).toMatchObject({ ok: false, source: 'none', baseUrl: null, models: [] });
  });
  it('planGates is the SDK read; onModelsChanged is an explicit no-op subscription', async () => {
    const gates = { gatewayAllowed: true, trialEndsAt: null, governance: false, sso: false, rpm: 60, defaultModel: 'auto' };
    const c = buildContract({ ...authedClient(), plans: { gates: vi.fn(async () => gates) } }, deps);
    expect(await c.planGates()).toEqual(gates);
    const off = c.onModelsChanged(() => {});
    expect(typeof off).toBe('function');
  });
});

// ── The 2026-10-04 sweep: names the renderer reads that the contract now serves ──
describe('the sweep shims (2026-10-04)', () => {
  const sweepClient = () => ({
    ...authedClient(),
    connections: {
      ...authedClient().connections,
      personalMcpCreate: vi.fn(async (input) => ({ ok: true, connection: { slug: input.slug, name: input.name } })),
      personalMcpUpdate: vi.fn(async (slug, patch) => ({ ok: true, connection: { slug, ...patch } })),
      personalMcpRemove: vi.fn(async () => ({ ok: true })),
      mcpTools: vi.fn(async (slug) => { if (slug === 'org-srv') return [{ name: 'search', description: 'Search' }]; const e = new Error('404'); e.status = 404; throw e; }),
      resolvedTools: vi.fn(async () => ({ connections: [{ slug: 'my-srv', tools: [{ name: 'a' }], availableTools: [{ name: 'a', description: 'A' }, { name: 'b', description: 'B' }] }] })),
      popular: vi.fn(async () => ({ apps: [{ id: 'slack', name: 'Slack', installs: 9 }] })),
      categories: vi.fn(async () => ({ categories: [{ name: 'Chat', count: 1, apps: [{ id: 'slack', name: 'Slack' }] }] })),
    },
    agents: { ...authedClient().agents, create: vi.fn(async (i) => ({ id: 'n', ...i })), update: vi.fn(async (ref, p) => ({ id: ref, ...p })), remove: vi.fn(async () => undefined) },
    releases: { list: vi.fn(async () => [{ tag: 'v1.4.8', publishedAt: null, assets: [] }]), assetUrl: vi.fn(async (tag, name) => ({ url: `https://dl/${tag}/${name}` })) },
    files: { list: vi.fn(async () => [{ id: 'f1', name: 'a.md' }]), get: vi.fn(async () => ({ id: 'f1', downloadUrl: null })), delete: vi.fn(async () => undefined) },
  });
  const deps = { apiUrl: 'https://api.glyphh.ai', isAuthenticated: async () => true, signOut: async () => {} };

  it('the preload STRING properties are strings (a function was a truthy link once)', () => {
    const k = buildContract(sweepClient(), deps);
    expect(k.apiUrl).toBe('https://api.glyphh.ai');
    expect(k.serverUrl).toBe('https://api.glyphh.ai');
    expect(typeof k.discordInvite).toBe('string');
    // This origin's /platform in a browser; the platform host where there is no location (node).
    expect(k.platformUrl).toMatch(/^https:\/\/(platform\.glyphh\.ai|.+\/platform)$/);
  });

  it('custom MCP writes ride the personal MCP resource in main\'s {ok,…} shapes', async () => {
    const c = sweepClient();
    const k = buildContract(c, deps);
    expect(await k.mcpConnectionsCreate({ name: 'My Srv', url: 'https://x', headers: { a: 'b' } })).toEqual({ ok: true, connection: { slug: 'my-srv', name: 'My Srv' }, toolCount: 0 });
    expect(c.connections.personalMcpCreate).toHaveBeenCalledWith({ slug: 'my-srv', name: 'My Srv', url: 'https://x', headers: { a: 'b' } });
    expect(await k.mcpConnectionsCreate({ name: '', url: 'x' })).toMatchObject({ ok: false });
    expect(await k.mcpConnectionsUpdate('my-srv', { enabled: false, hiddenTools: ['b'], url: ' ' })).toEqual({ ok: true, connection: { slug: 'my-srv', enabled: false, hiddenTools: ['b'] } });
    expect(await k.mcpConnectionsDelete('my-srv')).toEqual({ ok: true });
    expect(await k.mcpConnectionsInstall('x')).toMatchObject({ ok: false });
    // Tools: the org probe, else the member's resolved set (hidden = not granted).
    expect(await k.mcpConnectionsTools('org-srv')).toEqual({ ok: true, tools: [{ name: 'search', description: 'Search', hidden: false }] });
    expect(await k.mcpConnectionsTools('my-srv')).toEqual({ ok: true, tools: [{ name: 'a', description: 'A', hidden: false }, { name: 'b', description: 'B', hidden: true }] });
    expect(await k.mcpConnectionsTools('nope')).toMatchObject({ ok: false, tools: [] });
  });

  it('connector discovery answers main/connectors.ts rows; agents + releases + files in their IPC shapes', async () => {
    const k = buildContract(sweepClient(), deps);
    expect(await k.connectorsGetPopular()).toEqual([{ id: 'slack', name: 'Slack', description: '', icon: undefined, categories: [], installs: 9 }]);
    expect(await k.connectorsGetCategories()).toEqual([{ name: 'Chat', count: 1, apps: [{ id: 'slack', name: 'Slack', description: '', icon: undefined, categories: [] }] }]);
    // Agents write THE MEMBER LIBRARY (member-library-web.js): the same row the desktop's local-agents builds.
    expect(await k.libraryAgentCreate({ name: 'Ada' })).toMatchObject({ ok: true, data: { id: 'ada', slug: 'ada', name: 'Ada', live: true } });
    expect(await k.libraryAgentUpdate('ada', { name: 'Ada 2' })).toMatchObject({ ok: true, data: { id: 'ada', name: 'Ada 2' } });
    expect(await k.libraryAgentDelete('ada')).toEqual({ ok: true, data: true });
    expect(await k.releasesList()).toEqual({ ok: true, releases: [{ tag: 'v1.4.8', publishedAt: null, assets: [] }] });
    expect(await k.releasesAssetUrl('v1.4.8', 'Glyphh.dmg')).toEqual({ ok: true, url: 'https://dl/v1.4.8/Glyphh.dmg' });
    expect(await k.filesList()).toEqual([{ id: 'f1', name: 'a.md' }]);
    expect(await k.filesPeek('f1')).toBe('');
  });

  it('logged out, every sweep shim still answers its empty shape', async () => {
    const k = buildContract(rejectingClient(), deps);
    expect(await k.mcpConnectionsCreate({ name: 'a', url: 'b' })).toMatchObject({ ok: false });
    expect(await k.mcpConnectionsTools('a')).toMatchObject({ ok: false, tools: [] });
    expect(await k.connectorsGetPopular()).toEqual([]);
    expect(await k.connectorsGetCategories()).toEqual([]);
    expect(await k.libraryAgentCreate({})).toMatchObject({ ok: false });
    expect(await k.releasesList()).toMatchObject({ ok: false });
    expect(await k.filesList()).toEqual([]);
    expect(await k.wsStateLoad()).toEqual({});
  });

  it('the workbench UI state rides the member\'s prefs (workbenchUiState), trimmed to budget newest-first', async () => {
    const c = sweepClient();
    const store = { workbenchUiState: JSON.stringify({ wall: { v: '{"layout":"dev"}', at: 3 } }) };
    c.profile.prefs = vi.fn(async () => ({ ...store }));
    c.profile.setPrefs = vi.fn(async (patch) => { Object.assign(store, patch); return store; });
    const k = buildContract(c, deps);
    expect(await k.wsStateLoad()).toEqual({ wall: { v: '{"layout":"dev"}', at: 3 } });
    expect(await k.wsStateSave({ wall: { v: 'x', at: 4 }, 'wall:dev': { v: 'y', at: 5 } })).toBe(true);
    expect(JSON.parse(store.workbenchUiState)).toEqual({ wall: { v: 'x', at: 4 }, 'wall:dev': { v: 'y', at: 5 } });
    // Budget: the newest entries survive, the oldest go.
    const big = { old: { v: 'o'.repeat(20_000), at: 1 }, mid: { v: 'm'.repeat(20_000), at: 2 }, newest: { v: 'n', at: 3 } };
    expect(Object.keys(trimWsState(big, 28 * 1024)).sort()).toEqual(['mid', 'newest']);
    expect(trimWsState(null)).toEqual({});
  });
});

// ── THE MEMBER LIBRARY IS DATABASE-AS-TRUTH (his rule, 2026-10-04): the lists read the
// server FIRST (client.memberLibrary), the rows an attached desktop still holds fill in
// behind them (the server wins a tie), and a write goes to the server at this client's
// clock — the desktop pulls it on its next sync. Nothing is refused any more.
describe('buildContract — workspaces and app tabs read the server first, write the server', () => {
  const DESK_LAYOUT = { name: 'Research', cols: 2, rows: 1, colWidths: [0.5, 0.5], rowHeights: [1], target: 'glyphh', loop: 'glyphh', modelSelections: { default: 'm' }, sessionMode: 'new', folder: '/Users/me/code', space: 'code', splits: [{ panelId: 'tool:coding', col: 0, row: 0, colSpan: 1, rowSpan: 1 }] };
  const DESK_TAB = { id: 'crm', orgId: '', createdBy: '', name: 'CRM (desktop)', slug: 'crm', system: false, url: 'https://crm.local', isBrowser: true, execPath: null, appArchetype: 'web', launchConfig: { forceWeb: true }, access: 'members', owned: true, latestVersion: null, version: '', secretNames: [], requiredConnections: [], connectionIds: [], iconUrl: null, listing: null, mcp: null, commands: {}, createdAt: '', updatedAt: '' };
  const STUDIO_TAB = { ...DESK_TAB, id: 'mail', slug: 'mail', name: 'Mail' };
  /** An attach client with two machines; `answers[machineId][method]` is a reply or an Error. */
  const attachFor = (answers) => ({
    status: vi.fn(async () => ({ attached: true, machines: [{ id: 'm1', name: 'MacBook' }, { id: 'm2', name: 'Studio' }] })),
    dispatch: vi.fn(async (method, _params, opts) => {
      const a = answers[opts?.machineId]?.[method];
      if (a instanceof Error) throw a;
      return a ?? {};
    }),
  });
  const withDesktops = (client, answers) => ({ ...client, attach: attachFor(answers) });

  it('layoutsList: the member library\'s workspace rows are the one list — a desktop\'s own layouts.list is never asked (his order, 2026-10-06)', async () => {
    const attach = attachFor({
      m1: { 'layouts.list': { layouts: [DESK_LAYOUT, { ...DESK_LAYOUT, name: 'Grid', cols: 9 }] } },
    });
    const c = buildContract({ ...authedClient(), attach }, deps);
    const rows = await c.layoutsList();
    expect(rows.map((l) => l.name)).toEqual(['Grid']);
    expect(rows[0]).toMatchObject({ cols: 2, splits: [{ panelId: 'p' }], updatedAt: 1_000 }); // the server's Grid
    expect(attach.dispatch).not.toHaveBeenCalledWith('layouts.list', expect.anything(), expect.anything());
  });

  it('layoutsList: ONE LIST, THIS SURFACE\'S ROWS — a workspace carries where it was made (his order, 2026-10-06); the web lists the web-made ones, a desktop-made one and one from before the stamp stay in the library for the desktop; an older `home: cloud` stamp changes nothing', async () => {
    const client = authedClient();
    const rows = await client.memberLibrary.list('workspace');
    client.memberLibrary.list = vi.fn(async () => [...rows,
      { ...rows[0], id: 'desk', data: { ...rows[0].data, name: 'Desk', surface: 'desktop' } },
      { ...rows[0], id: 'before', data: { ...rows[0].data, name: 'Before', surface: undefined } },
      { ...rows[0], id: 'old', data: { ...rows[0].data, name: 'Old', home: 'cloud' } }]);
    const c = buildContract(client, deps);
    expect((await c.layoutsList()).map((l) => l.name).sort()).toEqual(['Grid', 'Old']);
  });

  it('layoutsList: a 401 on the server read is an empty list, even with a desktop attached', async () => {
    const offline = buildContract(withDesktops(rejectingClient(), { m1: { 'layouts.list': { layouts: [DESK_LAYOUT] } } }), deps);
    expect(await offline.layoutsList()).toEqual([]);
    expect((await buildContract(authedClient(), deps).layoutsList()).map((l) => l.name)).toEqual(['Grid']);
  });

  it('layoutsSaveGrid / layoutsDelete write the server at this client\'s clock', async () => {
    const client = authedClient();
    const c = buildContract(client, deps);
    expect(await c.layoutsSaveGrid({ name: 'Research', cols: 1, rows: 1, colWidths: [1], rowHeights: [1], cells: [], loop: 'glyphh', sessionMode: 'keep' })).toBe(true);
    const [kind, id, input] = client.memberLibrary.put.mock.calls[0];
    expect([kind, id]).toEqual(['workspace', 'research']);
    expect(input.data).toMatchObject({ name: 'Research', version: 2, loop: 'glyphh', updatedAt: input.updatedAt });
    expect(input.data.home).toBeUndefined();   // ONE LIST (2026-10-06): no `home` split
    expect(input.data.surface).toBe('web');    // …but the row names where it was MADE (his order, 2026-10-06)
    expect(input.data.sessionMode).toBeUndefined();           // "keep" is the default — not written
    expect((await c.layoutsList()).map((l) => l.name).sort()).toEqual(['Grid', 'Research']);
    expect(await c.layoutsDelete('Research')).toBe(true);
    expect(client.memberLibrary.remove).toHaveBeenCalledWith('workspace', 'research', { updatedAt: expect.any(Number) });
    expect((await c.layoutsList()).map((l) => l.name)).toEqual(['Grid']);
    expect(await c.layoutsDelete('never-there')).toBe(true);  // 404 = already gone
    expect(await c.layoutsSaveGrid({ name: ' ' })).toEqual({ error: 'A name is required.' });
  });

  it('panelAppsList: the server\'s tabs (tabRowOf) are the one list — a machine\'s panelApps.list is never asked (his order, 2026-10-06)', async () => {
    const attach = attachFor({
      m1: { 'panelApps.list': { apps: [DESK_TAB] } },
      m2: { 'panelApps.list': { apps: [STUDIO_TAB, { ...DESK_TAB, name: 'CRM (studio)' }] } },
    });
    const c = buildContract({ ...authedClient(), attach }, deps);
    const rows = await c.panelAppsList();
    expect(rows.map((a) => a.name)).toEqual(['CRM']);
    expect(rows[0]).toMatchObject({ id: 'crm', slug: 'crm', isBrowser: true, url: 'https://crm', mcp: null, commands: {} });
    expect(attach.dispatch).not.toHaveBeenCalled();
  });

  it('panelAppsCreate / Update / Delete write the server; config vars never ride', async () => {
    const client = authedClient();
    const c = buildContract(client, deps);
    const made = await c.panelAppsCreate({ name: 'Mail', slug: 'mail', isBrowser: true, url: 'https://mail', launchConfig: { iconUrl: 'https://i', env: { TOKEN: 'secret' } } });
    expect(made).toMatchObject({ ok: true, app: { id: 'mail', slug: 'mail', url: 'https://mail', isBrowser: true } });
    const put = client.memberLibrary.put.mock.calls.find(([k, id]) => k === 'tab' && id === 'mail');
    expect(put[2].data.config).toEqual({ iconUrl: 'https://i' });            // env stripped
    expect(put[2].data.updatedAt).toBe(new Date(put[2].updatedAt).toISOString());
    expect(await c.panelAppsCreate({ name: 'Mail' })).toMatchObject({ ok: false, error: /already exists/ });
    expect(await c.panelAppsUpdate('crm', { name: 'CRM 2', isBrowser: false, execPath: '/Applications/CRM.app' })).toMatchObject({ ok: true, app: { name: 'CRM 2', isBrowser: false, execPath: '/Applications/CRM.app', appArchetype: 'native' } });
    expect(await c.panelAppsUpdate('nope', { name: 'x' })).toMatchObject({ ok: false });
    expect(await c.panelAppsDelete('crm')).toEqual({ ok: true });
    expect((await c.panelAppsList()).map((a) => a.slug)).toEqual(['mail']);
  });

  it('what still needs the machine answers so, per action', async () => {
    const c = buildContract(authedClient(), deps);
    expect(await c.taskRun('t')).toEqual({ ok: false, error: NEEDS_DESKTOP });
    expect(await c.libraryAgentTaskAdd('a', {})).toEqual({ ok: false, error: NEEDS_DESKTOP });
    expect(await c.skillReveal('glyphh:x')).toEqual({ ok: false, error: NEEDS_DESKTOP });
    expect(await c.libraryAgentTasks('a')).toEqual({ ok: true, data: [] });
  });

  it('mergeServerFirst: server rows first, relay rows only for keys the server lacks', () => {
    const key = (r) => r.k;
    expect(mergeServerFirst([{ k: 'a', from: 'srv' }, { k: 'b', from: 'srv' }], [{ k: 'b', from: 'desk' }, { k: 'c', from: 'desk' }], key))
      .toEqual([{ k: 'a', from: 'srv' }, { k: 'b', from: 'srv' }, { k: 'c', from: 'desk' }]);
    expect(mergeServerFirst([], [{ k: 'c' }], key)).toEqual([{ k: 'c' }]);
  });
});

describe('THE WEB CUT (2026-10-05) — the agent menu reaches the attached desktop', () => {
  const deps = { apiUrl: 'https://api.glyphh.ai', isAuthenticated: async () => true, signOut: async () => {} };
  const APP = { id: 'gmail', slug: 'gmail', name: 'Gmail', system: false, url: 'https://mail.google.com', execPath: null, appArchetype: 'web', iconUrl: null, iconDataUrl: 'data:image/png;base64,AAAA' };
  const NATIVE = { id: 'notes', slug: 'notes', name: 'Notes', system: false, url: null, execPath: '/Applications/Notes.app', appArchetype: 'native', iconUrl: 'https://cdn/notes.png' };
  const SYSTEM = { id: 'browser', slug: 'browser', name: 'Browser', system: true, url: null, execPath: null, appArchetype: null };
  const NAV = { id: 'nav-home', slug: 'home', name: 'Home', system: true, url: null, execPath: null, appArchetype: 'glyphh-nav', isBrowser: true };
  const GLYPHH = { id: 'slides', slug: 'slides', name: 'Slides', system: false, url: null, execPath: '/Users/c/.glyphh/apps/slides/app.json', appArchetype: 'glyphh-app', iconDataUrl: 'data:image/svg+xml;base64,BBBB' };
  const attachFor = (answers, status = { attached: true, machines: [{ id: 'm1', name: 'MacBook' }, { id: 'm2', app: 'glyphh-cli' }] }) => ({
    status: vi.fn(async () => status),
    dispatch: vi.fn(async (method, params, opts) => {
      const a = answers[opts?.machineId]?.[method];
      if (a instanceof Error) throw a;
      return typeof a === 'function' ? a(params) : (a ?? {});
    }),
  });

  it('attachStatus: the machines by id + name (the app standing in for a nameless one); none → not attached', async () => {
    const c = buildContract({ ...authedClient(), attach: attachFor({}) }, deps);
    expect(await c.attachStatus()).toEqual({ attached: true, machines: [{ id: 'm1', name: 'MacBook' }, { id: 'm2', name: 'glyphh-cli' }] });
    const none = buildContract({ ...authedClient(), attach: attachFor({}, { attached: false, machines: [] }) }, deps);
    expect(await none.attachStatus()).toEqual({ attached: false, machines: [] });
    const dead = buildContract({ ...authedClient(), attach: { status: async () => { throw new Error('offline'); } } }, deps);
    expect(await dead.attachStatus()).toEqual({ attached: false, machines: [] });
    expect(await buildContract(authedClient(), deps).attachStatus()).toEqual({ attached: false, machines: [] });
  });

  it('the relay carries no record: the contract has no desktopAppsList and no desktopPanelOpen (his order, 2026-10-06)', () => {
    const c = buildContract({ ...authedClient(), attach: attachFor({ m1: { 'panelApps.list': { apps: [APP] } } }) }, deps);
    expect(c.desktopAppsList).toBeUndefined();
    expect(c.desktopPanelOpen).toBeUndefined();
  });

});

// ── THE CLOUD SESSION'S CHIPS (his report, 2026-10-05): git + environments ──
describe('buildContract — the cloud chips\' git + environments doors', () => {
  const apiErr = (status, msg) => Object.assign(new Error(msg), { httpStatus: status });
  /** A client whose SDK predates the typed doors (no git.complete / branches,
   *  no environments): the shims must fall back to the raw http door. */
  function oldSdk() {
    const http = {
      get: vi.fn(async (p) => (p === '/api/environments' ? [{ id: 'e1', name: 'Prod', network: 'trusted', varCount: 2, createdAt: null }] : p.endsWith('/branches') ? [{ name: 'main', default: true }, { name: 'dev', default: false }] : { id: 'e1', name: 'Prod', network: 'trusted', varCount: 1, vars: [{ key: 'A', preview: 'hu•••••' }, { nope: 1 }] })),
      post: vi.fn(async (p, body) => (p === '/api/git/connect' ? { url: 'https://github.com/apps/glyphh/installations/new?state=s' } : p === '/api/git/connect/complete' ? { connected: true, login: 'chris', installationId: 'i' } : { id: 'e2', name: body.name, network: body.network, varCount: 0, vars: [] })),
      put: vi.fn(async (p, body) => ({ id: 'e1', name: body.name, network: 'full', varCount: 0, vars: [] })),
      del: vi.fn(async () => undefined),
    };
    return { http, git: { status: vi.fn(async () => ({ connected: false, login: null, pending: true })), repos: vi.fn(async () => [{ id: '1', fullName: 'glyphh-ai/api', private: true, defaultBranch: 'main' }]), disconnect: vi.fn(async () => undefined) } };
  }
  it('reads status, repos and environments to honest shapes, raw http when the SDK is old', async () => {
    const client = oldSdk();
    const c = buildContract(client, deps);
    expect(await c.cloudGitStatus()).toEqual({ connected: false, login: null, pending: true });
    expect(await c.cloudGitRepos()).toEqual([{ id: '1', fullName: 'glyphh-ai/api', private: true, defaultBranch: 'main' }]);
    expect(await c.cloudGitConnect('https://app.glyphh.ai/home')).toEqual({ url: 'https://github.com/apps/glyphh/installations/new?state=s' });
    expect(client.http.post).toHaveBeenCalledWith('/api/git/connect', { returnTo: 'https://app.glyphh.ai/home' });
    expect(await c.cloudGitComplete('n0nce')).toEqual({ connected: true, login: 'chris', pending: false });
    expect(client.http.post).toHaveBeenCalledWith('/api/git/connect/complete', { link: 'n0nce' });
    expect(await c.cloudGitBranches('glyphh-ai/api', 'main')).toEqual([{ name: 'main', default: true }, { name: 'dev', default: false }]);
    expect(client.http.get).toHaveBeenCalledWith('/api/git/repos/glyphh-ai/api/branches');
    expect(await c.cloudEnvironmentsList()).toEqual([{ id: 'e1', name: 'Prod', network: 'trusted', varCount: 2 }]);
    expect(await c.cloudEnvironmentsGet('e1')).toEqual({ id: 'e1', name: 'Prod', network: 'trusted', varCount: 1, vars: [{ key: 'A', preview: 'hu•••••' }] });
    expect(await c.cloudEnvironmentsCreate({ name: 'Stage', network: 'none', vars: 'A=1' })).toMatchObject({ id: 'e2', name: 'Stage', network: 'none', vars: [] });
    expect(await c.cloudEnvironmentsUpdate('e1', { name: 'Prod 2' })).toMatchObject({ id: 'e1', name: 'Prod 2' });
    await c.cloudEnvironmentsDelete('e1');
    expect(client.http.del).toHaveBeenCalledWith('/api/environments/e1');
    await c.cloudGitDisconnect();
    expect(client.git.disconnect).toHaveBeenCalled();
  });
  it('uses the typed doors when the SDK has them', async () => {
    const client = { http: { get: vi.fn(), post: vi.fn() }, git: { complete: vi.fn(async () => ({ connected: true, login: 'c' })), branches: vi.fn(async () => [{ name: 'main', default: true }]) }, environments: { list: vi.fn(async () => [{ id: 'e', name: 'E', network: 'full', varCount: 0 }]) } };
    const c = buildContract(client, deps);
    expect(await c.cloudGitComplete()).toEqual({ connected: true, login: 'c', pending: false });
    expect(client.git.complete).toHaveBeenCalledWith(undefined);
    expect(await c.cloudGitBranches('a/b', 'main')).toEqual([{ name: 'main', default: true }]);
    expect(await c.cloudEnvironmentsList()).toEqual([{ id: 'e', name: 'E', network: 'full', varCount: 0 }]);
    expect(client.http.get).not.toHaveBeenCalled();
  });
  it('reads resolve to empties on a miss; a branches door that is missing answers the default branch; writes throw the ApiError', async () => {
    const boom = vi.fn(async () => { throw apiErr(401, '401'); });
    const c = buildContract({ http: { get: boom, post: vi.fn(async () => { throw apiErr(403, 'other'); }), put: boom, del: boom }, git: { status: boom, repos: boom } }, deps);
    expect(await c.cloudGitStatus()).toEqual({ connected: false, login: null, pending: false });
    expect(await c.cloudGitRepos()).toEqual([]);
    expect(await c.cloudEnvironmentsList()).toEqual([]);
    expect(await c.cloudGitBranches('a/b', 'trunk')).toEqual([{ name: 'trunk', default: true }]);
    await expect(c.cloudGitComplete('x')).rejects.toMatchObject({ httpStatus: 403 });
  });
});

// ── THE ARTIFACTS PANEL's shims (his order, 2026-10-05) ──────────────────────
describe('artifacts shims — the typed resource when the SDK has it, else the raw routes; every answer an envelope', () => {
  const META = { id: 'art_1', name: 'Mascots', mime: 'text/html', sizeBytes: 10, access: 'private', ownerId: 'u1', ownerName: 'Chris', mine: true, createdAt: 'c', updatedAt: 'u', viewUrl: '/a/art_1' };
  function rawClient() {
    const calls = [];
    const http = {
      get: vi.fn(async (p) => { calls.push(['get', p]); return p.includes('/comments') ? [{ id: 'c1' }] : p.includes('?scope=') ? [META] : META; }),
      post: vi.fn(async (p, b) => { calls.push(['post', p, b]); return p.endsWith('/share') ? { access: b.access, shareUrl: b.access === 'public' ? 'https://app/a/art_1?t=x' : null } : { id: 'c2', ...b }; }),
      put: vi.fn(async (p, b) => { calls.push(['put', p, b]); return { ...META, ...b }; }),
      patch: vi.fn(async (p, b) => { calls.push(['patch', p, b]); return { id: 'c1', ...b }; }),
      del: vi.fn(async (p) => { calls.push(['del', p]); return {}; }),
    };
    return { http, calls, token: vi.fn(async () => 'tok 1') };
  }
  it('lists by scope (an unknown scope is all), gets, updates only name/access, deletes, shares', async () => {
    const c = rawClient();
    const a = buildArtifactsWeb(c, { document: null });
    expect(await a.artifactsList('mine')).toEqual({ ok: true, data: [META] });
    expect(await a.artifactsList('wat')).toEqual({ ok: true, data: [META] });
    expect(c.calls[0]).toEqual(['get', '/api/artifacts?scope=mine']);
    expect(c.calls[1]).toEqual(['get', '/api/artifacts?scope=all']);
    expect(await a.artifactsGet('art 1')).toEqual({ ok: true, data: META });
    expect(c.calls[2]).toEqual(['get', '/api/artifacts/art%201']);
    expect((await a.artifactsUpdate('art_1', { name: 'N', access: 'org', mine: false, ownerId: 'x' })).data).toMatchObject({ name: 'N', access: 'org', ownerId: 'u1' });
    expect(c.calls[3]).toEqual(['put', '/api/artifacts/art_1', { name: 'N', access: 'org' }]);
    expect(await a.artifactsDelete('art_1')).toEqual({ ok: true, data: {} });
    expect(c.calls[4]).toEqual(['del', '/api/artifacts/art_1']);
    expect(await a.artifactsShare('art_1', 'public')).toEqual({ ok: true, data: { access: 'public', shareUrl: 'https://app/a/art_1?t=x' } });
    expect(c.calls[5]).toEqual(['post', '/api/artifacts/art_1/share', { access: 'public' }]);
  });
  it('comments: list, add (region + parent only when given), resolve, delete', async () => {
    const c = rawClient();
    const a = buildArtifactsWeb(c, { document: null });
    expect(await a.artifactsCommentsList('art_1')).toEqual({ ok: true, data: [{ id: 'c1' }] });
    expect(await a.artifactsCommentAdd('art_1', { text: 'hi', region: { x: 0, y: 0, w: 0.5, h: 0.5 } })).toEqual({ ok: true, data: { id: 'c2', text: 'hi', region: { x: 0, y: 0, w: 0.5, h: 0.5 } } });
    expect(c.calls[1]).toEqual(['post', '/api/artifacts/art_1/comments', { text: 'hi', region: { x: 0, y: 0, w: 0.5, h: 0.5 } }]);
    await a.artifactsCommentAdd('art_1', { text: 'reply', parentId: 'c1' });
    expect(c.calls[2]).toEqual(['post', '/api/artifacts/art_1/comments', { text: 'reply', parentId: 'c1' }]);
    expect(await a.artifactsCommentPatch('art_1', 'c1', { resolved: true })).toEqual({ ok: true, data: { id: 'c1', resolved: true } });
    expect(c.calls[3]).toEqual(['patch', '/api/artifacts/art_1/comments/c1', { resolved: true }]);
    expect(await a.artifactsCommentDelete('art_1', 'c/1')).toEqual({ ok: true, data: {} });
    expect(c.calls[4]).toEqual(['del', '/api/artifacts/art_1/comments/c%2F1']);
  });
  it('a typed client.artifacts resource is preferred over the raw routes', async () => {
    const c = rawClient();
    c.artifacts = {
      list: vi.fn(async () => [META]), get: vi.fn(async () => META), share: vi.fn(async () => ({ access: 'org', shareUrl: null })), remove: vi.fn(async () => undefined),
      // The SDK's shape: comments are a SUB-RESOURCE, not a method (the viewer once died on `comments is not a function`).
      comments: { list: vi.fn(async () => [{ id: 'c1' }]), add: vi.fn(async (_id, b) => ({ id: 'c2', ...b })), resolve: vi.fn(async (_id, cid, resolved) => ({ id: cid, resolved })), remove: vi.fn(async () => undefined) },
    };
    const a = buildArtifactsWeb(c, { document: null });
    expect((await a.artifactsList('shared')).data).toEqual([META]);
    expect(await a.artifactsDelete('art_1')).toEqual({ ok: true, data: {} });
    expect(c.artifacts.remove).toHaveBeenCalledWith('art_1');
    expect(await a.artifactsCommentsList('art_1')).toEqual({ ok: true, data: [{ id: 'c1' }] });
    expect(c.artifacts.comments.list).toHaveBeenCalledWith('art_1');
    expect((await a.artifactsCommentAdd('art_1', { text: 'hi', parentId: 'c1' })).data).toEqual({ id: 'c2', text: 'hi', parentId: 'c1' });
    expect(await a.artifactsCommentPatch('art_1', 'c1', { resolved: true })).toEqual({ ok: true, data: { id: 'c1', resolved: true } });
    expect(c.artifacts.comments.resolve).toHaveBeenCalledWith('art_1', 'c1', true);
    expect(await a.artifactsCommentDelete('art_1', 'c1')).toEqual({ ok: true, data: {} });
    expect(c.artifacts.comments.remove).toHaveBeenCalledWith('art_1', 'c1');
    expect(c.calls.filter(([m, p]) => p.includes('/comments') || m === 'del')).toEqual([]);
    expect(c.artifacts.list).toHaveBeenCalledWith('shared');
    expect((await a.artifactsShare('art_1', 'org')).data).toEqual({ access: 'org', shareUrl: null });
    expect(c.http.get).not.toHaveBeenCalled();
  });
  it('a rejecting client answers { ok:false, error } — never a throw, never undefined', async () => {
    const boom = vi.fn(async () => { throw new Error('401 Unauthorized'); });
    const a = buildArtifactsWeb({ http: { get: boom, post: boom, put: boom, patch: boom, del: boom }, token: boom }, { document: null });
    for (const r of await Promise.all([a.artifactsList('all'), a.artifactsGet('x'), a.artifactsUpdate('x', {}), a.artifactsDelete('x'), a.artifactsShare('x', 'org'), a.artifactsCommentsList('x'), a.artifactsCommentAdd('x', { text: 't' }), a.artifactsCommentPatch('x', 'c', { resolved: false }), a.artifactsCommentDelete('x', 'c')])) {
      expect(r).toEqual({ ok: false, error: '401 Unauthorized' });
    }
    expect(await a.artifactsViewerPrepare()).toBe(false);
  });
  it('the viewer prepare parks the session as a cookie scoped to /a only (the app-host pattern)', async () => {
    const doc = { cookie: '' };
    const a = buildArtifactsWeb(rawClient(), { document: doc, secure: true });
    expect(await a.artifactsViewerPrepare()).toBe(true);
    expect(doc.cookie).toBe('glyphh_session=tok%201; path=/a; SameSite=Strict; Secure');
    expect(ARTIFACT_COOKIE_PATH).toBe('/a');
    expect(artifactCookieOf('t', false)).toBe('glyphh_session=t; path=/a; SameSite=Strict');
    const none = buildArtifactsWeb({ http: {}, token: async () => '' }, { document: doc });
    expect(await none.artifactsViewerPrepare()).toBe(false);
  });
});
