/**
 * web-surface.ts — WHICH HOST IS THIS, and WHAT CAN IT DO.
 *
 * The renderer is shared by the desktop (Electron, `window.glyphh` = the
 * preload's IPC surface) and the web (app.glyphh.ai, `window.glyphh` = the
 * bridge's Proxy over @glyphh/sdk). On web that Proxy answers EVERY name with
 * a function, so `typeof window.glyphh.x === "function"` cannot tell a real
 * method from a no-op. The bridge therefore exposes `window.glyphhWeb.has(name)`
 * — true only for a method web-contract.js actually implements — and this
 * module is the renderer's one door to it.
 *
 * Rule: a control that depends on a method the host cannot serve is HIDDEN,
 * never left to silently no-op (his order, 2026-10-04).
 */

import { WEB_BUILD_SUBS, WEB_CUSTOMIZE_SUBS, WEB_CUT_ROW_CLASS, WEB_DESKTOP_ONLY_EXTRA, WEB_GROUP_ROWS, WEB_HIDDEN_NAV_GROUPS, WEB_HIDDEN_RAIL, WEB_HIDDEN_SETTINGS_ROWS, webGroupPanelKept } from "./surface.js";

interface GlyphhWebProbe { has?: (name: string) => boolean }

/** The web target (the bridge stamps both the global and the html class). */
export function onWeb(): boolean {
  if (typeof window === "undefined") return false;
  return !!(window as unknown as { __GLYPHH_WEB__?: boolean }).__GLYPHH_WEB__
    || (typeof document !== "undefined" && document.documentElement.classList.contains("glyphh-web"));
}

/** Does the host implement `window.glyphh[name]` for real? Desktop: every
 *  preload method exists (typeof is honest there). Web: only what the bridge
 *  contract serves. */
export function hostHas(name: string): boolean {
  if (!onWeb()) {
    const g = (window as unknown as { glyphh?: Record<string, unknown> }).glyphh;
    return typeof g?.[name] === "function";
  }
  const probe = (window as unknown as { glyphhWeb?: GlyphhWebProbe }).glyphhWeb;
  return typeof probe?.has === "function" ? probe.has(name) : false;
}

/** Hide `el` unless the host serves every one of `names`. Returns whether it
 *  stayed visible, so a caller can skip wiring a control nobody can use. */
export function keepIfHost(el: Element | null | undefined, ...names: string[]): boolean {
  const ok = names.every(hostHas);
  if (!ok) el?.classList.add("hidden");
  return ok;
}

/** Copy text: the desktop's clipboard IPC where it exists, the browser's
 *  Clipboard API on web. Never throws. */
export async function copyText(text: string): Promise<boolean> {
  if (hostHas("copyToClipboard")) {
    const g = (window as unknown as { glyphh: { copyToClipboard: (t: string) => Promise<unknown> } }).glyphh;
    try { await g.copyToClipboard(text); return true; }
    catch { /* fall through to the browser API */ }
  }
  try { await navigator.clipboard.writeText(text); return true; }
  catch { return false; }
}

/** Settings sub-pages that are the DESKTOP's own: on web their nav rows +
 *  panels hide, a stale deep link lands on General, and a loader that still
 *  runs paints `desktopOnlyCard`. */
/** Skills, tasks, drips and schedules left this set on 2026-10-04 (the
 *  member library is database-as-truth, served by web-contract.js) and came
 *  BACK on 2026-10-05 with the web cut below: the pages still work from the
 *  server, but building is the desktop's job and the web no longer shows
 *  them. The library doors in web-contract.js stay for the agent's tools. */
/** The Settings MODAL on the web does not list the Customize group (Skills,
 *  Agents, Apps, Tasks, plugins, Connections, Tabs, Workspaces, Drips,
 *  Schedules — one group since his report, 2026-10-07) — the rail's
 *  full-screen Customize page carries those tabs, the same rows as the
 *  desktop's (surface.ts WEB_GROUP_ROWS, panels kept mounted). The rest of
 *  this set are CAPABILITY pages the
 *  browser lacks: the local MCP server, the plugins' folder.
 *  A deep link to any of them lands on General (navigation.ts
 *  settingsSubAlias). */
export const DESKTOP_ONLY_SUBS: ReadonlySet<string> = new Set(["plugins", ...WEB_BUILD_SUBS, ...WEB_CUSTOMIZE_SUBS, ...WEB_DESKTOP_ONLY_EXTRA]);

/** Hide every desktop-only settings row + panel on web (idempotent; the
 *  settings DOM is static in home.html, so this runs once at init) — and,
 *  with the web cut, the Build / Customize group headers, the rail's doors
 *  into the command center and those pages, and the settings rows that
 *  govern surfaces the web no longer has (the dock, streamed panels). */
export function hideDesktopOnlySubs(): void {
  // THE GROUP PAGE IS A PAGE ON BOTH SURFACES (his order, 2026-10-07): the
  // Customize rows leave the Settings nav on the desktop as on the web — cut
  // (WEB_CUT_ROW_CLASS), never `.hidden`, so the page still lists them — and
  // the group header goes with them. The rest of this function is the web's
  // capability cut.
  for (const sub of WEB_GROUP_ROWS) {
    document.querySelectorAll<HTMLElement>(`.settings-nav-item[data-sub="${sub}"]`).forEach((n) => n.classList.add(WEB_CUT_ROW_CLASS));
  }
  for (const id of WEB_HIDDEN_NAV_GROUPS) document.getElementById(id)?.classList.add("hidden");
  if (!onWeb()) return;
  for (const sub of DESKTOP_ONLY_SUBS) {
    // THE WEB'S FULL-SCREEN CUSTOMIZE (his order, 2026-10-05): the group
    // page's PANEL stays mounted (the full-screen page adopts it as a
    // tab) and its nav row wears WEB_CUT_ROW_CLASS, never `.hidden` — the
    // group page reads the same non-hidden rows the desktop does, so the
    // web's tabs ARE the desktop's. Every other desktop-only panel hides
    // with its row.
    if (webGroupPanelKept(sub)) continue;
    document.querySelectorAll<HTMLElement>(`.settings-nav-item[data-sub="${sub}"], .settings-panel[data-sub="${sub}"]`).forEach((n) => n.classList.add("hidden"));
  }
  for (const sel of [...WEB_HIDDEN_RAIL, ...WEB_HIDDEN_SETTINGS_ROWS]) {
    document.querySelectorAll<HTMLElement>(sel).forEach((n) => n.classList.add("hidden"));
  }
}

const esc = (s: string): string => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;" }[c] as string));

/** The state card a desktop-only page paints on web instead of loading — the
 *  repo's `.crud-empty` empty state, with the one line that says where the
 *  feature lives ("Schedules run on your desktop; open Glyphh Desktop to
 *  manage them"). Returns the markup; the caller owns the host. */
export function desktopOnlyCard(title: string, body: string): string {
  return `<div class="crud-empty ws-desktop-only"><strong>${esc(title)}</strong><br>${esc(body)}</div>`;
}

/** Paint `desktopOnlyCard` into `host` (and hide `alsoHide`) when on web.
 *  Returns true when it did — the caller's loader stops there. */
export function paintDesktopOnly(host: HTMLElement | null, title: string, body: string, alsoHide: Array<HTMLElement | null> = []): boolean {
  if (!onWeb()) return false;
  if (host) host.innerHTML = desktopOnlyCard(title, body);
  for (const el of alsoHide) el?.classList.add("hidden");
  return true;
}
