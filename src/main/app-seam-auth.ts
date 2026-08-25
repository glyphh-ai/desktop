/**
 * app-seam-auth.ts — the DESKTOP half of the app data seam.
 *
 * A hosted Glyphh app calls its data planes relative to its own page. The
 * desktop webview holds no session cookie, so main injects the signed-in
 * bearer — under three gates, all mandatory:
 *   1. the request comes from a REGISTERED glyphh-app webview (the rpa
 *      slug→wcId map the mount maintains) — a browser-pane page never rides;
 *   2. the request targets the webview's OWN CURRENT ORIGIN — an app that
 *      fetches anywhere else gets nothing;
 *   3. the path is the seam: /api/app|apps/… at the origin root (the edge
 *      form) or /hosted/<slug>/api/… (the local /hosted form).
 * Whether the app may reach beyond its own surfaces stays a SERVER decision
 * (builtin-only) — this file only supplies the credential.
 */

import { session, webContents } from "electron";
import { readSessionFileSync } from "./glyphh-client.js";
import { slugForWebContents } from "./rpa.js";

const SEAM_RE = /^\/(api\/(app|apps)\/|hosted\/[a-z0-9][a-z0-9-]*\/api\/)/;

let loggedOnce = false;

export function installAppSeamAuth(): void {
  session.fromPartition("persist:yo").webRequest.onBeforeSendHeaders(
    (details, callback) => {
      try {
        const wcId = details.webContentsId;
        if (wcId !== undefined && slugForWebContents(wcId)) {
          const target = new URL(details.url);
          if (SEAM_RE.test(target.pathname)) {
            const pageUrl = webContents.fromId(wcId)?.getURL() ?? "";
            if (pageUrl && new URL(pageUrl).origin === target.origin) {
              const token = readSessionFileSync()?.accessToken;
              if (token) {
                if (!loggedOnce) { loggedOnce = true; console.log(`[app-seam] injecting bearer for ${target.origin}${target.pathname}`); }
                callback({ requestHeaders: { ...details.requestHeaders, Authorization: `Bearer ${token}` } });
                return;
              }
            }
          }
        }
      } catch { /* fall through — send unmodified */ }
      callback({ requestHeaders: details.requestHeaders });
    },
  );
}
