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
import { glyphh, isAuthenticated, syncGating, signOut } from './glyphh-web.js';
import { classifyMethod } from './glyphh-core.js';

const client = glyphh();
const noop = () => {};

// Real methods wired for boot + first light. The rest fill in per phase.
const KNOWN = {
  // Auth / account — SDK-direct.
  isAuthenticated: () => isAuthenticated(),
  getAccountInfo: () => syncGating(), // legacy user shape or null
  logout: () => signOut(),
  signOut: () => signOut(),
  // Prefs/theme — cloud-backed later; safe defaults now so boot renders.
  getPreferences: async () => ({}),
  getTheme: async () => 'dark',
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
}
