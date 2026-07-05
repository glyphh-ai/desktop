/**
 * Shared resolution from the user's server app/layout library (yo-server:
 * /api/panel-apps, /api/layouts) to OS-window specs, plus the open helpers.
 *
 * Used by BOTH the MCP relay handlers (relay-handlers.ts) and the command
 * overlay (command-window.ts) so "open browser / open <app> / open <layout>"
 * behaves identically no matter what triggered it. Every layout opens as real
 * OS windows — nothing renders inside the Glyphh client.
 */

import { screen, app as electronApp } from "electron";
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { cachedServerGet } from "./server-cache.js";
import {
  openAppWindowAt, openAppWindowSlide, focusAppWindow, closeAppWindow, listAppWindows,
  resolveBrowserHomeUrl, type AppWindowSpec, type LayoutSpec,
} from "./app-window-manager.js";
import { launchNativeApp, launchWebApp, type LaunchResult } from "./native-launch.js";
import { getBrowser, detectBrowsers, type InstalledBrowser } from "./browser-detect.js";
import { getPreference } from "./stores/preferences-db.js";
import {
  positionAppWindow, focusWindow, setWindowBounds, listWindows, minimizeWindow,
  snapshotWindowIds, waitForAppWindow,
  type Rect as OsRect,
} from "./os-window-manager.js";
import { normKey, isSubsequence } from "./installed-apps.js";
import { openGlyphhApp, isGlyphhAppRow } from "./glyphh-app-host.js";
import { getMainWindowRef } from "./main-window-ref.js";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// ── Window-manager debug logging ─────────────────────────────────────
// Writes to <userData logs>/window-debug.log AND the main-process console so a
// native-window repro (which config's window gets opened/placed) is traceable.
// Temporary diagnostics for the two-same-binary-configs (e.g. two Terminals) bug.
let winDbgPath = "";
function wlog(...parts: unknown[]): void {
  const line = `[win-dbg ${new Date().toISOString()}] ` +
    parts.map((p) => (typeof p === "string" ? p : JSON.stringify(p))).join(" ");
  console.error(line);
  try {
    if (!winDbgPath) winDbgPath = join(electronApp.getPath("logs"), "window-debug.log");
    appendFileSync(winDbgPath, line + "\n");
  } catch { /* logging must never throw */ }
}
/** Snapshot of the tracked map (app-id → window-id) for logging. */
function trackedSnapshot(): Record<string, string> {
  return Object.fromEntries([...nativeAppWindows.entries()].map(([id, t]) => [id, t.winId]));
}

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
  // Browser ↔ Native model (mirrors SavedPanelApp): native apps carry an
  // execPath + archetype/launchConfig instead of a url.
  isBrowser?: boolean;
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
// saved-app row id → the OS window it owns (+ identity for panels_list).
// Covers BOTH native executables and web apps opened as browser windows —
// a browser is just another binary whose new window we adopt and drive.
const nativeAppWindows = new Map<string, { winId: string; slug: string; name: string }>();

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
async function openNativeTracked(
  app: ServerApp,
  rect: OsRect,
  retileOnFocus: boolean,
  // Custom launcher (web apps): hint = the browser's process name, run = the
  // browser launch, alwaysNewWindow = the launch always creates a window, so
  // adoption must never fall back to an existing one. Default = the
  // native-executable launch.
  launch?: { hint: string; run: () => LaunchResult; alwaysNewWindow?: boolean },
): Promise<void> {
  const hint = launch?.hint ?? ((app.execPath || "").split("/").pop()?.replace(/\.app$/, "") || app.name);
  wlog("openNativeTracked ENTER", { id: app.id, slug: app.slug, name: app.name, hint, exec: app.execPath, archetype: app.appArchetype, launchConfig: app.launchConfig, retileOnFocus, rect, map: trackedSnapshot() });

  const tracked = nativeAppWindows.get(app.id)?.winId;
  if (tracked) {
    // Minimized windows are excluded from the on-screen list — detect that so
    // we can re-apply bounds after the un-minimize animation (a single bounds
    // write mid-genie-animation is dropped, leaving the window at its old size
    // instead of full-screen).
    const visible = (await listWindows().catch(() => []));
    const trackedWin = visible.find((w) => w.id === tracked);
    const wasMinimized = !trackedWin;
    wlog("  tracked hit", { tracked, wasMinimized, trackedWin: trackedWin ? { proc: trackedWin.proc, title: trackedWin.title } : null });
    const focused = await focusWindow(tracked);
    wlog("  focusWindow(tracked)", { tracked, focused });
    let trackedAlive = focused;
    if (focused && wasMinimized) {
      // Absent from the visible list means minimized OR closed — and on macOS
      // focusWindow can "succeed" against a dead id (the AX call doesn't
      // throw). A real unminimize makes the window visible again; if it never
      // shows up, the user closed it — drop tracking and relaunch.
      if (retileOnFocus) {
        await setWindowBounds(tracked, rect);
        await sleep(180); await setWindowBounds(tracked, rect);
        await sleep(280); await setWindowBounds(tracked, rect);
      } else {
        await sleep(460);
      }
      const nowVisible = (await listWindows().catch(() => [])).some((w) => w.id === tracked);
      if (!nowVisible) {
        wlog("  tracked window never became visible — treating as CLOSED", { id: app.id, tracked });
        trackedAlive = false;
      }
    } else if (focused && retileOnFocus) {
      await setWindowBounds(tracked, rect);
    }
    if (trackedAlive) {
      wlog("  DONE via tracked-focus", { id: app.id, tracked });
      return;
    }
    wlog("  focus failed or window gone — dropping tracked + relaunching", { id: app.id, tracked });
    nativeAppWindows.delete(app.id); // window was closed — relaunch below
  } else {
    wlog("  no tracked window for this config — will launch/adopt");
  }

  // Gate settles when the launch has been issued (or failed) — the adopt
  // phase after it stays detached.
  let launched!: () => void;
  let launchFailed!: (e: Error) => void;
  const launchGate = new Promise<void>((res, rej) => { launched = res; launchFailed = rej; });

  const key = hint.toLowerCase();
  const prev = nativeOpenChains.get(key) ?? Promise.resolve();
  const task = prev.then(async () => {
    // Windows already owned by OTHER configs of this same binary (e.g. the
    // second Terminal). They must be excluded from adoption so this launch
    // can never claim another config's window — critical when they're
    // minimized, since a minimized window is absent from the CGWindowList
    // snapshot and would otherwise look "new" if the launch surfaces it.
    const ownedByOthers = new Set(
      [...nativeAppWindows.entries()].filter(([id]) => id !== app.id).map(([, t]) => t.winId),
    );
    const snap = await snapshotWindowIds(hint);
    const before = new Set([...snap, ...ownedByOthers]);
    wlog("  relaunch: snapshot", { id: app.id, hint, snapshot: [...snap], ownedByOthers: [...ownedByOthers] });
    const r = launch ? launch.run() : launchNativeApp(app.execPath ?? "", app.appArchetype ?? null, app.launchConfig ?? null);
    if (!r.ok) { wlog("  launch FAILED", { id: app.id, err: r.error }); launchFailed(new Error(r.error || "failed to launch native app")); return; }
    launched();
    const w = await waitForAppWindow(hint, before, { forbidden: ownedByOthers, noFallback: !!launch?.alwaysNewWindow });
    if (!w) { wlog("  no window appeared after launch", { id: app.id, hint }); console.error(`[app-resolver] no window appeared for "${app.name}" (${hint})`); return; }
    wlog("  ADOPTED window", { id: app.id, slug: app.slug, adopted: w.id, proc: w.proc, title: w.title, map: trackedSnapshot() });
    nativeAppWindows.set(app.id, { winId: w.id, slug: app.slug, name: app.name });
    await setWindowBounds(w.id, rect);
    // Raise the placed window — without this a layout can tile windows that
    // stay buried under unrelated apps (bounds don't change z-order).
    await focusWindow(w.id);
    wlog("  DONE via launch-adopt", { id: app.id, adopted: w.id });
  });
  nativeOpenChains.set(key, task.catch(() => {}));
  await launchGate;
}

