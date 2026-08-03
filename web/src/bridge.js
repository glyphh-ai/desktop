/**
 * bridge.js — assembles window.glyphh for the WEB target and boots the SDK client.
 *
 * This is NOT the Electron bridge (that's IPC via preload). On web the renderer
 * owns the SDK client directly, so most of window.glyphh is a thin compatibility
 * layer over the SDK that lets the existing renderer boot and work SDK-direct
 * without rewriting its ~175 call sites on day one. Each phase migrates real
 * views to call the SDK handle (window.glyphhSdk) directly and the mapped surface
 * below shrinks toward just the local (machine-only) methods.
 *
 * Routing for anything not explicitly wired:
 *   native    → no-op (OS-only; hidden on web via __GLYPHH_WEB__)
 *   subscribe → returns an unsubscribe fn
 *   local     → rejects with "needs a machine" (attach lands in P6)
 *   cloud     → async no-op placeholder (wired per phase)
 *
 * Bundled to dist/renderer/glyphh-web-bundle.js by esbuild and injected before
 * the renderer scripts by web/serve.mjs.
 */
import { glyphh, isAuthenticated, signOut, API_URL } from './glyphh-web.js';
import {
  classifyMethod,
  libEnvelope, libError,
  toLegacyConnections, toLegacyConnectionTools, toLegacyConnectorApps,
  toLegacyMcpConnections, toLegacyLoops, toLegacyLoopRoles,
  toLegacyLayouts, toLegacyDrips, toLegacyPanelApps, toAccountInfo,
} from './glyphh-core.js';

const client = glyphh();
const noop = () => {};

/** Run an SDK read and wrap its result in a library `{ok,data}` envelope; any
 *  rejection becomes `{ok:false,error}` so the renderer's `unwrap` reports it. */
async function lib(thunk) {
  try {
    return libEnvelope(await thunk());
  } catch (err) {
    return libError(err);
  }
}

// Real methods wired for boot + first light. The rest fill in per phase.
// Grouped by SDK domain; each maps an SDK call → the legacy shape the renderer
// reads (adapters live in glyphh-core.js so they're unit-tested pure).
const KNOWN = {
  // ── Auth / account ─────────────────────────────────────────────────────────
  isAuthenticated: () => isAuthenticated(),
  logout: () => signOut(),
  signOut: () => signOut(),
  // The rail + Settings account card: identity ⊕ org name ⊕ subscription. The org
  // and billing reads are best-effort — a member without billing visibility still
  // gets their name/email/role.
  getAccountInfo: async () => {
    try {
      const [me, org, sub] = await Promise.all([
        client.me(),
        client.org.get().catch(() => null),
        client.billing.status().catch(() => null),
      ]);
      return toAccountInfo(me, org, sub);
    } catch {
      return null;
    }
  },
  // Server-profile timezone (users.timezone) — same field the platform edits.
  userTimezoneGet: async () => {
    try { return (await client.profile.get()).timezone ?? null; } catch { return null; }
  },
  userTimezoneSet: async (tz) => {
    try { await client.profile.update({ timezone: tz }); return { ok: true }; }
    catch (err) { return libError(err); }
  },

  // ── Prefs/theme — no server prefs endpoint yet (section C); safe defaults. ───
  getPreferences: async () => ({}),
  getTheme: async () => 'dark',

  // ── Connections (ConnectionsClient) ─────────────────────────────────────────
  connectionsList: async () => {
    try { return toLegacyConnections(await client.connections.resolvedTools()); }
    catch (err) { return { ok: false, error: err?.message ?? String(err), connections: [] }; }
  },
  connectionToolsList: async (id) => {
    try { return toLegacyConnectionTools(await client.connections.resolvedTools(), id); }
    catch (err) { return { ok: false, error: err?.message ?? String(err), tools: [] }; }
  },
  connectorsGetApps: async (search, _offset) => {
    try { return toLegacyConnectorApps(await client.connections.apps({ search })); }
    catch { return { apps: [], hasMore: false }; }
  },
  mcpConnectionsList: async () => {
    try {
      const [personal, org] = await Promise.all([
        client.connections.personalMcpList().catch(() => []),
        client.connections.orgMcpList().catch(() => []),
      ]);
      return toLegacyMcpConnections(personal, org, API_URL);
    } catch (err) { return { ok: false, error: err?.message ?? String(err), connections: [] }; }
  },
  // Governance gate for the "+ Custom MCP" affordance — no server policy endpoint
  // on the new server (section C). Default closed; a write still 403s if disallowed.
  mcpCustomAllowed: async () => ({ allowed: false }),

  // ── Loops (LoopsClient) ──────────────────────────────────────────────────────
  loopsList: async () => {
    try { return toLegacyLoops(await client.loops.list()); }
    catch { return { ok: false, loops: [], canBuild: false }; }
  },
  loopRoles: async (loop) => {
    try { return toLegacyLoopRoles(loop, await client.loops.roles(loop)); }
    catch (err) { return { ok: false, loop, roles: [], error: err?.message ?? String(err) }; }
  },
  libraryLoopGet: (ref) => lib(() => client.loops.get(ref)),

  // ── Skills (SkillsClient) — library {ok,data} envelope ───────────────────────
  librarySkillsList: () => lib(() => client.skills.list()),
  librarySkillGet: (ref) => lib(() => client.skills.get(ref)),

  // ── Agents (AgentsClient) — library {ok,data} envelope ───────────────────────
  libraryAgentsList: () => lib(() => client.agents.list()),
  libraryAgentGet: (ref) => lib(() => client.agents.get(ref)),
  libraryAgentTasks: (ref) => lib(() => client.agents.tasks(ref)),
  libraryAgentTaskRuns: (ref, taskId) => lib(() => client.agents.taskRuns(ref, taskId)),

  // ── Library grids (LibraryClient: layouts / drips) ───────────────────────────
  layoutsList: async () => {
    try { return toLegacyLayouts(await client.layouts.list()); } catch { return []; }
  },
  dripsList: async () => {
    try { return toLegacyDrips(await client.drips.list()); } catch { return []; }
  },
  dripsBuiltinEffects: async () => [],

  // ── Apps (AppsClient) ────────────────────────────────────────────────────────
  panelAppsList: async () => {
    try { return toLegacyPanelApps(await client.apps.deployed()); } catch { return []; }
  },

  // ── Models governance (OrgModelsClient / ModelsClient / ProvidersClient) ─────
  orgModelsList: () => lib(() => client.orgModels.list()),
  orgCustomModelsList: () => lib(() => client.orgModels.listCustom()),
  // Provider enablement rows are a CATALOG read (whole catalog ⊕ the org's
  // enablement/BYOK state); ProvidersClient is write-only.
  orgProvidersList: () => lib(() => client.catalog.providers()),

  // ── Support (SupportClient) ──────────────────────────────────────────────────
  submitSupportTicket: async (ticket) => {
    try {
      await client.support.ticket({ subject: ticket.subject, description: ticket.description });
      return { ok: true };
    } catch (err) { return libError(err); }
  },

  // Shaped defaults for machine-only calls the boot path *reads*, so the renderer
  // gets the right empty shape instead of throwing off `undefined`.
  localMcpStatus: async () => ({ running: false, port: null }),
  localMcpTokensList: async () => [],
  getWorkingDir: async () => null,
};

