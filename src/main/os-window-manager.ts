/**
 * os-window-manager — OS-level window control for the `.dip` layout commands.
 *
 * Unlike app-window-manager (which drives only Glyphh's own BrowserWindows),
 * this arranges/minimizes/expands EVERY visible app window on the machine —
 * Chrome, Slack, VS Code, Terminal, and Glyphh's own windows alike.
 *
 * Backends (src/main/native-windows/):
 *   - macOS   → bundled Swift helper (CGWindowList enumeration + AXUIElement
 *     manipulation — the same stack yabai/Rectangle use; needs the
 *     Accessibility permission). ~1-20ms per operation.
 *   - Windows → koffi FFI straight into user32/dwmapi (EnumWindows /
 *     SetWindowPos / ShowWindow / SetForegroundWindow). ~1-5ms per operation.
 *
 * Both replaced per-call process spawning (osascript with a System Events
 * full enumeration; PowerShell with a runtime-compiled Add-Type) that cost
 * 0.5-15s per operation and made native-window layouts unusable.
 *
 * Geometry (the target rects for grid/split/expand) is computed here in Node
 * against Electron's screen work area; the native layer only enumerates the
 * live windows and applies the bounds we hand it.
 *
 * NOTE: window control of arbitrary third-party apps is inherently best-effort
 * — some apps refuse AX/Win32 sizing or clamp their own size. Failures on
 * individual windows are swallowed so one stubborn app can't break a whole
 * `.dip grid`.
 */

import { screen } from "electron";
import {
  initMacHelper, disposeMacHelper, macHelperAvailable,
  macList, macApps, macFront, macBounds, macMinimizeWin,
  macMinimizeWins, macMinimizeAllWins, macFocusApp, macFocusWin, macPerms,
} from "./native-windows/mac-helper-backend";
import {
  winBackendAvailable, winList, winApps, winFront, winBounds,
  winMinimizeWins, winMinimizeAll as winMinimizeAllWins, winFocusApp, winFocusWindow,
} from "./native-windows/win-koffi-backend";

