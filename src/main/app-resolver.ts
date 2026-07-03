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
import { cachedServerGet } from "./server-cache.js";
import {
  openAppWindowAt, openAppWindowSlide, openLayoutInWindow,
  resolveBrowserHomeUrl, type AppWindowSpec, type LayoutSpec,
} from "./app-window-manager.js";
import { launchNativeApp, launchInNativeChrome } from "./native-launch.js";
import {
  positionAppWindow, focusWindow, setWindowBounds,
  snapshotWindowIds, waitForAppWindow, listOsApps, focusOsAppFullscreen,
  type Rect as OsRect,
} from "./os-window-manager.js";
import { findInstalledApp, launchInstalledApp, normKey, isSubsequence } from "./installed-apps.js";
import { openGlyphhApp, isGlyphhAppRow } from "./glyphh-app-host.js";
import { getMainWindowRef } from "./main-window-ref.js";

/** The seeded "Glyphh" system app (archetype 'glyphh-self') — the palette's
 *  permanent top-left card. Opening it focuses Glyphh's own window; its
 *  install location is machine-specific so the server row carries no path. */
function isGlyphhSelfRow(app: ServerApp): boolean {
  return app.appArchetype === "glyphh-self" || app.slug === "glyphh";
}

function focusGlyphhSelf(rect?: { x: number; y: number; width: number; height: number }): boolean {
  const win = getMainWindowRef();
  if (!win) return false;
  if (win.isMinimized()) win.restore();
  if (rect) win.setBounds(rect);
  win.show();
  win.focus();
  return true;
}

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

// ── Native-app window tracking ──────────────────────────────────────────
//
// Two saved apps can point at the SAME binary with different configs (e.g.
// two Terminal apps with different cwd/init commands). Process-name matching
// can't tell their windows apart, so the window manager grabbed/focused the
// wrong one when toggling. Instead, remember which OS window each saved app
// row opened (pre-launch window-set diff → the window the launch created)
// and drive THAT window on subsequent opens.
const nativeAppWindows = new Map<string, string>(); // saved-app row id → OS window id

// Launch+adopt chains, one per binary. Two same-binary launches in quick
// succession (a layout with both Terminal configs) must not race: the second
// snapshot has to include the window the first launch created, or both
// waiters could adopt the same window. Different binaries run in parallel.
const nativeOpenChains = new Map<string, Promise<void>>();

/**
 * Open a native library app with window identity:
 *  - already tracked and its window still exists → focus it (retile to `rect`
 *    only when the caller is a layout placing tiles)
 *  - otherwise snapshot matching windows, launch, then adopt the NEW window
 *    the launch created (window-set diff; grace-fallback to the frontmost
 *    match for launches that reuse a window, e.g. Terminal tab/blank modes)
 *    and position it.
 * Resolves once the launch itself has been issued — adoption/positioning
 * continues detached so callers (and the thinking scrim) aren't held through
 * a cold app start.
 */
