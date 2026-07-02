/**
 * os-window-manager — OS-level window control for the `.dip` layout commands.
 *
 * Unlike app-window-manager (which drives only Glyphh's own BrowserWindows),
 * this arranges/minimizes/expands EVERY visible app window on the machine —
 * Chrome, Slack, VS Code, Terminal, and Glyphh's own windows alike.
 *
 * Backends:
 *   - macOS   → AppleScript via System Events (needs Accessibility permission)
 *   - Windows → PowerShell + user32 (EnumWindows / SetWindowPos / ShowWindow)
 *
 * Geometry (the target rects for grid/split/expand) is computed here in Node
 * against Electron's screen work area; the native layer only enumerates the
 * live windows and applies the bounds we hand it.
 *
 * NOTE: window control of arbitrary third-party apps is inherently best-effort
 * — some apps refuse scripting or clamp their own size. Failures on individual
 * windows are swallowed so one stubborn app can't break a whole `.dip grid`.
 */

import { spawn } from "child_process";
import { screen } from "electron";

export interface OsWindow {
  /** Owning application / process name (macOS) or process name (Windows). */
  proc: string;
  /** macOS: 1-based window index within its process. Windows: unused (0). */
  index: number;
  /** Windows: the HWND as a string. Empty on macOS. */
  hwnd: string;
  title: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Rect { x: number; y: number; width: number; height: number; }

interface Target extends Rect { proc: string; index: number; hwnd: string; }

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

// ── process spawners ─────────────────────────────────────────────────────

// Generous timeout: the FIRST call blocks on the macOS "control System Events"
// Automation prompt until the user responds. If they miss it we don't want the
// keytap spinner stuck forever — kill it and surface an error instead.
function run(cmd: string, args: string[], timeoutMs = 15000): Promise<string> {
  return new Promise((resolve, reject) => {
    let out = "", err = "", settled = false;
    const p = spawn(cmd, args);
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { p.kill("SIGKILL"); } catch { /* noop */ }
      reject(new Error(`${cmd} timed out — grant Glyphh Accessibility + Automation permission (System Settings → Privacy & Security)`));
    }, timeoutMs);
    p.stdout.on("data", (d) => { out += d.toString(); });
    p.stderr.on("data", (d) => { err += d.toString(); });
    p.on("error", (e) => { if (!settled) { settled = true; clearTimeout(timer); reject(e); } });
    p.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      code === 0 ? resolve(out) : reject(new Error(err.trim() || `${cmd} exited ${code}`));
    });
  });
}

const osa = (script: string) => run("osascript", ["-e", script]);
const ps = (script: string) =>
  run("powershell", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script]);

