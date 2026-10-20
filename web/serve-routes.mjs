/**
 * serve-routes.mjs — the WEB front door's ROUTE DECISION, pure and unit-tested
 * (web/test/serve-routes.test.js). serve.mjs reads the request, calls
 * resolveRoute(), and acts on the answer; no routing logic lives in the server.
 *
 * app.glyphh.ai = the IDENTICAL desktop app on the web (his order, 2026-10-04):
 * a signed-in desktop browser gets the full command center at /home; phones get
 * the mobile shell; the mobile-only deploy (mobile.glyphh.ai, GLYPHH_MOBILE_ONLY)
 * makes every page the mobile app.
 */

// SPA fallback paths — client-side routes with no file on disk, mirroring the
// platform's: /auth/callback (OAuth + magic-link return) and /auth/device (the
// device-grant approval page). They serve the LOGIN SHELL (index.html) IN PLACE,
// so the browser STAYS on the URL the boot script routes off. That is the whole
// point for /auth/device: a 302 to /?code=… made the device code arrive looking
// exactly like an OAuth callback code, and web-boot exchanged it as one.
// index.html's asset URLs are relative, so a shell served at a NESTED path also
// gets `<base href="/">` injected — that, not a redirect, is what keeps
// styles.css / brand/* resolving (the ENOENT + naked-page problem).
export const SHELL_ROUTES = new Set([
  '/', '/login', '/auth', '/auth/',
  '/auth/callback', '/auth/callback/',
  '/auth/device', '/auth/device/',
  '/auth/accept-invite', '/auth/accept-invite/',
  // The OAuth consent screen /oauth/authorize redirects to. It was handled by
  // isNestedShellRoute below (for <base>) but never listed HERE, which is the set
  // that actually selects the shell — so it fell through to a static file lookup
  // and 404'd, dead-ending every MCP client trying to connect.
  '/settings/mcp', '/settings/mcp/',
]);

/** A shell route BELOW the root needs <base href="/"> for its relative assets.
 *  /settings/mcp is two levels deep — without <base>, home.html's relative
 *  src="home.js" resolves to /settings/home.js (404) and the consent page
 *  never boots (stuck on the wb-booting veil, blank). */
export const isNestedShellRoute = (p) => SHELL_ROUTES.has(p) && p !== '/' && p !== '/login';

// The mobile web app (web/src/mobile.tsx → /glyphh-mobile.js) is its own React
// surface, served at /m. Unlike the desktop shells it does NOT get the renderer
// bridge injected — it loads its own bundle — but it still needs the client-safe
// config so the SDK knows the API url.
export const MOBILE_ROUTES = new Set(['/m', '/m/']);
export const GITHUB_DONE_ROUTE = '/github/done';
// THE ARTIFACT PAGES (his order, 2026-10-05): /a/<id> is the viewer page for a
// direct / shared link, /a/<id>/raw and /meta are the proxy's (artifact-proxy.mjs).
export const ARTIFACT_ROUTE_PREFIX = '/a/';
export const isArtifactPath = (p) => String(p || '').startsWith(ARTIFACT_ROUTE_PREFIX) && String(p).length > ARTIFACT_ROUTE_PREFIX.length;

export const isPhoneUserAgent = (ua) => /iPhone|iPod|Android.+Mobile/i.test(String(ua || ''));
export const hasAuthedCookie = (cookie) => /(?:^|;\s*)glyphh_logged_in=1\b/.test(String(cookie || ''));

const hasExt = (p) => /\.[a-z0-9]+$/i.test(p);

/**
 * Decide what one request gets.
 * @param {{ path: string, ua?: string, cookie?: string, mobileOnly?: boolean }} req
 * @returns {{ kind: 'redirect', location: string }
 *         | { kind: 'mobile' }                       — the mobile shell (mobile.html)
 *         | { kind: 'github-done' }                  — the GitHub connect return page
 *         | { kind: 'artifact' }                     — /a/<id>[/raw|/meta] (artifact-proxy.mjs decides the part)
 *         | { kind: 'login', nested: boolean }       — the login shell (index.html, home.html fallback)
 *         | { kind: 'app' }                          — the command center (home.html, /home)
 *         | { kind: 'platform' }                     — the admin surface (home.html, /platform)
 *         | { kind: 'static' }}                      — a file on disk
 */
export function resolveRoute({ path, ua = '', cookie = '', mobileOnly = false }) {
  const p = path;
  const isPhoneUA = isPhoneUserAgent(ua);
  const authedCookie = hasAuthedCookie(cookie);
  const isAuthRoute = p === '/auth' || p.startsWith('/auth/');
  const isHomeRoute = p === '/home' || p === '/home/';
  // /platform — the admin surface (the settings shell as a full page). Same
  // home.html document as /home; home.ts branches on the pathname client-side.
  const isPlatformRoute = p === '/platform' || p === '/platform/';
  // Stripe returns to the OLD platform's /billing route (success/cancel and
  // top-up redirects) — bounce it into the shell; the caller keeps the query
  // intact; the shell opens the Billing tab from those params.
  if (p === '/billing' || p === '/billing/') return { kind: 'redirect', location: '/platform' };
  // The return from GitHub's connect flow (his report, 2026-10-05): a small
  // page that completes the link and closes itself — on every device, before
  // the phone routing, so no shell boots in the second tab.
  if (p === GITHUB_DONE_ROUTE) return { kind: 'github-done' };
  // An artifact link (his order, 2026-10-05) is the same on every device, signed
  // in or not: the viewer page, or the proxied bytes / row under it.
  if (isArtifactPath(p)) return { kind: 'artifact' };
  // The OAuth consent screen is web-boot's, on every device: the mobile shell has
  // no consent view, so handing a phone mobile.html here would swallow the
  // authorization request and strand the MCP client mid-flow.
  const isConsentRoute = p === '/settings/mcp' || p === '/settings/mcp/';
  // Device routing: the mobile app owns the authed experience on PHONES. /m is
  // always the mobile app; a SIGNED-IN phone (glyphh_logged_in cookie) also
  // gets it for the app shell + /home, so login lands in the mobile ui instead
  // of the desktop rail. Signed-out phones still see the working login shell,
  // and /auth/* stays on the shell so magic-link/device token exchange runs.
  const phoneWantsApp = isPhoneUA && authedCookie && !isAuthRoute && !isConsentRoute
    && (SHELL_ROUTES.has(p) || isHomeRoute || isPlatformRoute);
  // MOBILE-ONLY (mobile.glyphh.ai, 2026-09-30): every page is the mobile app —
  // its own sign-in included — and nothing from the desktop renderer's web shell
  // (index.html, home.html, the bridge) is served or needed in the build.
  if ((mobileOnly && !hasExt(p)) || MOBILE_ROUTES.has(p) || phoneWantsApp) return { kind: 'mobile' };
  // The command center is BACK on the web (his order, 2026-10-04): a desktop
  // browser's /home is the full app, no longer a 302 to /platform.
  if (isHomeRoute) return { kind: 'app' };
  if (SHELL_ROUTES.has(p)) return { kind: 'login', nested: isNestedShellRoute(p) };
  if (isPlatformRoute) return { kind: 'platform' };
  return { kind: 'static' };
}
