/**
 * web-icons.js — what an app tile wears on app.glyphh.ai (his report,
 * 2026-10-04: "app icons are not coming through on the app web" — every tile
 * but the built-in panels showed its letter).
 *
 * The wall's rows come over the relay from the member's desktop
 * (panelApps.list → src/main/org-apps.ts), where a tile's art is LOCAL: an
 * icon file in the app's folder, a favicon fetched in main. The row now
 * carries what a browser can use (app-icon-file.ts):
 *
 *   iconDataUrl — the local icon file's bytes (≤ 24 KB) as a data URL
 *   faviconUrl  — a URL tab's favicon URL, the one the desktop fetches
 *
 * iconForRow() turns a row into the src the wall sets on its <img>, in order:
 *   1. the row's own bytes (iconDataUrl)
 *   2. the favicon through OUR origin — /webicon?u=… (web/webicon.mjs), the
 *      proxy's favicon rule; derived from the row's url when the row carries
 *      no faviconUrl (a server row, an older desktop)
 *   3. "" — the caller keeps its fallback. A Glyphh app with no local icon
 *      and no URL stays on its letter / app mark until the cloud app host
 *      serves icons; a native app's OS icon never leaves the machine.
 *
 * Pure (web/test/web-icons.test.js); web-contract.js exposes it as
 * glyphh.iconForRow and the wall (code-workbench.ts, tileIconUrl) calls it on
 * the web target only.
 */
import { faviconUrlForPage, webIconProxyPath } from '../webicon.mjs';

/** The src for one app row's tile icon, or "" when the row carries nothing
 *  a browser can show. */
export function iconForRow(row) {
  if (!row || typeof row !== 'object') return '';
  if (typeof row.iconDataUrl === 'string' && /^data:image\//i.test(row.iconDataUrl)) return row.iconDataUrl;
  const fav = (typeof row.faviconUrl === 'string' && row.faviconUrl) || faviconUrlForPage(row.url);
  return (fav && webIconProxyPath(fav)) || '';
}
