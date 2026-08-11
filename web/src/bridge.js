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
  applyPhoneClass,
  isWebAuthedFromCookie,
} from './glyphh-core.js';
import { buildContract } from './web-contract.js';
import { installErrorSurface } from './web-errors.js';
import { createWbRelay } from './wb-relay.js';
import { createWbPod, createWbSelector } from './wb-pod.js';

const client = glyphh();
const noop = () => {};

// The renderer↔SDK contract for web — one coherent module implementing every
// window.glyphh.* method the renderer consumes, each returning its exact preload.ts
// shape via a named pure adapter with uniform empty-shape error handling. This is the
// systematic replacement for the ad-hoc per-method try/catch shapes that used to live
// inline here (see web-contract.js). Anything not covered here falls through the Proxy
// below by classification (native no-op / subscribe unsubscribe / local stub / cloud).
const KNOWN = buildContract(client, { apiUrl: API_URL, isAuthenticated, signOut });

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

// The workbench bridge (window.wb) is REAL on web now, with TWO transports
// routed by the CURRENT session's locus (wb-pod.js createWbSelector):
//   · machine-bound session (or none) → the desktop panel relay (wb-relay.js —
//     attach.dispatch calls + a /ws/panel push socket for live change events)
//   · cloud session → the session's POD WORKSPACE over the harness front door
//     (wb-pod.js — /api/harness/fs/* + a ~2s change-event cursor poll)
// The locus follows the session store's own save path (web-contract.js →
// noteSessionsSnapshot). Machine-only dialogs stay honest no-ops, and an
// unreachable far side (desktop offline / pod asleep) renders the panels'
// designed offline states.
const wb = createWbSelector({
  relay: createWbRelay({ client, apiUrl: API_URL, isAuthenticated }),
  pod: createWbPod({ client, isAuthenticated }),
});