function esc(s: string): string { return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"'); }

// ── macOS (System Events) ────────────────────────────────────────────────

// NB: `rows` is a reserved System Events term (table rows) — using it as a
// variable throws -10006. Use `acc` for the accumulator.
const MAC_LIST = `
tell application "System Events"
  set AppleScript's text item delimiters to linefeed
  set acc to {}
  repeat with proc in (every process whose visible is true and background only is false)
    set pn to name of proc
    set wi to 0
    repeat with w in (every window of proc)
      set wi to wi + 1
      try
        set pos to position of w
        set sz to size of w
        set end of acc to pn & tab & wi & tab & (name of w) & tab & (item 1 of pos) & tab & (item 2 of pos) & tab & (item 1 of sz) & tab & (item 2 of sz)
      end try
    end repeat
  end repeat
  return acc as text
end tell`;

async function macList(): Promise<OsWindow[]> {
  const out = await osa(MAC_LIST);
  return out.split("\n").map((line) => line.split("\t")).filter((f) => f.length >= 7).map((f) => ({
    proc: f[0], index: Number(f[1]), hwnd: "", title: f[2],
    x: Number(f[3]), y: Number(f[4]), width: Number(f[5]), height: Number(f[6]),
  }));
}

function macApply(targets: Target[]): Promise<string> {
  const body = targets.map((t) =>
    `try
  tell application "System Events" to tell process "${esc(t.proc)}"
    set position of window ${t.index} to {${Math.round(t.x)}, ${Math.round(t.y)}}
    set size of window ${t.index} to {${Math.round(t.width)}, ${Math.round(t.height)}}
  end tell
end try`).join("\n");
  return osa(body || "return");
}

const MAC_FRONT = `
tell application "System Events"
  set fp to first process whose frontmost is true
  set pos to position of window 1 of fp
  set sz to size of window 1 of fp
  return (name of fp) & tab & (item 1 of pos) & tab & (item 2 of pos) & tab & (item 1 of sz) & tab & (item 2 of sz)
end tell`;

async function macFrontWindow(): Promise<OsWindow | null> {
  try {
    const f = (await osa(MAC_FRONT)).trim().split("\t");
    if (f.length < 5) return null;
    return { proc: f[0], index: 1, hwnd: "", title: "", x: Number(f[1]), y: Number(f[2]), width: Number(f[3]), height: Number(f[4]) };
  } catch { return null; }
}

function macSetFront(r: Rect): Promise<string> {
  return osa(`tell application "System Events" to tell (first process whose frontmost is true)
  set position of window 1 to {${Math.round(r.x)}, ${Math.round(r.y)}}
  set size of window 1 to {${Math.round(r.width)}, ${Math.round(r.height)}}
end tell`);
}

function macMinimizeFront(): Promise<string> {
  return osa(`tell application "System Events" to set value of attribute "AXMinimized" of window 1 of (first process whose frontmost is true) to true`);
}

function macMinimizeAll(): Promise<string> {
  return osa(`tell application "System Events"
  repeat with proc in (every process whose visible is true and background only is false)
    repeat with w in (every window of proc)
      try
        set value of attribute "AXMinimized" of w to true
      end try
    end repeat
  end repeat
end tell`);
}

// ── Windows (user32 via PowerShell) ──────────────────────────────────────

const WIN_USER32 = `
Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public class Win32 {
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr hWnd, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT r);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr hWnd, IntPtr after, int x, int y, int cx, int cy, uint flags);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int cmd);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
  public struct RECT { public int Left, Top, Right, Bottom; }
}
"@`;

async function winList(): Promise<OsWindow[]> {
  const script = `${WIN_USER32}
$rows = New-Object System.Collections.ArrayList
$cb = {
  param($h,$l)
  if ([Win32]::IsWindowVisible($h) -and -not [Win32]::IsIconic($h)) {
    $len = [Win32]::GetWindowTextLength($h)
    if ($len -gt 0) {
      $sb = New-Object System.Text.StringBuilder ($len + 1)
      [void][Win32]::GetWindowText($h, $sb, $sb.Capacity)
      $r = New-Object Win32+RECT
      [void][Win32]::GetWindowRect($h, [ref]$r)
      $procId = 0; [void][Win32]::GetWindowThreadProcessId($h, [ref]$procId)
      $pn = try { (Get-Process -Id $procId -ErrorAction Stop).ProcessName } catch { "" }
      $w = $r.Right - $r.Left; $ht = $r.Bottom - $r.Top
      if ($w -gt 0 -and $ht -gt 0) {
        [void]$rows.Add(("{0}\`t{1}\`t{2}\`t{3}\`t{4}\`t{5}\`t{6}" -f $pn, $h.ToInt64(), $sb.ToString(), $r.Left, $r.Top, $w, $ht))
      }
    }
  }
  return $true
}
[void][Win32]::EnumWindows($cb, [IntPtr]::Zero)
$rows -join "\`n"`;
  const out = await ps(script);
  return out.split("\n").map((l) => l.trim().split("\t")).filter((f) => f.length >= 7).map((f) => ({
    proc: f[0], index: 0, hwnd: f[1], title: f[2],
    x: Number(f[3]), y: Number(f[4]), width: Number(f[5]), height: Number(f[6]),
  }));
}

function winApply(targets: Target[]): Promise<string> {
  const SWP = "0x0004 -bor 0x0010"; // SWP_NOZORDER | SWP_NOACTIVATE
  const lines = targets.map((t) =>
    `[void][Win32]::SetWindowPos([IntPtr]${t.hwnd}, [IntPtr]::Zero, ${Math.round(t.x)}, ${Math.round(t.y)}, ${Math.round(t.width)}, ${Math.round(t.height)}, (${SWP}))`).join("\n");
  return ps(`${WIN_USER32}\n${lines}`);
}

async function winFrontWindow(): Promise<OsWindow | null> {
  const script = `${WIN_USER32}
$h = [Win32]::GetForegroundWindow()
$r = New-Object Win32+RECT
[void][Win32]::GetWindowRect($h, [ref]$r)
$procId = 0; [void][Win32]::GetWindowThreadProcessId($h, [ref]$procId)
$pn = try { (Get-Process -Id $procId -ErrorAction Stop).ProcessName } catch { "" }
"{0}\`t{1}\`t{2}\`t{3}\`t{4}\`t{5}" -f $pn, $h.ToInt64(), $r.Left, $r.Top, ($r.Right-$r.Left), ($r.Bottom-$r.Top)`;
  try {
    const f = (await ps(script)).trim().split("\t");
    if (f.length < 6) return null;
    return { proc: f[0], index: 0, hwnd: f[1], title: "", x: Number(f[2]), y: Number(f[3]), width: Number(f[4]), height: Number(f[5]) };
  } catch { return null; }
}

function winMinimizeFront(): Promise<string> {
  return ps(`${WIN_USER32}\n[void][Win32]::ShowWindow([Win32]::GetForegroundWindow(), 6)`);
}

async function winMinimizeAll(): Promise<string> {
  const wins = await winList();
  return ps(`${WIN_USER32}\n${wins.map((w) => `[void][Win32]::ShowWindow([IntPtr]${w.hwnd}, 6)`).join("\n")}`);
}

// ── public API (platform-dispatched) ─────────────────────────────────────

export function osWindowsSupported(): boolean { return isMac || isWin; }

export async function listWindows(): Promise<OsWindow[]> {
  if (isMac) return macList();
  if (isWin) return winList();
  return [];
}

async function frontWindow(): Promise<OsWindow | null> {
  if (isMac) return macFrontWindow();
  if (isWin) return winFrontWindow();
  return null;
}

function applyBounds(targets: Target[]): Promise<string> {
  if (targets.length === 0) return Promise.resolve("");
  if (isMac) return macApply(targets);
  if (isWin) return winApply(targets);
  return Promise.resolve("");
}

const toTarget = (w: OsWindow, r: Rect): Target => ({ proc: w.proc, index: w.index, hwnd: w.hwnd, ...r });

/** Tile every open window into an even grid across the work area. */
export async function arrangeGrid(): Promise<number> {
  const wins = await listWindows();
  if (wins.length === 0) return 0;
  const rects = gridRects(wins.length);
  await applyBounds(wins.map((w, i) => toTarget(w, rects[i])));
  return wins.length;
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
  if (isMac) { await macMinimizeFront(); return true; }
  if (isWin) { await winMinimizeFront(); return true; }
  return false;
}

export async function minimizeAll(): Promise<boolean> {
  if (isMac) { await macMinimizeAll(); return true; }
  if (isWin) { await winMinimizeAll(); return true; }
  return false;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Find the window matching `match` (process name or title, case-insensitive)
 * and move it to `rect`. Polls briefly because a just-launched native app's
 * window may not exist yet. Best-effort — returns false if never found.
 */
export async function positionAppWindow(match: string, rect: Rect, attempts = 8, delayMs = 300): Promise<boolean> {
  const m = match.trim().toLowerCase();
  if (!m || !osWindowsSupported()) return false;
  for (let i = 0; i < attempts; i++) {
    try {
      const wins = await listWindows();
      const w = wins.find((x) => x.proc.toLowerCase().includes(m) || x.title.toLowerCase().includes(m));
      if (w) { await applyBounds([toTarget(w, rect)]); return true; }
    } catch { /* retry */ }
    await sleep(delayMs);
  }
  return false;
}

/** Even grid of N cells across the work area (cols = ceil(sqrt(N))). */
function gridRects(n: number): Rect[] {
  const wa = workArea();
  const cols = Math.ceil(Math.sqrt(n));
  const rows = Math.ceil(n / cols);
  const cellW = wa.width / cols;
  const cellH = wa.height / rows;
  const rects: Rect[] = [];
  for (let i = 0; i < n; i++) {
    const c = i % cols;
    const r = Math.floor(i / cols);
    rects.push({ x: wa.x + c * cellW, y: wa.y + r * cellH, width: cellW, height: cellH });
  }
  return rects;
}
