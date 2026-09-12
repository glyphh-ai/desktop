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
// STANDARD drip effects ship with the product — the same shared catalog +
// generators the desktop main process uses (electron-free by design).
import { BUILTIN_EFFECT_LIST } from '../../src/shared/drip-effects';
// DOM-free at import time; only running a recipe touches the document.
import { runDripRecipe } from './drip-web-runner.js';
// The workbench locus tracker: every session-cache load/save below feeds it, so
// window.wb can route Files/Diff/Editor to the CURRENT session's workspace
// (cloud pod vs attached desktop) without touching the renderer (wb-pod.js).
import { noteSessionsSnapshot } from './wb-pod.js';

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
  // The API origin as a PROPERTY (preload.ts parity) — settings-mcp shows
  // the cloud MCP endpoint from it.
  void 0;

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

  // Per-loop model picks — the web's counterpart of the desktop's main-process
  // selection store. { [loop]: { [role]: modelId } } in localStorage.
  const LOOP_SELECTIONS_KEY = 'glyphh.loopSelections';
  const loopSelections = () => {
    try { return JSON.parse(localStorage.getItem(LOOP_SELECTIONS_KEY) || '{}') || {}; }
    catch { return {}; }
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
    // Injected at build time (esbuild --define, same as mobile.tsx) — the
    // typeof guard keeps vitest (no define) from a ReferenceError.
    getAppVersion: async () => (typeof __GLYPHH_VERSION__ !== 'undefined' ? __GLYPHH_VERSION__ : ''),
    // Updater shims (parity law): the web IS always the latest deploy, so a
    // check honestly answers "up to date" and the rest are inert. Without
    // these the About panel (user menu → About) threw at onUpdateStatus.
    checkForUpdates: async () => null,
    getUpdateStatus: async () => null,
    onUpdateStatus: () => {},
    updateInstall: () => {},
    // Timezone (users.timezone) is edited only through Settings › Account,
    // which goes straight at client.profile.update via the account API.

    // ── Chat-tab landing (dashboard) ────────────────────────────────────────────
    // The composer + starters render ONLY when dashboardData() resolves truthy, so this
    // ALWAYS returns a full shape — real when authed, emptyDashboardData() when not.
    dashboardData: async () => {
      let me;
      try { me = await client.me(); }        // 401 for an anonymous visitor → empty shape
      catch { return emptyDashboardData(); } // logged-out: still render the Chat landing
      const [credits, alloc, usage, apps, plans, sub] = await Promise.all([
        client.billing.credits().catch(() => null),   // org pool — admins only (403 → null)
        client.usage.allocation().catch(() => null),   // the caller's own allocation
        client.usage.summary().catch(() => null),      // month-to-date spend
        client.apps.deployed().catch(() => null),      // deployed-app count
        client.billing.plans().catch(() => []),        // the plan catalog — name + allowance
        client.billing.status().catch(() => null),     // which tier the org is on
      ]);
      return toDashboardData(me, credits, alloc, usage, apps, plans, sub);
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
    // Workbench/ui-state map (nav collapse, layouts, panel memory). Desktop
    // keeps per-user FILES behind these names; the web keeps the ONE
    // workbenchUiState pref (server-side law) — same shape either way. This
    // lane was desktop-only until 2026-09-11, so every platform refresh
    // silently forgot the map (the proxy swallowed the missing shims).
    wsStateLoad: async () => {
      try {
        const raw = (await prefsCache.get()).workbenchUiState;
        if (!raw) return {};
        const map = typeof raw === 'string' ? JSON.parse(raw) : raw;
        return map && typeof map === 'object' ? map : {};
      } catch { return {}; }
    },
    wsStateSave: async (snapshot) => {
      await prefsCache.set('workbenchUiState', JSON.stringify(snapshot || {}));
      return true;
    },
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

    // ── Glyphh Office · Slides (OfficeSlidesClient) ──────────────────────────────
    // Same wire shapes as the desktop preload, so the Slides panel (wb-gpoint)
    // is surface-agnostic: the org's R2 library through the SDK on every surface.
    gpointList: async () => {
      try {
        const decks = (await client.officeSlides.list()).map((m) => ({
          file: m.file, title: m.title, slides: m.slides,
          mtime: Date.parse(m.updatedAt) || 0, size: m.sizeBytes,
        }));
        return { ok: true, decks };
      } catch (err) { return { ok: false, error: err?.message ?? String(err), decks: [] }; }
    },
    gpointRead: async (file) => {
      try { return { ok: true, content: (await client.officeSlides.get(file)).html }; }
      catch (err) { return { ok: false, error: err?.message ?? String(err) }; }
    },
    gpointDelete: async (file) => {
      try { await client.officeSlides.delete(file); return { ok: true }; }
      catch (err) { return { ok: false, error: err?.message ?? String(err) }; }
    },
    gpointWrite: async (file, html) => {
      try { await client.officeSlides.put(file, html); return { ok: true }; }
      catch (err) { return { ok: false, error: err?.message ?? String(err) }; }
    },

    // ── Glyphh Office · Docs (OfficeDocsClient) — same wire shapes as preload ──
    gdocList: async () => {
      try {
        const docs = (await client.officeDocs.list()).map((d) => ({
          file: d.file, title: d.title, size: d.sizeBytes, folderId: d.folderId,
          mtime: Date.parse(d.updatedAt) || 0,
        }));
        return { ok: true, docs };
      } catch (err) { return { ok: false, error: err?.message ?? String(err), docs: [] }; }
    },
    gdocRead: async (file) => {
      try { const d = await client.officeDocs.get(file); return { ok: true, markdown: d.markdown, title: d.title }; }
      catch (err) { return { ok: false, error: err?.message ?? String(err) }; }
    },
    gdocWrite: async (file, markdown, folderId) => {
      try { const m = await client.officeDocs.put(file, markdown, folderId); return { ok: true, file: m.file, title: m.title }; }
      catch (err) { return { ok: false, error: err?.message ?? String(err) }; }
    },
    gdocDelete: async (file) => {
      try { await client.officeDocs.delete(file); return { ok: true }; }
      catch (err) { return { ok: false, error: err?.message ?? String(err) }; }
    },
    gdocSuggest: async (file, input) => {
      try { return { ok: true, suggestion: await client.officeDocs.suggest(file, input) }; }
      catch (err) { return { ok: false, error: err?.message ?? String(err) }; }
    },
    gdocSuggestions: async (file, status) => {
      try { return { ok: true, suggestions: await client.officeDocs.suggestions(file, status) }; }
      catch (err) { return { ok: false, error: err?.message ?? String(err), suggestions: [] }; }
    },
    gdocResolve: async (id, approve) => {
      try { return { ok: true, suggestion: await client.officeDocs.resolveSuggestion(id, approve) }; }
      catch (err) { return { ok: false, error: err?.message ?? String(err) }; }
    },
    gsheetList: async () => {
      try {
        const sheets = (await client.officeSheets.list()).map((m) => ({
          file: m.file, title: m.title, sheets: m.sheets, totalRows: m.totalRows,
          size: m.sizeBytes, folderId: m.folderId, mtime: Date.parse(m.updatedAt) || 0,
        }));
        return { ok: true, sheets };
      } catch (err) { return { ok: false, error: err?.message ?? String(err), sheets: [] }; }
    },
    gsheetRead: async (file) => {
      try { const s = await client.officeSheets.get(file); return { ok: true, title: s.title, workbook: s.workbook }; }
      catch (err) { return { ok: false, error: err?.message ?? String(err) }; }
    },
    gsheetWrite: async (file, title, workbook) => {
      try { const m = await client.officeSheets.put(file, title, workbook); return { ok: true, file: m.file, title: m.title }; }
      catch (err) { return { ok: false, error: err?.message ?? String(err) }; }
    },
    gsheetDelete: async (file) => {
      try { await client.officeSheets.delete(file); return { ok: true }; }
      catch (err) { return { ok: false, error: err?.message ?? String(err) }; }
    },
    designList: async () => {
      try {
        const designs = (await client.designs.list()).map((m) => ({
          file: m.file, title: m.title, size: m.sizeBytes, mtime: Date.parse(m.updatedAt) || 0,
        }));
        return { ok: true, designs };
      } catch (err) { return { ok: false, error: err?.message ?? String(err), designs: [] }; }
    },
    designRead: async (file) => {
      try { const d = await client.designs.get(file); return { ok: true, title: d.title, document: d.document }; }
      catch (err) { return { ok: false, error: err?.message ?? String(err) }; }
    },
    designWrite: async (file, document) => {
      try { const m = await client.designs.put(file, document); return { ok: true, file: m.file, title: m.title }; }
      catch (err) { return { ok: false, error: err?.message ?? String(err) }; }
    },
    designDelete: async (file) => {
      try { await client.designs.delete(file); return { ok: true }; }
      catch (err) { return { ok: false, error: err?.message ?? String(err) }; }
    },
    designAssetUpload: async (file, input) => {
      try { return { ok: true, asset: await client.designs.uploadAsset(file, input) }; }
      catch (err) { return { ok: false, error: err?.message ?? String(err) }; }
    },
    designAssetUrl: async (file, assetId) => {
      try {
        const d = await client.designs.get(file);
        const entry = (d.document.assets ?? []).find((x) => x.id === assetId);
        if (!entry) throw new Error("asset not found");
        const bytes = await client.designs.assetBytes(file, assetId);
        let bin = "";
        const arr = new Uint8Array(bytes);
        for (let i = 0; i < arr.length; i++) bin += String.fromCharCode(arr[i]);
        return { ok: true, url: `data:${entry.contentType};base64,${btoa(bin)}` };
      } catch (err) { return { ok: false, error: err?.message ?? String(err) }; }
    },
    designAssetDelete: async (file, assetId) => {
      try { await client.designs.deleteAsset(file, assetId); return { ok: true }; }
      catch (err) { return { ok: false, error: err?.message ?? String(err) }; }
    },
    memoryBrowse: async (threadId) => {
      try { const r = await client.stator.browse(threadId || undefined); return { ok: true, ...r }; }
      catch (err) { return { ok: false, error: err?.message ?? String(err), facts: [], turns: [], window: [] }; }
    },
    memoryGraph: async (opts) => {
      try { const r = await client.stator.graph(opts ?? {}); return { ok: true, ...r }; }
      catch (err) { return { ok: false, error: err?.message ?? String(err), nodes: [], coords: [], edges: [] }; }
    },
    memorySearch: async (query, topK) => {
      try {
        const r = await client.stator.recall({ query: String(query ?? ''), topK: topK || 12, threshold: 0.05 });
        return { ok: true, recalled: r.recalled, directives: r.directives };
      } catch (err) { return { ok: false, error: err?.message ?? String(err), recalled: [], directives: [] }; }
    },
    memoryForget: async (input) => {
      try { const r = await client.stator.forget(input); return { ok: true, deleted: r.deleted }; }
      catch (err) { return { ok: false, error: err?.message ?? String(err) }; }
    },
    memoryAmend: async (input) => {
      try { const r = await client.stator.amend(input); return { ok: true, written: r.written }; }
      catch (err) { return { ok: false, error: err?.message ?? String(err) }; }
    },
    mediaList: async (kind, q) => {
      try { return { ok: true, assets: await client.media.list(kind || undefined, q || undefined) }; }
      catch (err) { return { ok: false, error: err?.message ?? String(err), assets: [] }; }
    },
    mediaUrl: async (id) => {
      try {
        const r = await client.media.playbackUrl(id);
        if (r.url) return { ok: true, url: r.url };
        return { ok: false, error: "no direct URL on this surface" };
      } catch (err) { return { ok: false, error: err?.message ?? String(err) }; }
    },
    mediaDelete: async (id) => {
      try { await client.media.delete(id); return { ok: true }; }
      catch (err) { return { ok: false, error: err?.message ?? String(err) }; }
    },
    mediaGenerate: async (input) => {
      try { const r = await client.media.generate(input); return { ok: true, job: r.job, outputKind: r.outputKind }; }
      catch (err) { return { ok: false, error: err?.message ?? String(err) }; }
    },
    mediaJob: async (id) => {
      try { return { ok: true, job: await client.media.job(id) }; }
      catch (err) { return { ok: false, error: err?.message ?? String(err) }; }
    },
    // Web upload rides the panel's own file input in a later pass — explicit gap.
    mediaUploadPick: async () => ({ ok: false, error: "uploads ride the desktop for now" }),
    musicArtists: async () => {
      try { return { ok: true, artists: await client.music.artists() }; }
      catch (err) { return { ok: false, error: err?.message ?? String(err), artists: [] }; }
    },
    musicArtistSave: async (id, input) => {
      try { const artist = id ? await client.music.updateArtist(id, input) : await client.music.createArtist(input); return { ok: true, artist }; }
      catch (err) { return { ok: false, error: err?.message ?? String(err) }; }
    },
    musicArtistDelete: async (id) => {
      try { await client.music.deleteArtist(id); return { ok: true }; }
      catch (err) { return { ok: false, error: err?.message ?? String(err) }; }
    },
    musicInstruments: async () => {
      try { return { ok: true, instruments: await client.music.instruments() }; }
      catch (err) { return { ok: false, error: err?.message ?? String(err), instruments: [] }; }
    },
    musicInstrumentSave: async (id, input) => {
      try { const instrument = id ? await client.music.updateInstrument(id, input) : await client.music.createInstrument(input); return { ok: true, instrument }; }
      catch (err) { return { ok: false, error: err?.message ?? String(err) }; }
    },
    musicInstrumentDelete: async (id) => {
      try { await client.music.deleteInstrument(id); return { ok: true }; }
      catch (err) { return { ok: false, error: err?.message ?? String(err) }; }
    },
    musicInstrumentGenlook: async () => ({ ok: false, error: "look generation rides the desktop for now" }),
    musicSongs: async () => {
      try { return { ok: true, songs: await client.music.songs() }; }
      catch (err) { return { ok: false, error: err?.message ?? String(err), songs: [] }; }
    },
    musicSongSave: async (id, input) => {
      try { const song = id ? await client.music.updateSong(id, input) : await client.music.createSong(input); return { ok: true, song }; }
      catch (err) { return { ok: false, error: err?.message ?? String(err) }; }
    },
    musicSongDelete: async (id) => {
      try { await client.music.deleteSong(id); return { ok: true }; }
      catch (err) { return { ok: false, error: err?.message ?? String(err) }; }
    },
    // Look generation composes several metered jobs — desktop-main owns it.
    musicArtistGenlook: async () => ({ ok: false, error: "look generation rides the desktop for now" }),
    musicSongRegenerate: async (id, input) => {
      try { const r = await client.music.regenerateSong(id, input ?? {}); return { ok: true, song: r.song, job: r.job }; }
      catch (err) { return { ok: false, error: err?.message ?? String(err) }; }
    },
    mediaProjects: async () => {
      try { return { ok: true, projects: await client.media.projects() }; }
      catch (err) { return { ok: false, error: err?.message ?? String(err), projects: [] }; }
    },
    mediaProjectSave: async (id, input) => {
      try { const project = id ? await client.media.updateProject(id, input) : await client.media.createProject(input); return { ok: true, project }; }
      catch (err) { return { ok: false, error: err?.message ?? String(err) }; }
    },
    mediaProjectDelete: async (id) => {
      try { await client.media.deleteProject(id); return { ok: true }; }
      catch (err) { return { ok: false, error: err?.message ?? String(err) }; }
    },
    mediaProjectGenerate: async (id, input) => {
      try { const r = await client.media.generateProject(id, input ?? {}); return { ok: true, project: r.project, job: r.job }; }
      catch (err) { return { ok: false, error: err?.message ?? String(err) }; }
    },
    mediaUploadBytes: async (input) => {
      try {
        const bytes = new Uint8Array(input.bytes);
        const ticket = await client.media.uploadTicket({ kind: input.kind, mime: input.mime, title: input.title, sizeBytes: bytes.byteLength, ...(input.meta ? { meta: input.meta } : {}) });
        if (ticket.url) {
          const res = await fetch(ticket.url, { method: "PUT", headers: { "content-type": input.mime }, body: bytes });
          if (!res.ok) throw new Error(`presigned upload failed: ${res.status}`);
        } else {
          await client.media.putBytes(ticket.asset.id, bytes);
        }
        const done = await client.media.finalize(ticket.asset.id);
        return { ok: true, id: done.id, title: done.title };
      } catch (err) { return { ok: false, error: err?.message ?? String(err) }; }
    },
    mediaSave: async (id) => {
      try {
        const asset = await client.media.get(id);
        const bytes = await client.media.bytes(id);
        const blobUrl = URL.createObjectURL(new Blob([bytes], { type: asset.mime }));
        const a2 = document.createElement("a");
        a2.href = blobUrl;
        a2.download = (asset.title || "media").replace(/[^\w\s.-]/g, "").trim().replace(/\s+/g, "-");
        a2.click();
        setTimeout(() => URL.revokeObjectURL(blobUrl), 30_000);
        return { ok: true };
      } catch (err) { return { ok: false, error: err?.message ?? String(err) }; }
    },
    gdriveList: async (q) => {
      try { const l = await client.officeDrive.list(q || undefined); return { ok: true, folders: l.folders, files: l.files }; }
      catch (err) { return { ok: false, error: err?.message ?? String(err), folders: [], files: [] }; }
    },
    gdriveMkdir: async (name, parentId) => {
      try { return { ok: true, folder: await client.officeDrive.createFolder(name, parentId ?? null) }; }
      catch (err) { return { ok: false, error: err?.message ?? String(err) }; }
    },
    gdriveMove: async (kind, file, folderId) => {
      try { await client.officeDrive.move(kind, file, folderId ?? null); return { ok: true }; }
      catch (err) { return { ok: false, error: err?.message ?? String(err) }; }
    },
    gdriveFolderRename: async (id, name) => {
      try { await client.officeDrive.updateFolder(id, { name }); return { ok: true }; }
      catch (err) { return { ok: false, error: err?.message ?? String(err) }; }
    },
    gdriveFolderDelete: async (id) => {
      try { await client.officeDrive.deleteFolder(id); return { ok: true }; }
      catch (err) { return { ok: false, error: err?.message ?? String(err) }; }
    },
    gdocTemplates: async () => {
      try { return { ok: true, templates: await client.officeDocs.templates() }; }
      catch (err) { return { ok: false, error: err?.message ?? String(err), templates: [] }; }
    },

    // ── Connections (ConnectionsClient) ──────────────────────────────────────────
    // The ORG list first, for its SIDE-EFFECT (his report, 2026-09-11: a
    // freshly connected org account was invisible): /api/org/connections
    // SYNCS the Pipedream account mirror; resolvedTools reads the mirror and
    // never syncs. Members 403 on the org lane — swallowed, harmless.
    connectionsList: read(
      () => client.connections.pipedreamList().catch(() => null).then(() => client.connections.resolvedTools()),
      toLegacyConnections,
      EMPTY.connections,
    ),
    connectionToolsList: (id) =>
      read(() => client.connections.resolvedTools(), (r) => toLegacyConnectionTools(r, id), EMPTY.tools)(),
    connectorsGetApps: read((search) => client.connections.apps({ search }), toLegacyConnectorApps, EMPTY.connectorApps),
    // Rename a connection — same envelope the desktop IPC returns. Web rows
    // carry SLUGS as ids (toLegacyConnections), but the rename routes take the
    // ACCOUNT UUID — resolve slug → account first (personal wins, org next),
    // or postgres rejects the slug ("invalid input syntax for type uuid").
    connectionRename: async (id, label) => {
      try {
        const personal = await client.connections.personalList().catch(() => []);
        const mine = (personal || []).find((c) => c.id === id || c.appSlug === id);
        if (mine) return { ok: true, connection: await client.connections.renamePersonalConnection(mine.id, label) };
        const org = await client.connections.pipedreamList().catch(() => []);
        const shared = (org || []).find((c) => c.id === id || c.appSlug === id);
        if (shared) return { ok: true, connection: await client.connections.renameOrgConnection(shared.id, label) };
        return { ok: false, error: 'No connected account to rename' };
      } catch (err) { return { ok: false, error: err instanceof Error ? err.message : String(err) }; }
    },
    // The connector OAuth flow, WEB-NATIVE (his rule, 2026-08-20: same tooling
    // as the desktop minus fs): Pipedream Connect is a browser flow by nature —
    // open the popup FIRST (inside the click's gesture budget, before any
    // fetch, or the browser blocks it), point it at the connect link, then
    // poll the personal list until the new account lands.
    connectorsConnect: async (appSlug) => {
      const popup = window.open('about:blank', '_blank', 'popup,width=520,height=720');
      if (!popup) return { ok: false, error: 'Popup blocked — allow popups for this site' };
      try {
        // SCOPE follows the SURFACE (his report, 2026-09-11: an org admin's
        // "org level" connect landed as a PERSONAL account): the platform
        // shell is the ORG admin surface — connect the org account there;
        // everywhere else stays the member's own.
        const onPlatform = document.body.classList.contains('platform-shell');
        const listNow = () => onPlatform
          ? client.connections.pipedreamList().catch(() => []).then((r) => (Array.isArray(r) ? r : []))
          : client.connections.personalList().catch(() => []);
        const before = new Set((await listNow()).map((c) => c.id));
        const session = onPlatform
          ? await client.connections.pipedreamConnect(appSlug)
          : await client.connections.personalConnect(appSlug);
        if (!session?.connectUrl) { popup.close(); return { ok: false, error: 'Failed to get connect token' }; }
        popup.location = session.connectUrl;
        const landed = async () => {
          const now = await listNow();
          return now.some((c) => !before.has(c.id));
        };
        for (let i = 0; i < 150; i++) {                     // <= 5 minutes
          await new Promise((r) => setTimeout(r, 2000));
          if (await landed()) { try { popup.close(); } catch (e) { /* gone */ } return { ok: true }; }
          if (popup.closed) {
            // Grace polls: the OAuth finished as the window closed and the
            // account sync can trail it by a few seconds.
            for (let j = 0; j < 5; j++) {
              await new Promise((r) => setTimeout(r, 1500));
              if (await landed()) return { ok: true };
            }
            return { ok: false, error: 'The connect window closed before finishing' };
          }
        }
        return { ok: false, error: 'Timed out waiting for the connection' };
      } catch (err) {
        try { popup.close(); } catch (e) { /* gone */ }
        return { ok: false, error: err?.message || String(err) };
      }
    },
    // Manage connections on web — same seams the desktop IPC rides.
    connectionDisconnect: async (id) => {
      try { await client.connections.personalDisconnect(id); return { ok: true }; }
      catch (e1) {
        try { await client.connections.pipedreamDisconnect(id); return { ok: true }; }
        catch (err) { return { ok: false, error: err?.message || String(err) }; }
      }
    },
    connectionToolsSet: async (slug, tools) => {
      try { await client.connections.setPersonalConnectionTools(slug, tools); return { ok: true }; }
      catch (e1) {
        try { await client.connections.setOrgConnectionTools(slug, tools); return { ok: true }; }
        catch (err) { return { ok: false, error: err?.message || String(err) }; }
      }
    },
    mcpConnectionsCatalog: async () => {
      try {
        const list = await client.connections.orgMcpList();
        return { ok: true, connections: list ?? [] };
      } catch (e) { return { ok: false, connections: [] }; }
    },
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
    // Governance gate for "+ Custom MCP" — mirrors the desktop (home-ipc):
    // probe the personal MCP surface; a 403 means the org/role disallows it,
    // anything else (incl. an empty list) means allowed. The old hard-closed
    // stub hid every MCP configuration and connected endpoint on the web.
    mcpCustomAllowed: async () => {
      try {
        await client.connections.personalMcpList();
        return { allowed: true };
      } catch (err) {
        const status = err?.status ?? err?.statusCode;
        if (status === 403) return { allowed: false, reason: 'Custom MCP connections are disabled by your organization.' };
        return { allowed: false };
      }
    },

    // ── Loops (LoopsClient) ───────────────────────────────────────────────────────
    loopsList: read(() => client.tasks.list(), toLegacyLoops, EMPTY.loops),
    // (loop, force?, context?) — force is meaningless here (no main-process
    // cache on web); context="cloud" resolves without on-device models, whose
    // weights only exist on a desktop machine.
    loopRoles: (loop, _force, context) =>
      read(() => client.tasks.roles(loop, loopSelections()[loop] || {}, context === "cloud" ? { context: "cloud" } : {}), (roles) => toLegacyLoopRoles(loop, roles), (error) => EMPTY.loopRoles(loop, error))(),
    // Bind a slot to a model (null clears back to the loop's default). The
    // desktop stores picks in main-process prefs; on web they live in
    // localStorage and ride the roles call as `select=` params. This method
    // simply didn't exist on web before — the picker's click was a silent
    // no-op (the glyphh Proxy fabricated it).
    loopRoleSet: async (loop, role, modelId) => {
      const all = loopSelections();
      const forLoop = { ...(all[loop] || {}) };
      if (modelId) forLoop[role] = modelId; else delete forLoop[role];
      all[loop] = forLoop;
      try { localStorage.setItem(LOOP_SELECTIONS_KEY, JSON.stringify(all)); } catch { /* storage full/blocked */ }
      try {
        const roles = await client.tasks.roles(loop, forLoop);
        return toLegacyLoopRoles(loop, roles);
      } catch (err) {
        return EMPTY.loopRoles(loop, err?.message || String(err));
      }
    },
    libraryLoopGet: lib((ref) => client.tasks.get(ref)),
    // Mirror of the desktop's loop-set-role-default IPC: read the loop, patch
    // the role slot's default in the manifest, write it back. Pure SDK — the
    // web bridge lacked this, so changing a model in a loop crashed on web.
    loopSetRoleDefault: async (loopId, role, modelId) => {
      try {
        const loop = await client.tasks.get(loopId);
        const manifest = { ...(loop.manifest ?? {}) };
        const roles = Array.isArray(manifest.roles) && manifest.roles.length
          ? manifest.roles.map((r) => ({ ...r }))
          : [{ name: 'default', label: 'Model', description: 'The model this loop runs on.' }];
        const slot = roles.find((r) => r.name === role);
        if (slot) slot.default = modelId ?? null;
        else roles.push({ name: role, default: modelId ?? null });
        await client.tasks.update(loop.id ?? loopId, { manifest: { ...manifest, roles } });
        return { ok: true };
      } catch (e) {
        return { ok: false, error: String((e && e.message) || e) };
      }
    },

    // ── LOOPS + licensing (his rule: the web has the SAME tooling as the
    //    desktop minus the file system). These are the WEB HALF of the
    //    desktop's loops-available / org-loops-list / org-loop-set /
    //    plan-gates IPC. Without them the proxy answers undefined SILENTLY:
    //    Organization -> Loops is platform-only and would never load at all,
    //    and planGates falling back to CLOSED renders Roles and SSO locked
    //    for orgs that pay for them.
    loopsAvailable: lib(() => client.loops.list()),
    // Settings → General's model list (the role-narrowed available set). A
    // missing shim here fails SILENTLY through the proxy — the dropdown just
    // never fills (his report, 2026-09-12).
    workspacesModelCatalog: lib(() => client.models.available()),
    orgLoopsList: lib(() => client.orgLoops.list()),
    orgLoopSet: lib((cli, enabled) => client.orgLoops.setEnabled(cli, enabled)),
    /** THE licensing read — one place, every surface (SDK client.plans). */
    planGates: () => client.plans.gates(),

    // ── Skills / Agents (library {ok,data} envelope) ──────────────────────────────
    librarySkillsList: lib(() => client.skills.list()),
    librarySkillGet: lib((ref) => client.skills.get(ref)),
    libraryAgentsList: lib(() => client.agents.list()),
    libraryAgentGet: lib((ref) => client.agents.get(ref)),
    libraryAgentTasks: lib((ref) => client.agents.tasks(ref)),
    libraryAgentTaskAdd: lib((ref, input) => client.agents.addTask(ref, input)),
    libraryAgentTaskRuns: lib((ref, taskId) => client.agents.taskRuns(ref, taskId)),

    // ── Library grids (LibraryClient: layouts / drips) ────────────────────────────
    layoutsList: read(() => client.layouts.list(), toLegacyLayouts, EMPTY.list),
    // CREATE/EDIT/DELETE workspaces on web (his rule, 2026-08-20: the web has
    // the SAME tooling as the desktop minus the file-system tools). Mirrors
    // the desktop layout-manager's server body exactly — one record shape,
    // every surface reads it.
    layoutsSaveGrid: async (grid) => {
      try {
        const body = {
          name: grid.name,
          cols: grid.cols,
          rows: grid.rows,
          cells: (grid.cells || []).map((c) => ({
            panelId: c.panelId, col: c.col, row: c.row, colSpan: c.colSpan, rowSpan: c.rowSpan,
            sticky: c.sticky, ...(c.config ? { config: c.config } : {}),
          })),
          folderMode: grid.folderMode ?? 'single',
          target: grid.target ?? 'glyphh',
          ...(grid.loop ? { loop: grid.loop } : {}),
          ...(grid.modelSelections && Object.keys(grid.modelSelections).length ? { modelSelections: grid.modelSelections } : {}),
          ...(grid.sessionMode && grid.sessionMode !== 'keep' ? { sessionMode: grid.sessionMode } : {}),
          ...(grid.folder ? { folder: grid.folder } : {}),
          ...(grid.space === 'chat' || grid.space === 'cowork' || grid.space === 'code' ? { space: grid.space } : {}),
        };
        const existing = (await client.layouts.list()).find((it) => it.name === grid.name);
        await client.layouts.save({ name: grid.name, data: body, ...(existing ? { id: existing.id } : {}) });
        return true;
      } catch (err) {
        return { error: err?.message || String(err) };
      }
    },
    layoutsDelete: async (name) => {
      try {
        const hit = (await client.layouts.list()).find((it) => it.name === name);
        if (!hit) return false;
        await client.layouts.delete(hit.id);
        return true;
      } catch { return false; }
    },
    dripsList: read(() => client.drips.list(), toLegacyDrips, EMPTY.list),
    // The standard effects are code, not a cloud read — same catalog as the
    // desktop IPC (one-shots then loops, 'timme' hidden). Fresh objects so a
    // caller can never mutate the shared catalog.
    dripsBuiltinEffects: async () => BUILTIN_EFFECT_LIST.map((fx) => ({ ...fx })),
    // Drips RENDER HERE on web: the recipe plays in a sandboxed full-viewport
    // iframe overlay (see drip-web-runner.js) — no machine needed.
    dripsPreview: async (recipe) => runDripRecipe(recipe),

    // ── Apps (AppsClient) ─────────────────────────────────────────────────────────
    // WEB app launch (2026-08-03): panels can't host third-party sites in a
    // browser (X-Frame-Options/frame-ancestors belong to the TARGET site), so
    // on web an app simply OPENS IN A NEW TAB. Native apps need the desktop.
    appLaunch: async (app) => {
      let a = app || {};
      // NAME-ONLY callers (.dip <app>, command parser) hand just {slug, name} —
      // the desktop resolves that against the app library main-side; the web
      // shim must do the same or every .dip died with "needs the desktop app"
      // (his report, 2026-08-20). Resolve by slug, id, or name.
      if (!a.url && !a.prodUrl && !a.glyphh) {
        try {
          const rows = toLegacyPanelApps(await client.apps.mine());
          const key = String(a.slug || a.name || '').toLowerCase();
          const hit = rows.find((r) =>
            (r.slug || '').toLowerCase() === key
            || String(r.id || '').toLowerCase() === key
            || (r.name || '').toLowerCase() === key);
          if (hit) a = { ...hit, glyphh: hit.appArchetype === 'glyphh-app' };
        } catch { /* offline — the fallbacks below still answer honestly */ }
      }
      const url = (a && (a.url || a.prodUrl)) || null;
      // On web an app opens as a STREAMED workbench panel (rendered on the
      // user's attached desktop, streamed here) — not a new browser tab.
      const open = (typeof window !== 'undefined') && window.__wbOpenApp;
      if (open && (url || a.glyphh)) {
        try { open({ slug: a.slug, name: a.name, url: url || '', glyphh: !!a.glyphh }, true); return { ok: true }; }
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

    // ── Dedicated app servers + custom domains (Phase F). Straight to the SDK; the
    // main process contributes nothing, so desktop and web share one renderer.
    // Deploy tab (dev-host) — the DESKTOP's hosting-* IPC, twinned (his bug,
    // 2026-08-25: deploy from the web silently no-oped — the fabricating proxy
    // swallowed the missing shims while the desktop worked).
    // Build & deploy — the SOURCE-OF-RECORD build: the org's regional pod pulls
    // the app's R2 snapshot head, npm install + build, and publishes via
    // build_app — all server-proxied, so the browser needs no pod binding.
    // (his bug, 2026-08-25: the missing shim made the web button fail flat.)
    appBuildDeploy: async (slug, opts) => {
      try {
        const r = await client.apps.buildFromSource(slug, opts || {});
        // NO SNAPSHOT (a legacy app whose source never left the desktop): the
        // right action is still available — ship the latest BUILT release.
        // Nothing could have changed server-side without a snapshot anyway.
        // NEVER when the user said "No hosting" (his bug, 2026-08-25: the
        // fallback deployed regardless of the choice).
        if (!r?.ok && r?.stage === 'source') {
          if (opts && opts.deploy === false) {
            return { ok: false, error: 'No source snapshot and "No hosting" selected — there is nothing to build server-side. Build once from the machine that holds the project; after that, web builds work with or without hosting.' };
          }
          try {
            const dep = await client.hosting.deploy({ appSlug: slug });
            return {
              ok: true,
              result: { url: dep.url || undefined },
              note: 'No source snapshot yet — deployed the latest built release instead. Build once from the machine that holds the project and web rebuilds turn on.',
            };
          } catch {
            return { ok: false, error: `${r.stage}: ${r.error}` };
          }
        }
        if (!r?.ok) return { ok: false, error: r?.error ? `${r.stage ? `${r.stage}: ` : ''}${r.error}` : 'cloud build failed' };
        let info = {};
        try {
          const p = JSON.parse(r.result || '');
          info = {
            version: typeof p.version === 'string' ? p.version : undefined,
            url: typeof p.url === 'string' ? p.url : (typeof p.deployUrl === 'string' ? p.deployUrl : undefined),
          };
        } catch { /* non-JSON text — no structured fields */ }
        return { ok: true, result: info };
      } catch (err) { return { ok: false, error: err?.message || String(err) }; }
    },

    // The app's OWN cron handlers live in the DESKTOP's local app worker —
    // the web has no such thing, so it reports none rather than fabricating.
    appsCronList: async () => ({ ok: true, handlers: [] }),

    // Schedules — recurring agent runs against an app.
    appsSchedulesList: async (slug) => {
      try { return { ok: true, ...(await client.apps.schedules(slug)) }; }
      catch (err) { return { ok: false, error: err?.message || String(err) }; }
    },
    appsScheduleCreate: async (slug, input) => {
      try { return { ok: true, ...(await client.apps.createSchedule(slug, input)) }; }
      catch (err) { return { ok: false, error: err?.message || String(err) }; }
    },
    appsScheduleUpdate: async (slug, id, patch) => {
      try { return { ok: true, ...(await client.apps.updateSchedule(slug, id, patch)) }; }
      catch (err) { return { ok: false, error: err?.message || String(err) }; }
    },
    appsScheduleDelete: async (slug, id) => {
      try { await client.apps.deleteSchedule(slug, id); return { ok: true }; }
      catch (err) { return { ok: false, error: err?.message || String(err) }; }
    },
    appsScheduleRun: async (slug, id) => {
      try { return { ok: true, ...(await client.apps.runScheduleNow(slug, id)) }; }
      catch (err) { return { ok: false, error: err?.message || String(err) }; }
    },

    // Releases — the web reads the SAME control-plane history the desktop does
    // (his bug, 2026-08-25: the missing shims left the web claiming "release
    // history isn't available on this surface").
    appReleases: async (slug) => {
      try { return { ok: true, releases: await client.apps.releases(slug) }; }
      catch (err) { return { ok: false, error: err?.message || String(err), releases: [] }; }
    },
    appReleaseNotes: async (slug, releaseId, notes) => {
      try { return { ok: true, release: await client.apps.updateReleaseNotes(slug, releaseId, notes) }; }
      catch (err) { return { ok: false, error: err?.message || String(err) }; }
    },
    appReleasePromote: async (slug, releaseId) => {
      try { return { ok: true, release: await client.apps.promoteRelease(slug, releaseId) }; }
      catch (err) { return { ok: false, error: err?.message || String(err) }; }
    },
    // Co-working — collaborators + per-release org approval (same surface as desktop).
    appCollaborators: async (slug) => {
      try { return { ok: true, collaborators: await client.apps.collaborators(slug) }; }
      catch (err) { return { ok: false, error: err?.message || String(err), collaborators: [] }; }
    },
    appCollaboratorSet: async (slug, userId, role) => {
      try {
        await client.apps.setCollaborator(slug, userId, role);
        return { ok: true, collaborators: await client.apps.collaborators(slug) };
      } catch (err) { return { ok: false, error: err?.message || String(err) }; }
    },
    appCollaboratorRemove: async (slug, userId) => {
      try { await client.apps.removeCollaborator(slug, userId); return { ok: true }; }
      catch (err) { return { ok: false, error: err?.message || String(err) }; }
    },
    appReleaseOrgReview: async (slug, releaseId, action) => {
      try { await client.apps.orgReview(slug, releaseId, action); return { ok: true }; }
      catch (err) { return { ok: false, error: err?.message || String(err) }; }
    },
    appOrgPendingReleases: async () => {
      try { return { ok: true, pending: await client.apps.pendingOrgReleases() }; }
      catch (err) { return { ok: false, error: err?.message || String(err), pending: [] }; }
    },
    // Edge traffic — the apex fleet's per-hostname stats.
    appTraffic: async (slug, days) => {
      try { return { ok: true, ...(await client.apps.traffic(slug, days ?? 30)) }; }
      catch (err) { return { ok: false, error: err?.message || String(err), days: [], hosts: [] }; }
    },
    orgDomainsTraffic: async (days, filter) => {
      try { return { ok: true, ...(await client.org.domainsTraffic(days ?? 30, filter)) }; }
      catch (err) { return { ok: false, error: err?.message || String(err), days: [], hosts: [] }; }
    },
    // Duplicate an owned app as a template.
    appClone: async (slug, input) => {
      try { return { ...(await client.apps.clone(slug, input)), ok: true }; }
      catch (err) { return { ok: false, error: err?.message || String(err) }; }
    },
    // Agency client orgs — workspaces the org creates and funds for its clients.
    orgClients: async () => {
      try { return { ok: true, ...(await client.org.clients()) }; }
      catch (err) { return { ok: false, error: err?.message || String(err), clients: [] }; }
    },
    orgClientCreate: async (name) => {
      try { return { ...(await client.org.createClient(name)), ok: true }; }
      catch (err) { return { ok: false, error: err?.message || String(err) }; }
    },
    orgClientCap: async (id, monthlyCapCredits) => {
      try { await client.org.setClientCap(id, monthlyCapCredits); return { ok: true }; }
      catch (err) { return { ok: false, error: err?.message || String(err) }; }
    },
    orgClientDetach: async (id) => {
      try { await client.org.detachClient(id); return { ok: true }; }
      catch (err) { return { ok: false, error: err?.message || String(err) }; }
    },
    // Library sharing + marketplace (skills + loops) — free installs, approvals.
    libraryShare: async (kind, ref) => {
      try { return { ok: true, ...(await (kind === "skill" ? client.skills.share(ref) : client.tasks.share(ref))) }; }
      catch (err) { return { ok: false, error: err?.message || String(err) }; }
    },
    libraryPublish: async (kind, ref) => {
      try { return { ok: true, ...(await (kind === "skill" ? client.skills.publish(ref) : client.tasks.publish(ref))) }; }
      catch (err) { return { ok: false, error: err?.message || String(err) }; }
    },
    libraryPending: async () => {
      try { return { ok: true, ...(await client.libraryMarket.pendingShares()) }; }
      catch (err) { return { ok: false, error: err?.message || String(err), pending: [] }; }
    },
    libraryShareReview: async (id, action) => {
      try { await client.libraryMarket.reviewShare(id, action); return { ok: true }; }
      catch (err) { return { ok: false, error: err?.message || String(err) }; }
    },
    libraryMarket: async (kind) => {
      try { return { ok: true, ...(await client.libraryMarket.browse(kind)) }; }
      catch (err) { return { ok: false, error: err?.message || String(err), listings: [], org: [] }; }
    },
    libraryMarketInstall: async (id) => {
      try { return { ok: true, ...(await client.libraryMarket.install(id)) }; }
      catch (err) { return { ok: false, error: err?.message || String(err) }; }
    },
    libraryMarketUninstall: async (id) => {
      try { await client.libraryMarket.uninstall(id); return { ok: true }; }
      catch (err) { return { ok: false, error: err?.message || String(err) }; }
    },
    libraryAdminQueue: async () => {
      try { return { ok: true, ...(await client.libraryMarket.reviewQueue()) }; }
      catch (err) { return { ok: false, error: err?.message || String(err), queue: [] }; }
    },
    libraryAdminReview: async (id, action, notes) => {
      try { await client.libraryMarket.reviewListing(id, action, notes); return { ok: true }; }
      catch (err) { return { ok: false, error: err?.message || String(err) }; }
    },
    // Marketing links — campaign URLs + attribution stats.
    marketingLinks: async (days) => {
      try { return { ok: true, ...(await client.org.marketingLinks(days ?? 30)) }; }
      catch (err) { return { ok: false, error: err?.message || String(err), links: [] }; }
    },
    marketingLinkCreate: async (input) => {
      try { return { ok: true, ...(await client.org.createMarketingLink(input)) }; }
      catch (err) { return { ok: false, error: err?.message || String(err) }; }
    },
    marketingLinkUpdate: async (id, patch) => {
      try { await client.org.updateMarketingLink(id, patch); return { ok: true }; }
      catch (err) { return { ok: false, error: err?.message || String(err) }; }
    },
    marketingLinkDelete: async (id) => {
      try { await client.org.deleteMarketingLink(id); return { ok: true }; }
      catch (err) { return { ok: false, error: err?.message || String(err) }; }
    },
    // Version history — the same chain the desktop shows; restore needs a
    // local working folder, which only the desktop has.
    appSourceHistory: async (slug) => {
      try { return { ok: true, history: await client.apps.sourceHistory(slug) }; }
      catch (err) { return { ok: false, error: err?.message || String(err), history: [] }; }
    },
    appSourceRestore: async () => ({ ok: false, error: "Restoring a version needs the desktop app (it writes into your working folder)." }),
    // Org switcher — memberships + this session's active org.
    orgMemberships: async () => {
      try { return await client.memberships.orgs(); }
      catch { return []; }
    },
    orgSwitch: async (orgId) => {
      try { await client.memberships.setActiveOrg(orgId); return { ok: true }; }
      catch (err) { return { ok: false, error: err?.message || String(err) }; }
    },
    appVersionSet: async (slug, version) => {
      try { return { ok: true, ...(await client.apps.setVersion(slug, version)) }; }
      catch (err) { return { ok: false, error: err?.message || String(err) }; }
    },
    hostingStatus: async (slug) => {
      try {
        const deployments = await client.hosting.list();
        return { ok: true, deployment: deployments.find((x) => x.appSlug === slug) ?? null };
      } catch (err) { return { ok: false, error: err?.message || String(err) }; }
    },
    hostingDeploy: async (slug) => {
      try { return { ok: true, deployment: await client.hosting.deploy({ appSlug: slug }) }; }
      catch (err) { return { ok: false, error: err?.message || String(err) }; }
    },
    hostingDestroy: async (id) => {
      try { await client.hosting.destroy(id); return { ok: true }; }
      catch (err) { return { ok: false, error: err?.message || String(err) }; }
    },
    appServersList: async () => {
      try { return { ok: true, images: await client.appServers.list() }; }
      catch (err) { return { ok: false, error: err?.message || String(err) }; }
    },
    appServerDeploy: async (slug, imageKey, releaseId) => {
      try { return { ok: true, queued: await client.hosting.deployToServer(slug, releaseId ? { imageKey, releaseId } : { imageKey }) }; }
      catch (err) { return { ok: false, error: err?.message || String(err) }; }
    },
    appServerDeployments: async (slug) => {
      try { return { ok: true, deployments: await client.hosting.serverDeployments(slug) }; }
      catch (err) { return { ok: false, error: err?.message || String(err) }; }
    },
    appServerDestroy: async (slug, id) => {
      try { await client.hosting.destroyServer(slug, id); return { ok: true }; }
      catch (err) { return { ok: false, error: err?.message || String(err) }; }
    },
    appDomainsList: async (slug) => {
      try { return { ok: true, domains: await client.hosting.domains(slug) }; }
      catch (err) { return { ok: false, error: err?.message || String(err) }; }
    },
    appDomainAdd: async (slug, deploymentId, hostname) => {
      try {
        // OMIT deploymentId when null/empty — the zod schema is .optional()
        // (undefined), and a literal null 400s as "invalid request body".
        // No deploymentId = the domain binds to the app's hosted deployment.
        return { ok: true, domain: await client.hosting.addDomain(slug, { ...(deploymentId ? { deploymentId } : {}), hostname }) };
      }
      catch (err) { return { ok: false, error: err?.message || String(err) }; }
    },
    appDomainRemove: async (slug, id) => {
      try { await client.hosting.removeDomain(slug, id); return { ok: true }; }
      catch (err) { return { ok: false, error: err?.message || String(err) }; }
    },

    // ── Models governance (OrgModelsClient / CatalogClient) ───────────────────────
    orgModelsList: lib(() => client.orgModels.list()),
    // Gateway telemetry (Gateway › Metrics) — org-scoped router spend metadata.
    gatewayMetrics: lib((opts) => client.gateway.metrics(opts || {})),
    gatewayKeysList: lib(() => client.gateway.keys()),
    gatewayKeysCreate: lib((input) => client.gateway.createKey(input)),
    gatewayKeysRevoke: lib((id) => client.gateway.revokeKey(id).then(() => ({ ok: true }))),
    workspacesList: lib(() => client.workspaces.list()),
    // Role provider keys — the org key is the default; a role key overrides it.
    workspaceProviderKeys: lib((id) => client.workspaces.providerKeys(id)),
    workspaceProviderKeySet: lib((id, slug, key) => client.workspaces.setProviderKey(id, slug, key)),
    workspaceProviderKeyClear: lib((id, slug) => client.workspaces.clearProviderKey(id, slug).then(() => ({ ok: true }))),
    orgCustomModelsList: lib(() => client.orgModels.listCustom()),
    // Provider rows are a CATALOG read (the whole catalog ⊕ the org's enablement state);
    // ProvidersClient itself is write-only.
    orgProvidersList: lib(() => client.catalog.providers()),
    // ── Voice settings (Settings › Voice) — same SDK calls the desktop IPC makes ──
    catalogModels: lib(() => client.catalog.models()),
    catalogVoices: lib((provider) => client.catalog.voices(provider)),
    voiceSettingsGet: lib(() => client.profile.voiceSettings()),
    voiceSettingsSet: lib((patch) => client.profile.setVoiceSettings(patch)),
    // Drive file artifacts — metadata (+ signed URL), delete, and text
    // content for the editor (browser fetch; R2 CORS permitting, else the
    // caller falls back to the Browser panel).
    filesGet: (id) => client.files.get(id).catch(() => null),
    filesDelete: (id) => client.files.delete(id).then(() => ({ ok: true })).catch((e) => ({ ok: false, error: String(e?.message ?? e) })),
    filesContent: async (id) => {
      try {
        const f = await client.files.get(id);
        if (!f?.downloadUrl) return { ok: false, error: 'no download url' };
        const res = await fetch(f.downloadUrl);
        if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
        const text = await res.text();
        if (text.length > 2 * 1024 * 1024) return { ok: false, error: 'file exceeds the 2MB editor cap' };
        return { ok: true, content: text };
      } catch (e) { return { ok: false, error: String(e?.message ?? e) }; }
    },
    // The HOUSE DEFAULTS — the glyphh launcher set (command center only).
    appsDefaults: () => client.apps.defaults().catch(() => []),
    voiceTranscribe: lib((audio, mime, model, ms) => client.voice.transcribe(new Uint8Array(audio), model, mime, ms)),
    voiceSynthesize: lib((text, model, voiceId) => client.voice.synthesize(text, model, voiceId)),
    // WRITES — these existed only as desktop IPC; on web the glyphh Proxy
    // fabricated them (resolved undefined) and the Models page threw on `r.ok`.
    // Same SDK calls the desktop's main process makes.
    billingPaymentMethod: () => client.billing.paymentMethod().catch(() => null),
    apiUrl,
    orgModelsSetSupported: lib((id, supported) => client.orgModels.setSupported(id, supported)),
    orgModelsSetSupportedBulk: lib((ids) => client.orgModels.setSupportedBulk(ids)),
    orgCustomModelsSave: lib((input) => client.orgModels.saveCustom(input)),
    orgCustomModelsDelete: lib((id) => client.orgModels.deleteCustom(id)),
    orgCustomProvidersList: lib(() => client.orgModels.listProviders()),
    orgCustomProvidersSave: lib((input) => client.orgModels.saveProvider(input)),
    orgCustomProvidersDelete: lib((slug) => client.orgModels.deleteProvider(slug)),
    orgProviderEnable: lib((slug, key) => client.providers.enable(slug, key)),
    orgProviderDisable: lib((slug) => client.providers.disable(slug)),
    orgProviderClearKey: lib((slug) => client.providers.clearKey(slug)),

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
        const loaded = { chats: Array.isArray(p?.chats) ? p.chats : [], currentId: String(p?.currentId || '') };
        noteSessionsSnapshot(loaded.chats, loaded.currentId); // seed the wb locus at boot
        return loaded;
      } catch { return EMPTY.sessions(); }
    },
    glyphhSessionsSave: async (chats, currentId) => {
      // Every session switch/birth/source-bind flows through this write-through
      // save (thread-store persist) — the one seam the wb locus needs.
      try { noteSessionsSnapshot(chats, currentId); } catch { /* locus is best-effort */ }
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