if (typeof window !== 'undefined') {
  window.glyphh = bridge;
  window.wb = wb;
  window.glyphhSdk = client;    // raw @glyphh/sdk handle for SDK-direct views (P2+)
  window.__GLYPHH_WEB__ = true; // renderer branches on this to hide native/attach UI
  // A class so CSS can hide OS-only chrome (window controls) that has no meaning
  // in a browser tab. Set before renderer scripts run, so there's no flash.
  if (typeof document !== 'undefined') document.documentElement.classList.add('glyphh-web');
  // A ghost service worker from the retired PWA install can intercept fetches
  // (including the cross-origin POST to the runtime) and fail them opaquely.
  // This build ships no SW at all, so unregister anything still registered.
  try {
    if (typeof navigator !== 'undefined' && navigator.serviceWorker) {
      void navigator.serviceWorker.getRegistrations()
        .then((rs) => rs.forEach((r) => { void r.unregister(); }))
        .catch(() => {});
    }
  } catch { /* no SW API */ }
  // ── ?diag=1 — on-device layout diagnostic for the top-band bug ─────────────
  // Renders a fixed overlay reporting what THIS device computed for the top
  // chrome, so the band can be debugged from the user's real screen.
  try {
    if (typeof document !== 'undefined' && (/[?&]diag=1/.test(location.search) || location.hash === '#diag')) {
      const paint = () => {
        const g = (id) => document.getElementById(id);
        const R = (el) => { if (!el) return 'MISSING'; const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return `top=${Math.round(r.top)} h=${Math.round(r.height)} disp=${s.display} bg=${s.backgroundColor}`; };
        const at = (y) => { const e = document.elementFromPoint(Math.floor(innerWidth / 2), y); return e ? `${e.tagName}#${e.id || '-'}.${String(e.className).split(' ')[0] || '-'} bg=${getComputedStyle(e).backgroundColor}` : 'null'; };
        const lines = [
          `url=${location.pathname} title=${document.title}`,
          `html.class=${document.documentElement.className}`,
          `body.class=${document.body.className}`,
          `--titlebar-h(body)=${getComputedStyle(document.body).getPropertyValue('--titlebar-h')}`,
          `strip: ${R(g('shell-drag-strip'))}`,
          `overlay: ${R(g('help-overlay'))}`,
          `rail: ${R(g('app-rail'))}`,
          `panel-wc: ${R(g('panel-wc'))}`,
          `@y5: ${at(5)}`, `@y20: ${at(20)}`, `@y40: ${at(40)}`,
        ];
        let d = g('glyphh-diag');
        if (!d) { d = document.createElement('pre'); d.id = 'glyphh-diag'; document.body.appendChild(d); }
        d.style.cssText = 'position:fixed;top:70px;left:8px;z-index:2147483647;background:#000;color:#0f0;font:11px/1.5 monospace;padding:10px;border:1px solid #0f0;max-width:92vw;white-space:pre-wrap;pointer-events:none;';
        d.textContent = lines.join('\n');
      };
      const kick = () => { paint(); setTimeout(paint, 2000); setTimeout(paint, 5000); setTimeout(paint, 10000); };
      if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', kick);
      else kick();
    }
  } catch { /* diagnostics must never break the page */ }

  // ── LOGIN-FIRST wall (2026-08-03, Claude model — no anonymous app access) ────
  // `/` serves the login shell; `/home` is the AUTHED app surface. `isAuthed()`
  // reads the instant `glyphh_logged_in` gating cookie the SDK's token store
  // stamps — synchronous, no network round-trip. An anonymous visitor landing on
  // /home bounces to the login BEFORE the renderer paints. The old per-tab
  // Work/Code gating (lock affordances for signed-out visitors) is dead under
  // this model — nobody signed-out reaches the tabs at all.
  const isAuthedSync = () =>
    isWebAuthedFromCookie(typeof document !== 'undefined' ? document.cookie : '');
  const loc = typeof window !== 'undefined' ? window.location : undefined;
  if (loc && /^\/home(\.html)?\/?$/.test(loc.pathname || '') && !isAuthedSync()) {
    loc.replace('/');
  }
  window.glyphhWeb = {
    /** Instant, cookie-backed auth presence check (see isAuthedSync). */
    isAuthed: isAuthedSync,
  };

  // ── LOUD errors ────────────────────────────────────────────────────────────
  // Blank screens are the enemy: install global error + unhandledrejection handlers
  // that surface any render-path throw as a visible overlay (+ tagged console.error)
  // instead of a silent white-out. First thing, so a bridge/renderer boot error shows.
  try { window.__glyphhReportError = installErrorSurface(); } catch { /* never block boot */ }

  // ── Phone-mode marker ──────────────────────────────────────────────────────
  // A PHONE viewport gets `glyphh-phone` on <html> (alongside `glyphh-web`); all
  // mobile CSS is scoped to it so it can NEVER touch desktop or iPad (both stay
  // FULL). Detection is min-dimension based (see isPhoneViewport) — no UA sniff —
  // and re-runs on resize/orientationchange so rotating a device flips modes live.
  // Applied synchronously here (before the renderer paints) to avoid a layout flash.
  // Only wire this in a REAL browser: a live classList (add+remove) and numeric
  // viewport dims. Bare test stubs (node --test) skip it, keeping bridge.js importable.
  const root = typeof document !== 'undefined' ? document.documentElement : null;
  const realClassList = root && root.classList
    && typeof root.classList.add === 'function' && typeof root.classList.remove === 'function';
  if (realClassList && typeof window.innerWidth === 'number' && typeof window.innerHeight === 'number') {
    const coarse = () => {
      try { return typeof window.matchMedia === 'function' && window.matchMedia('(pointer: coarse)').matches; }
      catch { return undefined; }
    };
    const measure = () => ({ innerWidth: window.innerWidth, innerHeight: window.innerHeight, coarse: coarse() });
    const syncPhone = () => applyPhoneClass(root.classList, measure());
    syncPhone();
    if (typeof window.addEventListener === 'function') {
      let raf = 0;
      const debounced = () => {
        if (raf) return;
        raf = (window.requestAnimationFrame || ((cb) => setTimeout(cb, 100)))(() => { raf = 0; syncPhone(); });
      };
      window.addEventListener('resize', debounced);
      window.addEventListener('orientationchange', debounced);
    }
  }

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
    // A signed-out bounce (session became unrecoverable, or an explicit sign out).
    // LOGIN-FIRST: the app has no signed-out state — leave the app surface and
    // return to the login shell at `/`. (On the login shell itself, web-boot
    // already mounts/re-mounts the login screen.)
    window.addEventListener('glyphh:signed-out', () => {
      if (document.getElementById('onboarding-overlay')) return; // already on the login shell
      window.location.replace('/');
    });
  }
}
