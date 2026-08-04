/**
 * glyphh-core.js — the pure, SDK-free heart of the app-web client layer.
 *
 * Everything here is a plain function with no import of @glyphh/sdk and no
 * hard dependency on browser globals (globals are passed in), so it unit-tests
 * under `node --test` with zero setup. The SDK-touching singleton lives in
 * glyphh-web.js; the window.glyphh assembly lives in bridge.js. This split is
 * what lets the foundation be tested without a browser or a running server.
 */

export const SESSION_KEY = 'glyphh_session';
export const USER_KEY = 'glyphh_user';

/** The static-server path the OAuth/magic-link redirect returns to (see web/serve.mjs
 *  SPA fallback). Mirrors platform's /auth/callback. */
export const CALLBACK_PATH = '/auth/callback';

/** The phone breakpoint, keyed off the SMALLER viewport dimension (not width).
 *  ~600px cleanly separates a phone (smaller-dim ≤ ~430) from an iPad (smaller-dim
 *  ≥ 768): iPad — portrait OR landscape, and a full-screen PWA — always stays FULL. */
export const PHONE_MAX = 600;

/**
 * Is this a PHONE viewport? Pure (takes the measurements, not `window`) so it
 * unit-tests with plain numbers. We branch on `Math.min(innerWidth, innerHeight)`
 * — the SHORTER edge — rather than a raw `max-width`, because a phone held in
 * landscape is wide-but-short: min-dimension catches it, while width alone would
 * misread it as a desktop. It also keeps every iPad (portrait 768, landscape 1024,
 * full-screen PWA) on the FULL layout. No user-agent sniffing.
 *
 * A coarse pointer (touch) LOWERS confidence that a borderline size is a real phone
 * vs. a small desktop window: when `coarse` is explicitly `false` (a mouse), we
 * require the shorter edge to be clearly phone-sized; a touch device uses the full
 * threshold. When `coarse` is unknown (undefined), we don't gate on it.
 *
 * @param {{ innerWidth:number, innerHeight:number, coarse?:boolean }} m
 * @returns {boolean}
 */
export function isPhoneViewport({ innerWidth, innerHeight, coarse } = {}) {
  const w = Number(innerWidth);
  const h = Number(innerHeight);
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return false;
  const minDim = Math.min(w, h);
  // A definite mouse (coarse === false) on a borderline-small window is NOT a phone:
  // require it to be well under the threshold. Touch / unknown pointer uses the line.
  const threshold = coarse === false ? PHONE_MAX - 120 : PHONE_MAX;
  return minDim < threshold;
}

/**
 * Reconcile the `glyphh-phone` marker class against the current viewport. Pure DOM
 * side-effect isolated behind an injected classList so the toggle logic is unit-
 * tested without a browser. Returns the resolved phone state.
 * @param {{ add:Function, remove:Function }} classList  documentElement.classList (or a fake)
 * @param {{ innerWidth:number, innerHeight:number, coarse?:boolean }} m
 * @returns {boolean} the phone state applied
 */
export function applyPhoneClass(classList, m) {
  const phone = isPhoneViewport(m);
  if (phone) classList.add('glyphh-phone');
  else classList.remove('glyphh-phone');
  return phone;
}

/**
 * Parse the auth-callback query so the boot script can complete a magic-link (or
 * legacy code) sign-in. Kept pure (takes the raw `?…` search string, not a
 * `location`) so it unit-tests with a plain string.
 *   - `token`    → the opaque magic-link token → client.auth.verifyEmailLink(token)
 *   - `code`     → a one-time exchange code    → client.auth.exchange(code)
 *   - `redirect` → an in-app path to land on afterward (only honoured if it starts '/')
 * @param {string} search  e.g. `?token=abc&redirect=%2Fchat`
 * @returns {{ token: string|null, code: string|null, redirect: string|null }}
 */
