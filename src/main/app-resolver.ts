/**
 * Shared resolution from the user's server app/layout library (yo-server:
 * /api/panel-apps, /api/layouts) to WORKBENCH app panels.
 *
 * OS-native windows are retired: every app renders as a webview slot in the
 * Code page's right-side workbench, beside the agent. This module resolves
 * refs (fuzzy names, slugs, layout names) and drives the renderer over the
 * wb:app-cmd channel; the renderer reports its open panels back on
 * wb-apps-changed, which backs listOpenAppWindows for Glyphh's tools and
 * the relay's panels_* surface.
 */

import { spawn } from "child_process";
import { ipcMain, webContents } from "electron";
import { fetchOrgApps } from "./org-apps.js";
import { fetchServerLayouts } from "./layout-manager.js";
import { applyLoopConfig } from "./loop-selections.js";
import { getPreference } from "./stores/preferences-db.js";
import { normKey, isSubsequence, findInstalledApp, launchInstalledApp } from "./installed-apps.js";
import { isGlyphhAppRow } from "./glyphh-app-host.js";
import { getMainWindowRef } from "./main-window-ref.js";

export interface ServerApp {
  id: string;
  slug: string;
  name: string;
  url: string | null;
  // Browser ↔ Native model (mirrors SavedPanelApp): native apps carry an
  // execPath + archetype/launchConfig instead of a url.
  isBrowser?: boolean;
  execPath?: string | null;
  appArchetype?: string | null;
  launchConfig?: Record<string, unknown> | null;
}

interface WbAppRef { slug: string; name: string; url: string; glyphh?: boolean }

// ── Browser homepage (the built-in "browser" app's start page) ──
const BROWSER_HOMES: Record<string, string> = {
  claude: "https://claude.ai",
  chatgpt: "https://chatgpt.com",
  gemini: "https://gemini.google.com",
};

export function resolveBrowserHomeUrl(): string {
  const pref = getPreference<string>("browserHomepage", "claude");
  if (pref === "custom") return getPreference<string>("browserHomepageUrl", "") || BROWSER_HOMES.claude;
  return BROWSER_HOMES[pref] || BROWSER_HOMES.claude;
}

// ── Open-panel registry (renderer-reported) ──
let wbOpenApps: Array<{ slug: string; name: string }> = [];

/** Wire the renderer's open-panel reports. Call once at boot. */
export function registerWbAppRegistry(): void {
  ipcMain.on("wb-apps-changed", (_e, apps: unknown) => {
    wbOpenApps = Array.isArray(apps)
      ? (apps as Array<{ slug?: unknown; name?: unknown }>)
          .filter((a) => typeof a?.slug === "string" && typeof a?.name === "string")
          .map((a) => ({ slug: a.slug as string, name: a.name as string }))
      : [];
  });
}

type WbCmd =
  | { action: "open"; app: WbAppRef }
  | { action: "open-many"; apps: WbAppRef[]; layoutName?: string }
  | { action: "terminal" }
  | { action: "close"; slug: string }
  | { action: "focus"; slug: string }
  | { action: "switcher" }
  | { action: "clear-panels" }
  | { action: "grid-panels" };

function sendWbCmd(cmd: WbCmd): void {
  const win = getMainWindowRef();
  if (!win || win.isDestroyed()) throw new Error("Glyphh window unavailable");
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
  // The workbench UI runs in the home.html PANEL (a BrowserView), NOT the
  // index.html shell that owns mainWindow.webContents — so wb:app-cmd must go
  // to the home panel(s), or onWbAppCommand never fires. Fall back to the
  // shell only if no home panel is up yet.
  const homeWcs = webContents.getAllWebContents().filter((wc) => {
    try { return !wc.isDestroyed() && /home\.html/.test(wc.getURL()); } catch { return false; }
  });
  const targets = homeWcs.length ? homeWcs : [win.webContents];
  for (const wc of targets) wc.send("wb:app-cmd", cmd);
}

/** The seeded "Glyphh" system app (archetype 'glyphh-self') — opening it
 *  focuses Glyphh's own window on the agent. */
function isGlyphhSelfRow(app: ServerApp): boolean {
  return app.appArchetype === "glyphh-self" || app.slug === "glyphh";
}

/** A built-in NAV app (archetype 'glyphh-nav') — opening it navigates the home
 *  panel to its section ("settings:account" carries a sub-panel). */
function navTargetOf(app: ServerApp): string | null {
  if (app.appArchetype !== "glyphh-nav") return null;
  const nav = (app.launchConfig as { nav?: unknown } | null | undefined)?.nav;
  return typeof nav === "string" && nav ? nav : null;
}