export interface OsWindow {
  /** Backend window id — macOS: "pid:cgWindowId", Windows: HWND as string. */
  id: string;
  pid: number;
  /** Owning application name (macOS) or executable base name (Windows). */
  proc: string;
  title: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Rect { x: number; y: number; width: number; height: number; }

export interface OsApp {
  /** Process / application name, e.g. "Google Chrome". */
  proc: string;
  /** Executable / .app bundle path ("" when unresolvable) — used for its icon. */
  path: string;
}

const isMac = process.platform === "darwin";
const isWin = process.platform === "win32";

// Remembered pre-expand bounds for the `exp` toggle, keyed by process name
// (best effort — we only track the frontmost window's app).
const priorBounds = new Map<string, Rect>();

/** Work area (screen minus menu bar / dock / taskbar) under the cursor. */
function workArea(): Rect {
  const d = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  return d.workArea;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ── lifecycle ────────────────────────────────────────────────────────────

/** Start the platform backend (pre-spawns the macOS helper). Call at boot. */
export function initOsWindowManager(): void {
  if (isMac) initMacHelper();
}

export function disposeOsWindowManager(): void {
  if (isMac) disposeMacHelper();
}

/** Trigger the macOS Accessibility prompt (no-op elsewhere). */
export async function requestOsWindowPermission(): Promise<boolean> {
  if (!isMac) return true;
  try { return (await macPerms(true)).trusted; } catch { return false; }
}

export function osWindowsSupported(): boolean {
  if (isMac) return macHelperAvailable();
  if (isWin) return winBackendAvailable();
  return false;
}

// ── core ops (platform-dispatched) ───────────────────────────────────────

export async function listWindows(): Promise<OsWindow[]> {
  if (isMac) return macList();
  if (isWin) return winList();
  return [];
}

export async function frontWindow(): Promise<OsWindow | null> {
  try {
    if (isMac) return await macFront();
    if (isWin) return await winFront();
  } catch { /* no frontmost window */ }
  return null;
}

async function applyBounds(items: Array<{ win: string } & Rect>): Promise<number> {
  if (items.length === 0) return 0;
  try {
    if (isMac) return (await macBounds(items)).applied;
    if (isWin) return await winBounds(items);
  } catch (err) {
    console.error("[os-win] applyBounds failed:", err instanceof Error ? err.message : err);
  }
  return 0;
}

async function minimizeWindows(wins: OsWindow[]): Promise<void> {
  if (wins.length === 0) return;
  const ids = wins.map((w) => w.id);
  try {
    if (isMac) await macMinimizeWins(ids);
    else if (isWin) await winMinimizeWins(ids);
  } catch (err) {
    console.error("[os-win] minimize failed:", err instanceof Error ? err.message : err);
  }
}

const toTarget = (w: OsWindow, r: Rect) => ({ win: w.id, ...r });

// ── arrangements ─────────────────────────────────────────────────────────

// Smallest cell we'll shrink a window to. Below this most apps hit their own
// minimum size and overflow their cell, so we cap grid density here and page
// (minimize) the overflow instead of producing a broken, overlapping grid.
const MIN_CELL_W = 440;
const MIN_CELL_H = 300;

/**
 * Tile open windows into an even grid across the work area, with cells no
 * smaller than MIN_CELL — windows that don't fit on this "page" are minimized.
 * Returns how many were gridded vs minimized.
 */
export async function arrangeGrid(): Promise<{ gridded: number; minimized: number }> {
  const wins = await listWindows();
  if (wins.length === 0) return { gridded: 0, minimized: 0 };
  const wa = workArea();

  const maxCols = Math.max(1, Math.floor(wa.width / MIN_CELL_W));
  const maxRows = Math.max(1, Math.floor(wa.height / MIN_CELL_H));
  const perPage = maxCols * maxRows;
  const count = Math.min(wins.length, perPage);

  let cols = Math.min(maxCols, Math.ceil(Math.sqrt(count)));
  let rows = Math.ceil(count / cols);
  if (rows > maxRows) { rows = maxRows; cols = Math.min(maxCols, Math.ceil(count / rows)); }
  const cellW = wa.width / cols;
  const cellH = wa.height / rows;

  const keep = wins.slice(0, count);
  const overflow = wins.slice(count);

  await applyBounds(keep.map((w, i) => {
    const c = i % cols, r = Math.floor(i / cols);
    return toTarget(w, { x: wa.x + c * cellW, y: wa.y + r * cellH, width: cellW, height: cellH });
  }));
  await minimizeWindows(overflow);
  return { gridded: keep.length, minimized: overflow.length };
}

/** Tile the first window of each named app side by side (columns). */
export async function arrangeSplit(appNames: string[]): Promise<number> {
  const names = appNames.map((n) => n.trim().toLowerCase()).filter(Boolean);
  if (names.length === 0) return 0;
  const wins = await listWindows();
  const picked: OsWindow[] = [];
  for (const n of names) {
    // Process name first; title only as a last resort (titles reflect content
    // — a Terminal running `claude` must not satisfy a "claude" split slot).
    const w = wins.find((x) => windowMatches(x, n))
      || wins.find((x) => x.title.toLowerCase().includes(n));
    if (w && !picked.includes(w)) picked.push(w);
  }
  if (picked.length === 0) return 0;
  const wa = workArea();
  const colW = wa.width / picked.length;
  await applyBounds(picked.map((w, i) =>
    toTarget(w, { x: wa.x + i * colW, y: wa.y, width: colW, height: wa.height })));
  return picked.length;
}

/** Expand every window to fill the work area. */
export async function expandAll(): Promise<number> {
  const wins = await listWindows();
  const wa = workArea();
  await applyBounds(wins.map((w) => toTarget(w, wa)));
  return wins.length;
}

/** Toggle a specific window between full-work-area and its prior bounds. */
export async function toggleExpandWindow(w: OsWindow): Promise<boolean> {
  const wa = workArea();
  const isExpanded = Math.abs(w.x - wa.x) < 6 && Math.abs(w.y - wa.y) < 6
    && Math.abs(w.width - wa.width) < 6 && Math.abs(w.height - wa.height) < 6;
  const prior = priorBounds.get(w.proc);
  let target: Rect;
  if (isExpanded && prior) {
    target = prior;
    priorBounds.delete(w.proc);
  } else {
    priorBounds.set(w.proc, { x: w.x, y: w.y, width: w.width, height: w.height });
    target = wa;
  }
  await applyBounds([toTarget(w, target)]);
  return true;
}

/** Toggle the focused window between full-work-area and its prior bounds. */
export async function toggleExpandFocused(): Promise<boolean> {
  const front = await frontWindow();
  if (!front) return false;
  return toggleExpandWindow(front);
}

/** Minimize one specific window. */
export async function minimizeWindow(id: string): Promise<boolean> {
  try {
    if (isMac) { await macMinimizeWin(id); return true; }
    if (isWin) { await winMinimizeWins([id]); return true; }
  } catch { /* window gone */ }
  return false;
}

export async function minimizeFocused(): Promise<boolean> {
  const front = await frontWindow();
  if (!front) return false;
  return minimizeWindow(front.id);
}

export async function minimizeAll(): Promise<boolean> {
  try {
    if (isMac) { await macMinimizeAllWins(); return true; }
    if (isWin) { await winMinimizeAllWins(); return true; }
  } catch (err) {
    console.error("[os-win] minimizeAll failed:", err instanceof Error ? err.message : err);
  }
  return false;
}

// ── running-apps list + focus (command overlay's "Running apps" section) ─

/** Visible, foreground-capable apps currently running (deduped by process). */
export async function listOsApps(): Promise<OsApp[]> {
  let rows: OsApp[] = [];
  try {
    if (isMac) rows = (await macApps()).map((a) => ({ proc: a.proc, path: a.path }));
    else if (isWin) rows = (await winApps()).map((a) => ({ proc: a.proc, path: a.path }));
  } catch (err) {
    console.error("[os-win] listOsApps failed:", err instanceof Error ? err.message : err);
    return [];
  }
  const seen = new Set<string>();
  return rows.filter((a) => {
    const k = a.proc.toLowerCase();
    if (!k || seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/** Bring a running app to the front (unminimizing its first window if needed). */
export async function focusOsApp(proc: string): Promise<boolean> {
  const name = proc.trim();
  if (!name) return false;
  try {
    if (isMac) { await macFocusApp(name); return true; }
    if (isWin) return await winFocusApp(name);
  } catch { /* not found */ }
  return false;
}

/**
 * Bring a running app to the front AND land its window full-work-area — the
 * command palette's "Running apps" click and typed-name open both use this,
 * matching the full-screen contract of library apps.
 */
export async function focusOsAppFullscreen(proc: string): Promise<boolean> {
  const name = proc.trim();
  if (!name) return false;
  try {
    const w = (await listWindows()).find((x) => windowMatches(x, name));
    if (w) {
      const ok = await focusWindow(w.id);
      if (ok) {
        await setWindowBounds(w.id, workArea());
        return true;
      }
    }
  } catch { /* fall through */ }
  // No enumerable window — e.g. the app is MINIMIZED on macOS, which excludes
  // it from the on-screen window list. Plain app focus unminimizes + activates,
  // but that alone reopens the window at its old size/position. Once it's back
  // on screen, poll for it and land it full work-area (same contract as an
  // already-visible app), so a minimized app still opens full-screen.
  const focused = await focusOsApp(name);
  if (focused) await positionAppWindow(name, workArea());
  return focused;
}

/**
 * Does this window belong to the app named by `hint`? PROCESS NAME only, in
 * either direction ("Visual Studio Code" hint ↔ "Code" process, ≥3 chars for
 * the reverse so a short proc name can't swallow everything).
 *
 * Deliberately NOT title-based: titles reflect content, not identity — a
 * Terminal running the `claude` CLI has "claude" in its title, and title
 * matching made the Claude app adopt/position the Terminal window.
 */
export function windowMatches(w: OsWindow, hint: string): boolean {
  const m = hint.trim().toLowerCase();
  if (!m) return false;
  const p = w.proc.toLowerCase();
  if (!p) return false;
  return p.includes(m) || (p.length >= 3 && m.includes(p));
}

/** Bring one SPECIFIC window to front (unminimize + raise + activate). Fails
 *  (false) when the window no longer exists — callers relaunch on that. */
export async function focusWindow(id: string): Promise<boolean> {
  try {
    if (isMac) { await macFocusWin(id); return true; }
    if (isWin) return await winFocusWindow(Number(id));
  } catch { /* window gone */ }
  return false;
}

/** Move/resize one specific window. */
export async function setWindowBounds(id: string, rect: Rect): Promise<boolean> {
  return (await applyBounds([{ win: id, ...rect }])) > 0;
}

/** Ids of the windows currently matching `hint` — snapshot BEFORE launching
 *  an app so waitForAppWindow can spot the window the launch created. */
export async function snapshotWindowIds(hint: string): Promise<Set<string>> {
  try {
    return new Set((await listWindows()).filter((w) => windowMatches(w, hint)).map((w) => w.id));
  } catch { return new Set(); }
}

/**
 * Wait for the window a just-launched app creates, by window-set diff: the
 * first matching window whose id was NOT in `excludeIds` (the pre-launch
 * snapshot). Handles single-binary/multi-config apps (two Terminal configs)
 * and single-instance apps whose launcher pid exits (Chrome, VS Code).
 *
 * Launches that reuse an existing window (Terminal tab/blank modes) never
 * produce a new id — after `graceMs` we fall back to the frontmost existing
 * match (enumeration is front-to-back), which is where the new tab landed.
 *
 * `opts.forbidden` — windows that must NEVER be adopted (e.g. owned by another
 * config of the same binary). The reuse fallback skips these, so two Terminal
 * configs can't collapse onto one window; if the only candidates are forbidden,
 * this returns null rather than steal another config's window.
 */
export async function waitForAppWindow(
  hint: string,
  excludeIds: Set<string>,
  opts?: { timeoutMs?: number; graceMs?: number; pollMs?: number; forbidden?: Set<string> },
): Promise<OsWindow | null> {
  const timeoutMs = opts?.timeoutMs ?? 10_000;
  const graceMs = opts?.graceMs ?? 2_000;
  const pollMs = opts?.pollMs ?? 150;
  const forbidden = opts?.forbidden ?? new Set<string>();
  const t0 = Date.now();
  let fallback: OsWindow | null = null;
  while (Date.now() - t0 < timeoutMs) {
    try {
      const matches = (await listWindows()).filter((w) => windowMatches(w, hint));
      const fresh = matches.find((w) => !excludeIds.has(w.id));
      if (fresh) return fresh;
      // Reuse fallback: frontmost matching window that isn't owned by another
      // config. Never latch a forbidden window (that's the cross-wiring bug).
      if (!fallback) fallback = matches.find((w) => !forbidden.has(w.id)) ?? null;
      if (fallback && Date.now() - t0 >= graceMs) return fallback;
    } catch { /* retry */ }
    await sleep(pollMs);
  }
  return fallback;
}

/**
 * Find the window matching `match` (process name or title, case-insensitive,
 * either direction) and move it to `rect`. Polls because a just-launched
 * native app's window may not exist yet — enumeration is now milliseconds,
 * so we poll fast and long enough to cover cold app starts (~10s).
 * Best-effort — returns false if never found. (Used for installed-OS-app
 * fallbacks with no saved-app identity; library apps go through the tracked
 * flow in app-resolver instead.)
 */
export async function positionAppWindow(match: string, rect: Rect, attempts = 50, delayMs = 200): Promise<boolean> {
  const m = match.trim().toLowerCase();
  if (!m || !osWindowsSupported()) return false;
  for (let i = 0; i < attempts; i++) {
    try {
      const w = (await listWindows()).find((x) => windowMatches(x, match));
      if (w) {
        await applyBounds([toTarget(w, rect)]);
        return true;
      }
    } catch { /* retry */ }
    await sleep(delayMs);
  }
  return false;
}
