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
  toAccountInfo,
  toDashboardData, emptyDashboardData,
} from './glyphh-core.js';
// STANDARD drip effects ship with the product — the same shared catalog +
// generators the desktop main process uses (electron-free by design).
import { BUILTIN_EFFECT_LIST } from '../../src/shared/drip-effects';
import { WS_STATE_PREF, WS_STATE_BUDGET, trimWsState } from '../../src/shared/ui-state-trim';
// DOM-free at import time; only running a recipe touches the document.
import { runDripRecipe, stopAllDrips } from './drip-web-runner.js';
import { webIconProxyPath } from '../webicon.mjs';
// The workbench locus tracker: every session-cache load/save below feeds it, so
// window.wb can route Files/Diff/Editor to the CURRENT session's workspace
// (cloud pod vs attached desktop) without touching the renderer (wb-pod.js).
import { noteSessionsSnapshot } from './wb-pod.js';
// THE MEMBER LIBRARY (his rule, 2026-10-04: database-as-truth): workspaces,
// tabs, skills, agents and tasks read the server FIRST and write to it; the
// desktop pulls what the web wrote on its next sync (member-library-web.js).
import { iconForRow } from './web-icons.js';
import { buildMemberLibrary, NEEDS_DESKTOP } from './member-library-web.js';
// THE HOUSE APPS' files off the attached desktop (his order, 2026-10-05).
import { createHouseStoreWeb } from './house-store-web.js';
import { askBrowserNotificationPermission, showBrowserNotification, watchNotifications } from './notify-web.js';

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
/** main/loop-models.ts's mapping, verbatim: chat models only, the auto-router
 *  as "Auto", one row per name, provider-then-name order. Exported for its test. */
