/**
 * force-web — keep a web app IN ITS PANEL when it tries to bounce to a
 * native client (slack://, msteams://, zoommtg://, …). Restored from the
 * BrowserView era (c15176f) for the workbench's <webview> panels: the app
 * opts in via launchConfig.forceWeb (Apps form), popups stay allowed, and a
 * popup that redirects to a native protocol is mapped back to the web
 * client, loaded in the PARENT panel, and the popup closed.
 */

import type { WebContents } from "electron";
import { fetchOrgApps } from "./org-apps.js";
import { slugForWebContents } from "./rpa.js";

let forceWebSlugs = new Set<string>();

/** Re-read which apps opted in — called at webview attach + app save. */
export async function refreshForceWebSlugs(): Promise<void> {
  try {
    const apps = await fetchOrgApps();
    forceWebSlugs = new Set(
      apps
        .filter((a) => !!(a.launchConfig as { forceWeb?: boolean } | null)?.forceWeb)
        .map((a) => (a.slug || a.id).toLowerCase()),
    );
  } catch { /* offline — keep the last known set */ }
}

const isWebUrl = (u: string): boolean =>
  u.startsWith("http://") || u.startsWith("https://") || u.startsWith("about:");

/** Map a native protocol URL to the corresponding web client URL. Falls back
 *  to the parent page's origin; null only for a malformed parent too. */
function nativeToWebUrl(nativeUrl: string, parentUrl: string): string | null {
  try {
    const parsed = new URL(nativeUrl);
    const proto = parsed.protocol; // e.g. "slack:", "discord:", "msteams:"
    if (proto === "slack:") {
      const team = parsed.searchParams.get("team") || "";
      return team ? `https://app.slack.com/client/${team}` : "https://app.slack.com/client";
    }
    if (proto === "discord:") return "https://discord.com/app";
    if (proto === "msteams:") return "https://teams.microsoft.com";
    if (proto === "zoommtg:" || proto === "zoomus:") {
      const confno = parsed.searchParams.get("confno") || "";
      return confno ? `https://app.zoom.us/wc/${confno}/join` : "https://app.zoom.us";
    }
    if (proto === "notion:") return "https://notion.so";
  } catch { /* malformed URL */ }
  try { return new URL(parentUrl).origin; } catch { return null; }
}

/**
 * Wire one workbench webview guest. The guard resolves LAZILY per event (the
 * renderer registers slug → webContents id after attach, and the setting can
 * change while the panel is open).
 */
export function wireForceWebGuest(guest: WebContents): void {
  void refreshForceWebSlugs();
  const guarded = (): boolean => {
    const slug = slugForWebContents(guest.id);
    return !!slug && forceWebSlugs.has(slug.toLowerCase());
  };
  // The panel itself must never leave the web — a native-protocol navigation
  // maps back to the web client in place.
  guest.on("will-navigate", (e, navUrl) => {
    if (isWebUrl(navUrl) || !guarded()) return;
    e.preventDefault();
    const web = nativeToWebUrl(navUrl, guest.getURL());
    if (web) void guest.loadURL(web);
  });
  // Popups (sign-in flows) stay allowed — but one that redirects to a native
  // protocol (Slack's "open the app" bounce) navigates the PARENT to the web
  // client and closes itself.
  guest.on("did-create-window", (child) => {
    if (!guarded()) return;
    child.webContents.on("will-navigate", (e, navUrl) => {
      if (isWebUrl(navUrl)) return;
      e.preventDefault();
      const web = nativeToWebUrl(navUrl, guest.getURL());
      if (web) void guest.loadURL(web);
      setTimeout(() => { if (!child.isDestroyed()) child.close(); }, 300);
    });
    child.webContents.setWindowOpenHandler(({ url }) => (isWebUrl(url) ? { action: "allow" } : { action: "deny" }));
  });
}
