/**
 * force-web — keep a web app IN ITS PANEL when it tries to bounce to a
 * native client (slack://, msteams://, zoommtg://, …) — or out of the panel
 * at all. The app opts in via launchConfig.forceWeb (Apps form, "Keep in
 * panel"): navigations AND popups load in the SAME panel, with a native
 * protocol mapped back to its web client first. Popups from apps that did
 * NOT opt in get their own slot (see openPopupPanel).
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
/** Is this guest a "Keep in panel" app? Resolved LAZILY per event — the
 *  renderer registers slug → webContents id after attach, and the setting
 *  can change while the panel is open. */
export function isForceWebGuest(guest: WebContents): boolean {
  const slug = slugForWebContents(guest.id);
  return !!slug && forceWebSlugs.has(slug.toLowerCase());
}

/**
 * A popup this guest tried to open. For a "Keep in panel" app it never
 * leaves the panel: the URL (native protocol mapped back to the web client)
 * loads in the SAME guest. Returns true when it handled the popup.
 */
export function handleForceWebPopup(guest: WebContents, url: string): boolean {
  if (!isForceWebGuest(guest)) return false;
  // about:blank ("open a window, then set location") must NOT load — it would
  // wipe the app out of its own panel. Swallow it: the popup is denied and the
  // panel keeps what it has.
  if (url.startsWith("about:")) return true;
  const target = url.startsWith("http://") || url.startsWith("https://")
    ? url
    : nativeToWebUrl(url, guest.getURL());
  if (target) void guest.loadURL(target);
  return true;
}

export function wireForceWebGuest(guest: WebContents): void {
  void refreshForceWebSlugs();
  const guarded = (): boolean => isForceWebGuest(guest);
  // The panel itself must never leave the web — a native-protocol navigation
  // maps back to the web client in place.
  guest.on("will-navigate", (e, navUrl) => {
    if (isWebUrl(navUrl) || !guarded()) return;
    e.preventDefault();
    const web = nativeToWebUrl(navUrl, guest.getURL());
    if (web) void guest.loadURL(web);
  });
  // Popups are handled at the window-open gate (handleForceWebPopup) — no
  // child window is ever created, so there is nothing to police here.
}