export function toLoopModels(rows) {
  const seen = new Set();
  return (Array.isArray(rows) ? rows : [])
    .filter((m) => m && m.modality === 'chat')
    .map((m) => ({
      id: m.name, name: m.autoRouter ? 'Auto' : m.name, providerSlug: m.autoRouter ? 'auto' : m.providerSlug,
      ...(typeof m.reasoning === 'boolean' ? { reasoning: m.reasoning } : {}),
      ...(typeof m.freePlan === 'boolean' ? { freePlan: m.freePlan } : {}),
      // The utility-model rule reads these (renderer help/utility-model.ts, his
      // order 2026-10-05): the console's Utility flag, else the cheapest by price.
      modality: m.modality,
      ...(typeof m.utility === 'boolean' ? { utility: m.utility } : {}),
      ...(typeof m.inputUsdPerMTok === 'number' ? { inputUsdPerMTok: m.inputUsdPerMTok } : {}),
      ...(typeof m.outputUsdPerMTok === 'number' ? { outputUsdPerMTok: m.outputUsdPerMTok } : {}),
    }))
    .filter((m) => {
      const key = String(m.name ?? m.id).trim().toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => a.providerSlug.localeCompare(b.providerSlug) || a.name.localeCompare(b.name));
}
const MODELS_TTL_MS = 60_000;
let modelsCache = null;

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


  // THE MEMBER LIBRARY IS THE ONE LIST (his order, 2026-10-06): every record
  // is on the server; a desktop syncs its rows there and the web reads them
  // there. Nothing is read off a desktop over the relay — the relay drives a
  // session on a desktop, it carries no data.
  const library = buildMemberLibrary(client, { apiUrl });
  const { layoutsList, panelAppsList } = library;
  const house = createHouseStoreWeb({ client, apiUrl });

  // Per-loop model picks — the web's counterpart of the desktop's main-process
  // selection store. { [loop]: { [role]: modelId } } in localStorage.
  const LOOP_SELECTIONS_KEY = 'glyphh.loopSelections';
  const loopSelections = () => {
    try { return JSON.parse(localStorage.getItem(LOOP_SELECTIONS_KEY) || '{}') || {}; }
    catch { return {}; }
  };

  // THE CLOUD FS/GIT LANE (desktop: main/cloud-fs.ts over IPC; here the SDK's
  // harness client answers directly — the same calls web/src/wb-pod.js makes).
  // Every failure rides IN the shape, as on the desktop; a scope is required.
  const pod = () => {
    if (typeof client?.harnessViaApi !== 'function') throw new Error('no cloud runtime transport');
    return client.harnessViaApi();
  };
  const laneErr = (e) => (e instanceof Error ? e.message : String(e));
  // A named cloud environment as the renderer reads it (contract/environments.ts
  // EnvironmentSummary / Environment): the row, and the row + masked vars.
  const envPath = (id) => `/api/environments/${encodeURIComponent(String(id || ''))}`;
  const envRow = (r) => ({ id: String(r?.id ?? ''), name: String(r?.name ?? ''), network: r?.network ?? 'full', varCount: Number(r?.varCount ?? 0) });
  const envDetail = (d) => ({
    ...envRow(d),
    vars: (Array.isArray(d?.vars) ? d.vars : []).filter((v) => typeof v?.key === 'string').map((v) => ({ key: String(v.key), preview: String(v.preview ?? '•••••') })),
  });
  const lane = (run, onError) => async (scope, ...rest) => {
    if (!scope) return onError('no cloud session');
    try { return await run(pod(), String(scope), ...rest); } catch (e) { return onError(laneErr(e)); }
  };
  return {
    cloudFsInfo: lane(async (hc, scope) => { const r = await hc.fsInfo({ scope }); return { root: String(r?.root || ''), isRepo: !!r?.isRepo, ...(r?.branch ? { branch: String(r.branch) } : {}) }; }, (error) => ({ root: '', isRepo: false, error })),
    cloudFsList: lane((hc, scope, dir) => hc.fsList({ scope, ...(dir ? { dir: String(dir) } : {}) }), (error) => ({ entries: [], error })),
    cloudFsRead: lane((hc, scope, path) => hc.fsRead({ scope, path: String(path ?? '') }), (error) => ({ content: '', error })),
    cloudFsWrite: lane((hc, scope, path, content) => hc.fsWrite({ scope, path: String(path ?? ''), content: typeof content === 'string' ? content : '' }), (error) => ({ ok: false, error })),
    cloudFsSearch: lane((hc, scope, query) => hc.fsSearch({ scope, query: String(query ?? '') }), (error) => ({ entries: [], error })),
    cloudFsEvents: lane((hc, scope, from) => hc.fsEvents({ scope, from: typeof from === 'number' ? from : -1 }), (error) => ({ seq: -1, events: [], error })),
    cloudGitInfo: lane(async (hc, scope) => { const r = await hc.fsInfo({ scope }); return { isRepo: !!r?.isRepo, ...(r?.branch ? { branch: String(r.branch) } : {}) }; }, (error) => ({ isRepo: false, error })),
    cloudGitDiff: lane((hc, scope) => hc.fsDiff({ scope }), (error) => ({ text: '', error })),
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
        client.appInstances.list().catch(() => null), // the cloud apps this member may open
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
    getPreference: async (key, defaultVal) => {
      const map = await prefsCache.get();
      return key in map ? map[key] : (defaultVal === undefined ? null : defaultVal);
    },
    getPreferences: async () => ({ ...(await prefsCache.get()) }),
    setPreference: (key, value) => prefsCache.set(key, value),
    getTheme: async () => (await prefsCache.get()).theme ?? 'dark',
    setTheme: (theme) => prefsCache.set('theme', theme),
    // getBackgroundMode/setBackgroundMode are deliberately NOT here: "keep
    // running in the background" is the desktop's tray + login item, which a
    // browser tab cannot do — so `glyphhWeb.has('setBackgroundMode')` is false
    // and Settings → General hides the row (help/settings.ts).

    // ── THE HOUSE APPS — Design, Slides, Images, Video, Audio, Drive ──────────────
    // (his order, 2026-10-06: cloud is the one home): the web's own panels
    // over the member library — the same store the desktop's panels read
    // (shared/house-store.ts, house-store-web.js). Same wire shapes as the
    // desktop preload; reads and writes alike.
    ...house,

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
    gdocTemplates: async () => {
      try { return { ok: true, templates: await client.officeDocs.templates() }; }
      catch (err) { return { ok: false, error: err?.message ?? String(err), templates: [] }; }
    },

    // ── Connections (ConnectionsClient) ──────────────────────────────────────────
    connectionsList: read(() => client.connections.resolvedTools(), toLegacyConnections, EMPTY.connections),
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
        const before = new Set((await client.connections.personalList().catch(() => [])).map((c) => c.id));
        const session = await client.connections.personalConnect(appSlug);
        if (!session?.connectUrl) { popup.close(); return { ok: false, error: 'Failed to get connect token' }; }
        popup.location = session.connectUrl;
        const landed = async () => {
          const now = await client.connections.personalList().catch(() => []);
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
    loopsList: read(() => client.loops.list(), toLegacyLoops, EMPTY.loops),
    // (loop, force?, context?) — force is meaningless here (no main-process
    // cache on web); context="cloud" resolves without on-device models, whose
    // weights only exist on a desktop machine.
    loopRoles: (loop, _force, context) =>
      read(() => client.loops.roles(loop, loopSelections()[loop] || {}, context === "cloud" ? { context: "cloud" } : {}), (roles) => toLegacyLoopRoles(loop, roles), (error) => EMPTY.loopRoles(loop, error))(),
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
        const roles = await client.loops.roles(loop, forLoop);
        return toLegacyLoopRoles(loop, roles);
      } catch (err) {
        return EMPTY.loopRoles(loop, err?.message || String(err));
      }
    },
    libraryLoopGet: lib((ref) => client.loops.get(ref)),
    // Mirror of the desktop's loop-set-role-default IPC: read the loop, patch
    // the role slot's default in the manifest, write it back. Pure SDK — the
    // web bridge lacked this, so changing a model in a loop crashed on web.
    loopSetRoleDefault: async (loopId, role, modelId) => {
      try {
        const loop = await client.loops.get(loopId);
        const manifest = { ...(loop.manifest ?? {}) };
        const roles = Array.isArray(manifest.roles) && manifest.roles.length
          ? manifest.roles.map((r) => ({ ...r }))
          : [{ name: 'default', label: 'Model', description: 'The model this loop runs on.' }];
        const slot = roles.find((r) => r.name === role);
        if (slot) slot.default = modelId ?? null;
        else roles.push({ name: role, default: modelId ?? null });
        await client.loops.update(loop.id ?? loopId, { manifest: { ...manifest, roles } });
        return { ok: true };
      } catch (e) {
        return { ok: false, error: String((e && e.message) || e) };
      }
    },

    // ── The shared (org) library's skills — the legacy surface, untouched ─────
    librarySkillsList: lib(() => client.skills.list()),
    librarySkillGet: lib((ref) => client.skills.get(ref)),

    // ── THE MEMBER LIBRARY (member-library-web.js): skills, tasks and agents
    // read from and written to the server; what needs the machine (a run, a
    // schedule, a folder dialog) answers NEEDS_DESKTOP per action. ──
    skillsList: library.skillsList,
    skillGet: library.skillGet,
    skillFileRead: library.skillFileRead,
    skillFileWrite: library.skillFileWrite,
    skillCreate: library.skillCreate,
    skillDelete: library.skillDelete,
    appInstancePin: library.appInstancePin,
    appInstanceUpdate: library.appInstanceUpdate,
    appInstancesUpdateAll: library.appInstancesUpdateAll,
    skillSetEnabled: library.skillSetEnabled,
    skillAgents: library.skillAgents,
    skillAgentSet: library.skillAgentSet,
    skillReveal: library.skillReveal,
    skillImport: library.skillImport,
    skillReplace: library.skillReplace,
    skillDownload: library.skillDownload,
    skillAdopt: library.skillAdopt,
    skillTab: library.skillTab,
    // APPS LIVE IN THE CLOUD (2026-10-04): a Glyphh-app panel loads the
    // instance's UI through this origin's /app-host proxy.
    glyphhAppPreviewOpen: library.glyphhAppPreviewOpen,
    glyphhAppPreviewClear: library.glyphhAppPreviewClear,
    skillImage: library.skillImage,
    skillsHome: library.skillsHome,
    libraryAgentsList: library.libraryAgentsList,
    libraryAgentGet: library.libraryAgentGet,
    libraryAgentTasks: library.libraryAgentTasks,
    libraryAgentTaskAdd: library.libraryAgentTaskAdd,
    libraryAgentTaskUpdate: library.libraryAgentTaskUpdate,
    libraryAgentTaskRunNow: library.libraryAgentTaskRunNow,
    libraryAgentTaskRuns: library.libraryAgentTaskRuns,
    libraryAgentTaskRunning: library.libraryAgentTaskRunning,
    tasksSpecs: library.tasksSpecs,
    taskSpec: library.taskSpec,
    taskSlotSet: library.taskSlotSet,
    taskRun: library.taskRun,
    taskRuns: library.taskRuns,
    taskRunGet: library.taskRunGet,
    taskRunCancel: library.taskRunCancel,
    skillsDiscover: library.skillsDiscover,
    skillUpdates: library.skillUpdates,
    skillShares: library.skillShares,
    skillStandings: library.skillStandings,
    skillVersions: library.skillVersions,
    hubCategories: library.hubCategories,
    skillInstall: library.skillInstall,
    skillUpdate: library.skillUpdate,
    skillHubFiles: library.skillHubFiles,
    skillCategoriesSet: library.skillCategoriesSet,
    skillPublish: library.skillPublish,
    skillWithdraw: library.skillWithdraw,
    skillVersionFiles: library.skillVersionFiles,
    appInstanceReleases: library.appInstanceReleases,
    skillComments: library.skillComments,
    skillCommentAdd: library.skillCommentAdd,
    skillLifecycle: library.skillLifecycle,
    skillSubmitPublic: library.skillSubmitPublic,
    skillWithdrawPublic: library.skillWithdrawPublic,
    libraryQueue: library.libraryQueue,
    libraryDecide: library.libraryDecide,
    libraryVersionFiles: library.libraryVersionFiles,
    // Schedules are records of the member library (2026-10-04); the runs and
    // "run now" are the desktop's clock until the cloud clock exists.
    schedulesList: library.schedulesList,
    scheduleRecentRuns: library.scheduleRecentRuns,
    scheduleRuns: library.scheduleRuns,
    scheduleSave: library.scheduleSave,
    scheduleDelete: library.scheduleDelete,
    scheduleSetEnabled: library.scheduleSetEnabled,
    scheduleRunNow: library.scheduleRunNow,

    // ── Library grids (layouts / drips) ───────────────────────────────────────────
    // Workspaces: the server's records first, then an attached desktop's (see
    // layoutsList above). A save or delete WRITES THE SERVER at this client's
    // clock; the desktop pulls it on its next sync (main/library-sync.ts).
    layoutsList,
    layoutsSaveGrid: library.layoutsSaveGrid,
    layoutsDelete: library.layoutsDelete,
    // Drip presets are member-library records too (2026-10-04): read and
    // written on the server; the desktop's table follows on its next sync.
    dripsList: library.dripsList,
    dripsSave: library.dripsSave,
    dripsDelete: library.dripsDelete,
    // The standard effects are code, not a cloud read — same catalog as the
    // desktop IPC (one-shots then loops, 'timme' hidden). Fresh objects so a
    // caller can never mutate the shared catalog.
    dripsBuiltinEffects: async () => BUILTIN_EFFECT_LIST.map((fx) => ({ ...fx })),
    // Drips RENDER HERE on web: the recipe plays in a sandboxed full-viewport
    // iframe overlay (see drip-web-runner.js) — no machine needed. Stop tears
    // every overlay down (a looping effect must have its off switch here too).
    dripsPreview: async (recipe) => runDripRecipe(recipe),
    dripsStop: async () => { stopAllDrips(); return 'stopped'; },

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
          const rows = await panelAppsList();
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

    // The LAUNCHER list: the attached desktops' app tabs (the member's real
    // rows), then every app the org owns or installed server-side. See
    // panelAppsList above.
    panelAppsList,
    // A tab made, changed or deleted here WRITES THE SERVER record (its
    // config vars never ride — they stay on the machine that set them); the
    // desktop pulls the row on its next sync.
    panelAppsCreate: library.panelAppsCreate,
    panelAppsUpdate: library.panelAppsUpdate,
    panelAppsDelete: library.panelAppsDelete,

    // The old `/api/apps/*` lane (client.apps / client.hosting / client.appServers —
    // config vars, build + deploy, schedules, releases, collaborators, org review,
    // per-app traffic, clone, source history, hosting, app servers, domains) left
    // the SDK on 2026-10-06; the server no longer serves it. Nothing here shims it.

    // Edge traffic — the apex fleet's per-hostname stats (org-wide).
    orgDomainsTraffic: async (days, filter) => {
      try { return { ok: true, ...(await client.org.domainsTraffic(days ?? 30, filter)) }; }
      catch (err) { return { ok: false, error: err?.message || String(err), days: [], hosts: [] }; }
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
      try { return { ok: true, ...(await (kind === "skill" ? client.skills.share(ref) : client.loops.share(ref))) }; }
      catch (err) { return { ok: false, error: err?.message || String(err) }; }
    },
    libraryPublish: async (kind, ref) => {
      try { return { ok: true, ...(await (kind === "skill" ? client.skills.publish(ref) : client.loops.publish(ref))) }; }
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
    // Org switcher — memberships + this session's active org.
    orgMemberships: async () => {
      try { return await client.memberships.orgs(); }
      catch { return []; }
    },
    orgSwitch: async (orgId) => {
      try { await client.memberships.setActiveOrg(orgId); return { ok: true }; }
      catch (err) { return { ok: false, error: err?.message || String(err) }; }
    },

    // ── Models governance (OrgModelsClient / CatalogClient) ───────────────────────
    orgModelsList: lib(() => client.orgModels.list()),
    orgCustomModelsList: lib(() => client.orgModels.listCustom()),
    // Provider rows are a CATALOG read (the whole catalog ⊕ the org's enablement state);
    // ProvidersClient itself is write-only.
    orgProvidersList: lib(() => client.catalog.providers()),
    // ── Voice settings (Settings › Voice) — same SDK calls the desktop IPC makes ──
    catalogModels: lib(() => client.catalog.models()),
    catalogVoices: lib((provider) => client.catalog.voices(provider)),
    voiceConfig: lib(() => client.http.get('/api/voice/config').then((r) => (r && typeof r === 'object' && 'data' in r ? r.data : r))),
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

    // ── The composer's model list + plan gates ─────────────────────────────────────
    // THE SAME ANSWER main gives (src/main/loop-models.ts listLoopModels): the
    // server's `models.available()` — the team's list, public names — narrowed
    // to chat models, the auto-router named "Auto", deduped by name, sorted by
    // provider then name; 60 s cache, `force` bypasses it. No gateway creds on
    // web, so baseUrl is null. A failed read is the honest `source: "none"` shape.
    loopModels: async (_loopId, force) => {
      if (!force && modelsCache && Date.now() - modelsCache.at < MODELS_TTL_MS) return modelsCache.value;
      let value;
      try {
        const rows = await client.models.available();
        value = { ok: true, source: 'gateway', baseUrl: null, models: toLoopModels(rows) };
        modelsCache = { at: Date.now(), value };
      } catch (err) {
        value = { ok: false, source: 'none', baseUrl: null, models: [], error: err?.message ?? String(err) };
      }
      return value;
    },
    /** What this org's plan allows (SDK plans.gates() — main's plan-gates IPC
     *  is the same pass-through). The renderer's plan-gate.ts falls back to
     *  its CLOSED gates on a throw, so this one may throw. */
    planGates: () => client.plans.gates(),
    /** Main pushes this when the server moves the list; the web has no push
     *  seam yet (the composer re-reads on focus + open). An explicit no-op
     *  subscription, so `has('onModelsChanged')` is honest. */
    onModelsChanged: () => () => {},

    // WHERE THE MEMBER STANDS ON MONEY (his report, 2026-10-07: the usage ring
    // said "not available" on the web — the page had no door). The same
    // server read the desktop's main/spend-state.ts makes, the same shape.
    spendState: async () => {
      try {
        const raw = await client.http.get('/api/me/spend-state');
        const d = raw && typeof raw === 'object' && 'data' in raw ? raw.data : raw;
        const o = d && typeof d === 'object' ? d : {};
        return { ok: true, hasPlan: o.hasPlan !== false, plan: String(o.plan ?? ''), canManage: !!o.canManage, tightest: o.tightest ?? null };
      } catch {
        return { ok: false, hasPlan: true, plan: '', canManage: false, tightest: null };
      }
    },
    // ── Is a desktop attached, and which (attach.status, the server's own
    // answer). The one thing the web asks about a desktop: a Code session on a
    // desktop folder runs there over the relay. No attach client, nothing
    // attached, a dead answer → honest empties, never a throw.
    attachStatus: async () => {
      const attach = client.attach;
      if (!attach || typeof attach.status !== 'function') return { attached: false, machines: [] };
      try {
        const st = await attach.status();
        const machines = (Array.isArray(st?.machines) ? st.machines : [])
          .map((m) => ({ id: String(m?.id || ''), name: String(m?.name || m?.app || '') }))
          .filter((m) => !!m.id);
        return { attached: !!st?.attached && machines.length > 0, ...(typeof st?.allowed === 'boolean' ? { allowed: st.allowed } : {}), machines };
      } catch { return { attached: false, machines: [] }; }
    },
    // ── THE CLOUD SESSION'S CHIPS (his report, 2026-10-05: "how does the user
    // pick a new cloud env or connect github?") — the SDK's `git` and
    // `environments` resources for help/cloud-chips.ts, the same calls the
    // phone's doors make (mobile-git.ts, mobile-environments.ts). A bundled
    // SDK older than the typed doors (git.complete / git.branches /
    // environments) is served through its raw authenticated `http` instead,
    // so the renderer works against either. Reads resolve to honest empties;
    // writes throw the SDK's ApiError (its `httpStatus` names the verdict —
    // help/cloud-source.ts gitCompleteError / environmentSaveError).
    cloudGitStatus: async () => {
      try {
        const st = await client.git.status();
        return { connected: !!st?.connected, login: st?.login ?? null, pending: !!st?.pending };
      } catch { return { connected: false, login: null, pending: false }; }
    },
    cloudGitConnect: async (returnTo) => {
      const r = await client.http.post('/api/git/connect', returnTo ? { returnTo: String(returnTo) } : {});
      return { url: String(r?.url || '') };
    },
    cloudGitComplete: async (link) => {
      const st = typeof client.git?.complete === 'function'
        ? await client.git.complete(link || undefined)
        : await client.http.post('/api/git/connect/complete', link ? { link: String(link) } : {});
      return { connected: !!st?.connected, login: st?.login ?? null, pending: !!st?.pending };
    },
    cloudGitRepos: async () => {
      try { const list = await client.git.repos(); return Array.isArray(list) ? list : []; }
      catch { return []; }
    },
    // The repo's branches, the default first; a server without the door yet
    // answers the repo's default branch as the one row.
    cloudGitBranches: async (repo, defaultBranch) => {
      const [owner, name] = String(repo || '').split('/');
      try {
        const rows = typeof client.git?.branches === 'function'
          ? await client.git.branches(String(repo))
          : await client.http.get(`/api/git/repos/${encodeURIComponent(owner || '')}/${encodeURIComponent(name || '')}/branches`);
        const list = (Array.isArray(rows) ? rows : [])
          .filter((b) => typeof b?.name === 'string' && b.name)
          .map((b) => ({ name: String(b.name), default: !!b.default }));
        if (list.length) return list;
      } catch { /* no branches door yet */ }
      return [{ name: String(defaultBranch || 'main'), default: true }];
    },
    cloudGitDisconnect: () => client.git.disconnect(),
    cloudEnvironmentsList: async () => {
      try {
        const rows = client.environments ? await client.environments.list() : await client.http.get('/api/environments');
        return (Array.isArray(rows) ? rows : []).map(envRow).filter((r) => r.id);
      } catch { return []; }
    },
    cloudEnvironmentsGet: async (id) => envDetail(client.environments ? await client.environments.get(String(id)) : await client.http.get(envPath(id))),
    cloudEnvironmentsCreate: async (input) => envDetail(client.environments ? await client.environments.create(input) : await client.http.post('/api/environments', input)),
    cloudEnvironmentsUpdate: async (id, input) => envDetail(client.environments ? await client.environments.update(String(id), input) : await client.http.put(envPath(id), input)),
    cloudEnvironmentsDelete: async (id) => { if (client.environments) await client.environments.delete(String(id)); else await client.http.del(envPath(id)); },

    // ── Settings → Devices (his order, 2026-10-04) ─────────────────────────────────
    // main/remote-control.ts's three IPC answers, off the SDK handle: the server's
    // /api/attach/devices (attached machines + the ones disconnected from the web),
    // Disconnect by machine id, Allow by the stable device key. A server without
    // the routes yet (404) lists attach.status's machines instead.
    attachDevicesList: async () => {
      try {
        const r = await client.http.get('/api/attach/devices');
        return { source: 'devices', ...(typeof r?.allowed === 'boolean' ? { allowed: r.allowed } : {}), devices: Array.isArray(r?.devices) ? r.devices : [], blocked: Array.isArray(r?.blocked) ? r.blocked : [] };
      } catch (err) {
        if (Number(err?.httpStatus) !== 404) throw err;
        const st = await client.attach.status();
        return { source: 'status', ...(typeof st?.allowed === 'boolean' ? { allowed: st.allowed } : {}), devices: Array.isArray(st?.machines) ? st.machines : [], blocked: [] };
      }
    },
    attachDeviceDisconnect: (machineId) => client.http.post(`/api/attach/devices/${encodeURIComponent(String(machineId || ''))}/disconnect`),
    attachDeviceAllow: (device) => client.http.post(`/api/attach/devices/${encodeURIComponent(String(device || ''))}/allow`),
    // Vendor marks (the rail's recents, the wall's CLI tiles, the dock): the
    // desktop fetches them in main; the browser cannot — the vendors refuse a
    // cross-origin fetch — so an allowlisted mark comes from OUR origin through
    // the front door's /webicon proxy (web/webicon.mjs), same-origin, no CORS.
    // Any other URL (an app's icon on our CORS-open resolver) is still tried
    // directly; a refusal answers "" and the caller shows its letter.
    webIconFetch: async (url) => {
      try {
        const proxied = webIconProxyPath(url);
        const res = await fetch(proxied ?? url, proxied ? { credentials: "same-origin" } : { mode: "cors" });
        if (!res.ok) return "";
        const blob = await res.blob();
        return await new Promise((resolve) => { const r = new FileReader(); r.onload = () => resolve(String(r.result || "")); r.onerror = () => resolve(""); r.readAsDataURL(blob); });
      } catch { return ""; }
    },
    iconForRow, // an app row's tile src on the web (web-icons.js): its carried bytes, else its favicon via /webicon
    getWorkingDir: async () => null,
    getWorkingDirRecents: async () => EMPTY.list(),
    localMcpStatus: async () => ({ running: false, port: null }),
    localMcpTokensList: async () => EMPTY.list(),

    // ── The preload's STRING properties ────────────────────────────────────────────
    // preload.ts exposes these as plain strings; the Proxy would otherwise answer
    // each with a FUNCTION (truthy, so `x || fallback` kept the function and a link
    // became "function () {...}"). The web's platform is this origin's /platform.
    apiUrl,
    serverUrl: apiUrl,
    platformUrl: typeof location !== 'undefined' && location.origin ? `${location.origin}/platform` : 'https://platform.glyphh.ai',
    discordInvite: 'https://discord.gg/P3yynv4v9',

    // ── Custom MCP connections: the WRITE side (connections.ts) ────────────────────
    // main/mcp-connections.ts keeps a local cache + dials the server itself; on web
    // the SERVER is the only copy, so each is the SDK call main makes, in main's
    // {ok, …} shapes. Tools come from the server's probe of the endpoint.
    mcpConnectionsCreate: async (fields) => {
      try {
        const name = String(fields?.name ?? '').trim();
        const url = String(fields?.url ?? '').trim();
        if (!name || !url) return { ok: false, error: 'name and server URL (or command) are required' };
        const headers = fields?.headers && typeof fields.headers === 'object' ? fields.headers : {};
        const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'mcp';
        const created = await client.connections.personalMcpCreate({ slug, name, url, ...(Object.keys(headers).length ? { headers } : {}) });
        const finalSlug = created?.connection?.slug ?? slug;
        let toolCount = 0;
        try { toolCount = (await client.connections.mcpTools(finalSlug)).length; } catch { /* the detail view reports reachability */ }
        return { ok: true, connection: { slug: finalSlug, name }, toolCount };
      } catch (err) { return { ok: false, error: err?.message ?? String(err) }; }
    },
    mcpConnectionsUpdate: async (slug, fields) => {
      try {
        const patch = {};
        if (fields?.name !== undefined) patch.name = String(fields.name);
        if (fields?.url !== undefined && String(fields.url).trim()) patch.url = String(fields.url).trim();
        if (fields?.enabled !== undefined) patch.enabled = fields.enabled !== false;
        if (Array.isArray(fields?.hiddenTools)) patch.hiddenTools = fields.hiddenTools.map(String);
        if (fields?.headers && typeof fields.headers === 'object' && Object.keys(fields.headers).length) patch.headers = fields.headers;
        const r = await client.connections.personalMcpUpdate(String(slug), patch);
        return { ok: true, connection: r?.connection ?? { slug: String(slug), ...patch } };
      } catch (err) { return { ok: false, error: err?.message ?? String(err) }; }
    },
    mcpConnectionsDelete: async (slug) => {
      try { await client.connections.personalMcpRemove(String(slug)); return { ok: true }; }
      catch (err) { return { ok: false, error: err?.message ?? String(err) }; }
    },
    // The desktop DIALS the endpoint itself; a browser cannot. The server's org
    // probe answers for an org server; a personal one reads from the member's
    // RESOLVED tool set (the server already probed it when it was enabled).
    mcpConnectionsTools: async (slug) => {
      const key = String(slug);
      try {
        const tools = await client.connections.mcpTools(key);
        return { ok: true, tools: (tools ?? []).map((t) => ({ name: t.name, description: t.description ?? '', hidden: !!t.hidden })) };
      } catch (orgErr) {
        try {
          const { connections } = await client.connections.resolvedTools();
          const c = (connections ?? []).find((x) => x.slug === key);
          if (!c) return { ok: false, error: orgErr?.message ?? String(orgErr), tools: [] };
          const granted = new Set((c.tools ?? []).map((t) => t.name));
          return { ok: true, tools: (c.availableTools ?? c.tools ?? []).map((t) => ({ name: t.name, description: t.description ?? '', hidden: !granted.has(t.name) })) };
        } catch (err) { return { ok: false, error: err?.message ?? String(err), tools: [] }; }
      }
    },
    // The org catalog died with the server — main's answer, verbatim.
    mcpConnectionsInstall: async () => ({ ok: false, error: 'the org catalog is retired — add servers directly with + Custom MCP' }),

    // ── Connector discovery (settings-connections.ts) — main/connectors.ts's shapes ─
    connectorsGetPopular: async () => {
      try {
        const { apps } = await client.connections.popular(6);
        return (apps ?? []).map((a) => ({ id: a.id, name: a.name, description: a.description ?? '', icon: a.icon ?? undefined, categories: a.categories ?? [], installs: a.installs ?? 0 }));
      } catch { return []; }
    },
    connectorsGetCategories: async () => {
      try {
        const { categories } = await client.connections.categories();
        return (categories ?? []).map((c) => ({ name: c.name, count: c.count, apps: (c.apps ?? []).map((a) => ({ id: a.id, name: a.name, description: a.description ?? '', icon: a.icon ?? undefined, categories: a.categories ?? [] })) }));
      } catch { return []; }
    },

    // ── Library agents: the WRITE side (settings-agents.ts) ───────────────────────
    libraryAgentCreate: library.libraryAgentCreate,
    libraryAgentUpdate: library.libraryAgentUpdate,
    libraryAgentDelete: library.libraryAgentDelete,

    // ── Desktop releases (Settings → Download) — main/account-ipc.ts's shapes ─────
    releasesList: async () => {
      try { return { ok: true, releases: await client.releases.list() }; }
      catch (err) { return { ok: false, error: err?.message ?? String(err) }; }
    },
    releasesAssetUrl: async (tag, name) => {
      try { return { ok: true, url: (await client.releases.assetUrl(String(tag || ''), String(name || ''))).url }; }
      catch (err) { return { ok: false, error: err?.message ?? String(err) }; }
    },

    // ── Artifacts (files.ts): the server's file list; a peek is the opening text ──
    filesList: async () => { try { return await client.files.list(); } catch { return []; } },
    filesPeek: async (id) => {
      try {
        const f = await client.files.get(id);
        if (!f?.downloadUrl) return '';
        const res = await fetch(f.downloadUrl);
        if (!res.ok) return '';
        return (await res.text()).slice(0, 600);
      } catch { return ''; }
    },

    // ── The workbench's UI state (help/ui-state.ts) ───────────────────────────────
    // THE DESKTOP keeps it in ~/.glyphh/workspaces/*/state.json (main/workspace-
    // state.ts). A browser tab has no disk: the map rides the member's SERVER
    // prefs under the key ui-state.ts already migrates FROM (`workbenchUiState`),
    // so a web arrangement survives a reload and the desktop can seed from it.
    // Server prefs are small: the map is trimmed oldest-first (by its `at` write
    // stamp) to WS_STATE_BUDGET before a save, as the old server store was.
    wsStateLoad: async () => {
      try {
        const raw = (await prefsCache.get())?.[WS_STATE_PREF];
        const map = typeof raw === 'string' ? JSON.parse(raw) : raw;
        return map && typeof map === 'object' ? map : {};
      } catch { return {}; }
    },
    wsStateSave: async (snapshot) => {
      try {
        const r = await prefsCache.set(WS_STATE_PREF, JSON.stringify(trimWsState(snapshot)));
        return !!r?.ok;
      } catch { return false; }
    },

    // ── THE ARTIFACTS PANEL (his order, 2026-10-05) ──────────────────────────────
    // The desktop's artifacts-ipc.ts off the SDK handle: the typed `client.artifacts`
    // resource when the SDK carries it, else the raw routes (the cloud* way). Every
    // answer an { ok, data | error } envelope — help/artifacts-panel.ts paints one way.
    ...buildArtifactsWeb(client),
  };
}

