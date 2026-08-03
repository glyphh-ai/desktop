/**
 * web-contract.js — the renderer↔SDK CONTRACT LAYER for the web target.
 *
 * The renderer (shared with desktop) consumes `window.glyphh.*` — the IPC contract
 * whose canonical shape is src/renderer/preload.ts. On desktop those methods are
 * Electron IPC into the main process; on web THIS module implements the SAME contract
 * over @glyphh/client, returning the EXACT shapes the renderer reads. It is the single,
 * coherent place the contract is honoured for web — the systematic replacement for the
 * ad-hoc per-method try/catch shapes that had accumulated in bridge.js.
 *
 * Three rules keep this whack-a-mole-proof:
 *   1. Every method returns its CONTRACT shape — parsed, adapted, complete — never
 *      `undefined`. Adaptation is a NAMED PURE adapter from glyphh-core.js (tested with
 *      plain objects, no SDK, no DOM); this file is only the plumbing.
 *   2. Error/logged-out handling is UNIFORM, not per-method: a cloud read that throws
 *      (401 for an anonymous visitor, offline) resolves to the CORRECT EMPTY shape of
 *      its contract type — defined ONCE in EMPTY below — so the renderer never reads a
 *      wrong/undefined field. The scattered inline `catch { return {ok:false,…} }` that
 *      each KNOWN entry used to carry is gone.
 *   3. A cloud method with NO SDK backing yet is an EXPLICIT stub returning its empty
 *      contract shape (listed in EMPTY / stubbed below) — a visible, enumerable gap, not
 *      a silent `async () => undefined` fallback that hides it.
 *
 * bridge.js consumes buildContract() and only owns boot/gate/phone/error wiring.
 */
import {
  libEnvelope, libError,
  toLegacyConnections, toLegacyConnectionTools, toLegacyConnectorApps,
  toLegacyMcpConnections, toLegacyLoops, toLegacyLoopRoles,
  toLegacyLayouts, toLegacyDrips, toLegacyPanelApps, toAccountInfo,
  toDashboardData, emptyDashboardData,
} from './glyphh-core.js';

/**
 * The canonical EMPTY shape per contract type — the value a cloud read resolves to
 * when it throws (logged-out 401 / offline) so the renderer always reads a valid,
 * fully-typed object. Keyed by the shape family, referenced by name below so a given
 * empty shape is defined exactly once. Each is a FACTORY (returns a fresh object) so a
 * caller can never mutate a shared instance.
 */
export const EMPTY = {
  /** `{ ok:false, error, <coll>:[] }` — a list envelope whose read fields survive a miss. */
  connections: (error) => ({ ok: false, error, connections: [] }),
  tools: (error) => ({ ok: false, error, tools: [] }),
  loops: () => ({ ok: false, loops: [], canBuild: false }),
  loopRoles: (loop, error) => ({ ok: false, loop, roles: [], error }),
  connectorApps: () => ({ apps: [], hasMore: false }),
  mcpConnections: (error) => ({ ok: false, error, connections: [] }),
  list: () => [],
  sessions: () => ({ chats: [], currentId: '' }),
  accountInfo: () => null,
  dashboardData: emptyDashboardData,
};

/**
 * Assemble the web contract: the map of `window.glyphh.*` method → implementation.
 * Every entry honours preload.ts's return type for the same-named method.
 *
 * @param {import('@glyphh/client').Client} client  the SDK handle
 * @param {{ apiUrl:string, isAuthenticated:()=>Promise<boolean>, signOut:()=>Promise<void> }} deps
 * @returns {Record<string, Function>} the contract method map (bridge.js's KNOWN)
 */
