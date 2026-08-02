/**
 * glyphh-core.js — the pure, SDK-free heart of the app-web client layer.
 *
 * Everything here is a plain function with no import of @glyphh/client and no
 * hard dependency on browser globals (globals are passed in), so it unit-tests
 * under `node --test` with zero setup. The SDK-touching singleton lives in
 * glyphh-web.js; the window.glyphh assembly lives in bridge.js. This split is
 * what lets the foundation be tested without a browser or a running server.
 */

export const SESSION_KEY = 'glyphh_session';
export const USER_KEY = 'glyphh_user';

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
  };
}

// Native/OS-only bridge methods — no web equivalent; they no-op (degrade) on web.
const NATIVE = new Set([
  'windowClose', 'windowMinimize', 'windowMaximize', 'onCloseGesture',
  'panelsHide', 'panelsShow', 'panelsRefresh', 'panelsZoom', 'panelsGetZoom',
  'capturePanels', 'copyToClipboard', 'openExternal', 'openFile', 'openInEditor',
  'getPathForFile', 'appFileIcon',
]);

// Prefixes/names that only a real machine can serve — on web these route over
// the attach protocol to a connected provider (desktop OR `glyphh remote-control`).
// NOTE: Ada (memory/vectors/encoding) is deliberately NOT here — it is cloud-only
// now, so a user's memory + sessions are portable to any surface. The only thing
// genuinely local is the file system (and the shell that acts on it).
const LOCAL_PREFIXES = ['files:', 'git:', 'pty:', 'terminal:', 'localMcp', 'workingDir'];
const LOCAL_NAMES = new Set([
  'getWorkingDir', 'setWorkingDir', 'pickWorkingDir',
  'deployAppFromWorkdir', 'dripsPreview',
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
