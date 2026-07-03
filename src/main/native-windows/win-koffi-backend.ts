/**
 * win-koffi-backend — Windows window control via koffi FFI straight into
 * user32/dwmapi/kernel32. Replaces the old PowerShell + Add-Type approach,
 * which paid a powershell.exe spawn AND a runtime C# compile on every call
 * (~0.5-2s); these are in-process calls (~1-5ms).
 *
 * koffi ships prebuilt binaries (no node-gyp / electron-rebuild) and is
 * loaded lazily so macOS never touches it. All HWNDs cross the FFI boundary
 * as intptr_t (JS numbers — window handles fit comfortably in 53 bits).
 *
 * Notes:
 *  - Enumeration filters to "real" app windows: visible, titled, not
 *    WS_EX_TOOLWINDOW, not DWM-cloaked (UWP ghosts), non-zero size.
 *  - SetForegroundWindow is OS-restricted when we're not the foreground
 *    process; the standard ALT-tap (keybd_event) workaround lifts it.
 *  - Windows of elevated processes can't be touched from a non-elevated
 *    Glyphh (UIPI) — those ops fail silently per-window, never throw.
 */

export interface WinWindow {
  id: string;      // HWND as decimal string
  pid: number;
  proc: string;    // executable base name, e.g. "chrome"
  title: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface WinApp { proc: string; path: string; pid: number; }

// user32 constants
const SW_MINIMIZE = 6;
const SW_RESTORE = 9;
const SWP_NOZORDER = 0x0004;
const SWP_NOACTIVATE = 0x0010;
const SWP_ASYNCWINDOWPOS = 0x4000;
const GWL_EXSTYLE = -20;
const WS_EX_TOOLWINDOW = 0x00000080;
const DWMWA_CLOAKED = 14;
const VK_MENU = 0x12;
const KEYEVENTF_KEYUP = 0x0002;
const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;

interface Api {
  EnumWindows: (cb: unknown, lparam: number) => boolean;
  IsWindowVisible: (hwnd: number) => boolean;
  IsIconic: (hwnd: number) => boolean;
  GetWindowTextW: (hwnd: number, buf: Buffer, max: number) => number;
  GetWindowRect: (hwnd: number, rect: Buffer) => boolean;
  SetWindowPos: (hwnd: number, after: number, x: number, y: number, cx: number, cy: number, flags: number) => boolean;
  ShowWindow: (hwnd: number, cmd: number) => boolean;
  SetForegroundWindow: (hwnd: number) => boolean;
  GetForegroundWindow: () => number;
  GetWindowThreadProcessId: (hwnd: number, pidOut: Buffer) => number;
  GetWindowLongPtrW: (hwnd: number, index: number) => number;
  keybd_event: (vk: number, scan: number, flags: number, extra: number) => void;
  DwmGetWindowAttribute: (hwnd: number, attr: number, out: Buffer, size: number) => number;
  OpenProcess: (access: number, inherit: boolean, pid: number) => number;
  QueryFullProcessImageNameW: (h: number, flags: number, buf: Buffer, sizeInOut: Buffer) => boolean;
  CloseHandle: (h: number) => boolean;
  register: (fn: (...args: unknown[]) => unknown) => unknown;
  unregister: (cb: unknown) => void;
}

let api: Api | null = null;

function ensureApi(): Api | null {
  if (api) return api;
  if (process.platform !== "win32") return null;
  // Lazy require so non-Windows platforms never load the native module.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const koffi = require("koffi");
  const user32 = koffi.load("user32.dll");
  const dwmapi = koffi.load("dwmapi.dll");
  const kernel32 = koffi.load("kernel32.dll");

  const EnumWindowsProc = koffi.proto("bool EnumWindowsProc(intptr_t hwnd, intptr_t lparam)");

  api = {
    EnumWindows: user32.func("bool __stdcall EnumWindows(EnumWindowsProc* cb, intptr_t lparam)"),
    IsWindowVisible: user32.func("bool __stdcall IsWindowVisible(intptr_t hwnd)"),
    IsIconic: user32.func("bool __stdcall IsIconic(intptr_t hwnd)"),
    GetWindowTextW: user32.func("int __stdcall GetWindowTextW(intptr_t hwnd, _Out_ uint16_t* buf, int max)"),
    GetWindowRect: user32.func("bool __stdcall GetWindowRect(intptr_t hwnd, _Out_ uint8_t* rect)"),
    SetWindowPos: user32.func("bool __stdcall SetWindowPos(intptr_t hwnd, intptr_t after, int x, int y, int cx, int cy, uint32_t flags)"),
    ShowWindow: user32.func("bool __stdcall ShowWindow(intptr_t hwnd, int cmd)"),
    SetForegroundWindow: user32.func("bool __stdcall SetForegroundWindow(intptr_t hwnd)"),
    GetForegroundWindow: user32.func("intptr_t __stdcall GetForegroundWindow()"),
    GetWindowThreadProcessId: user32.func("uint32_t __stdcall GetWindowThreadProcessId(intptr_t hwnd, _Out_ uint8_t* pid)"),
    GetWindowLongPtrW: user32.func("intptr_t __stdcall GetWindowLongPtrW(intptr_t hwnd, int index)"),
    keybd_event: user32.func("void __stdcall keybd_event(uint8_t vk, uint8_t scan, uint32_t flags, uintptr_t extra)"),
    DwmGetWindowAttribute: dwmapi.func("long __stdcall DwmGetWindowAttribute(intptr_t hwnd, uint32_t attr, _Out_ uint8_t* out, uint32_t size)"),
    OpenProcess: kernel32.func("intptr_t __stdcall OpenProcess(uint32_t access, bool inherit, uint32_t pid)"),
    QueryFullProcessImageNameW: kernel32.func("bool __stdcall QueryFullProcessImageNameW(intptr_t h, uint32_t flags, _Out_ uint16_t* buf, _Inout_ uint32_t* size)"),
    CloseHandle: kernel32.func("bool __stdcall CloseHandle(intptr_t h)"),
    register: (fn: (...args: unknown[]) => unknown) => koffi.register(fn, koffi.pointer(EnumWindowsProc)),
    unregister: (cb: unknown) => koffi.unregister(cb),
  };
  return api;
}

export function winBackendAvailable(): boolean {
  try { return ensureApi() !== null; } catch { return false; }
}

// ── helpers ─────────────────────────────────────────────────────────────

function windowTitle(a: Api, hwnd: number): string {
  const buf = Buffer.alloc(512 * 2);
  const n = a.GetWindowTextW(hwnd, buf, 512);
  return n > 0 ? buf.toString("utf16le", 0, n * 2) : "";
}

function windowRect(a: Api, hwnd: number): { x: number; y: number; width: number; height: number } | null {
  const buf = Buffer.alloc(16); // RECT: 4x int32
  if (!a.GetWindowRect(hwnd, buf)) return null;
  const left = buf.readInt32LE(0), top = buf.readInt32LE(4);
  const right = buf.readInt32LE(8), bottom = buf.readInt32LE(12);
  return { x: left, y: top, width: right - left, height: bottom - top };
}

function windowPid(a: Api, hwnd: number): number {
  const buf = Buffer.alloc(4);
  a.GetWindowThreadProcessId(hwnd, buf);
  return buf.readUInt32LE(0);
}

function isCloaked(a: Api, hwnd: number): boolean {
  const buf = Buffer.alloc(4);
  const hr = a.DwmGetWindowAttribute(hwnd, DWMWA_CLOAKED, buf, 4);
  return hr === 0 && buf.readUInt32LE(0) !== 0;
}

const procNameCache = new Map<number, { proc: string; path: string }>();

function processInfo(a: Api, pid: number): { proc: string; path: string } {
  const cached = procNameCache.get(pid);
  if (cached) return cached;
  let out = { proc: "", path: "" };
  const h = a.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid);
  if (h) {
    const buf = Buffer.alloc(1024 * 2);
    const size = Buffer.alloc(4);
    size.writeUInt32LE(1024, 0);
    if (a.QueryFullProcessImageNameW(h, 0, buf, size)) {
      const len = size.readUInt32LE(0);
      const full = buf.toString("utf16le", 0, len * 2);
      const base = full.split("\\").pop() || "";
      out = { proc: base.replace(/\.exe$/i, ""), path: full };
    }
    a.CloseHandle(h);
  }
  procNameCache.set(pid, out);
  if (procNameCache.size > 500) procNameCache.clear(); // crude bound; pids recycle
  return out;
}