export function parseCallbackParams(search) {
  let params;
  try {
    params = new URLSearchParams(search || '');
  } catch {
    return { token: null, code: null, redirect: null };
  }
  const redirect = params.get('redirect');
  return {
    token: params.get('token') || null,
    code: params.get('code') || null,
    // Only accept an in-app absolute path — never an off-site or protocol-relative URL.
    redirect: redirect && redirect.startsWith('/') && !redirect.startsWith('//') ? redirect : null,
  };
}

/**
 * Decide what the WEB boot should do next, given the current path and whether a
 * session resolved. Pure so the whole boot state machine is unit-testable with no
 * browser, SDK, or server (glyphh-core.js style).
 *   - 'callback' — we're on the /auth/callback path with a token/code to exchange
 *   - 'app'      — a live session exists → dismiss splash, enter the app
 *   - 'login'    — no session → show the platform-style Google + magic-link screen
 * The callback path is decided BEFORE auth so a returning link always gets exchanged
 * (the user may have no session yet on this device — that's the whole point).
 * @param {{ pathname:string, search:string, authenticated:boolean }} input
 * @returns {'callback'|'app'|'login'}
 */
export function decideBootState({ pathname, search, authenticated }) {
  // The callback is identified by its PAYLOAD, not its path: serve.mjs 302s the
  // nested /auth/callback to '/' (relative-asset fix), so the token/code arrives
  // at the root. Any page carrying a token/code is a returning sign-in.
  const { token, code } = parseCallbackParams(search);
  if (token || code) return 'callback';
  return authenticated ? 'app' : 'login';
}

/**
 * Resolve the control-plane base URL. Normally the env value, but if the page
 * was opened from a non-localhost host (a LAN device, the machine IP) while the
 * env still points at localhost, the API is really on the SAME host that served
 * the app — rewrite localhost→that host so cross-device dev works with no
 * rebuild. A real remote api host is left untouched. (Ported from platform.)
 * @param {string} envUrl
 * @param {{hostname:string}|null} loc  location-like ({hostname}); null on server
 */
export function resolveApiUrl(envUrl, loc) {
  const env = envUrl || 'https://api.glyphh.ai';
  if (!loc) return env;
  try {
    const u = new URL(env);
    const apiIsLocal = u.hostname === 'localhost' || u.hostname === '127.0.0.1';
    const pageIsLocal = loc.hostname === 'localhost' || loc.hostname === '127.0.0.1';
    if (apiIsLocal && !pageIsLocal) {
      u.hostname = loc.hostname;
      return u.toString().replace(/\/$/, '');
    }
  } catch {
    /* fall through to env */
  }
  return env;
}

/**
 * Build the four gating-cookie strings the app reads to gate routes. Kept pure
 * (returns the strings; the caller assigns document.cookie) so the domain/secure/
 * max-age logic is unit-testable. A `.glyphh.ai` cookie is only valid on a real
 * glyphh.ai host; localhost / bare IPs (LAN dev) must stay host-only.
 * @param {boolean} loggedIn
 * @param {string=} role
 * @param {boolean=} platformAdmin
 * @param {boolean=} impersonating
 * @param {{hostname:string, protocol:string}} loc
 * @returns {string[]} four Set-Cookie-style strings for document.cookie
 */
export function gatingCookieStrings(loggedIn, role, platformAdmin, impersonating, loc) {
  const onGlyphh = loc.hostname === 'glyphh.ai' || loc.hostname.endsWith('.glyphh.ai');
  const domain = onGlyphh ? '; domain=.glyphh.ai' : '';
  const secure = loc.protocol === 'https:' ? '; Secure' : '';
  const maxAge = loggedIn ? 60 * 60 * 24 * 30 : 0;
  const tail = `path=/${domain}; max-age=${maxAge}; SameSite=Lax${secure}`;
  return [
    `glyphh_logged_in=${loggedIn ? '1' : ''}; ${tail}`,
    `glyphh_role=${loggedIn ? role || '' : ''}; ${tail}`,
    `glyphh_platform_admin=${loggedIn && platformAdmin ? '1' : ''}; ${tail}`,
    `glyphh_impersonating=${loggedIn && impersonating ? '1' : ''}; ${tail}`,
  ];
}

