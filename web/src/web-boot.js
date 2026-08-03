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
 * It NEVER triggers device-flow (that's desktop-only). Only started under
 * __GLYPHH_WEB__ by bridge.js. The decision logic is the pure decideBootState()
 * in glyphh-core.js (unit-tested); this file is the thin browser wiring around it.
 */

import { decideBootState, parseCallbackParams, CALLBACK_PATH } from './glyphh-core.js';
import {
  isAuthenticated, syncGating,
  signInWithGoogle, startEmailLink, verifyEmailLink, exchangeCode,
} from './glyphh-web.js';
import { mountLogin } from './web-login.js';

const SPLASH_MIN_MS = 1200;

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

/** Once a session exists: stamp gating cookies + cache the user, then enter the app. */
async function enterApp(shownAt) {
  await syncGating();
  // The onboarding overlay (if it was shown) comes down; the renderer's own boot
  // continues behind the splash. `yo-onboarding-done` is the same signal desktop
  // fires post-auth so the boot gate restores the workspace (Chat front door).
  document.getElementById('onboarding-overlay')?.classList.add('hidden');
  dismissSplash(shownAt);
  window.dispatchEvent(new Event('yo-onboarding-done'));
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

  splashStatus('Loading…');
  let authed = false;
  try {
    authed = await isAuthed();
  } catch {
    authed = false;
  }

  const state = decideBootState({
    pathname: window.location.pathname,
    search: window.location.search,
    authenticated: authed,
  });

  if (state === 'callback') return handleCallback(shownAt);
  if (state === 'app') return enterApp(shownAt);
  return showLogin(shownAt);
}

// Re-export for tests / callers that want the callback path constant.
export { CALLBACK_PATH };