/** A "real" app window: visible, titled, not a tool window, not DWM-cloaked. */
function qualifies(a: Api, hwnd: number, includeMinimized: boolean): boolean {
  if (!a.IsWindowVisible(hwnd)) return false;
  if (!includeMinimized && a.IsIconic(hwnd)) return false;
  const ex = a.GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
  if (ex & WS_EX_TOOLWINDOW) return false;
  if (isCloaked(a, hwnd)) return false;
  return true;
}

function enumerate(a: Api, includeMinimized: boolean): WinWindow[] {
  const out: WinWindow[] = [];
  const cb = a.register((hwndRaw: unknown) => {
    const hwnd = Number(hwndRaw);
    if (!qualifies(a, hwnd, includeMinimized)) return true;
    const title = windowTitle(a, hwnd);
    if (!title) return true;
    const rect = windowRect(a, hwnd);
    if (!rect || rect.width <= 0 || rect.height <= 0) return true;
    const pid = windowPid(a, hwnd);
    const info = processInfo(a, pid);
    out.push({ id: String(hwnd), pid, proc: info.proc, title, ...rect });
    return true;
  });
  try { a.EnumWindows(cb, 0); } finally { a.unregister(cb); }
  return out;
}

// ── public API (mirrors mac-helper-backend) ─────────────────────────────