/**
 * Read the `glyphh_logged_in` gating cookie out of a raw `document.cookie` string.
 * Pure (takes the cookie string, not `document`) so it unit-tests with no browser.
 * This is the SYNC, instant answer the renderer's tab-gate consults — it mirrors the
 * cookie `gatingCookieStrings()` stamps on sign-in and clears on sign-out, so it needs
 * no network round-trip. A truthy value only requires a live session existed; the SDK
 * still refreshes lazily on the next real call.
 * @param {string} cookieStr  e.g. `glyphh_logged_in=1; glyphh_role=org_admin`
 * @returns {boolean}
 */
export function isWebAuthedFromCookie(cookieStr) {
  if (typeof cookieStr !== 'string' || !cookieStr) return false;
  return cookieStr
    .split(';')
    .some((c) => c.trim().startsWith('glyphh_logged_in=') && c.trim().slice('glyphh_logged_in='.length) === '1');
}

/**
 * A localStorage-shaped TokenStore implementing the SDK's async load/save/clear.
 * Storage and side-effects are injected so it tests against a fake Map with no
 * browser. `onSave`/`onClear` carry the cookie stamping (kept out of here so the
 * store stays pure re: cookies).
 * @param {{storage:Storage|{getItem:Function,setItem:Function,removeItem:Function}, onSave?:Function, onClear?:Function, key?:string}} deps
 */
export function makeTokenStore({ storage, onSave, onClear, key = SESSION_KEY }) {
  return {
    async load() {
      try {
        const raw = storage.getItem(key);
        return raw ? JSON.parse(raw) : null;
      } catch {
        return null;
      }
    },
    async save(session) {
      storage.setItem(key, JSON.stringify(session));
      if (onSave) onSave(session);
    },
    async clear() {
      storage.removeItem(key);
      if (onClear) onClear();
    },
  };
}

/**
 * Map the SDK Identity to the legacy user shape the renderer's nav/gating read,
 * so those stay byte-identical to platform. (Ported from platform.)
 * @param {object} id  SDK Identity
 */
export function toLegacyUser(id) {
  const parts = (id.name || '').trim().split(/\s+/).filter(Boolean);
  return {
    id: id.userId,
    userId: id.userId,
    email: id.email,
    name: id.name,
    firstName: parts[0] || '',
    lastName: parts.slice(1).join(' '),
    role: id.role,
    orgId: id.orgId,
    tier: id.tier,
    imageUrl: id.imageUrl ?? null,
    avatarUrl: id.avatarUrl || null,
    isPlatformAdmin: !!id.isPlatformAdmin,
    impersonating: id.impersonating || null,
    // The server's per-user first-run flag (from /api/auth/me). false/absent = a NEW
    // user who hasn't chosen a region yet → the web boot shows first-run once.
    regionChosen: !!id.regionChosen,
  };
}

/**
 * Decide whether the WEB target should show the first-time flow (region choice /
 * onboarding / tutorial) right after sign-in. Pure + testable, like decideBootState.
 *
 * The gate is the SERVER's per-user `regionChosen`, NOT a per-device local flag and
 * NOT app-start: first-run appears only the first time a genuinely new USER signs in
 * (regionChosen === false), on any device. It NEVER shows pre-auth, and a returning
 * user (regionChosen === true) goes straight into the app. On web this replaces the
 * desktop `hasSeenTutorial` mechanism entirely (which is per-device and, on web, a
 * broken prefs stub — hence the misfire this fixes).
 *
 * @param {{ authenticated:boolean, regionChosen:boolean }} input
 * @returns {boolean}
 */
export function shouldShowFirstRun({ authenticated, regionChosen }) {
  if (!authenticated) return false; // pre-auth: login only, never first-run
  return regionChosen === false;    // new user (no region yet) → show once
}