/** Steer the home panel(s) to a section — same channel home-ipc exposes. */
function sendHomeGoto(section: string): void {
  const homes = webContents.getAllWebContents().filter((wc) => {
    try { return !wc.isDestroyed() && /home\.html/.test(wc.getURL()); } catch { return false; }
  });
  for (const wc of homes) wc.send("home:goto-section", section);
}

/** Restore + front the Glyphh window (nav + self opens land here). */
function focusGlyphhWindow(): void {
  const win = getMainWindowRef();
  if (!win) throw new Error("Glyphh window unavailable");
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

/** Built-in apps that aren't in the server library. */
function builtinRef(key: string): WbAppRef | "terminal" | null {
  if (key === "browser") return { slug: "browser", name: "Browser", url: resolveBrowserHomeUrl() };
  if (key === "terminal" || key === "term") return "terminal";
  return null;
}

/** A library row as a workbench panel ref. Only Glyphh-Panel rows reach this —
 *  openAppByRef routes native rows to an OS launch and external-browser rows
 *  out of the app BEFORE panel resolution. Anything with a web surface
 *  (top-level url, or a url stashed in launchConfig for legacy rows) opens. */
function toWbRef(app: ServerApp): WbAppRef {
  if (isGlyphhAppRow(app)) return { slug: app.slug, name: app.name, url: "", glyphh: true };
  const lc = app.launchConfig as { url?: unknown; homepage?: unknown } | null | undefined;
  const url = app.url
    || (typeof lc?.url === "string" ? lc.url : "")
    || (typeof lc?.homepage === "string" ? lc.homepage : "");
  if (url) return { slug: app.slug, name: app.name, url };
  throw new Error(`"${app.name}" has no web address to open as a panel.`);
}

/**
 * Find a library app by ref with graceful fuzz — exact id/slug/name first,
 * then normalized equality ("vscode" ≈ "VS Code"), then prefix, then
 * substring. Prefix/substring tiers need ≥2 normalized chars so a stray
 * single letter can't grab an arbitrary app.
 */
export function findLibraryApp(apps: ServerApp[], ref: string): ServerApp | undefined {
  const raw = ref.trim();
  const key = raw.toLowerCase();
  const nk = normKey(raw);
  return apps.find((a) => a.id === raw)
    || apps.find((a) => a.slug === key)
    || apps.find((a) => a.name.toLowerCase() === key)
    || (nk
      ? apps.find((a) => normKey(a.slug || "") === nk)
        || apps.find((a) => normKey(a.name) === nk)
        || (nk.length >= 2
          ? apps.find((a) => normKey(a.slug || "").startsWith(nk))
            || apps.find((a) => normKey(a.name).startsWith(nk))
            || apps.find((a) => normKey(a.name).includes(nk))
            || apps.find((a) => normKey(a.slug || "").includes(nk))
            || (nk.length >= 4 ? apps.find((a) => isSubsequence(nk, normKey(a.name))) : undefined)
          : undefined)
      : undefined);
}

/** Open a saved app (or built-in) as a workbench panel beside the agent. */
export async function openAppByRef(ref: string): Promise<{ slug: string; name: string }> {
  const key = ref.trim().toLowerCase();
  if (!key) throw new Error("app is required");

  const builtin = builtinRef(key);
  if (builtin === "terminal") {
    sendWbCmd({ action: "terminal" });
    return { slug: "terminal", name: "Terminal" };
  }
  if (builtin) {
    sendWbCmd({ action: "open", app: builtin });
    return { slug: builtin.slug, name: builtin.name };
  }

  const apps = await fetchOrgApps();
  const app = findLibraryApp(apps, ref);
  if (!app) throw new Error(`unknown app: ${ref} — not in the app library`);

  // Built-in nav apps: no panel, no webview — the section IS the open.
  const navTo = navTargetOf(app);
  if (navTo) {
    focusGlyphhWindow();
    sendHomeGoto(navTo);
    return { slug: app.slug, name: app.name };
  }
  if (isGlyphhSelfRow(app)) {
    // The Glyphh app = the coding agent, full screen (workspace clears).
    focusGlyphhWindow();
    sendHomeGoto("agent");
    return { slug: app.slug, name: app.name };
  }

  // ── Respect the app's declared OPEN TYPE (every caller funnels here:
  //    command center, rail, .dip, and the agent's panels.open). ──
  // Native rows LAUNCH the OS app — a webview panel cannot render one.
  if (!isGlyphhAppRow(app) && (app.isBrowser === false || app.execPath)) {
    launchNativeRow(app);
    return { slug: app.slug, name: app.name };
  }
  // Every web app opens as a Glyphh PANEL. Handing the URL to a real browser
  // meant Glyphh then wanted to find, adopt and place that window — the OS
  // window management this app no longer does.
  sendWbCmd({ action: "open", app: toWbRef(app) });
  return { slug: app.slug, name: app.name };
}


/** Open the tabbed Browser panel at a specific URL (the agent's preview
 *  surface for built/deployed apps — url bar, tabs, DevTools, unlike the raw
 *  app panel). Same slot semantics as open_app("browser"). */
export function openBrowserAt(url: string): { slug: string; name: string } {
  sendWbCmd({ action: "open", app: { slug: "browser", name: "Browser", url } });
  return { slug: "browser", name: "Browser" };
}

/** Launch a NATIVE library row on this machine (path first, name fallback). */
function launchNativeRow(app: ServerApp): void {
  if (app.execPath) {
    if (process.platform === "darwin") {
      spawn("open", ["-a", app.execPath], { detached: true, stdio: "ignore" }).unref();
    } else if (process.platform === "win32") {
      spawn("cmd", ["/c", "start", "", app.execPath], { detached: true, stdio: "ignore" }).unref();
    } else {
      throw new Error(`"${app.name}" is a native app — launching is not supported on this platform.`);
    }
    return;
  }
  const installed = findInstalledApp(app.name);
  if (!installed) throw new Error(`"${app.name}" is a native app but nothing matching it is installed here.`);
  launchInstalledApp(installed);
}


/** Open a saved layout by name — every cell becomes a workbench panel. */
export async function openLayoutByName(name: string): Promise<{ layout: string; apps: string[] }> {
  const key = name.trim().toLowerCase();
  if (!key) throw new Error("layout name is required");

  const [layouts, apps] = await Promise.all([
    fetchServerLayouts(),
    fetchOrgApps(),
  ]);
  const layout = layouts.find((l) => l.name.toLowerCase() === key)
    || layouts.find((l) => l.id === name);
  if (!layout) {
    const names = layouts.map((l) => l.name).join(", ") || "(none saved)";
    throw new Error(`unknown layout: ${name} — saved layouts: ${names}`);
  }

  // ── Feasibility: a layout is a grid of PANELS inside the Glyphh window.
  //    Arranging the OS desktop is gone — Glyphh does not place other apps'
  //    windows — so a native app has nothing to render into and is named
  //    rather than silently skipped. ──
  const offenders: string[] = [];
  for (const cell of layout.cells) {
    const cellKey = cell.panelId.trim().toLowerCase();
    if (cellKey.startsWith("tool:") || builtinRef(cellKey)) continue;
    if (cellKey.startsWith("agent:") || cellKey === "agents-tabbed") continue;
    const app = findLibraryApp(apps, cell.panelId);
    if (!app || isGlyphhSelfRow(app)) continue;
    if (app.isBrowser === false || app.execPath) offenders.push(app.name);
  }
  if (offenders.length) {
    throw new Error(
      `layout "${layout.name}" contains native apps: ${offenders.join(", ")}. ` +
      "A layout arranges panels inside Glyphh; a native app opens in its own OS window and cannot be one.",
    );
  }

  // ── Panels tile inside the workbench (family-pure by the validation
  //    above — every cell is a tool or a Glyphh-Panel app). ──
  const refs: WbAppRef[] = [];
  const opened: string[] = [];
  for (const cell of layout.cells) {
    const cellKey = cell.panelId.trim().toLowerCase();
    const builtin = builtinRef(cellKey);
    if (builtin === "terminal") continue;   // terminal opens as its own slot kind
    if (builtin) { refs.push(builtin); opened.push(builtin.name); continue; }
    const app = findLibraryApp(apps, cell.panelId);
    if (!app || isGlyphhSelfRow(app)) continue;
    try {
      refs.push(toWbRef(app));
      opened.push(app.name);
    } catch { /* one bad cell must not stop the rest */ }
  }
  if (!refs.length) throw new Error(`layout "${layout.name}" has no apps to open`);
  sendWbCmd({ action: "open-many", apps: refs, layoutName: layout.name });
  // A layout binds arrangement AND program+models: opening it also switches the
  // active loop and its slot models, so the composer lands in the layout's state.
  applyLoopConfig(layout.loop, layout.modelSelections);
  return { layout: layout.name, apps: opened };
}

export interface OpenWindowInfo { slug: string; name: string }

/** The workbench app panels currently open (renderer-reported). */
/** `.dip clear` — close all workspace panels (panels ONLY, nothing else). */
export function clearWbPanels(): void {
  sendWbCmd({ action: "clear-panels" });
}

/** `.dip grid` — re-flow the open workspace panels into an even grid. */
export function gridWbPanels(): void {
  sendWbCmd({ action: "grid-panels" });
}

export async function listOpenAppWindows(): Promise<OpenWindowInfo[]> {
  return wbOpenApps.slice();
}

export function focusOpenApp(slug: string): void {
  sendWbCmd({ action: "focus", slug });
}

export function closeOpenApp(slug: string): void {
  sendWbCmd({ action: "close", slug });
}