/** How this web app's config says to open: which browser, window or tab. */
function webLaunchPlan(app: ServerApp): { browser: InstalledBrowser | null; openAs: "window" | "tab" } {
  const lc = (app.launchConfig || {}) as Record<string, unknown>;
  const pref = getPreference<string>("defaultBrowser", "default");
  const browser = getBrowser(typeof lc.browser === "string" && lc.browser ? lc.browser : pref)
    ?? detectBrowsers().find(() => false) ?? null;
  const openAs = lc.openAs === "tab" ? "tab" as const : "window" as const;
  return { browser: browser ?? null, openAs };
}

/**
 * Open a WEB app in its configured real browser. Window mode rides the same
 * tracked-open machinery as native apps — the browser is just another binary
 * whose new window we adopt, position, and re-focus on later opens. Tab mode
 * (or "System default" browser) is fire-and-forget: nothing to track.
 */
async function openWebTracked(app: ServerApp, rect: OsRect, retileOnFocus: boolean): Promise<void> {
  const url = String(app.url || "");
  if (!url.startsWith("http://") && !url.startsWith("https://")) throw new Error("app has no web URL");
  const { browser, openAs } = webLaunchPlan(app);
  if (!browser || openAs === "tab") {
    const r = launchWebApp(url, browser, openAs);
    if (!r.ok) throw new Error(r.error || "failed to open in browser");
    return;
  }
  await openNativeTracked(app, rect, retileOnFocus, {
    hint: browser.proc,
    run: () => launchWebApp(url, browser, "window"),
    alwaysNewWindow: true,
  });
}

