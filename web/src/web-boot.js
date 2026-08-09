/**
 * web-boot.js — the WEB target's boot sequence. On desktop the splash + auth gate
 * are driven by the main process over IPC (window.glyphh.onBoot → boot-gate-ui.ts);
 * on web that IPC never fires, so this module owns the sequence instead:
 *
 *   splash → resolve auth
 *     • on the /auth/callback path with a token/code → exchange it (magic-link /
 *       deep-link return), stamp gating, then land in the app
 *     • already authenticated → straight into the app (Chat front door)
 *     • not authenticated → show the platform-style Google + magic-link login
 *
 * INPUT-FIRST front door (no login wall):
 * The base page (/) is the Chat tab = home.html, rendered LOGGED-OUT. The deliberate
 * auth page (index.html — the onboarding/login FRAME + Google/magic-link) stays fully
 * intact and reachable ON DEMAND at /auth, and remains the target of the magic-link /
 * OAuth callback. So:
 *   • home shell (home.html, the Chat tab): render regardless of auth. An anonymous
 *     visitor sees the composer + starters; auth-gated data degrades to empty. We do
 *     NOT bounce them to login.
 *   • login shell (index.html at /auth, /auth/callback): the full splash→auth→login /
 *     first-run flow; on success, navigate BACK to the Chat tab (/).
 *
 * It NEVER triggers device-flow (that's desktop-only). Only started under
 * __GLYPHH_WEB__ by bridge.js. The decision logic is the pure decideBootState()
 * in glyphh-core.js (unit-tested); this file is the thin browser wiring around it.
 */

import { decideBootState, parseCallbackParams, shouldShowFirstRun, CALLBACK_PATH } from './glyphh-core.js';
import {
  isAuthenticated, syncGating,
  signInWithGoogle, startEmailLink, verifyEmailLink, exchangeCode, approveDevice,
} from './glyphh-web.js';
import { mountLogin } from './web-login.js';

const SPLASH_MIN_MS = 1200;

/** The AUTHED app surface (serve.mjs maps /home → home.html). LOGIN-FIRST: `/` is
 *  the login shell now, so after sign-in we hand off HERE — navigating to '/'
 *  would land back on the login shell and loop the getting-started flow. */
export const HOME_PATH = '/home';

/** True when we're on the LOGIN shell (index.html / the /auth page) — it carries the
 *  onboarding overlay. home.html (the Chat tab) has none, so the splash→auth→login
 *  sequence must NOT run there — the Chat tab renders logged-out. */
function isLoginShell() {
  return !!document.getElementById('onboarding-overlay');
}

/** Navigate to the Chat-tab front door. A full navigation (not a history push) so
 *  home.html boots fresh under the bridge; a fresh session in localStorage survives
 *  the nav. Overridable in tests. */
function goHome() {
  try { window.location.assign(HOME_PATH); }
  catch { window.location.href = HOME_PATH; }
}

/** Fade the splash out (mirrors boot-gate-ui.ts finishSplash), respecting a
 *  minimum on-screen time so it never flashes. */
function dismissSplash(shownAt) {
  const splash = document.getElementById('splash');
  if (!splash) return;
  const finish = () => {
    splash.classList.add('fade-out');
    setTimeout(() => splash.remove(), 600);
  };
  const elapsed = Date.now() - (shownAt || 0);
  setTimeout(finish, Math.max(0, SPLASH_MIN_MS - elapsed));
}

/** Paint a status line on the splash while we resolve auth / exchange a code. */
function splashStatus(msg) {
  const el = document.getElementById('splash-status');
  if (el) el.textContent = msg || '';
}

/** Resolve the renderer-exposed first-run drivers (window.glyphhWebBoot), which
 *  renderer.ts publishes once initBootGate runs. The renderer bundle loads as a
 *  module right after this script, so briefly poll rather than assume it's ready. */
/**
 * Once a session exists: stamp gating cookies + cache the user, then enter the app.
 * FIRST-RUN is gated on the SERVER's per-user `regionChosen` (surfaced by syncGating
 * → toLegacyUser), NOT app-start and NOT the per-device `hasSeenTutorial` prefs — a
 * genuinely new user (regionChosen === false) gets the first-time flow ONCE, on any
 * device; a returning user goes straight into the workspace.
 */
