/**
 * window-tiling — tracked opens of OTHER apps' OS windows, ported from the
 * OS-window era's app-resolver (e1b6f45^) onto the new layout model.
 *
 * Two saved apps can point at the SAME binary with different configs (e.g.
 * two Terminal apps with different cwd/init commands). Process-name matching
 * can't tell their windows apart, so we remember which OS window each saved
 * app row opened (pre-launch window-set diff → the window the launch created)
 * and drive THAT window on subsequent opens.
 *
 * Used by desktop-layout.ts to place native apps and real-browser web apps
 * into their grid cells, and by the .dip OS verbs.
 */

import { app as electronApp } from "electron";
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import type { ServerApp } from "./app-resolver.js";
import {
  launchNativeApp, launchWebApp, launchBrowserWindow, focusExistingBrowserTab,
  type LaunchResult,
} from "./native-launch.js";
import { resolveBrowser, browserForExecPath, type InstalledBrowser } from "./browser-detect.js";
import { getPreference } from "./stores/preferences-db.js";
import {
  focusWindow, setWindowBounds, listWindows, minimizeWindow,
  snapshotWindowIds, waitForAppWindow, frontWindow,
  type Rect as OsRect,
} from "./os-window-manager.js";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// ── Window-manager debug logging ─────────────────────────────────────
// Writes to <userData logs>/window-debug.log AND the main-process console so a
// native-window repro (which config's window gets opened/placed) is traceable.
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

// saved-app row id → the OS window it owns. Covers BOTH native executables
// and web apps opened as browser windows — a browser is just another binary
// whose new window we adopt and drive.
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
 * continues detached so callers aren't held through a cold app start.
 */