// Native/OS-only bridge methods — no web equivalent; they no-op (degrade) on web.
const NATIVE = new Set([
  'windowClose', 'windowMinimize', 'windowMaximize', 'onCloseGesture',
  'panelsHide', 'panelsShow', 'panelsRefresh', 'panelsZoom', 'panelsGetZoom',
  'capturePanels', 'copyToClipboard', 'openExternal', 'openFile', 'openInEditor',
  'getPathForFile', 'appFileIcon', 'webIconFetch',
  // Auto-updater / relaunch — an OS installer concept; a browser tab has none.
  'checkForUpdates', 'updateInstall', 'getUpdateStatus', 'relaunch',
  // OS window-manager panel/layout control (real tiled OS windows).
  'panelsGetZoom', 'railCollapseGet', 'railCollapseToggle', 'railCollapseSet',
  'appLaunch', 'appFileIcon', 'rpaRegister', 'rpaUnregister',
  'glyphhAppPreviewOpen', 'glyphhAppPreviewClear',
]);

// Prefixes/names that only a real machine can serve — on web these route over
// the attach protocol to a connected provider (desktop OR `glyphh remote-control`).
// NOTE: Ada (memory/vectors/encoding) is deliberately NOT here — it is cloud-only
// now, so a user's memory + sessions are portable to any surface. The only thing
// genuinely local is the file system (and the shell that acts on it).
const LOCAL_PREFIXES = ['files:', 'git:', 'pty:', 'terminal:', 'localMcp', 'workingDir'];
const LOCAL_NAMES = new Set([
  'getWorkingDir', 'setWorkingDir', 'pickWorkingDir', 'getWorkingDirRecents',
  'deployAppFromWorkdir', 'dripsPreview',
  // Local OS file/exec pickers + path classification — need a real filesystem.
  // P6 routes these over attach to a connected provider.
  'pickExecutable', 'pickDirectory', 'layoutsPickFolder',
  'glyphhPickAttachments', 'glyphhClassifyPaths', 'glyphhSaveClipboardImage',
  'exportGlyphhSkill', 'appImport', 'appExport', 'appGraduate',
]);

/**
 * Classify a bridge method name so the web bridge knows how to route it:
 *   'native'    — OS-only, degrade to a no-op on web
 *   'subscribe' — an on*() event subscription; returns an unsubscribe fn
 *   'local'     — needs a machine; route over attach to a connected provider
 *   'cloud'     — everything else; served SDK-direct
 * Best-effort for P0 routing; refined per-domain in later phases.
 * @param {string} name
 * @returns {'native'|'subscribe'|'local'|'cloud'}
 */
export function classifyMethod(name) {
  if (NATIVE.has(name)) return 'native';
  if (typeof name === 'string' && name.startsWith('on')) return 'subscribe';
  if (LOCAL_NAMES.has(name)) return 'local';
  if (typeof name === 'string' && LOCAL_PREFIXES.some((p) => name.startsWith(p))) return 'local';
  return 'cloud';
}

/* ─────────────────────────────────────────────────────────────────────────────
 * SHAPE ADAPTERS — pure functions mapping the SDK's clean response shapes to the
 * LEGACY IPC shapes the (unchanged) renderer reads. Kept here so each mapping is
 * unit-testable with a plain object, no SDK and no browser. bridge.js wires each
 * SDK call and pipes its result through the matching adapter below.
 *
 * The renderer's contracts live in src/renderer/preload.ts; each adapter's target
 * shape is that file's return type for the same-named method.
 * ──────────────────────────────────────────────────────────────────────────── */

/** The `{ ok, data }` envelope the library-* IPC handlers return; `unwrap` in the
 *  renderer throws `error` when `ok` is false. A resolved SDK call is always ok. */
export function libEnvelope(data) {
  return { ok: true, data };
}

/** An error envelope for a failed cloud read, so the renderer's `unwrap` surfaces
 *  a message instead of reading `undefined`. */
export function libError(err) {
  return { ok: false, error: err instanceof Error ? err.message : String(err) };
}

/**
 * `connectionsList` — adapt the SDK's RESOLVED connections (slug/name/kind/scope +
 * governance-narrowed tools) to the renderer's first-class Connection rows. The new
 * server keys connections by `slug`, so slug stands in for the legacy id/accountId/
 * appSlug. A resolved connection is, by definition, agent-allowed.
 * @param {{connections: Array<{slug:string,name:string,kind:string,scope:string,tools?:unknown[],availableTools?:unknown[]}>}} resolved
 */