async function openNativeTracked(app: ServerApp, rect: OsRect, retileOnFocus: boolean): Promise<void> {
  const hint = (app.execPath || "").split("/").pop()?.replace(/\.app$/, "") || app.name;

  const tracked = nativeAppWindows.get(app.id);
  if (tracked) {
    if (await focusWindow(tracked)) {
      if (retileOnFocus) await setWindowBounds(tracked, rect);
      return;
    }
    nativeAppWindows.delete(app.id); // window was closed — relaunch below
  }

  // Gate settles when the launch has been issued (or failed) — the adopt
  // phase after it stays detached.
  let launched!: () => void;
  let launchFailed!: (e: Error) => void;
  const launchGate = new Promise<void>((res, rej) => { launched = res; launchFailed = rej; });

  const key = hint.toLowerCase();
  const prev = nativeOpenChains.get(key) ?? Promise.resolve();
  const task = prev.then(async () => {
    const before = await snapshotWindowIds(hint);
    const r = launchNativeApp(app.execPath ?? "", app.appArchetype ?? null, app.launchConfig ?? null);
    if (!r.ok) { launchFailed(new Error(r.error || "failed to launch native app")); return; }
    launched();
    const w = await waitForAppWindow(hint, before);
    if (!w) { console.error(`[app-resolver] no window appeared for "${app.name}" (${hint})`); return; }
    nativeAppWindows.set(app.id, w.id);
    await setWindowBounds(w.id, rect);
    // Raise the placed window — without this a layout can tile windows that
    // stay buried under unrelated apps (bounds don't change z-order).
    await focusWindow(w.id);
  });
  nativeOpenChains.set(key, task.catch(() => {}));
  await launchGate;
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

  const apps = await cachedServerGet<ServerApp[]>("/api/panel-apps");
  const app = apps.find((a) => a.slug === key)
    || apps.find((a) => a.name.toLowerCase() === key)
    || apps.find((a) => a.id === ref.trim());
  if (!app?.url) throw new Error(`unknown app: ${ref} — use the app library slugs`);
  return { slug: app.slug, name: app.name, url: app.url, forceWeb: !!app.forceWeb };
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
  if (builtin) { openAppWindowSlide(builtin); return { slug: builtin.slug, name: builtin.name }; }

  const apps = await cachedServerGet<ServerApp[]>("/api/panel-apps");
  const app = findLibraryApp(apps, ref);
  if (!app) {
    // Not in the library — fall back to any app installed on this machine
    // (macOS: .app bundles in the standard folders). `open -a` launches a
    // cold app or activates a running one; then best-effort full-screen it.
    const installed = findInstalledApp(ref);
    if (installed) {
      launchInstalledApp(installed);
      const wa = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
      void positionAppWindow(installed.name, { x: wa.x, y: wa.y, width: wa.width, height: wa.height });
      return { slug: normKey(installed.name), name: installed.name };
    }
    // Last resort: a RUNNING app whose process name matches (covers procs
    // whose name differs from any installed .app, and Windows, where the
    // installed-apps scan doesn't exist). Same tiers as findInstalledApp.
    const running = await listOsApps().catch(() => [] as Array<{ proc: string; path: string }>);
    const nk = normKey(ref);
    const hit = running.find((a) => normKey(a.proc) === nk)
      || (nk.length >= 2
        ? running.find((a) => normKey(a.proc).startsWith(nk)) || running.find((a) => normKey(a.proc).includes(nk))
        : undefined)
      || (nk.length >= 4 ? running.find((a) => isSubsequence(nk, normKey(a.proc))) : undefined);
    if (hit) {
      await focusOsAppFullscreen(hit.proc);
      return { slug: normKey(hit.proc), name: hit.proc };
    }
    throw new Error(`unknown app: ${ref} — not in the app library, installed apps, or running apps`);
  }

  // The Glyphh system app → focus our own window (nothing to launch).
  if (isGlyphhSelfRow(app)) {
    if (!focusGlyphhSelf()) throw new Error("Glyphh window unavailable");
    return { slug: app.slug, name: app.name };
  }

  // Installed Glyphh app (marketplace unit) → capability-scoped window.
  if (isGlyphhAppRow(app)) {
    const r = openGlyphhApp({ name: app.name, slug: app.slug, execPath: app.execPath, launchConfig: app.launchConfig });
    if (!r.ok) throw new Error(r.error || "failed to open app");
    return { slug: app.slug, name: app.name };
  }

  // Native = explicitly flagged, or simply has an executable and no URL.
  const isNative = app.isBrowser === false || (!!app.execPath && !app.url);
  if (isNative) {
    // Tracked open: re-opening focuses THIS app's own window (not whichever
    // window of the shared binary happens to be first). retileOnFocus=true —
    // `.dip <app>` / a palette click always lands the app full-screen, the
    // same contract web apps get from openAppWindowSlide's reuse path.
    const wa = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
    await openNativeTracked(app, { x: wa.x, y: wa.y, width: wa.width, height: wa.height }, true);
    return { slug: app.slug, name: app.name };
  }
  if (app.browserTarget === "native") {
    const r = launchInNativeChrome(String(app.url || ""));
    if (!r.ok) throw new Error(r.error || "failed to open in browser");
    return { slug: app.slug, name: app.name };
  }
  const url = String(app.url || "");
  if (!url.startsWith("http://") && !url.startsWith("https://")) throw new Error("app has no web URL");
  openAppWindowSlide({ slug: app.slug, name: app.name, url, forceWeb: !!app.forceWeb });
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

  // Fetch both in parallel (the apps list doesn't depend on the layout), and
  // through the cache — the command palette fetched the same data seconds ago
  // to render its list, so a click normally opens with zero network waits.
  const [layouts, apps] = await Promise.all([
    cachedServerGet<Array<LayoutSpec & { id: string }>>("/api/layouts"),
    cachedServerGet<ServerApp[]>("/api/panel-apps"),
  ]);
  const layout = layouts.find((l) => l.name.toLowerCase() === key)
    || layouts.find((l) => l.id === name);
  if (!layout) {
    const names = layouts.map((l) => l.name).join(", ") || "(none saved)";
    throw new Error(`unknown layout: ${name} — saved layouts: ${names}`);
  }

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

    // The Glyphh system app → tile our own window into the cell.
    if (isGlyphhSelfRow(app)) {
      if (focusGlyphhSelf(bounds)) opened.push(app.slug);
      continue;
    }

    // Installed Glyphh app → its own capability-scoped window (no tiling).
    if (isGlyphhAppRow(app)) {
      const gr = openGlyphhApp({ name: app.name, slug: app.slug, execPath: app.execPath, launchConfig: app.launchConfig });
      if (gr.ok) opened.push(app.slug);
      continue;
    }

    // Native = explicitly flagged native, OR simply has an executable and no
    // URL (defensive: don't depend solely on the isBrowser flag).
    const isNative = app.isBrowser === false || (!!app.execPath && !app.url);
    if (isNative) {
      // Tracked open: each saved app owns ITS window (two configs of the same
      // binary get two distinct windows). retileOnFocus=true — a layout must
      // land the window in its cell even if it was already open elsewhere.
      // Fire-and-forget: same-binary launches serialize internally (adopt
      // chain), and the layout handler shouldn't wait through app starts.
      void openNativeTracked(app, bounds, true).catch((err) =>
        console.error(`[layout] native "${app.name}" failed: ${err instanceof Error ? err.message : err}`));
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