export async function openNativeTracked(
  app: ServerApp,
  rect: OsRect,
  retileOnFocus: boolean,
  // Custom launcher (web apps): hint = the browser's process name, run = the
  // browser launch, alwaysNewWindow = the launch always creates a window, so
  // adoption must never fall back to an existing one. Default = the
  // native-executable launch.
  launch?: {
    hint: string;
    run: () => LaunchResult;
    alwaysNewWindow?: boolean;
    /** Pre-launch dedupe: focus an already-open tab/window holding this app.
     *  null = nothing found (launch normally); { winId } = focused — stop,
     *  and track/place the window when it could be identified. */
    adoptExisting?: () => Promise<{ winId: string | null } | null>;
  },
): Promise<void> {
  // A saved "native" app whose binary IS a browser (a Chrome/Safari library
  // card): the default `open -a` launch can't create a window when the
  // browser is already running, so adoption finds nothing (every existing
  // window belongs to another config) and the open silently no-ops. Launch a
  // real NEW window instead; alwaysNewWindow keeps the adopt from ever
  // latching the user's personal window. Custom args keep the default path.
  if (!launch && app.execPath) {
    const lc = (app.launchConfig || {}) as Record<string, unknown>;
    const hasArgs = Array.isArray(lc.args) && lc.args.length > 0;
    const asBrowser = hasArgs ? null : browserForExecPath(app.execPath);
    if (asBrowser) {
      launch = { hint: asBrowser.proc, run: () => launchBrowserWindow(asBrowser), alwaysNewWindow: true };
    }
  }
  const hint = launch?.hint ?? ((app.execPath || "").split("/").pop()?.replace(/\.app$/, "") || app.name);
  wlog("openNativeTracked ENTER", { id: app.id, slug: app.slug, name: app.name, hint, exec: app.execPath, retileOnFocus, rect, map: trackedSnapshot() });

  const tracked = nativeAppWindows.get(app.id)?.winId;
  if (tracked) {
    // Minimized windows are excluded from the on-screen list — detect that so
    // we can re-apply bounds after the un-minimize animation (a single bounds
    // write mid-genie-animation is dropped, leaving the window at its old size
    // instead of full-screen).
    const visible = (await listWindows().catch(() => []));
    const trackedWin = visible.find((w) => w.id === tracked);
    const wasMinimized = !trackedWin;
    wlog("  tracked hit", { tracked, wasMinimized });
    const focused = await focusWindow(tracked);
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
    // The app's URL may already be open as a tab (user-opened, or from an
    // untracked session) — focus it instead of stacking a duplicate.
    if (launch?.adoptExisting) {
      const hit = await launch.adoptExisting().catch(() => null);
      if (hit) {
        if (hit.winId && !ownedByOthers.has(hit.winId)) {
          // Identified + unowned → it becomes this app's window.
          launched();
          nativeAppWindows.set(app.id, { winId: hit.winId, slug: app.slug, name: app.name });
          if (retileOnFocus) await setWindowBounds(hit.winId, rect);
          await focusWindow(hit.winId);
          wlog("  DONE via existing-tab adopt", { id: app.id, winId: hit.winId });
          return;
        }
        if (hit.winId) {
          // Hosted in a window OWNED by another app config — don't re-track
          // it, but the open still PLACES: the tab is focused, so position
          // the hosting window into the target rect. (Real-world case: the
          // user's "Chrome" library app owns the one big Chrome window that
          // hosts every tab-mode app.)
          launched();
          if (retileOnFocus) await setWindowBounds(hit.winId, rect);
          await focusWindow(hit.winId);
          wlog("  DONE via existing-tab focus (owned by another config — placed, not re-tracked)", { id: app.id, winId: hit.winId });
          return;
        }
        // Focused but the window couldn't be identified. A creating launch
        // (alwaysNewWindow) must STOP here — falling through would open a
        // duplicate. A no-op launch (tab mode) falls through so
        // waitForAppWindow's fallback polling can adopt the hosting window.
        if (launch.alwaysNewWindow) {
          launched();
          wlog("  DONE via existing-tab focus (window unidentified)", { id: app.id });
          return;
        }
        wlog("  existing tab focused, window unidentified — adopting via wait", { id: app.id });
      }
    }
    const snap = await snapshotWindowIds(hint);
    const before = new Set([...snap, ...ownedByOthers]);
    wlog("  relaunch: snapshot", { id: app.id, hint, snapshot: [...snap], ownedByOthers: [...ownedByOthers] });
    const r = launch ? launch.run() : launchNativeApp(app.execPath ?? "", app.appArchetype ?? null, app.launchConfig ?? null);
    if (!r.ok) { wlog("  launch FAILED", { id: app.id, err: r.error }); launchFailed(new Error(r.error || "failed to launch native app")); return; }
    launched();
    const w = await waitForAppWindow(hint, before, { forbidden: ownedByOthers, noFallback: !!launch?.alwaysNewWindow });
    if (!w) { wlog("  no window appeared after launch", { id: app.id, hint }); console.error(`[window-tiling] no window appeared for "${app.name}" (${hint})`); return; }
    wlog("  ADOPTED window", { id: app.id, slug: app.slug, adopted: w.id, proc: w.proc, title: w.title, map: trackedSnapshot() });
    nativeAppWindows.set(app.id, { winId: w.id, slug: app.slug, name: app.name });
    const placed = await setWindowBounds(w.id, rect);
    if (!placed) wlog("  setWindowBounds FAILED — window not moved (macOS: check the Accessibility grant)", { id: app.id, adopted: w.id, rect });
    // Raise the placed window — without this a layout can tile windows that
    // stay buried under unrelated apps (bounds don't change z-order).
    await focusWindow(w.id);
    wlog("  DONE via launch-adopt", { id: app.id, adopted: w.id });
  });
  nativeOpenChains.set(key, task.catch(() => {}));
  await launchGate;
}

/** How this web app's config says to open: which browser, window or tab.
 *  "default"/unset resolves to the machine's actual default browser so New
 *  window works there too (a real app path is needed to pass window flags). */
function webLaunchPlan(app: ServerApp): { browser: InstalledBrowser | null; openAs: "window" | "tab" } {
  const lc = (app.launchConfig || {}) as Record<string, unknown>;
  const configured = typeof lc.browser === "string" && lc.browser && lc.browser !== "glyphh-panel"
    ? lc.browser
    : getPreference<string>("defaultBrowser", "default");
  const openAs = lc.openAs === "tab" ? "tab" as const : "window" as const;
  return { browser: resolveBrowser(configured), openAs };
}

/** Does this OS window belong to the given browser? (proc names differ in
 *  casing/length between backends — match loosely, both directions). */
function isBrowserWindow(w: { proc: string } | null, browser: InstalledBrowser): boolean {
  if (!w) return false;
  const fp = w.proc.toLowerCase();
  const bp = browser.proc.toLowerCase();
  return fp.includes(bp) || bp.includes(fp);
}