async function enterApp(shownAt, nav = goHome) {
  const user = await syncGating();
  document.getElementById('onboarding-overlay')?.classList.add('hidden');
  dismissSplash(shownAt);

  const firstRun = shouldShowFirstRun({
    authenticated: !!user,
    regionChosen: !!(user && user.regionChosen),
  });

  // Drive the renderer's first-run vs. enter-app path (the desktop `yo-onboarding-done`
  // → hasSeenTutorial handler is web-gated off). New user → show the tutorial, then
  // navigate to the home.html front door on completion; returning user → straight to
  // home. If the drivers never appear, navigate anyway so the app still lands.
  // LOGIN-FIRST: this only ever runs on the LOGIN SHELL, which in a browser is a
  // blank workspace — never wait for renderer drivers or show a tutorial HERE
  // (that was up to 4s of white page post-exchange). A new user gets the region
  // choice stamped, then everyone navigates straight to /home. The real
  // region/image onboarding SCREEN replaces this seam when it ships.
  window.dispatchEvent(new Event('yo-onboarding-done'));
  if (firstRun) void completeFirstRun(nav);
  else nav();
}

/**
 * First-run COMPLETION: persist the one-time region choice so the server flips
 * `regionChosen` and the flow never re-shows. Until the real region/image picker
 * screen ships, the choice is the org's HOME region (stamped at signup from the
 * server's default) on the shared tier — the same thing the picker would default
 * to. Failure is non-fatal: the user still lands in the app, and the flow simply
 * shows again next login (better than blocking entry on a transient error).
 */
async function completeFirstRun(nav) {
  try {
    const { glyphh } = await import('./glyphh-web.js');
    const client = glyphh();
    const infra = await client.org.infra();
    if (!infra.regionChosen) {
      const region = infra.region || infra.regions?.[0]?.id;
      if (region) await client.org.chooseInfra({ region, tier: 'shared' });
    }
  } catch (err) {
    console.error('[glyphh-web] first-run region choice failed (will re-prompt)', err);
  }
  nav();
}

/** Strip the callback query from the URL so a refresh doesn't re-run the exchange,
 *  landing on the requested in-app path (or '/'). */
function clearCallbackUrl(redirect) {
  try {
    window.history.replaceState(null, '', redirect || '/');
  } catch {
    /* history unavailable — harmless */
  }
}

/** Redeem a returning magic-link/deep-link, then enter the app. On failure, fall
 *  back to the login screen with a message. */
async function handleCallback(shownAt) {
  splashStatus('Signing you in…');
  const { token, code, redirect } = parseCallbackParams(window.location.search);
  try {
    if (token) await verifyEmailLink(token);
    else if (code) await exchangeCode(code);
    clearCallbackUrl(redirect);
    await enterApp(shownAt);
  } catch (err) {
    clearCallbackUrl('/');
    showLogin(shownAt, (err && err.message) || 'This sign-in link is invalid or has expired.');
  }
}

/** Show the login screen (splash comes down behind it). */
/**
 * DEVICE GRANT (/auth/device?code=ABCD-1234) — a CLI/TUI sent the user here to
 * authorize a device. Signed OUT: the same login shell, but with the device
 * context in the copy (no bounce elsewhere) — after sign-in it re-enters this
 * view with the code intact. Signed IN: the confirm form → auth.approveDevice.
 */