export function toLegacyConnections(resolved) {
  const rows = (resolved?.connections ?? []).map((c) => ({
    id: c.slug,
    accountId: c.slug,
    appSlug: c.slug,
    appName: c.name,
    label: c.name,
    healthy: true,
    hiddenTools: [],
    createdAt: '',
    org: c.scope === 'org',
    agentAllowed: true,
    agentTools: (c.tools ?? []).length,
    agentAvailable: (c.availableTools ?? c.tools ?? []).length,
  }));
  return { ok: true, connections: rows };
}

/**
 * `connectionToolsList(id)` — the exposure list for one connection: every tool the
 * member COULD allow (`availableTools`), each flagged `hidden` when it is not in the
 * currently-allowed `tools` set. `id` is the connection slug.
 * @param {{connections: Array<{slug:string,tools?:Array<{name:string}>,availableTools?:Array<{name:string,description?:string|null}>}>}} resolved
 * @param {string} id
 */
export function toLegacyConnectionTools(resolved, id) {
  const conn = (resolved?.connections ?? []).find((c) => c.slug === id);
  if (!conn) return { ok: true, tools: [] };
  const allowed = new Set((conn.tools ?? []).map((t) => t.name));
  const universe = conn.availableTools ?? conn.tools ?? [];
  const tools = universe.map((t) => ({
    name: t.name,
    description: t.description ?? '',
    hidden: !allowed.has(t.name),
  }));
  return { ok: true, tools };
}

/**
 * `connectorsGetApps(search, offset)` — the "Add Connection" catalog picker. The SDK
 * returns `{ apps: [{id,name,icon}] }` with no paging cursor, so `hasMore` is false.
 * @param {{apps: Array<{id:string,name:string,icon?:string|null}>}} res
 */
export function toLegacyConnectorApps(res) {
  const apps = (res?.apps ?? []).map((a) => ({
    id: a.id,
    name: a.name,
    description: '',
    icon: a.icon ?? undefined,
  }));
  return { apps, hasMore: false };
}

/**
 * `mcpConnectionsList` — the org + personal custom-MCP catalog, tagged by kind.
 * @param {Array<{slug:string,name:string,url:string,headerKeys?:string[],enabled:boolean,iconSha?:string|null}>} personal
 * @param {Array<{slug:string,name:string,url:string,headerKeys?:string[],enabled:boolean,iconSha?:string|null}>} org
 * @param {string} apiUrl  base URL for the icon asset route
 */
export function toLegacyMcpConnections(personal, org, apiUrl) {
  const map = (rows, kind) => (rows ?? []).map((c) => ({
    slug: c.slug,
    name: c.name,
    url: c.url,
    headerKeys: c.headerKeys ?? [],
    enabled: c.enabled,
    hiddenTools: [],
    createdAt: '',
    kind,
    iconUrl: c.iconSha ? `${apiUrl}/api/mcp-icons/${c.iconSha}` : null,
  }));
  return { ok: true, connections: [...map(org, 'org'), ...map(personal, 'personal')] };
}

/**
 * `loopsList` — the org's loops for the picker. `canBuild` gates the "New loop" UI;
 * the new server enforces authz on write, so we optimistically allow the affordance
 * (a non-admin's create simply 403s).
 * @param {{loops: Array<{id:string,name:string,description:string,builtIn:boolean}>}} res
 */
export function toLegacyLoops(res) {
  const loops = (res?.loops ?? []).map((l) => ({
    id: l.id,
    name: l.name,
    description: l.description,
    builtIn: !!l.builtIn,
  }));
  return { ok: true, loops, canBuild: true };
}

/**
 * `loopRoles(loop)` — the resolved model slots for a loop's picker. The SDK returns
 * `ResolvedLoopRole[]` already in the renderer's LoopRoleView shape; only the outer
 * `{ ok, loop, roles }` envelope is added.
 * @param {string} loop
 * @param {Array<object>} roles
 */