export function buildContract(client, deps) {
  const { apiUrl, isAuthenticated, signOut } = deps;

  /** Run an SDK read → adapt; on ANY throw resolve to the named empty shape. The single
   *  uniform error path (replaces the per-method inline catches). `empty` is a factory. */
  const read = (thunk, adapt, empty) => async (...args) => {
    try {
      return adapt(await thunk(...args));
    } catch (err) {
      return typeof empty === 'function' ? empty(err?.message ?? String(err), ...args) : empty;
    }
  };

  /** Library `{ ok, data }` envelope reader — a resolved SDK call is always ok; a
   *  rejection becomes `{ ok:false, error }` so the renderer's `unwrap` reports it. */
  const lib = (thunk) => async (...args) => {
    try { return libEnvelope(await thunk(...args)); }
    catch (err) { return libError(err); }
  };

  return {
    // ── Auth / account ────────────────────────────────────────────────────────
    isAuthenticated: () => isAuthenticated(),
    logout: () => signOut(),
    signOut: () => signOut(),
    // Rail + Settings account card: identity ⊕ org name ⊕ subscription. Org + billing
    // are best-effort — a member without billing visibility still gets name/email/role.
    getAccountInfo: async () => {
      try {
        const [me, org, sub] = await Promise.all([
          client.me(),
          client.org.get().catch(() => null),
          client.billing.status().catch(() => null),
        ]);
        return toAccountInfo(me, org, sub);
      } catch { return EMPTY.accountInfo(); }
    },
    // Auth-status refresh the rail/nav fire at boot; contract shape is {tier,status}.
    refreshAuth: async () => {
      try { const me = await client.me(); return { tier: me.tier || 'free', status: 'active' }; }
      catch { return { tier: 'free', status: 'anonymous' }; }
    },
    getAuthStatus: async () => {
      try { const me = await client.me(); return { authenticated: true, status: 'active', tier: me.tier || 'free' }; }
      catch { return { authenticated: false, status: 'anonymous' }; }
    },
    recheckAccount: async () => {
      try { await client.me(); return { status: 'active' }; }
      catch { return { status: 'anonymous' }; }
    },
    getAppVersion: async () => '',
    // Server-profile timezone (users.timezone) — same field the platform edits.
    userTimezoneGet: async () => {
      try { return (await client.profile.get()).timezone ?? null; } catch { return null; }
    },
    userTimezoneSet: async (tz) => {
      try { await client.profile.update({ timezone: tz }); return { ok: true }; }
      catch (err) { return libError(err); }
    },

    // ── Chat-tab landing (dashboard) ────────────────────────────────────────────
    // The composer + starters render ONLY when dashboardData() resolves truthy, so this
    // ALWAYS returns a full shape — real when authed, emptyDashboardData() when not.
    dashboardData: async () => {
      let me;
      try { me = await client.me(); }        // 401 for an anonymous visitor → empty shape
      catch { return emptyDashboardData(); } // logged-out: still render the Chat landing
      const [credits, alloc, usage, apps] = await Promise.all([
        client.billing.credits().catch(() => null),   // org pool — admins only (403 → null)
        client.usage.allocation().catch(() => null),   // the caller's own allocation
        client.usage.summary().catch(() => null),      // month-to-date spend
        client.apps.deployed().catch(() => null),      // deployed-app count
      ]);
      return toDashboardData(me, credits, alloc, usage, apps);
    },
    // No cross-agent "recent runs" rollup on the new server yet (the SDK exposes only
    // per-task runs). EXPLICIT stub → the correct empty `{ ok, data:[] }` envelope the
    // dashboard's runs list reads, not a silent undefined. Wire when the endpoint lands.
    dashboardRuns: async () => ({ ok: true, data: [] }),

    // ── Prefs / theme ───────────────────────────────────────────────────────────
    // No server prefs endpoint yet: the contract is getPreference(key, default) → the
    // DEFAULT (not undefined), so the renderer's boot reads settle on their fallbacks.
    getPreference: async (_key, defaultVal) => (defaultVal === undefined ? null : defaultVal),
    getPreferences: async () => ({}),
    getTheme: async () => 'dark',
    getBackgroundMode: async () => false,

    // ── Connections (ConnectionsClient) ──────────────────────────────────────────
    connectionsList: read(() => client.connections.resolvedTools(), toLegacyConnections, EMPTY.connections),
    connectionToolsList: (id) =>
      read(() => client.connections.resolvedTools(), (r) => toLegacyConnectionTools(r, id), EMPTY.tools)(),
    connectorsGetApps: read((search) => client.connections.apps({ search }), toLegacyConnectorApps, EMPTY.connectorApps),
    mcpConnectionsList: read(
      async () => {
        const [personal, org] = await Promise.all([
          client.connections.personalMcpList().catch(() => []),
          client.connections.orgMcpList().catch(() => []),
        ]);
        return { personal, org };
      },
      ({ personal, org }) => toLegacyMcpConnections(personal, org, apiUrl),
      EMPTY.mcpConnections,
    ),
    // Governance gate for "+ Custom MCP" — no server policy endpoint (section C). Default
    // closed; a write still 403s if disallowed.
    mcpCustomAllowed: async () => ({ allowed: false }),

    // ── Loops (LoopsClient) ───────────────────────────────────────────────────────
    loopsList: read(() => client.loops.list(), toLegacyLoops, EMPTY.loops),
    loopRoles: (loop) =>
      read(() => client.loops.roles(loop), (roles) => toLegacyLoopRoles(loop, roles), (error) => EMPTY.loopRoles(loop, error))(),
    libraryLoopGet: lib((ref) => client.loops.get(ref)),

    // ── Skills / Agents (library {ok,data} envelope) ──────────────────────────────
    librarySkillsList: lib(() => client.skills.list()),
    librarySkillGet: lib((ref) => client.skills.get(ref)),
    libraryAgentsList: lib(() => client.agents.list()),
    libraryAgentGet: lib((ref) => client.agents.get(ref)),
    libraryAgentTasks: lib((ref) => client.agents.tasks(ref)),
    libraryAgentTaskRuns: lib((ref, taskId) => client.agents.taskRuns(ref, taskId)),

    // ── Library grids (LibraryClient: layouts / drips) ────────────────────────────
    layoutsList: read(() => client.layouts.list(), toLegacyLayouts, EMPTY.list),
    dripsList: read(() => client.drips.list(), toLegacyDrips, EMPTY.list),
    dripsBuiltinEffects: async () => [],

    // ── Apps (AppsClient) ─────────────────────────────────────────────────────────
    panelAppsList: read(() => client.apps.deployed(), toLegacyPanelApps, EMPTY.list),

    // ── Models governance (OrgModelsClient / CatalogClient) ───────────────────────
    orgModelsList: lib(() => client.orgModels.list()),
    orgCustomModelsList: lib(() => client.orgModels.listCustom()),
    // Provider rows are a CATALOG read (the whole catalog ⊕ the org's enablement state);
    // ProvidersClient itself is write-only.
    orgProvidersList: lib(() => client.catalog.providers()),

    // ── Support (SupportClient) ────────────────────────────────────────────────────
    submitSupportTicket: async (ticket) => {
      try {
        await client.support.ticket({ subject: ticket.subject, description: ticket.description });
        return { ok: true };
      } catch (err) { return libError(err); }
    },

    // ── Cloud-backed sessions store ────────────────────────────────────────────────
    // The renderer destructures { chats, currentId } at boot — the contract empty shape
    // keeps that safe. Real cloud message-session wiring lands in a later slice; until
    // then the local mirror (localStorage) the renderer falls back to owns persistence.
    glyphhSessionsLoad: async () => EMPTY.sessions(),
    glyphhSessionsSave: async () => true,

    // ── Local machine-only reads the BOOT path touches ─────────────────────────────
    // No filesystem/machine on web; these return their correct EMPTY contract shape so
    // the boot render is clean. P6 routes them over attach to a connected provider; until
    // then a user-triggered local ACTION surfaces "needs a machine" (not a boot read).
    recentsList: async () => EMPTY.list(),          // rail recents (local app/layout opens)
    getWorkingDir: async () => null,
    getWorkingDirRecents: async () => EMPTY.list(),
    localMcpStatus: async () => ({ running: false, port: null }),
    localMcpTokensList: async () => EMPTY.list(),
  };
}
