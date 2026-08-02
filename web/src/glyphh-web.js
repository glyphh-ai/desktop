/**
 * glyphh-web.js — app-web's ONE client onto the control plane, via @glyphh/client.
 *
 * This is the SDK-direct data layer for the web target: the SDK owns tokens,
 * refresh and rotation; here we back its token store with localStorage and stamp
 * the gating cookies the route guard reads. Mirrors platform/app/lib/glyphh.js,
 * adapted to the renderer (no Next): onSignedOut dispatches a `glyphh:signed-out`
 * event the boot-gate/router handles instead of a Next redirect.
 */
import { createClient } from '@glyphh/client';
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

/** After sign-in (or on load): resolve who-am-I, cache it, stamp the role cookie. */
export async function syncGating() {
  try {
    const me = await glyphh().me();
    setGatingCookies(true, me.role, me.isPlatformAdmin, !!me.impersonating);
    const user = toLegacyUser(me);
    cacheUser(user);
    return user;
  } catch {
    setGatingCookies(false);
    cacheUser(null);
    return null;
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