function fallback(name) {
  switch (classifyMethod(name)) {
    case 'native': return () => undefined;
    case 'subscribe': return () => noop;
    // local: quiet no-op on web. P6 routes these to attach.dispatch against a
    // connected provider and surfaces "needs a machine" in the UI when a user
    // actually triggers a local action (not fire-and-forget at boot).
    case 'local': return async () => undefined;
    default: return async () => undefined; // cloud placeholder, wired per phase
  }
}

const bridge = new Proxy({}, {
  get(_t, prop) {
    if (prop === 'then') return undefined; // never a thenable
    if (typeof prop !== 'string') return undefined;
    if (prop in KNOWN) return KNOWN[prop];
    return fallback(prop);
  },
});

// The workbench bridge is entirely machine-only; its UI is hidden on web, so
// every wb.* call is a quiet no-op (on* → unsubscribe) until attach lands.
const wb = new Proxy({}, {
  get(_t, prop) {
    if (prop === 'then') return undefined;
    if (typeof prop === 'string' && prop.startsWith('on')) return () => noop;
    return async () => undefined;
  },
});

if (typeof window !== 'undefined') {
  window.glyphh = bridge;
  window.wb = wb;
  window.glyphhSdk = client;    // raw @glyphh/client handle for SDK-direct views (P2+)
  window.__GLYPHH_WEB__ = true; // renderer branches on this to hide native/attach UI
  // A class so CSS can hide OS-only chrome (window controls) that has no meaning
  // in a browser tab. Set before renderer scripts run, so there's no flash.
  if (typeof document !== 'undefined') document.documentElement.classList.add('glyphh-web');

  // ── WEB boot gate ──────────────────────────────────────────────────────────
  // On desktop the splash + auth gate are driven by the main process over IPC
  // (window.glyphh.onBoot). On web that IPC never fires — so we drive the boot
  // ourselves: splash → resolve auth → app | platform-style login | callback.
  // Deferred to DOM-ready so #splash / #onboarding-overlay exist, and imported
  // lazily so the tested KNOWN/adapter surface above stays browser-free.
  const runWebBoot = () => {
    import('./web-boot.js')
      .then((m) => m.startWebBoot())
      .catch((err) => console.error('[glyphh-web] boot failed', err));
  };
  // Guard the real-browser wiring so bridge.js stays importable under `node --test`
  // (where window/document are bare stubs without addEventListener).
  const canListen = typeof document !== 'undefined'
    && typeof document.addEventListener === 'function'
    && typeof window.addEventListener === 'function';
  if (canListen) {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', runWebBoot, { once: true });
    } else {
      runWebBoot();
    }
    // A signed-out bounce (session became unrecoverable, or an explicit sign out)
    // returns the tab to the login screen — the web equivalent of platform's
    // `location.href = '/auth/login'`. Re-running the boot re-shows the login.
    window.addEventListener('glyphh:signed-out', () => {
      import('./web-login.js')
        .then((m) => m.mountLogin({
          googleClientId: window.__GLYPHH_GOOGLE_CLIENT_ID__ || null,
          origin: window.location.origin,
          onGoogle: (t) => import('./glyphh-web.js').then((w) => w.signInWithGoogle(t)),
          onStartEmailLink: (e, r) => import('./glyphh-web.js').then((w) => w.startEmailLink(e, r)),
          onAuthed: () => import('./glyphh-web.js').then((w) => w.syncGating()).then(() => window.location.reload()),
        }))
        .catch((err) => console.error('[glyphh-web] re-login failed', err));
    });
  }
}
