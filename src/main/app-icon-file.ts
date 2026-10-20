/**
 * app-icon-file — the icon an app tab carries OFF this machine (his report,
 * 2026-10-04: "app icons are not coming through on the app web" — every tile
 * but the built-in panels showed its letter).
 *
 * On the desktop a tile's art is local: a Glyphh app's icon file in its
 * folder, a URL tab's favicon fetched in main (web-icon-fetch), a native app's
 * OS icon. The web reads the same rows over the relay (panelApps.list), where a
 * file path is useless in a browser and a cross-origin favicon fetch is refused.
 * So the row projection (org-apps.ts) adds two fields through this module:
 *
 *   iconDataUrl — a local icon file ≤ ICON_DATA_MAX_BYTES, base64 in a data
 *                 URL; cached per path + mtime so a list read costs one stat
 *                 per app. A bigger file is omitted (the web keeps its letter).
 *   faviconUrl  — the favicon URL the desktop itself fetches for a URL tab
 *                 (the renderer's app-icon.ts rule: Google's s2 service by
 *                 hostname), so the web asks its own /webicon proxy for the
 *                 SAME mark. The host rule is the proxy's (web/webicon.mjs);
 *                 test/main/app-icon-file.test.ts keeps the two identical.
 *
 * Native apps get neither: their OS icon is extracted out-of-process on demand
 * (apps-ipc.ts) and never sits in a file the row could point at.
 */

import * as fs from "node:fs";
import * as path from "node:path";

/** The cap on an icon the row carries inline — a tab list stays a few KB a row. */
export const ICON_DATA_MAX_BYTES = 24 * 1024;

/** Image types an icon file may be, by extension. */
const ICON_MIME: Readonly<Record<string, string>> = Object.freeze({
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
});

/** The bare icon files a bundle folder may hold when its manifest names none. */
const BARE_ICON_FILES = ["icon.svg", "icon.png"];

/** One read per path + mtime; "" is cached too (missing, too big, not an image). */
const dataUrlCache = new Map<string, { mtimeMs: number; size: number; url: string }>();

/** The MIME type an icon file's extension says, or "" when it is not an image. */
export function iconMimeOf(file: string): string {
  return ICON_MIME[path.extname(file).toLowerCase()] ?? "";
}

/** A local icon file as a data URL — "" when it is missing, not an image type,
 *  empty, or over the cap. Cached per path + mtime + size. */
export function iconFileDataUrl(file: string): string {
  const mime = iconMimeOf(file);
  if (!mime) return "";
  let st: fs.Stats;
  try { st = fs.statSync(file); } catch { return ""; }
  if (!st.isFile()) return "";
  const hit = dataUrlCache.get(file);
  if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.url;
  let url = "";
  if (st.size > 0 && st.size <= ICON_DATA_MAX_BYTES) {
    try { url = `data:${mime};base64,${fs.readFileSync(file).toString("base64")}`; }
    catch { url = ""; }
  }
  dataUrlCache.set(file, { mtimeMs: st.mtimeMs, size: st.size, url });
  return url;
}

/** Drop every cached read (tests). */
export function resetIconFileCache(): void {
  dataUrlCache.clear();
}

/** The icon file an app folder holds: the manifest's `icon` (app.json, kept
 *  inside the folder), else a bare icon.svg / icon.png. null when none. */
export function appIconFileIn(dir: string): string | null {
  const root = path.resolve(dir);
  try {
    const m = JSON.parse(fs.readFileSync(path.join(root, "app.json"), "utf-8")) as { icon?: unknown };
    if (typeof m.icon === "string" && m.icon) {
      const p = path.resolve(root, m.icon);
      if (p.startsWith(root + path.sep) && iconMimeOf(p) && fs.existsSync(p)) return p;
    }
  } catch { /* no manifest, or none that names an icon — the bare files below */ }
  for (const name of BARE_ICON_FILES) {
    const p = path.join(root, name);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

/** The data URL for the first folder (in order) that holds an icon file within
 *  the cap; "" when none does. */
export function iconDataUrlForDirs(dirs: Array<string | null | undefined>): string {
  const seen = new Set<string>();
  for (const d of dirs) {
    if (!d || seen.has(d)) continue;
    seen.add(d);
    const file = appIconFileIn(d);
    if (!file) continue;
    const url = iconFileDataUrl(file);
    if (url) return url;
  }
  return "";
}

/** A plain hostname: lowercase labels of letters, digits and inner hyphens, at
 *  least two of them, 253 chars at most. No userinfo, port, path or encoding —
 *  the SAME expression as web/webicon.mjs's FAVICON_HOST. */
export const FAVICON_HOST = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/** The favicon URL for a page URL — the desktop's own rule (app-icon.ts
 *  resolverUrlFor): Google's s2 service by hostname at 64px. "" for anything
 *  that is not http(s) on a plain hostname (yo://, file:, localhost, an IP). */
export function faviconUrlFor(pageUrl: string | null | undefined): string {
  if (!pageUrl) return "";
  let host = "";
  try {
    const u = new URL(pageUrl);
    if (u.protocol !== "https:" && u.protocol !== "http:") return "";
    host = u.hostname.toLowerCase();
  } catch { return ""; }
  return FAVICON_HOST.test(host) ? `https://www.google.com/s2/favicons?domain=${host}&sz=64` : "";
}
