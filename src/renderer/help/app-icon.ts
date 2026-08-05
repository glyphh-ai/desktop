/**
 * Shared app-icon resolution — used by the Apps page (apps.ts), the Layouts
 * list (layouts.ts), and the command overlay so an app shows the exact same
 * icon everywhere.
 *
 * Priority mirrors the platform Apps page:
 *   1. Pipedream catalog icon (for connected apps) — cached per slug
 *   2. Google favicon by hostname (for web apps with a URL)
 *   3. OS file icon of the executable (for native apps) — cached per path
 *   4. initial letter (fallback)
 */

type IconApp = {
  slug?: string | null;
  url?: string | null;
  execPath?: string | null;
  appArchetype?: string | null;
  connection?: { accountId?: string; pipedreamSlug: string } | null;
};

// The built-in nav apps' glyphs, inlined so currentColor follows the theme
// (white in dark, black in light — an <img> can't inherit). Drawn in the
// MASCOT's language: bold solid ink-stamp fills with negative-space cutouts,
// not thin line art.
const NAV_GLYPH_PATHS: Record<string, string> = {
  home: '<path fill-rule="evenodd" clip-rule="evenodd" d="M11.3 2.3a1.1 1.1 0 0 1 1.4 0l8.9 7.5a1.1 1.1 0 0 1-1.4 1.68l-.4-.34V20a2 2 0 0 1-2 2H6.2a2 2 0 0 1-2-2v-8.86l-.4.34A1.1 1.1 0 0 1 2.4 9.8l8.9-7.5zM10 22v-5.4c0-.6.5-1.1 1.1-1.1h1.8c.6 0 1.1.5 1.1 1.1V22h-4z"/>',
  connections: '<circle cx="6" cy="5.8" r="3"/><circle cx="18" cy="5.8" r="3"/><circle cx="12" cy="18.2" r="3"/><path d="M7.3 8.2 10.7 15M16.7 8.2 13.3 15M8.8 5.8h6.4" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/>',
  apps: '<rect x="3" y="3" width="8.2" height="8.2" rx="2.3"/><rect x="12.8" y="3" width="8.2" height="8.2" rx="2.3"/><rect x="3" y="12.8" width="8.2" height="8.2" rx="2.3"/><rect x="12.8" y="12.8" width="8.2" height="8.2" rx="2.3"/>',
  layouts: '<rect x="3" y="3.4" width="8.6" height="7.8" rx="2"/><rect x="12.4" y="3.4" width="8.6" height="7.8" rx="2"/><rect x="3" y="12.9" width="18" height="7.8" rx="2"/>',
  skills: '<path d="M12 1.7l2.9 5.9 6.5 1-4.7 4.6 1.1 6.5-5.8-3.1-5.8 3.1 1.1-6.5L2.6 8.6l6.5-1z"/>',
  loops: '<path d="M17 2.5l4 4-4 4M3 12.5v-2a4 4 0 0 1 4-4h13M7 21.5l-4-4 4-4M21 11.5v2a4 4 0 0 1-4 4H4" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/>',
  agents: '<path fill-rule="evenodd" clip-rule="evenodd" d="M13.1 4.3a2 2 0 1 0-2.2 0V6H7a4 4 0 0 0-4 4v6a4 4 0 0 0 4 4h10a4 4 0 0 0 4-4v-6a4 4 0 0 0-4-4h-3.9V4.3zM9 11.2a1.7 1.7 0 1 0 0 3.4 1.7 1.7 0 0 0 0-3.4zm6 0a1.7 1.7 0 1 0 0 3.4 1.7 1.7 0 0 0 0-3.4z"/>',
  models: '<path d="M12 1.6 20.8 6.3 12 11 3.2 6.3z"/><path d="M2.6 8.1l8.3 4.4v9.4l-8.3-4.7z"/><path d="M21.4 8.1l-8.3 4.4v9.4l8.3-4.7z"/>',
  settings: '<path d="M19.14 12.94c.04-.3.06-.61.06-.94 0-.32-.02-.64-.07-.94l2.03-1.58c.18-.14.23-.41.12-.61l-1.92-3.32c-.12-.22-.37-.29-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54c-.04-.24-.24-.41-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96c-.22-.08-.47 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.05.3-.09.63-.09.94s.02.64.07.94l-2.03 1.58c-.18.14-.23.41-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6c-1.98 0-3.6-1.62-3.6-3.6s1.62-3.6 3.6-3.6 3.6 1.62 3.6 3.6-1.62 3.6-3.6 3.6z"/>',
};