async function showDevice(shownAt) {
  dismissSplash(shownAt);
  const params = new URLSearchParams(window.location.search);
  const code = (params.get('code') || '').toUpperCase();

  // A magic link aimed back at THIS page arrives as ?code=…&token=… — redeem the
  // token first (decideBootState routes by path, so handleCallback never sees it),
  // then strip it from the URL so a reload can't double-redeem.
  const token = params.get('token') || '';
  if (token) {
    try { await verifyEmailLink(token); } catch { /* expired — the check below shows login */ }
    params.delete('token');
    window.history.replaceState(null, '', `${window.location.pathname}?${params.toString()}`);
  }

  // Verify the session for REAL (me() via syncGating) — a cached user can outlive
  // a dead session and drop the user on a confirm form that just 401s.
  let user = null;
  try { user = await syncGating(); } catch { user = null; }

  if (!user) {
    mountLogin({
      googleClientId: (typeof window !== 'undefined' && window.__GLYPHH_GOOGLE_CLIENT_ID__) || null,
      origin: window.location.origin,
      onGoogle: signInWithGoogle,
      onStartEmailLink: startEmailLink,
      title: 'Authorize this device',
      lede: code
        ? `Sign in to approve the code ${code} from your terminal.`
        : 'Sign in to approve the device shown in your terminal.',
      // The magic link must come BACK HERE with the code, not to /auth/callback.
      redirectUri: `${window.location.origin}${window.location.pathname}?code=${encodeURIComponent(code)}`,
      // Google signs in right here in-page — re-enter this view for the confirm step.
      onAuthed: () => { void showDevice(shownAt); },
    });
    return;
  }

  const step = document.getElementById('onboarding-step-auth');
  const overlay = document.getElementById('onboarding-overlay');
  if (overlay) overlay.classList.remove('hidden');
  if (!step) return;
  step.innerHTML = '';
  const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  };
  // Same components as the DESKTOP device screen (onboarding.ts): auth-shell
  // title/lede, the code as device-code-grid TILES, btn-primary btn-lg btn-full.
  // The tile styles are scoped to #onboarding-overlay, which this renders inside.
  const h = el('h1', 'auth-shell-title', 'Approve this sign-in');
  const lede = el('p', 'auth-shell-lede', code
    ? 'Make sure this matches the code shown in your terminal or app.'
    : 'Enter the code shown in your terminal or app.');
  const grid = el('div', 'device-code-grid');
  const paintTiles = (value) => {
    grid.innerHTML = '';
    for (const ch of value) {
      if (ch === '-' || ch === ' ') grid.append(el('span', 'device-code-sep', '–'));
      else grid.append(el('span', 'device-code-tile', ch));
    }
  };
  // No code in the URL (user typed the bare verification URI): an input in the
  // shell idiom; with a code, the tiles — matching the app's screen exactly.
  const input = el('input', 'auth-shell-input device-code-input');
  input.id = 'device-code'; input.placeholder = 'ABCD-1234';
  input.autocomplete = 'off'; input.spellcheck = false;
  input.addEventListener('input', () => { input.value = input.value.toUpperCase(); });
  if (code) paintTiles(code); else grid.style.display = 'none';

  const err = el('p', 'auth-shell-error'); err.style.display = 'none';
  const btn = el('button', 'btn btn-primary btn-lg btn-full', 'Approve sign-in');
  btn.type = 'button';
  const actions = el('div', 'auth-shell-actions'); actions.append(btn);
  btn.addEventListener('click', async () => {
    const value = (code || input.value || '').trim();
    if (!value) { err.textContent = 'Enter the code from your terminal.'; err.style.display = ''; return; }
    btn.disabled = true; btn.textContent = 'Approving…'; err.style.display = 'none';
    try {
      await approveDevice(value);
      step.innerHTML = '';
      step.append(
        el('h1', 'auth-shell-title', 'Device approved'),
        el('p', 'auth-shell-lede', 'You are signed in — return to the app. You can close this tab.'),
      );
    } catch (ex) {
      btn.disabled = false; btn.textContent = 'Approve sign-in';
      err.textContent = (ex && ex.message) || 'Could not confirm this code.';
      err.style.display = '';
    }
  });

  step.append(h, lede, grid);
  if (!code) step.append(input);
  // Error ABOVE the button — below it, a full-height card clips/overlaps it at
  // the viewport's bottom edge (it read as "hidden behind the button").
  step.append(err, actions);
}

function showLogin(shownAt, initialError) {
  dismissSplash(shownAt);
  mountLogin({
    googleClientId: (typeof window !== 'undefined' && window.__GLYPHH_GOOGLE_CLIENT_ID__) || null,
    origin: window.location.origin,
    onGoogle: signInWithGoogle,
    onStartEmailLink: startEmailLink,
    onAuthed: () => enterApp(shownAt),
    initialError,
  });
}

/**
 * Run the web boot sequence. Idempotent-safe to call once at DOM-ready.
 * @param {object} [overrides] injectable seams for tests (all optional)
 */
export async function startWebBoot(overrides = {}) {
  const shownAt = Date.now();
  const isAuthed = overrides.isAuthenticated || isAuthenticated;
  const loginShell = overrides.isLoginShell ? overrides.isLoginShell() : isLoginShell();

  splashStatus('Loading…');
  let authed = false;
  try {
    authed = await isAuthed();
  } catch {
    authed = false;
  }

  // CHAT TAB / front door (home.html): no login overlay here. INPUT-FIRST — the Chat
  // tab renders for everyone, logged-in OR logged-out. We do NOT gate it behind auth
  // and never bounce an anonymous visitor to login. home.ts renders the composer +
  // starters; auth-gated SDK reads degrade to empty via the bridge. If authed, syncing
  // gating cookies is best-effort (non-blocking) so the session-aware UI can light up.
  if (!loginShell) {
    if (authed) { try { void syncGating(); } catch { /* best-effort */ } }
    return;
  }

  // LOGIN SHELL (the deliberate /auth page + the OAuth/magic-link callback).
  const state = decideBootState({
    pathname: window.location.pathname,
    search: window.location.search,
    authenticated: authed,
  });

  if (state === 'device') return showDevice(shownAt);
  if (state === 'callback') return handleCallback(shownAt);
  if (state === 'app') return enterApp(shownAt);
  return showLogin(shownAt);
}

// Re-export for tests / callers that want the callback path constant.
export { CALLBACK_PATH };
