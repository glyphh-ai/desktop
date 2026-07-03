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
  macMinimizeWins, macMinimizeAllWins, macFocusApp, macPerms,
} from "./native-windows/mac-helper-backend";
import {
  winBackendAvailable, winList, winApps, winFront, winBounds,
  winMinimizeWins, winMinimizeAll as winMinimizeAllWins, winFocusApp,
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

async function frontWindow(): Promise<OsWindow | null> {
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
    const w = wins.find((x) => x.proc.toLowerCase().includes(n) || x.title.toLowerCase().includes(n));
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

/** Toggle the focused window between full-work-area and its prior bounds. */
export async function toggleExpandFocused(): Promise<boolean> {
  const front = await frontWindow();
  if (!front) return false;
  const wa = workArea();
  const isExpanded = Math.abs(front.x - wa.x) < 6 && Math.abs(front.y - wa.y) < 6
    && Math.abs(front.width - wa.width) < 6 && Math.abs(front.height - wa.height) < 6;
  const prior = priorBounds.get(front.proc);
  let target: Rect;
  if (isExpanded && prior) {
    target = prior;
    priorBounds.delete(front.proc);
  } else {
    priorBounds.set(front.proc, { x: front.x, y: front.y, width: front.width, height: front.height });
    target = wa;
  }
  await applyBounds([toTarget(front, target)]);
  return true;
}

export async function minimizeFocused(): Promise<boolean> {
  const front = await frontWindow();
  if (!front) return false;
  try {
    if (isMac) { await macMinimizeWin(front.id); return true; }
    if (isWin) { await winMinimizeWins([front.id]); return true; }
  } catch { /* fall through */ }
  return false;
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
 * Find the window matching `match` (process name or title, case-insensitive,
 * either direction) and move it to `rect`. Polls because a just-launched
 * native app's window may not exist yet — enumeration is now milliseconds,
 * so we poll fast and long enough to cover cold app starts (~10s).
 * Best-effort — returns false if never found.
 */
export async function positionAppWindow(match: string, rect: Rect, attempts = 50, delayMs = 200): Promise<boolean> {
  const m = match.trim().toLowerCase();
  if (!m || !osWindowsSupported()) return false;
  for (let i = 0; i < attempts; i++) {
    try {
      const wins = await listWindows();
      // Match either direction: "Visual Studio Code" hint ↔ "Code" process.
      const w = wins.find((x) => {
        const p = x.proc.toLowerCase();
        return p.includes(m) || m.includes(p) || x.title.toLowerCase().includes(m);
      });
      if (w) {
        await applyBounds([toTarget(w, rect)]);
        return true;
      }
    } catch { /* retry */ }
    await sleep(delayMs);
  }
  return false;
}
