/**
 * Shared resolution from the user's server app/layout library (yo-server:
 * /api/panel-apps, /api/layouts) to WORKBENCH app panels.
 *
 * OS-native windows are retired: every app renders as a webview slot in the
 * Code page's right-side workbench, beside the agent. This module resolves
 * refs (fuzzy names, slugs, layout names) and drives the renderer over the
 * wb:app-cmd channel; the renderer reports its open panels back on
 * wb-apps-changed, which backs listOpenAppWindows for William's tools and
 * the relay's panels_* surface.
 */

import { ipcMain } from "electron";
import { cachedServerGet } from "./server-cache.js";
import { getPreference } from "./stores/preferences-db.js";
import { normKey, isSubsequence } from "./installed-apps.js";
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

interface LayoutSpec {
  id: string;
  name: string;
  cols: number;
  rows: number;
  cells: Array<{ panelId: string; col: number; row: number; colSpan: number; rowSpan: number }>;
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
  | { action: "open-many"; apps: WbAppRef[] }
  | { action: "terminal" }
  | { action: "close"; slug: string }
  | { action: "focus"; slug: string }
  | { action: "switcher" };

function sendWbCmd(cmd: WbCmd): void {
  const win = getMainWindowRef();
  if (!win || win.isDestroyed()) throw new Error("Glyphh window unavailable");
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
  win.webContents.send("wb:app-cmd", cmd);
}

/** The seeded "Glyphh" system app (archetype 'glyphh-self') — opening it
 *  focuses Glyphh's own window. */
function isGlyphhSelfRow(app: ServerApp): boolean {
  return app.appArchetype === "glyphh-self" || app.slug === "glyphh";
}

/** Built-in apps that aren't in the server library. */
function builtinRef(key: string): WbAppRef | "terminal" | null {
  if (key === "browser") return { slug: "browser", name: "Browser", url: resolveBrowserHomeUrl() };
  if (key === "terminal" || key === "term") return "terminal";
  return null;
}

/** A library row as a workbench panel ref. Native OS windows are DISABLED for
 *  now — every app opens as a webview panel beside the agent. Anything with a
 *  web surface (top-level url, or a url stashed in launchConfig for legacy
 *  "browser" rows) opens; the native execPath path is kept in the codebase
 *  (desktop-app scraping may revive it) but never taken here. */
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

  const apps = await cachedServerGet<ServerApp[]>("/api/panel-apps");
  const app = findLibraryApp(apps, ref);
  if (!app) throw new Error(`unknown app: ${ref} — not in the app library`);

  if (isGlyphhSelfRow(app)) {
    const win = getMainWindowRef();
    if (!win) throw new Error("Glyphh window unavailable");
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
    return { slug: app.slug, name: app.name };
  }

  const wbRef = toWbRef(app);
  console.log(`[app-open] "${app.name}" → panel`, JSON.stringify(wbRef));
  sendWbCmd({ action: "open", app: wbRef });
  return { slug: app.slug, name: app.name };
}

/** Open a saved layout by name — every cell becomes a workbench panel. */
export async function openLayoutByName(name: string): Promise<{ layout: string; apps: string[] }> {
  const key = name.trim().toLowerCase();
  if (!key) throw new Error("layout name is required");

  const [layouts, apps] = await Promise.all([
    cachedServerGet<LayoutSpec[]>("/api/layouts"),
    cachedServerGet<ServerApp[]>("/api/panel-apps"),
  ]);
  const layout = layouts.find((l) => l.name.toLowerCase() === key)
    || layouts.find((l) => l.id === name);
  if (!layout) {
    const names = layouts.map((l) => l.name).join(", ") || "(none saved)";
    throw new Error(`unknown layout: ${name} — saved layouts: ${names}`);
  }

  // Cell order approximates the grid: the workbench tiles panels in the
  // order they open. Native rows are skipped (no web surface to render).
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
    } catch { /* native row — skipped */ }
  }
  if (!refs.length) throw new Error(`layout "${layout.name}" has no web apps to open`);
  sendWbCmd({ action: "open-many", apps: refs });
  return { layout: layout.name, apps: opened };
}

export interface OpenWindowInfo { slug: string; name: string }

/** The workbench app panels currently open (renderer-reported). */
export async function listOpenAppWindows(): Promise<OpenWindowInfo[]> {
  return wbOpenApps.slice();
}

export function focusOpenApp(slug: string): void {
  sendWbCmd({ action: "focus", slug });
}

export function closeOpenApp(slug: string): void {
  sendWbCmd({ action: "close", slug });
}
