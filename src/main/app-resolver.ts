/**
 * Shared resolution from the user's server app/layout library (yo-server:
 * /api/panel-apps, /api/layouts) to OS-window specs, plus the open helpers.
 *
 * Used by BOTH the MCP relay handlers (relay-handlers.ts) and the command
 * overlay (command-window.ts) so "open browser / open <app> / open <layout>"
 * behaves identically no matter what triggered it. Every layout opens as real
 * OS windows — nothing renders inside the Glyphh client.
 */

import { screen } from "electron";
import { serverGetAuthed } from "./auth.js";
import {
  openAppWindow, openAppWindowAt, openLayoutInWindow,
  resolveBrowserHomeUrl, type AppWindowSpec, type LayoutSpec,
} from "./app-window-manager.js";
import { launchNativeApp, launchInNativeChrome } from "./native-launch.js";
import { positionAppWindow } from "./os-window-manager.js";

export interface ServerApp {
  id: string;
  slug: string;
  name: string;
  url: string | null;
  forceWeb?: boolean;
  // Browser ↔ Native model (mirrors SavedPanelApp): native apps carry an
  // execPath + archetype/launchConfig instead of a url.
  isBrowser?: boolean;
  browserTarget?: "webview" | "native";
  execPath?: string | null;
  appArchetype?: string | null;
  launchConfig?: Record<string, unknown> | null;
}

/** Built-in apps that aren't in the server library. */
function builtinSpec(key: string): AppWindowSpec | null {
  if (key === "browser") return { slug: "browser", name: "Browser", url: resolveBrowserHomeUrl() };
  if (key === "terminal" || key === "term") return { slug: "terminal", name: "Terminal", url: "yo://terminal" };
  return null;
}

/** Resolve an app reference (slug / name / id) to a window spec, or throw. */
export async function resolveAppSpec(ref: string): Promise<AppWindowSpec> {
  const key = ref.trim().toLowerCase();
  if (!key) throw new Error("app is required");
  const builtin = builtinSpec(key);
  if (builtin) return builtin;

  const apps = await serverGetAuthed<ServerApp[]>("/api/panel-apps");
  const app = apps.find((a) => a.slug === key)
    || apps.find((a) => a.name.toLowerCase() === key)
    || apps.find((a) => a.id === ref.trim());
  if (!app?.url) throw new Error(`unknown app: ${ref} — use the app library slugs`);
  return { slug: app.slug, name: app.name, url: app.url, forceWeb: !!app.forceWeb };
}

/** A panelId→spec resolver bound to a fetched app library (for layout cells). */
export function makeCellResolver(apps: ServerApp[]): (panelId: string) => AppWindowSpec | null {
  return (panelId: string): AppWindowSpec | null => {
    const key = panelId.trim().toLowerCase();
    const builtin = builtinSpec(key);
    if (builtin) return builtin;
    const app = apps.find((a) => a.slug === key) || apps.find((a) => a.id === panelId);
    return app?.url ? { slug: app.slug, name: app.name, url: app.url, forceWeb: !!app.forceWeb } : null;
  };
}

/**
 * Open a saved app (or built-in) the way its config says to — mirrors the
 * Apps page's app-launch dispatch:
 *   - native app (isBrowser=false) → launch its executable (VS Code, Terminal…)
 *   - browser app, target "native" → open the URL in the user's real Chrome
 *   - browser app, target "webview" (default) or a built-in → an OS webview
 *     window (openAppWindow)
 */
export async function openAppByRef(ref: string): Promise<{ slug: string; name: string }> {
  const key = ref.trim().toLowerCase();
  if (!key) throw new Error("app is required");

  const builtin = builtinSpec(key);
  if (builtin) { openAppWindow(builtin); return { slug: builtin.slug, name: builtin.name }; }

  const apps = await serverGetAuthed<ServerApp[]>("/api/panel-apps");
  const app = apps.find((a) => a.slug === key)
    || apps.find((a) => a.name.toLowerCase() === key)
    || apps.find((a) => a.id === ref.trim());
  if (!app) throw new Error(`unknown app: ${ref} — use the app library slugs`);

  const isBrowser = app.isBrowser !== false; // legacy rows default to browser
  if (!isBrowser) {
    const r = launchNativeApp(app.execPath ?? "", app.appArchetype ?? null, app.launchConfig ?? null);
    if (!r.ok) throw new Error(r.error || "failed to launch native app");
    return { slug: app.slug, name: app.name };
  }
  if (app.browserTarget === "native") {
    const r = launchInNativeChrome(String(app.url || ""));
    if (!r.ok) throw new Error(r.error || "failed to open in browser");
    return { slug: app.slug, name: app.name };
  }
  const url = String(app.url || "");
  if (!url.startsWith("http://") && !url.startsWith("https://")) throw new Error("app has no web URL");
  openAppWindow({ slug: app.slug, name: app.name, url, forceWeb: !!app.forceWeb });
  return { slug: app.slug, name: app.name };
}

