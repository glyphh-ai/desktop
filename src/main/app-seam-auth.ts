/**
 * app-seam-auth.ts — the DESKTOP half of the app data seam.
 *
 * A hosted Glyphh app calls its data planes relative to its own page; served
 * from the control plane's /hosted route those calls arrive as
 * /hosted/<slug>/api/… and the SERVER rewrites them onto the real surfaces.
 * What the desktop must supply is the CREDENTIAL: the webview has no session
 * cookie, so main injects the signed-in bearer — but ONLY for requests that
 * are (a) from a registered glyphh-app webview (the rpa slug→wcId map the
 * mount already maintains) and (b) aimed at the seam path on OUR server. A
 * browser-pane page can never ride it: its webContents is not registered.
 */

import { session } from "electron";
import { SERVER_URL, readSessionFileSync } from "./glyphh-client.js";
import { slugForWebContents } from "./rpa.js";

const SEAM_RE = /^\/hosted\/[a-z0-9][a-z0-9-]*\/api\//;

export function installAppSeamAuth(): void {
  const filterUrls = [`${SERVER_URL.replace(/\/$/, "")}/hosted/*`];
  session.fromPartition("persist:yo").webRequest.onBeforeSendHeaders(
    { urls: filterUrls },
    (details, callback) => {
      try {
        const wcId = details.webContentsId;
        const path = new URL(details.url).pathname;
        if (wcId !== undefined && SEAM_RE.test(path) && slugForWebContents(wcId)) {
          const token = readSessionFileSync()?.accessToken;
          if (token) {
            callback({ requestHeaders: { ...details.requestHeaders, Authorization: `Bearer ${token}` } });
            return;
          }
        }
      } catch { /* fall through — send unmodified */ }
      callback({ requestHeaders: details.requestHeaders });
    },
  );
}