export function toLegacyLoopRoles(loop, roles) {
  return { ok: true, loop, roles: roles ?? [] };
}

/**
 * `layoutsList` — the saved grids in the shape the renderer's rail + Layouts page
 * consume (desktop's apps-ipc `layouts-list`): `{ name, cols, rows, colWidths,
 * rowHeights, cells, splits, target, glyphh, loop, modelSelections, sessionMode,
 * folder, space }`.
 *
 * TWO shape hazards the naive `{...data, name}` spread hit:
 *  1. `item.data` is `unknown` — it may arrive as a JSON STRING (the server stores the
 *     grid spec opaquely); spreading a string yields char-index keys, not fields. Parse
 *     it first.
 *  2. The stored grid carries `cells`, NOT `splits` — but the rail's tile renderer reads
 *     `l.splits.map((s) => s.panelId)`. Derive `splits` from `cells` exactly as desktop
 *     does, so `renderRailLayouts` never sees an undefined `.splits`.
 * A corrupt/unparseable row degrades to a minimal valid layout (empty `splits`) rather
 * than being dropped or throwing.
 * @param {Array<{name:string,data:unknown}>} items
 */
export function toLegacyLayouts(items) {
  return (items ?? [])
    .filter((it) => it && it.data != null)
    .map((it) => {
      let d = it.data;
      if (typeof d === 'string') {
        try { d = JSON.parse(d); } catch { d = {}; }
      }
      if (typeof d !== 'object' || d === null) d = {};
      const cells = Array.isArray(d.cells) ? d.cells : [];
      // Prefer an already-present `splits`; otherwise derive it from `cells` (the
      // stored shape). Each split is the panel ref the rail's mini-icon stack reads.
      const splits = Array.isArray(d.splits)
        ? d.splits
        : cells.map((c) => ({
            panelId: c.panelId,
            col: c.col, row: c.row,
            colSpan: c.colSpan, rowSpan: c.rowSpan,
            sticky: c.sticky, config: c.config,
          }));
      return {
        name: it.name,
        cols: d.cols ?? 1,
        rows: d.rows ?? 1,
        colWidths: d.colWidths ?? [],
        rowHeights: d.rowHeights ?? [],
        cells,
        splits,
        target: d.target ?? 'glyphh',
        glyphh: d.glyphh ?? null,
        loop: d.loop ?? null,
        modelSelections: d.modelSelections ?? {},
        sessionMode: d.sessionMode ?? 'keep',
        folder: d.folder ?? null,
        space: d.space ?? null,
      };
    });
}

/**
 * `dripsList` — saved drips as `{name, recipe}`. The recipe string lives in the item's
 * `data` (either a bare string or `{recipe}`).
 * @param {Array<{name:string,data:unknown}>} items
 */
export function toLegacyDrips(items) {
  return (items ?? []).map((it) => ({
    name: it.name,
    recipe: typeof it.data === 'string' ? it.data : String(it.data?.recipe ?? ''),
  }));
}

/**
 * `panelAppsList` — the deployed panel apps as the dashboard's SavedPanelApp rows.
 * The new server's `/api/panel-apps` (client.apps.deployed) returns a leaner PanelApp;
 * missing legacy fields default so the renderer never reads `undefined`.
 * @param {Array<Record<string, unknown>>} apps
 */
export function toLegacyPanelApps(apps) {
  return (apps ?? []).map((a) => ({
    id: String(a.id ?? a.slug ?? ''),
    orgId: String(a.orgId ?? ''),
    createdBy: String(a.createdBy ?? ''),
    name: String(a.name ?? a.slug ?? ''),
    slug: String(a.slug ?? ''),
    system: !!a.system,
    url: a.url ?? null,
    isBrowser: a.isBrowser ?? true,
    execPath: a.execPath ?? null,
    appArchetype: a.appArchetype ?? null,
    launchConfig: a.launchConfig ?? null,
    access: a.access ?? 'members',
    owned: a.owned ?? true,
    latestVersion: a.latestVersion ?? null,
    requiredConnections: a.requiredConnections ?? [],
    connectionIds: a.connectionIds ?? [],
    mcp: a.mcp ?? null,
    commands: a.commands ?? {},
    createdAt: String(a.createdAt ?? ''),
    updatedAt: String(a.updatedAt ?? ''),
  }));
}