/** Inline nav-glyph markup ("" when the app isn't a nav row). */
function navGlyph(app: IconApp): string {
  if (app.appArchetype !== "glyphh-nav") return "";
  const paths = NAV_GLYPH_PATHS[app.slug || ""];
  return paths
    ? `<span class="nav-glyph"><svg viewBox="0 0 24 24" fill="currentColor">${paths}</svg></span>`
    : "";
}

// Pipedream's catalog icon per connected app's pipedreamSlug — the saved-app
// row doesn't carry an icon itself, so it's looked up from the connector
// catalog once per unique slug and cached for the session.
export const connectedIconCache: Record<string, string | null> = {};

// OS icon (data URL) per native app's execPath, via the app-file-icon IPC.
export const nativeIconCache: Record<string, string> = {};

// window.glyphh is globally typed in the renderer program (via renderer.ts), but
// this module is also compiled into the main-process typecheck through
// code-workbench.ts's import, where that global augmentation isn't in scope.
// Reach the two IPC methods through a locally typed accessor so both programs
// type-check identically.
const yoIcons = (): {
  appFileIcon: (execPath: string) => Promise<string | null>;
  connectorsGetApps: (slug: string) => Promise<{ apps: Array<{ id: string; icon?: string | null }> }>;
} => (window as unknown as { glyphh: {
  appFileIcon: (execPath: string) => Promise<string | null>;
  connectorsGetApps: (slug: string) => Promise<{ apps: Array<{ id: string; icon?: string | null }> }>;
} }).glyphh;

// ── Curated brand layer ──────────────────────────────────────────────────
// The household names get a hand-picked BRAND COLOR behind the server-resolved
// mark (the resolver's apple-touch icons ARE the official art at 180px, so the
// curated layer supplies identity color + guaranteed coverage, not redrawn
// logos). Keyed by hostname suffix.
const BRAND_COLORS: Array<[string, string]> = [
  ["gmail.com", "#ea4335"], ["mail.google.com", "#ea4335"],
  ["calendar.google.com", "#4285f4"], ["drive.google.com", "#fbbc04"],
  ["docs.google.com", "#4285f4"], ["github.com", "#24292f"],
  ["slack.com", "#611f69"], ["notion.so", "#191919"],
  ["figma.com", "#1e1e1e"], ["linear.app", "#5e6ad2"],
  ["youtube.com", "#ff0000"], ["x.com", "#000000"], ["twitter.com", "#000000"],
];
function brandColor(host: string): string {
  for (const [suffix, color] of BRAND_COLORS) {
    if (host === suffix || host.endsWith(`.${suffix}`)) return color;
  }
  return "";
}

/** The resolver URL for a domain — THROUGH THE SDK on web (the SDK is the
 *  only client of the server); the desktop renderer holds no SDK handle, so
 *  it uses the SDK-configured origin the preload exposes (serverUrl). */
function resolverUrlFor(host: string): string {
  const w = window as unknown as {
    glyphhSdk?: { icons?: { urlFor: (d: string) => string } };
    glyphh?: { serverUrl?: string };
  };
  if (w.glyphhSdk?.icons?.urlFor) return w.glyphhSdk.icons.urlFor(host);
  const base = (w.glyphh?.serverUrl || "https://api.glyphh.ai").replace(/\/$/, "");
  return `${base}/api/icons?domain=${encodeURIComponent(host)}`;
}

/** Deterministic monogram hue — the SAME app always wears the same color, and
 *  the tile reads designed, not "icon missing". */
export function monogramStyle(seed: string): string {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return `background:hsl(${h % 360} 42% 38%);color:#fff;`;
}