export async function winList(): Promise<WinWindow[]> {
  const a = ensureApi();
  return a ? enumerate(a, false) : [];
}

export async function winApps(): Promise<WinApp[]> {
  const a = ensureApi();
  if (!a) return [];
  const seen = new Set<number>();
  const apps: WinApp[] = [];
  for (const w of enumerate(a, true)) {
    if (seen.has(w.pid)) continue;
    seen.add(w.pid);
    const info = processInfo(a, w.pid);
    apps.push({ proc: w.proc, path: info.path, pid: w.pid });
  }
  return apps;
}

export async function winFront(): Promise<WinWindow | null> {
  const a = ensureApi();
  if (!a) return null;
  const hwnd = a.GetForegroundWindow();
  if (!hwnd) return null;
  const rect = windowRect(a, hwnd);
  if (!rect) return null;
  const pid = windowPid(a, hwnd);
  return { id: String(hwnd), pid, proc: processInfo(a, pid).proc, title: windowTitle(a, hwnd), ...rect };
}

export async function winBounds(items: Array<{ win: string; x: number; y: number; width: number; height: number }>): Promise<number> {
  const a = ensureApi();
  if (!a) return 0;
  let applied = 0;
  for (const it of items) {
    const hwnd = Number(it.win);
    if (!hwnd) continue;
    if (a.IsIconic(hwnd)) a.ShowWindow(hwnd, SW_RESTORE);
    if (a.SetWindowPos(hwnd, 0, Math.round(it.x), Math.round(it.y), Math.round(it.width), Math.round(it.height),
      SWP_NOZORDER | SWP_NOACTIVATE | SWP_ASYNCWINDOWPOS)) applied++;
  }
  return applied;
}

export async function winMinimizeWins(wins: string[]): Promise<number> {
  const a = ensureApi();
  if (!a) return 0;
  let n = 0;
  for (const id of wins) {
    const hwnd = Number(id);
    if (hwnd && a.ShowWindow(hwnd, SW_MINIMIZE)) n++;
  }
  return n;
}

export async function winMinimizeAll(): Promise<number> {
  const a = ensureApi();
  if (!a) return 0;
  let n = 0;
  for (const w of enumerate(a, false)) {
    if (a.ShowWindow(Number(w.id), SW_MINIMIZE)) n++;
  }
  return n;
}

export async function winFocusWindow(hwnd: number): Promise<boolean> {
  const a = ensureApi();
  if (!a || !hwnd) return false;
  if (a.IsIconic(hwnd)) a.ShowWindow(hwnd, SW_RESTORE);
  // ALT-tap lifts the SetForegroundWindow restriction when we're not the
  // foreground process (standard, widely-used workaround).
  a.keybd_event(VK_MENU, 0, 0, 0);
  const ok = a.SetForegroundWindow(hwnd);
  a.keybd_event(VK_MENU, 0, KEYEVENTF_KEYUP, 0);
  return ok;
}

export async function winFocusApp(name: string): Promise<boolean> {
  const a = ensureApi();
  if (!a) return false;
  const key = name.trim().toLowerCase();
  if (!key) return false;
  const w = enumerate(a, true).find((x) => x.proc.toLowerCase().includes(key) || x.title.toLowerCase().includes(key));
  return w ? winFocusWindow(Number(w.id)) : false;
}
