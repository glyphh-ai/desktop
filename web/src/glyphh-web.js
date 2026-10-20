/**
 * glyphh-web.js — app-web's ONE client onto the control plane, via @glyphh/sdk.
 *
 * This is the SDK-direct data layer for the web target: the SDK owns tokens,
 * refresh and rotation; here we back its token store with localStorage and stamp
 * the gating cookies the route guard reads. Mirrors platform/app/lib/glyphh.js,
 * adapted to the renderer (no Next): onSignedOut dispatches a `glyphh:signed-out`
 * event the boot-gate/router handles instead of a Next redirect.
 */
import { createClient, AuthError } from '@glyphh/sdk';
import {
  resolveApiUrl, gatingCookieStrings, makeTokenStore, toLegacyUser, USER_KEY,
} from './glyphh-core.js';

// In the renderer bundle these globals always exist; the guards keep the module
// importable under `node --test` (where it isn't the unit under test anyway).
const hasWindow = typeof window !== 'undefined';
const loc = hasWindow ? window.location : null;

export const API_URL = resolveApiUrl(
  hasWindow && window.__GLYPHH_API_URL__ ? window.__GLYPHH_API_URL__ : 'https://api.glyphh.ai',
  loc,
);

function setGatingCookies(loggedIn, role, platformAdmin, impersonating) {
  if (typeof document === 'undefined') return;
  for (const c of gatingCookieStrings(loggedIn, role, platformAdmin, impersonating, {
    hostname: loc.hostname, protocol: loc.protocol,
  })) {
    document.cookie = c;
  }
}

export function cacheUser(user) {
  if (!hasWindow) return;
  if (user) localStorage.setItem(USER_KEY, JSON.stringify(user));
  else localStorage.removeItem(USER_KEY);
}

export function cachedUser() {
  if (!hasWindow) return null;
  try {
    const raw = localStorage.getItem(USER_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

const tokenStore = makeTokenStore({
  storage: hasWindow ? window.localStorage : { getItem: () => null, setItem() {}, removeItem() {} },
  // role/platform-admin are stamped by syncGating() after who-am-I; save() only
  // knows a session now exists.
  onSave: () => setGatingCookies(true),
  onClear: () => setGatingCookies(false),
});

let _client = null;

/** The shared SDK client. Refresh + rotation + the signed-out bounce live inside it. */
export function glyphh() {
  if (!_client) {
    _client = createClient({
      url: API_URL,
      tokenStore,
      onSignedOut: () => {
        setGatingCookies(false);
        cacheUser(null);
        if (hasWindow) window.dispatchEvent(new CustomEvent('glyphh:signed-out'));
      },
    });
  }
  return _client;
}

/** After sign-in (or on load): resolve who-am-I, cache it, stamp the role cookie.
 *  Only a DEFINITIVE auth failure (AuthError — the session is dead) clears the
 *  gating state. A transient failure (server offline / 5xx / network) keeps the
 *  cached user + cookies as they are — clearing them on an outage made the
 *  /home route guard bounce to `/`, which saw the still-stored session and
 *  bounced back, flashing the two shells in a loop for as long as the server
 *  was down. */
export async function syncGating() {
  try {
    const me = await glyphh().me();
    setGatingCookies(true, me.role, me.isPlatformAdmin, !!me.impersonating);
    const user = toLegacyUser(me);
    cacheUser(user);
    return user;
  } catch (e) {
    if (e instanceof AuthError) {
      setGatingCookies(false);
      cacheUser(null);
      return null;
    }
    return cachedUser();   // transient — serve the stale identity, stay put
  }
}

/** Can the control plane be reached at all? (Unauthenticated liveness probe —
 *  distinguishes "signed out" from "server down" so boot can hold a stable
 *  offline screen instead of redirect-looping.) */
export async function serverReachable() {
  if (!hasWindow) return true;
  try {
    const r = await fetch(`${API_URL}/health/liveliness`, { method: 'GET', cache: 'no-store' });
    return r.status < 500;
  } catch {
    return false;
  }
}

/** Is there a live session? (Presence check; the SDK refreshes lazily on use.) */
export async function isAuthenticated() {
  try {
    return !!(await glyphh().getSession());
  } catch {
    return false;
  }
}

// ── Web sign-in surface (mirrors platform/app/auth) ──────────────────────────
// The renderer runs the platform's exact flows over the SDK: Google GIS yields an
// ID token we hand to auth.google(); magic-link start emails a link back to the
// static server's /auth/callback, which verifyEmailLink() then redeems. Each returns
// after the session is adopted so the caller can immediately syncGating() + enter.

/** Exchange a Google ID token (from GIS) for a session. */
export async function signInWithGoogle(idToken) {
  await glyphh().auth.google(idToken);
}

/** Email a magic sign-in link that returns to `redirectUri` (…/auth/callback?token=…). */
export function startEmailLink(email, redirectUri) {
  return glyphh().auth.startEmailLink(email, redirectUri ? { redirectUri } : {});
}

/** Redeem the opaque magic-link token from the callback URL. */
export async function verifyEmailLink(token) {
  await glyphh().auth.verifyEmailLink(token);
}

/** Redeem a one-time exchange code (org-SSO / deep-link handoff) from the callback. */
export async function exchangeCode(code) {
  await glyphh().auth.exchange(code);
}

/** Approve a pending DEVICE user code (ABCD-1234) as the signed-in user — the browser
 *  half of the RFC 8628 grant a CLI/TUI is blocked polling on. Requires a live session
 *  (the SDK throws otherwise), which is why the device page verifies with me() first. */
export async function approveDevice(userCode) {
  await glyphh().auth.approveDevice(userCode);
}

/** Sign out this device, clear local state, signal the app to show login. */
export async function signOut() {
  try {
    await glyphh().auth.signOut();
  } catch {
    /* best-effort */
  }
  setGatingCookies(false);
  cacheUser(null);
  if (hasWindow) window.dispatchEvent(new CustomEvent('glyphh:signed-out'));
}