/** The artifacts shims, pure over the client (tested in web-contract.test.js). */
export function buildArtifactsWeb(client, deps = {}) {
  const doc = deps.document ?? (typeof document !== 'undefined' ? document : null);
  const secure = deps.secure ?? (typeof location !== 'undefined' && location.protocol === 'https:');
  const msg = (e) => (e instanceof Error ? e.message : String(e));
  const env = async (run) => { try { return { ok: true, data: await run() }; } catch (e) { return { ok: false, error: msg(e) }; } };
  const path = (id, tail = '') => `/api/artifacts/${encodeURIComponent(String(id || ''))}${tail}`;
  const a = () => client.artifacts || null;
  const SCOPES = new Set(['all', 'mine', 'shared']);
  return {
    artifactsList: (scope) => env(async () => {
      const s = SCOPES.has(String(scope)) ? String(scope) : 'all';
      const rows = a()?.list ? await a().list(s) : await client.http.get(`/api/artifacts?scope=${s}`);
      return Array.isArray(rows) ? rows : [];
    }),
    artifactsGet: (id) => env(() => (a()?.get ? a().get(String(id)) : client.http.get(path(id)))),
    artifactsUpdate: (id, patch) => env(() => {
      const body = {};
      if (typeof patch?.name === 'string') body.name = patch.name;
      if (typeof patch?.access === 'string') body.access = patch.access;
      return a()?.update ? a().update(String(id), body) : client.http.put(path(id), body);
    }),
    artifactsDelete: (id) => env(async () => { if (a()?.remove) await a().remove(String(id)); else await client.http.del(path(id)); return {}; }),
    artifactsShare: (id, access) => env(() => (a()?.share ? a().share(String(id), String(access)) : client.http.post(path(id, '/share'), { access: String(access || 'private') }))),
    // THE SDK'S COMMENTS ARE A SUB-RESOURCE (`client.artifacts.comments.list /
    // add / resolve / remove`, sdk/src/resources/artifacts.ts) — not methods on
    // the artifacts client. The first cut called `comments(id)` on that object
    // and the viewer failed with "comments is not a function" (his report,
    // 2026-10-05). The raw routes stay as the fallback for an older SDK.
    artifactsCommentsList: (id) => env(async () => {
      const cm = a()?.comments;
      const rows = cm?.list ? await cm.list(String(id)) : await client.http.get(path(id, '/comments'));
      return Array.isArray(rows) ? rows : [];
    }),
    artifactsCommentAdd: (id, input) => env(() => {
      const body = { text: String(input?.text || '') };
      if (input?.region) body.region = input.region;
      if (input?.parentId) body.parentId = String(input.parentId);
      if (input?.agent === true) body.agent = true;
      const cm = a()?.comments;
      return cm?.add ? cm.add(String(id), body) : client.http.post(path(id, '/comments'), body);
    }),
    artifactsCommentPatch: (id, cid, patch) => env(() => {
      const cm = a()?.comments;
      return cm?.resolve ? cm.resolve(String(id), String(cid || ''), !!patch?.resolved) : client.http.patch(path(id, `/comments/${encodeURIComponent(String(cid || ''))}`), { resolved: !!patch?.resolved });
    }),
    artifactsCommentDelete: (id, cid) => env(async () => {
      const cm = a()?.comments;
      if (cm?.remove) await cm.remove(String(id), String(cid || ''));
      else await client.http.del(path(id, `/comments/${encodeURIComponent(String(cid || ''))}`));
      return {};
    }),
    /** The viewer frames `/a/<id>/raw` on THIS origin (web/artifact-proxy.mjs):
     *  an iframe carries no header, so the session parks as a cookie scoped to
     *  /a — the app-host panels' pattern (app-instances-web.js) — and the
     *  proxy turns it into the bearer. Never sent with the app's own pages. */
    artifactsViewerPrepare: async () => {
      try {
        const t = await client.token();
        if (!t || !doc) return false;
        doc.cookie = artifactCookieOf(t, secure);
        return true;
      } catch { return false; }
    },

    // ── Notifications (his order, 2026-10-05; notify-web.js) ─────────────────
    // A cloud app's notification reaches the tab as a `notify` push on a relay
    // socket kept up for it; the workbench meets the member's pref and asks for
    // the browser's own notification back through notifyShow.
    onNotify: (cb) => watchNotifications(() => client.token(), cb),
    notifyShow: async (n) => showBrowserNotification(n),
    notifyPrepare: () => askBrowserNotificationPermission(),
  };
}
/** The cookie line the viewer writes: scoped to the artifact proxy path. */
export const ARTIFACT_COOKIE_PATH = '/a';
export const artifactCookieOf = (token, secure) =>
  `glyphh_session=${encodeURIComponent(String(token))}; path=${ARTIFACT_COOKIE_PATH}; SameSite=Strict${secure ? '; Secure' : ''}`;

/** What a machine-only action answers on web (member-library-web.js) — the
 *  line the pages show per action (run a task now, a schedule, a folder dialog). */
export { NEEDS_DESKTOP };

/** The server pref the workbench's UI-state map rides on web (and the legacy
 *  seed ui-state.ts reads on the desktop's first file-store load). */
// THE ONE TRIM (shared/ui-state-trim.ts): the desktop's main process writes the
// same pref the same way since 2026-10-07.
export { WS_STATE_PREF, WS_STATE_BUDGET, trimWsState };