/**
 * `getAccountInfo` — the rail/Settings account card. Composed from `me()` (identity),
 * the org (name), and the billing subscription (tier + status). Any of the latter two
 * failing must not blank the card — they degrade to safe defaults.
 * @param {{email:string,name?:string|null,role:string,tier?:string}} me
 * @param {{name?:string}|null} org
 * @param {{tier?:string,billingStatus?:string}|null} sub
 */
export function toAccountInfo(me, org, sub) {
  if (!me) return null;
  const parts = (me.name || '').trim().split(/\s+/).filter(Boolean);
  return {
    email: me.email,
    firstName: parts[0] || '',
    lastName: parts.slice(1).join(' '),
    role: me.role,
    orgName: org?.name || '',
    tier: sub?.tier || me.tier || 'free',
    billingStatus: sub?.billingStatus || 'none',
  };
}

/**
 * The zeroed `dashboardData()` shape (preload.ts DashboardData) — what the Chat-tab
 * landing renders for a logged-out visitor or any failed read. The composer + starter
 * cards render ONLY when dashboardData() resolves truthy (help/dashboard.ts), so this
 * MUST be a full object, never null/undefined, or the front door blanks.
 */
export function emptyDashboardData() {
  return {
    name: '', plan: '', orgCredits: false, me: null,
    credits: 0, allowance: 0, spendCredits: 0, requests: 0, appsCount: 0,
  };
}

/**
 * `dashboardData()` — compose the Chat-tab landing card exactly as desktop's
 * `dashboard-data` handler (home-ipc.ts) does: identity + org credit pool +
 * the caller's own allocation + month-to-date spend + deployed-app count. Each SDK
 * read is best-effort at the CALL SITE (a member without billing visibility 403s on
 * the org pool → null → the personal `me` card renders instead), and the whole thing
 * degrades to `emptyDashboardData()` off an anonymous `me`. Pure: takes the already-
 * resolved SDK values (bridge.js does the Promise.all), so it unit-tests with plain
 * objects.
 * @param {{name?:string|null,tier?:string}|null} me       identity (client.me())
 * @param {{balance?:number,allowance?:number}|null} credits  org pool (billing.credits())
 * @param {{uncapped?:boolean,capCredits?:number,spentCredits?:number,remainingCredits?:number,windowEnd?:string,workspaceName?:string}|null} alloc  caller allocation (usage.allocation())
 * @param {{credits?:number,events?:number}|null} usage    MTD spend (usage.summary())
 * @param {Array<{system?:boolean,url?:string|null}>|null} apps  deployed apps (apps.deployed())
 */
export function toDashboardData(me, credits, alloc, usage, apps) {
  if (!me) return emptyDashboardData();
  const MICRO = 1_000_000;
  const parts = (me.name || '').trim().split(/\s+/).filter(Boolean);
  return {
    name: parts[0] || '',
    plan: me.tier || '',
    // null org credits = the pool is admin-only for this account — the renderer
    // swaps in the member card fed by `me`.
    orgCredits: credits != null,
    me: alloc
      ? {
          roleName: alloc.workspaceName || null,
          uncapped: alloc.uncapped,
          capCredits: alloc.capCredits,
          spentCredits: alloc.spentCredits,
          remainingCredits: alloc.remainingCredits,
          windowEnd: alloc.windowEnd || null,
        }
      : null,
    credits: Math.floor((credits?.balance || 0) / MICRO),
    allowance: Math.floor((credits?.allowance || 0) / MICRO),
    // UsageSummary.credits is already WHOLE credits (converted server-side).
    spendCredits: Math.round(usage?.credits || 0),
    requests: usage?.events || 0,
    // Live deployments only — the seeded system app (system:true) is not deployed.
    appsCount: Array.isArray(apps) ? apps.filter((a) => !a.system && a.url).length : 0,
  };
}
