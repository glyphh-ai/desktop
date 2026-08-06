/**
 * web-contract.js — the renderer↔SDK CONTRACT LAYER for the web target.
 *
 * The renderer (shared with desktop) consumes `window.glyphh.*` — the IPC contract
 * whose canonical shape is src/renderer/preload.ts. On desktop those methods are
 * Electron IPC into the main process; on web THIS module implements the SAME contract
 * over @glyphh/sdk, returning the EXACT shapes the renderer reads. It is the single,
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
 * @param {import('@glyphh/sdk').Client} client  the SDK handle
 * @param {{ apiUrl:string, isAuthenticated:()=>Promise<boolean>, signOut:()=>Promise<void> }} deps
 * @returns {Record<string, Function>} the contract method map (bridge.js's KNOWN)
 */
export function buildContract(client, deps) {
  const { apiUrl, isAuthenticated, signOut } = deps;

  /** The user's pref map, fetched once and cached. Reads are cheap + synchronous
   *  after the first load; writes update the cache immediately (optimistic) then
   *  persist to the server. A failed load caches `{}` so the app boots on defaults
   *  rather than storming the API on every getPreference. Cleared on sign-out. */
  const prefsCache = {
    _p: null,
    get() {
      if (!this._p) this._p = client.profile.prefs().catch(() => ({}));
      return this._p;
    },
    async set(key, value) {
      const map = await this.get();
      if (value === null || value === undefined) delete map[key];
      else map[key] = value;                 // optimistic — the renderer reads it back at once
      try { await client.profile.setPrefs({ [key]: value ?? null }); return { ok: true }; }
      catch (err) { return { ok: false, error: err?.message ?? String(err) }; }
    },
    clear() { this._p = null; },
  };

  /** The session-thread cache's localStorage key, scoped to the signed-in user
   *  (identity resolved once, then pinned). Logged out → the 'anon' key each
   *  call WITHOUT pinning, so the first authed call still lands per-user. */
  let _threadCacheKey = null;
  const threadCacheKey = async () => {
    if (_threadCacheKey) return _threadCacheKey;
    try {
      const me = await client.me();
      _threadCacheKey = `glyphhThreads:${me?.id || me?.email || 'me'}`;
      return _threadCacheKey;
    } catch { return 'glyphhThreads:anon'; }
  };

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
    logout: () => { prefsCache.clear(); return signOut(); },
    signOut: () => { prefsCache.clear(); return signOut(); },
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
    // Timezone (users.timezone) is edited only through Settings › Account,
    // which goes straight at client.profile.update via the account API.

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
    // The stacked usage chart's feed (Settings › Usage), matching home-ipc.ts's
    // desktop handler exactly: an N-day window bucketed in this device's zone,
    // credits converted from MICRO to WHOLE so the renderer never sees micro.
    // `userId` narrows to one member and is org_admin-only server-side, so it
    // is sent only when the caller actually picked someone.
    usageSeries: async (days, groupBy, userId) => {
      try {
        const MICRO = 1_000_000;
        const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
        const now = new Date();
        const win = Math.max(1, Math.min(Number(days) || 30, 365));
        const start = new Date(now);
        start.setDate(now.getDate() - (win - 1));
        const from = ymd(start);
        const to = ymd(now);
        const { points } = await client.usage.series({
          from,
          to,
          groupBy: groupBy === 'source' ? 'source' : 'model',
          tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
          ...(userId ? { userId } : {}),
        });
        return { ok: true, data: { from, to, points: (points || []).map((pt) => ({ ...pt, credits: pt.credits / MICRO })) } };
      } catch (err) {
        return { ok: false, error: err?.message ?? String(err) };
      }
    },

    // ── Prefs / theme ───────────────────────────────────────────────────────────
    // Server-backed (org→user in the stator) via profile.prefs/setPrefs. The whole
    // map is fetched ONCE and cached (prefsCache) — the renderer reads prefs
    // synchronously-ish at boot in many places, so a per-key round-trip would storm
    // the API. Writes update the cache optimistically, then persist; a logged-out
    // read resolves to the caller's default (never throws). `theme`/`backgroundMode`
    // are plain keys in the same map, so desktop and web share pref keys.
    getPreference: async (key, defaultVal) => {
      const map = await prefsCache.get();
      return key in map ? map[key] : (defaultVal === undefined ? null : defaultVal);
    },
    getPreferences: async () => ({ ...(await prefsCache.get()) }),
    setPreference: (key, value) => prefsCache.set(key, value),
    getTheme: async () => (await prefsCache.get()).theme ?? 'dark',
    setTheme: (theme) => prefsCache.set('theme', theme),
    getBackgroundMode: async () => (await prefsCache.get()).backgroundMode ?? false,
    setBackgroundMode: (enabled) => prefsCache.set('backgroundMode', !!enabled),

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
    // WEB app launch (2026-08-03): panels can't host third-party sites in a
    // browser (X-Frame-Options/frame-ancestors belong to the TARGET site), so
    // on web an app simply OPENS IN A NEW TAB. Native apps need the desktop.
    appLaunch: async (app) => {
      const url = (app && (app.url || app.prodUrl)) || null;
      // On web an app opens as a STREAMED workbench panel (rendered on the
      // user's attached desktop, streamed here) — not a new browser tab.
      const open = (typeof window !== 'undefined') && window.__wbOpenApp;
      if (open && (url || app.glyphh)) {
        try { open({ slug: app.slug, name: app.name, url: url || '', glyphh: !!app.glyphh }, true); return { ok: true }; }
        catch (e) { /* fall through to the tab fallback */ }
      }
      if (url) {
        try { window.open(url, '_blank', 'noopener'); return { ok: true }; }
        catch { return { ok: false, error: 'popup blocked — allow popups for this site' }; }
      }
      return { ok: false, error: 'this app needs the desktop app' };
    },

    // The LAUNCHER list: every app the org owns or installed (the copied 25
    // defaults live here) — NOT apps.deployed(), which is only hosted deploys
    // and is empty for a fresh org (that read backs the dashboard count).
    panelAppsList: read(() => client.apps.mine(), toLegacyPanelApps, EMPTY.list),

    // ── App config vars (write-only secrets) — SDK apps.secrets surface.
    // The desktop's `appReadable` flag is a LOCAL concept; the cloud store
    // has no read-back path at all, so the flag is accepted and dropped.
    appSecretsList: async (idOrSlug) => {
      try { return { ok: true, secrets: await client.apps.secrets(idOrSlug) }; }
      catch (err) { return { ok: false, error: err?.message || String(err) }; }
    },
    appSecretsSet: async (idOrSlug, key, value, _appReadable) => {
      try { await client.apps.setSecret(idOrSlug, key, value); return { ok: true }; }
      catch (err) { return { ok: false, error: err?.message || String(err) }; }
    },
    appSecretsDelete: async (idOrSlug, key) => {
      try { await client.apps.removeSecret(idOrSlug, key); return { ok: true }; }
      catch (err) { return { ok: false, error: err?.message || String(err) }; }
    },

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

    // ── Session-thread OFFLINE CACHE ───────────────────────────────────────────────
    // The SERVER THREADS SURFACE (client.sessions.threads/pushThread/…) is the source
    // of truth for chat sessions now — the renderer's thread-store syncs it LWW over
    // window.glyphhSdk directly. These two methods are its per-surface CACHE layer
    // (write-through localStorage here; main's sessions.json on desktop). Keyed per
    // USER so a shared browser can never push one account's cached sessions into
    // another's thread set; logged out (me() rejects) reads resolve empty and the
    // key is not pinned, so the first authed read lands on the right entry.
    glyphhSessionsLoad: async () => {
      try {
        const raw = localStorage.getItem(await threadCacheKey());
        const p = raw ? JSON.parse(raw) : null;
        return { chats: Array.isArray(p?.chats) ? p.chats : [], currentId: String(p?.currentId || '') };
      } catch { return EMPTY.sessions(); }
    },
    glyphhSessionsSave: async (chats, currentId) => {
      try {
        localStorage.setItem(await threadCacheKey(), JSON.stringify({ chats, currentId }));
        return true;
      } catch (err) {
        console.warn('[glyphh-web] session cache write failed:', err?.message ?? String(err));
        return false; // quota / private mode — the server copy is the truth anyway
      }
    },

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