/** Built-in apps that aren't in the server library. */
function builtinSpec(key: string): AppWindowSpec | null {
  if (key === "browser") return { slug: "browser", name: "Browser", url: resolveBrowserHomeUrl() };
  if (key === "terminal" || key === "term") return { slug: "terminal", name: "Terminal", url: "yo://terminal" };
  return null;
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

/**
 * Open a saved app (or built-in) the way its config says to — mirrors the
 * Apps page's app-launch dispatch:
 *   - native app (isBrowser=false) → launch its executable (VS Code, Terminal…)
 *   - web app → its URL in the user's configured real browser (window or tab)
 *   - built-in terminal → Glyphh's own terminal window
 */
export async function openAppByRef(ref: string): Promise<{ slug: string; name: string }> {
  const key = ref.trim().toLowerCase();
  if (!key) throw new Error("app is required");

  const builtin = builtinSpec(key);
  if (builtin) {
    if (builtin.url.startsWith("http")) {
      // Built-in "browser" → the user's real browser at their homepage.
      const wa0 = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
      await openWebTracked(
        { id: `builtin:${builtin.slug}`, slug: builtin.slug, name: builtin.name, url: builtin.url },
        { x: wa0.x, y: wa0.y, width: wa0.width, height: wa0.height }, true);
    } else {
      openAppWindowSlide(builtin); // terminal — Glyphh's own window
    }
    return { slug: builtin.slug, name: builtin.name };
  }

  const apps = await cachedServerGet<ServerApp[]>("/api/panel-apps");
  const app = findLibraryApp(apps, ref);
  wlog("openAppByRef", { ref, resolved: app ? { id: app.id, slug: app.slug, name: app.name, exec: app.execPath } : null,
    candidates: apps.filter((a) => (a.name + " " + (a.slug || "")).toLowerCase().includes(key)).map((a) => ({ id: a.id, slug: a.slug, name: a.name })) });
  if (!app) {
    throw new Error(`unknown app: ${ref} — not in the app library`);
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
  // Web app → the user's real browser, per its config (browser + window/tab).
  const wa2 = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
  await openWebTracked(app, { x: wa2.x, y: wa2.y, width: wa2.width, height: wa2.height }, true);
  return { slug: app.slug, name: app.name };
}

/**
 * Open a saved layout by name. Default "screen" mode tiles real OS windows
 * across the display under the cursor (nothing inside the Glyphh client).
 */
export async function openLayoutByName(name: string): Promise<{ layout: string; apps: string[] }> {
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

  // Tile each cell as a real OS window. Web apps open as browser windows and
  // native apps launch their executables — both adopted + placed through the
  // OS window layer. Nothing renders inside the Glyphh client.
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
    if (builtin) {
      if (builtin.url.startsWith("http")) {
        void openWebTracked({ id: `builtin:${builtin.slug}`, slug: builtin.slug, name: builtin.name, url: builtin.url }, bounds, true)
          .catch((err) => console.error(`[layout] browser cell failed: ${err instanceof Error ? err.message : err}`));
      } else {
        openAppWindowAt(builtin, bounds); // terminal — Glyphh's own window
      }
      opened.push(builtin.slug);
      continue;
    }

    const app = apps.find((a) => a.id === cell.panelId)
      || apps.find((a) => a.slug === key)
      || apps.find((a) => a.name.toLowerCase() === key);
    wlog("layout cell", { panelId: cell.panelId, cell: { row: cell.row, col: cell.col, rowSpan: cell.rowSpan, colSpan: cell.colSpan }, bounds, resolved: app ? { id: app.id, slug: app.slug, name: app.name } : null });
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
    const url = String(app.url || "");
    if (!url.startsWith("http://") && !url.startsWith("https://")) {
      console.error(`[layout] "${app.name}" — not native and no web URL, skipped`);
      continue;
    }
    // Web app → a tracked browser window tiled into the cell (tab-mode apps
    // just open; a tab can't be positioned). Fire-and-forget like natives.
    void openWebTracked(app, bounds, true).catch((err) =>
      console.error(`[layout] web "${app.name}" failed: ${err instanceof Error ? err.message : err}`));
    opened.push(app.slug);
  }

  if (opened.length === 0) throw new Error(`layout "${layout.name}" has no resolvable apps`);
  return { layout: layout.name, apps: opened };
}

// ── Panels surface (relay) — Electron windows + tracked OS windows ─────────

export interface OpenWindowInfo {
  app: string;
  name: string;
  url: string | null;
  title: string | null;
  focused: boolean;
}

/** Every open app window Glyphh knows about: Electron-hosted ones (terminal)
 *  plus tracked OS windows (native apps + web apps in browser windows).
 *  Minimized OS windows aren't in the visible list — they're skipped. */
export async function listOpenAppWindows(): Promise<OpenWindowInfo[]> {
  const out: OpenWindowInfo[] = listAppWindows();
  const visible = await listWindows().catch(() => []);
  for (const t of nativeAppWindows.values()) {
    const w = visible.find((x) => x.id === t.winId);
    if (!w) continue;
    out.push({ app: t.slug, name: t.name, url: null, title: w.title || t.name, focused: false });
  }
  return out;
}

/** Focus an app's window by slug — Electron windows first, then tracked. */
export async function focusOpenApp(slug: string): Promise<boolean> {
  if (focusAppWindow(slug)) return true;
  const t = [...nativeAppWindows.values()].find((x) => x.slug === slug);
  return t ? focusWindow(t.winId) : false;
}

/** Close an app's window by slug. Tracked OS windows can't be AX-closed yet,
 *  so they minimize instead (and stay tracked for the next open). */
export async function closeOpenApp(slug: string): Promise<boolean> {
  if (closeAppWindow(slug)) return true;
  const t = [...nativeAppWindows.values()].find((x) => x.slug === slug);
  return t ? minimizeWindow(t.winId) : false;
}
