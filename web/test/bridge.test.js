/**
 * bridge.test.js — verifies the web bridge wires each KNOWN cloud read to the
 * correct SDK domain method AND pipes its result through the right shape adapter.
 *
 * glyphh-web.js is the SDK-touching singleton (it imports @glyphh/sdk); we mock
 * it so `window.glyphh` assembles over a FAKE client with no server and no browser.
 * The adapters themselves are unit-tested separately (glyphh-core.test.js); here we
 * assert the plumbing — method name, arguments, and that the legacy shape comes out.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

// A fake SDK client whose domain methods are spies returning canned SDK shapes.
const fake = {
  me: vi.fn(async () => ({ email: 'a@b.co', name: 'Ada Lovelace', role: 'org_admin', tier: 'free' })),
  org: { get: vi.fn(async () => ({ name: 'Acme' })) },
  billing: { status: vi.fn(async () => ({ tier: 'pro', billingStatus: 'active' })) },
  profile: {
    get: vi.fn(async () => ({ timezone: 'America/New_York' })),
    update: vi.fn(async () => ({})),
  },
  connections: {
    // connectionsList calls this FIRST for its org-sync side-effect
    // (web-contract.js) — without it the double throws and the whole
    // read falls back to empty, which is what broke this suite.
    pipedreamList: vi.fn(async () => []),
    resolvedTools: vi.fn(async () => ({
      connections: [{ slug: 'gmail', name: 'Gmail', scope: 'personal', tools: [{ name: 'send' }], availableTools: [{ name: 'send' }, { name: 'find' }] }],
    })),
    apps: vi.fn(async () => ({ apps: [{ id: 'slack', name: 'Slack', icon: null }] })),
    personalMcpList: vi.fn(async () => [{ slug: 'p', name: 'P', url: 'u', enabled: true }]),
    orgMcpList: vi.fn(async () => [{ slug: 'o', name: 'O', url: 'u', enabled: true }]),
  },
  tasks: {
    list: vi.fn(async () => ({ tasks: [{ id: '1', name: 'Default', description: 'd', builtIn: true }] })),
    roles: vi.fn(async () => [{ name: 'planner', modelId: 'm', choices: [] }]),
    get: vi.fn(async () => ({ id: '1', slug: 'web' })),
  },
  skills: { list: vi.fn(async () => [{ id: 's', slug: 'sk' }]), get: vi.fn(async () => ({ id: 's' })) },
  agents: {
    list: vi.fn(async () => [{ id: 'a' }]),
    get: vi.fn(async () => ({ id: 'a' })),
    tasks: vi.fn(async () => [{ id: 't' }]),
    taskRuns: vi.fn(async () => [{ id: 'r' }]),
  },
  layouts: { list: vi.fn(async () => [{ name: 'Grid', data: { cols: 2, rows: 1 } }]) },
  drips: { list: vi.fn(async () => [{ name: 'd', data: 'confetti' }]) },
  apps: { deployed: vi.fn(async () => []), mine: vi.fn(async () => [{ slug: 'crm', name: 'CRM', url: 'https://crm' }]) },
  orgModels: { list: vi.fn(async () => [{ id: 'm1' }]), listCustom: vi.fn(async () => [{ id: 'c1' }]) },
  providers: {},
  catalog: { providers: vi.fn(async () => [{ slug: 'anthropic' }]) },
  support: { ticket: vi.fn(async () => ({ ok: true })) },
};

vi.mock('../src/glyphh-web.js', () => ({
  glyphh: () => fake,
  isAuthenticated: vi.fn(async () => true),
  signOut: vi.fn(async () => {}),
  API_URL: 'https://api.glyphh.ai',
}));

// bridge.js assigns window.glyphh on import; give it a window.
globalThis.window = globalThis.window || {};
globalThis.document = globalThis.document || { documentElement: { classList: { add() {} } } };

let glyphh;
beforeEach(async () => {
  vi.clearAllMocks();
  await import('../src/bridge.js');
  glyphh = window.glyphh;
});

describe('bridge KNOWN wiring', () => {
  it('connectionsList → connections.resolvedTools, adapted to legacy rows', async () => {
    const out = await glyphh.connectionsList();
    expect(fake.connections.resolvedTools).toHaveBeenCalled();
    expect(out.ok).toBe(true);
    expect(out.connections[0]).toMatchObject({ id: 'gmail', agentTools: 1, agentAvailable: 2 });
  });

  it('connectionToolsList(id) → resolvedTools, hidden flags per tool', async () => {
    const out = await glyphh.connectionToolsList('gmail');
    expect(out.tools).toEqual([
      { name: 'send', description: '', hidden: false },
      { name: 'find', description: '', hidden: true },
    ]);
  });

  it('connectorsGetApps → connections.apps({search})', async () => {
    const out = await glyphh.connectorsGetApps('sla');
    expect(fake.connections.apps).toHaveBeenCalledWith({ search: 'sla' });
    expect(out).toEqual({ apps: [{ id: 'slack', name: 'Slack', description: '', icon: undefined }], hasMore: false });
  });

  it('mcpConnectionsList → org + personal MCP lists, org first', async () => {
    const out = await glyphh.mcpConnectionsList();
    expect(fake.connections.orgMcpList).toHaveBeenCalled();
    expect(fake.connections.personalMcpList).toHaveBeenCalled();
    expect(out.connections.map((c) => c.kind)).toEqual(['org', 'personal']);
  });

  it('loopsList → tasks.list, canBuild true', async () => {
    const out = await glyphh.loopsList();
    expect(fake.tasks.list).toHaveBeenCalled();
    expect(out).toMatchObject({ ok: true, canBuild: true });
  });

  it('loopRoles(loop) → tasks.roles(loop, selections, context), envelope', async () => {
    const out = await glyphh.loopRoles('web');
    // Second arg: the web's stored per-loop model picks (localStorage; empty
    // here) — loopRoleSet writes them, loopRoles rides them. Third: the
    // execution context opts — empty unless the caller passes "cloud".
    expect(fake.tasks.roles).toHaveBeenCalledWith('web', {}, {});
    expect(out).toEqual({ ok: true, loop: 'web', roles: [{ name: 'planner', modelId: 'm', choices: [] }] });

    await glyphh.loopRoles('web', false, 'cloud');
    expect(fake.tasks.roles).toHaveBeenCalledWith('web', {}, { context: 'cloud' });
  });

  it('librarySkillsList → skills.list wrapped in {ok,data}', async () => {
    const out = await glyphh.librarySkillsList();
    expect(fake.skills.list).toHaveBeenCalled();
    expect(out).toEqual({ ok: true, data: [{ id: 's', slug: 'sk' }] });
  });

  it('libraryAgentsList / libraryAgentTasks → agents.* wrapped', async () => {
    expect(await glyphh.libraryAgentsList()).toEqual({ ok: true, data: [{ id: 'a' }] });
    const tasks = await glyphh.libraryAgentTasks('a');
    expect(fake.agents.tasks).toHaveBeenCalledWith('a');
    expect(tasks).toEqual({ ok: true, data: [{ id: 't' }] });
  });

  it('layoutsList → layouts.list, desktop layout shape with a splits array', async () => {
    const out = await glyphh.layoutsList();
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ name: 'Grid', cols: 2, rows: 1 });
    // splits must always be an array so the rail's `l.splits.map` never throws.
    expect(Array.isArray(out[0].splits)).toBe(true);
  });

  it('dripsList → drips.list, {name,recipe}', async () => {
    expect(await glyphh.dripsList()).toEqual([{ name: 'd', recipe: 'confetti' }]);
  });

  it('panelAppsList → apps.mine, SavedPanelApp defaults', async () => {
    const out = await glyphh.panelAppsList();
    expect(fake.apps.mine).toHaveBeenCalled();
    expect(out[0]).toMatchObject({ id: 'crm', slug: 'crm', isBrowser: true, mcp: null });
  });

  it('orgModelsList / orgCustomModelsList / orgProvidersList → {ok,data}', async () => {
    expect(await glyphh.orgModelsList()).toEqual({ ok: true, data: [{ id: 'm1' }] });
    expect(await glyphh.orgCustomModelsList()).toEqual({ ok: true, data: [{ id: 'c1' }] });
    const p = await glyphh.orgProvidersList();
    expect(fake.catalog.providers).toHaveBeenCalled();
    expect(p).toEqual({ ok: true, data: [{ slug: 'anthropic' }] });
  });

  it('getAccountInfo → me ⊕ org ⊕ billing.status', async () => {
    const out = await glyphh.getAccountInfo();
    expect(out).toMatchObject({ email: 'a@b.co', orgName: 'Acme', tier: 'pro', billingStatus: 'active' });
  });

  it('submitSupportTicket → support.ticket, {ok:true}', async () => {
    const out = await glyphh.submitSupportTicket({ subject: 's', description: 'd' });
    expect(fake.support.ticket).toHaveBeenCalledWith({ subject: 's', description: 'd' });
    expect(out).toEqual({ ok: true });
  });

  it('an unwired cloud method is a safe async no-op (returns undefined)', async () => {
    expect(await glyphh.someUnwiredCloudRead()).toBeUndefined();
  });
});