/** Resolve the icon URL for an app ("" when only the monogram applies). */
export function appIconUrl(app: IconApp): string {
  // The Glyphh system app always shows the brand mark (shipped next to every
  // renderer page that uses this module). Nav apps never resolve a URL —
  // appIconInner inlines their glyph so it can follow the theme.
  if (app.slug === "glyphh") return "brand/glyphh-mark.png";
  const isInternal = app.url?.startsWith("yo://");
  // OUR resolver, not Google's favicon service: apple-touch quality, cached in
  // R2, served first-party (CORS `*`, so WebGL tiles stay untainted).
  let resolved = "";
  if (app.url && !isInternal) {
    try { resolved = resolverUrlFor(new URL(app.url).hostname); }
    catch { resolved = ""; }
  }
  const connectedIcon = app.connection?.accountId && app.connection.pipedreamSlug
    ? connectedIconCache[app.connection.pipedreamSlug] || ""
    : "";
  const nativeIcon = app.execPath ? nativeIconCache[app.execPath] || "" : "";
  // The RESOLVER leads: it is the one source both surfaces share, so the same
  // app wears the same icon everywhere. Connected/native icons only exist on
  // some surfaces (pipedream priming, exec icons) — they are fallbacks, or
  // the only option for apps with no URL.
  return resolved || connectedIcon || nativeIcon;
}

/** Inner markup (img + hidden initial fallback, or just the initial) for one
 *  icon. The caller supplies the wrapper element + its initial class so each
 *  page keeps its own sizing. */
export function appIconInner(app: IconApp, name: string, initialClass: string): string {
  const glyph = navGlyph(app);
  if (glyph) return glyph;
  const iconUrl = appIconUrl(app);
  const initial = (name || "?").charAt(0).toUpperCase();
  // The failure state is a DESIGNED monogram: brand color for the household
  // names, else a deterministic hue from the slug — never a bare letter.
  let host = "";
  try { host = app.url ? new URL(app.url).hostname : ""; } catch { host = ""; }
  const plate = brandColor(host) ? `background:${brandColor(host)};color:#fff;` : monogramStyle(app.slug || name || "?");
  const mono = `<span class="${initialClass} icon-monogram" style="${plate}">${initial}</span>`;
  return iconUrl
    ? `<img src="${iconUrl}" crossorigin="anonymous" onerror="this.style.display='none';this.nextElementSibling.style.display='flex'" />${mono.replace('style="', 'style="display:none;')}`
    : mono;
}

/** Fetch + cache the OS file icon for any native app (execPath) not already
 *  cached. Calls onLoaded() once new icons land so the caller can re-render. */
export async function primeNativeIcons(
  apps: Array<{ execPath?: string | null }>,
  onLoaded: () => void,
): Promise<void> {
  const paths = [...new Set(
    apps.map((a) => (a.execPath || "").trim()).filter(Boolean),
  )].filter((p) => !(p in nativeIconCache));
  if (paths.length === 0) return;
  await Promise.all(paths.map(async (p) => {
    try { nativeIconCache[p] = (await yoIcons().appFileIcon(p)) || ""; }
    catch { nativeIconCache[p] = ""; }
  }));
  onLoaded();
}

/** Fetch + cache the Pipedream catalog icon for any connected app not already
 *  cached. Calls onLoaded() once new icons land so the caller can re-render. */
export async function primeConnectedIcons(
  apps: Array<{ connection?: { accountId?: string; pipedreamSlug: string } | null }>,
  onLoaded: () => void,
): Promise<void> {
  const slugs = [...new Set(
    apps
      .filter((a) => a.connection?.accountId && a.connection?.pipedreamSlug)
      .map((a) => a.connection!.pipedreamSlug),
  )].filter((slug) => !(slug in connectedIconCache));
  if (slugs.length === 0) return;
  await Promise.all(slugs.map(async (slug) => {
    try {
      const { apps: catalog } = await yoIcons().connectorsGetApps(slug);
      connectedIconCache[slug] = catalog.find((a) => a.id === slug)?.icon || null;
    } catch {
      connectedIconCache[slug] = null;
    }
  }));
  onLoaded();
}