/**
 * Open a saved layout by name. Default "screen" mode tiles real OS windows
 * across the display under the cursor (nothing inside the Glyphh client).
 */
export async function openLayoutByName(
  name: string,
  mode: "screen" | "window" = "screen",
): Promise<{ layout: string; mode: string; apps: string[] }> {
  const key = name.trim().toLowerCase();
  if (!key) throw new Error("layout name is required");

  const layouts = await serverGetAuthed<Array<LayoutSpec & { id: string }>>("/api/layouts");
  const layout = layouts.find((l) => l.name.toLowerCase() === key)
    || layouts.find((l) => l.id === name);
  if (!layout) {
    const names = layouts.map((l) => l.name).join(", ") || "(none saved)";
    throw new Error(`unknown layout: ${name} — saved layouts: ${names}`);
  }

  const apps = await serverGetAuthed<ServerApp[]>("/api/panel-apps");

  if (mode === "window") {
    const opened = openLayoutInWindow(layout, makeCellResolver(apps));
    if (opened.length === 0) throw new Error(`layout "${layout.name}" has no resolvable apps`);
    return { layout: layout.name, mode, apps: opened };
  }

  // "screen" mode — tile each cell as a real OS window. Web/webview apps become
  // Glyphh windows placed at the cell rect; native apps (VS Code, Terminal…) are
  // launched, then best-effort moved into place through the OS window layer.
  const wa = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
  const colW = wa.width / layout.cols;
  const rowH = wa.height / layout.rows;
  const opened: string[] = [];

  for (const cell of layout.cells) {
    const bounds = {
      x: Math.round(wa.x + cell.col * colW),
      y: Math.round(wa.y + cell.row * rowH),
      width: Math.round(cell.colSpan * colW),
      height: Math.round(cell.rowSpan * rowH),
    };
    const key = cell.panelId.trim().toLowerCase();

    const builtin = builtinSpec(key);
    if (builtin) { openAppWindowAt(builtin, bounds); opened.push(builtin.slug); continue; }

    const app = apps.find((a) => a.id === cell.panelId)
      || apps.find((a) => a.slug === key)
      || apps.find((a) => a.name.toLowerCase() === key);
    if (!app) { console.error(`[layout] cell "${cell.panelId}" — no matching app in library`); continue; }

    // Native = explicitly flagged native, OR simply has an executable and no
    // URL (defensive: don't depend solely on the isBrowser flag).
    const isNative = app.isBrowser === false || (!!app.execPath && !app.url);
    if (isNative) {
      // Launch by execPath (exactly what the working Apps → Open button does),
      // then best-effort nudge its OS window into the cell.
      const r = launchNativeApp(app.execPath ?? "", app.appArchetype ?? null, app.launchConfig ?? null);
      console.error(`[layout] native "${app.name}" execPath="${app.execPath}" → ok=${r.ok}${r.error ? " — " + r.error : ""}`);
      if (!r.ok) continue;
      const hint = (app.execPath || "").split("/").pop()?.replace(/\.app$/, "") || app.name;
      void positionAppWindow(hint, bounds);
      opened.push(app.slug);
      continue;
    }
    if (app.browserTarget === "native") {
      // Opens in the user's real Chrome; positioning a specific Chrome window
      // isn't reliable, so just launch it.
      launchInNativeChrome(String(app.url || ""));
      opened.push(app.slug);
      continue;
    }
    const url = String(app.url || "");
    if (!url.startsWith("http://") && !url.startsWith("https://")) {
      console.error(`[layout] "${app.name}" — not native and no web URL, skipped`);
      continue;
    }
    openAppWindowAt({ slug: app.slug, name: app.name, url, forceWeb: !!app.forceWeb }, bounds);
    opened.push(app.slug);
  }

  if (opened.length === 0) throw new Error(`layout "${layout.name}" has no resolvable apps`);
  return { layout: layout.name, mode, apps: opened };
}
