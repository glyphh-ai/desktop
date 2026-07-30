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

// The built-in nav apps' square line glyphs, inlined so stroke:currentColor
// follows the theme (white in dark, black in light — an <img> can't inherit).
const NAV_GLYPH_PATHS: Record<string, string> = {
  home: '<path d="M3 10.5 12 3l9 7.5"/><path d="M5.5 9v11h13V9"/><path d="M10 20v-6h4v6"/>',
  connections: '<circle cx="6" cy="6" r="2.6"/><circle cx="18" cy="6" r="2.6"/><circle cx="12" cy="18" r="2.6"/><path d="M7 8.3l3.6 7.2"/><path d="M17 8.3l-3.6 7.2"/><path d="M8.6 6h6.8"/>',
  apps: '<rect x="3.5" y="3.5" width="7" height="7" rx="1.8"/><rect x="13.5" y="3.5" width="7" height="7" rx="1.8"/><rect x="3.5" y="13.5" width="7" height="7" rx="1.8"/><rect x="13.5" y="13.5" width="7" height="7" rx="1.8"/>',
  layouts: '<rect x="3.5" y="4" width="17" height="16" rx="2"/><line x1="12" y1="4" x2="12" y2="12"/><line x1="3.5" y1="12" x2="20.5" y2="12"/>',
  skills: '<path d="M12 2l2.4 4.9 5.4.8-3.9 3.8.9 5.4-4.8-2.5-4.8 2.5.9-5.4L4.2 7.7l5.4-.8z"/>',
  loops: '<path d="M17 2.1l4 4-4 4"/><path d="M3 12.2v-2a4 4 0 0 1 4-4h12.8"/><path d="M7 21.9l-4-4 4-4"/><path d="M21 11.8v2a4 4 0 0 1-4 4H4.2"/>',
  agents: '<rect x="4" y="7" width="16" height="12" rx="2"/><path d="M12 7V4"/><circle cx="12" cy="3" r="1"/><circle cx="9" cy="12" r="1"/><circle cx="15" cy="12" r="1"/><path d="M9 16h6"/>',
  models: '<path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><polyline points="3.27 6.96 12 12.01 20.73 6.96"/><line x1="12" y1="22.08" x2="12" y2="12"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>',
  docs: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/>',
  account: '<path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>',
};

/** Inline nav-glyph markup ("" when the app isn't a nav row). */
function navGlyph(app: IconApp): string {
  if (app.appArchetype !== "glyphh-nav") return "";
  const paths = NAV_GLYPH_PATHS[app.slug || ""];
  return paths
    ? `<span class="nav-glyph"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">${paths}</svg></span>`
    : "";
}

// Pipedream's catalog icon per connected app's pipedreamSlug — the saved-app
// row doesn't carry an icon itself, so it's looked up from the connector
// catalog once per unique slug and cached for the session.
export const connectedIconCache: Record<string, string | null> = {};

// OS icon (data URL) per native app's execPath, via the app-file-icon IPC.
export const nativeIconCache: Record<string, string> = {};

// window.yo is globally typed in the renderer program (via renderer.ts), but
// this module is also compiled into the main-process typecheck through
// code-workbench.ts's import, where that global augmentation isn't in scope.
// Reach the two IPC methods through a locally typed accessor so both programs
// type-check identically.
const yoIcons = (): {
  appFileIcon: (execPath: string) => Promise<string | null>;
  connectorsGetApps: (slug: string) => Promise<{ apps: Array<{ id: string; icon?: string | null }> }>;
} => (window as unknown as { yo: {
  appFileIcon: (execPath: string) => Promise<string | null>;
  connectorsGetApps: (slug: string) => Promise<{ apps: Array<{ id: string; icon?: string | null }> }>;
} }).yo;

/** Resolve the icon URL for an app ("" when only the initial fallback applies). */
export function appIconUrl(app: IconApp): string {
  // The Glyphh system app always shows the brand mark (shipped next to every
  // renderer page that uses this module). Nav apps never resolve a URL —
  // appIconInner inlines their glyph so it can follow the theme.
  if (app.slug === "glyphh") return "brand/glyphh-mark.png";
  const isInternal = app.url?.startsWith("yo://");
  let favicon = "";
  if (app.url && !isInternal) {
    try { favicon = `https://www.google.com/s2/favicons?domain=${new URL(app.url).hostname}&sz=64`; }
    catch { favicon = ""; }
  }
  const connectedIcon = app.connection?.accountId && app.connection.pipedreamSlug
    ? connectedIconCache[app.connection.pipedreamSlug] || ""
    : "";
  const nativeIcon = app.execPath ? nativeIconCache[app.execPath] || "" : "";
  return connectedIcon || favicon || nativeIcon;
}

/** Inner markup (img + hidden initial fallback, or just the initial) for one
 *  icon. The caller supplies the wrapper element + its initial class so each
 *  page keeps its own sizing. */
export function appIconInner(app: IconApp, name: string, initialClass: string): string {
  const glyph = navGlyph(app);
  if (glyph) return glyph;
  const iconUrl = appIconUrl(app);
  const initial = (name || "?").charAt(0).toUpperCase();
  return iconUrl
    ? `<img src="${iconUrl}" onerror="this.style.display='none';this.nextElementSibling.style.display='flex'" /><span class="${initialClass}" style="display:none">${initial}</span>`
    : `<span class="${initialClass}">${initial}</span>`;
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
