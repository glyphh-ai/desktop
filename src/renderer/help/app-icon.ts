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
  connection?: { accountId?: string; pipedreamSlug: string } | null;
};

// Pipedream's catalog icon per connected app's pipedreamSlug — the saved-app
// row doesn't carry an icon itself, so it's looked up from the connector
// catalog once per unique slug and cached for the session.
export const connectedIconCache: Record<string, string | null> = {};

// OS icon (data URL) per native app's execPath, via the app-file-icon IPC.
export const nativeIconCache: Record<string, string> = {};

/** Resolve the icon URL for an app ("" when only the initial fallback applies). */
export function appIconUrl(app: IconApp): string {
  // The Glyphh system app always shows the brand mark (shipped next to every
  // renderer page that uses this module).
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
    try { nativeIconCache[p] = (await window.yo.appFileIcon(p)) || ""; }
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
      const { apps: catalog } = await window.yo.connectorsGetApps(slug);
      connectedIconCache[slug] = catalog.find((a) => a.id === slug)?.icon || null;
    } catch {
      connectedIconCache[slug] = null;
    }
  }));
  onLoaded();
}