/**
 * Open a WEB app in its configured real browser. ONE placement policy for
 * both open-as modes — the config only decides what gets created:
 *   window → a NEW browser window, adopted + placed;
 *   tab    → a tab (reusing an existing one with the app's URL), and the
 *            HOSTING browser window is adopted + placed.
 * "System default" browser stays fire-and-forget — we can't know which app
 * claimed the URL, so there's nothing to script or track.
 */
export async function openWebTracked(app: ServerApp, rect: OsRect, retileOnFocus: boolean): Promise<void> {
  const url = String(app.url || "");
  if (!url.startsWith("http://") && !url.startsWith("https://")) throw new Error("app has no web URL");
  const { browser, openAs } = webLaunchPlan(app);
  if (!browser) {
    const r = launchWebApp(url, null, openAs);
    if (!r.ok) throw new Error(r.error || "failed to open in browser");
    return;
  }

  if (openAs === "tab") {
    // Ensure the tab exists + is frontmost BEFORE the tracked open: select an
    // existing tab with this URL, else open a new one. This runs even when a
    // hosting window is already tracked — focusing the window isn't enough,
    // the right TAB has to come forward.
    const focused = await focusExistingBrowserTab(url, browser);
    if (!focused) {
      const r = launchWebApp(url, browser, "tab");
      if (!r.ok) throw new Error(r.error || "failed to open in browser");
      await sleep(600); // let the browser attach the tab (or begin launching)
    }
    await openNativeTracked(app, rect, retileOnFocus, {
      hint: browser.proc,
      run: () => ({ ok: true }), // the tab was ensured above — nothing to spawn
      adoptExisting: async () => {
        // The hunt/open raised the hosting window — adopt whatever browser
        // window is frontmost. If it can't be identified yet (browser still
        // launching), fall through to waitForAppWindow's existing-window
        // fallback, which polls for it.
        const front = await frontWindow().catch(() => null);
        return { winId: isBrowserWindow(front, browser) ? front!.id : null };
      },
    });
    return;
  }

  await openNativeTracked(app, rect, retileOnFocus, {
    hint: browser.proc,
    run: () => launchWebApp(url, browser, "window"),
    alwaysNewWindow: true,
    adoptExisting: async () => {
      // Solo-window hits only: a matching tab buried in the user's own
      // multi-tab window must NOT claim it — placing that window into the
      // app's rect hijacks the user's whole browser, and two apps whose
      // tabs share a window would thrash it between their rects. No solo
      // hit → fall through and open a real new window.
      if (!(await focusExistingBrowserTab(url, browser, { soloWindowOnly: true }))) return null;
      // The hunt raised the tab's window — identify it so it can be
      // tracked and placed like a window we opened ourselves.
      await sleep(250);
      const front = await frontWindow().catch(() => null);
      return { winId: isBrowserWindow(front, browser) ? front!.id : null };
    },
  });
}

/** The OS window a saved app row currently owns, if any — lets the layout
 *  re-tile foreign windows when a neighbor's shared edge moves. */
export function trackedWinId(appId: string): string | undefined {
  return nativeAppWindows.get(appId)?.winId;
}

/** Tracked OS windows (for panels_list-style surfaces): slug/name + liveness. */
export async function listTrackedWindows(): Promise<Array<{ app: string; name: string; title: string | null }>> {
  const visible = await listWindows().catch(() => []);
  const out: Array<{ app: string; name: string; title: string | null }> = [];
  for (const t of nativeAppWindows.values()) {
    const w = visible.find((x) => x.id === t.winId);
    if (!w) continue;
    out.push({ app: t.slug, name: t.name, title: w.title || t.name });
  }
  return out;
}

/** Focus a tracked app's window by slug. */
export async function focusTrackedApp(slug: string): Promise<boolean> {
  const t = [...nativeAppWindows.values()].find((x) => x.slug === slug);
  return t ? focusWindow(t.winId) : false;
}

/** "Close" a tracked app's window by slug — AX can't close foreign windows,
 *  so it minimizes (and stays tracked for the next open). */
export async function minimizeTrackedApp(slug: string): Promise<boolean> {
  const t = [...nativeAppWindows.values()].find((x) => x.slug === slug);
  return t ? minimizeWindow(t.winId) : false;
}
