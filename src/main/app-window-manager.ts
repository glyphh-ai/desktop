/**
 * AppWindowManager — the few windows Glyphh still hosts itself.
 *
 * Native-OS app model: web apps open in the user's REAL browser (see
 * native-launch.launchWebApp + app-resolver's tracked opens) — Glyphh renders
 * no web content of its own. What's left here:
 *   - the TERMINAL window (terminal.html + PTY IPC), and
 *   - open/focus/close/list over those Electron-hosted windows, which
 *     app-resolver merges with tracked OS windows for the relay's panels_*.
 *
 * Geometry is Node-controlled (Electron screen module) — windows cascade on
 * the display under the cursor, and layouts place them at exact cell rects.
 */

import { BrowserWindow, nativeTheme, screen } from "electron";
import { workspaceArea } from "./screen-layout";
import path from "path";
import { getPreference } from "./stores/preferences-db";

export interface AppWindowSpec {
  /** Stable identity — one window per slug; re-opening focuses it. */
  slug: string;
  name: string;
  /** "yo://terminal" for the terminal; web URLs identify browser built-ins
   *  (resolved by app-resolver — never rendered here). */
  url: string;
}

const CASCADE_STEP = 32;
const DEFAULT_W = 1100;
const DEFAULT_H = 760;

const windows = new Map<string, { win: BrowserWindow; spec: AppWindowSpec }>();
let cascade = 0;

// Same map main.ts uses for the in-dashboard browser panel — the built-in
// "browser" app opens the user's real browser at this homepage.
const BROWSER_HOMES: Record<string, string> = {
  google: "https://www.google.com",
  claude: "https://claude.ai",
  chatgpt: "https://chatgpt.com",
  gemini: "https://gemini.google.com",
};

export function resolveBrowserHomeUrl(): string {
  const pref = getPreference<string>("browserHomepage", "claude");
  if (pref === "custom") return getPreference<string>("browserHomepageUrl", "") || BROWSER_HOMES.claude;
  return BROWSER_HOMES[pref] || BROWSER_HOMES.claude;
}

function rendererFile(name: string): string {
  return `file://${path.join(__dirname, "..", "renderer", name)}`;
}

/** Themed window background — matches styles.css --bg so a freshly created
 *  window paints as a themed tile instead of flashing white while it loads. */
function themedBackground(): string {
  const t = getPreference<string>("theme", "dark");
  if (t === "light") return "#f5f5f5";
  if (t === "purple") return "#140a1f";
  if (t === "aurora") return "#0a0610";
  if (t === "system") return nativeTheme.shouldUseDarkColors ? "#1a1a1c" : "#f5f5f5";
  return "#1a1a1c"; // dark
}

function createAppWindow(spec: AppWindowSpec, bounds?: Electron.Rectangle): BrowserWindow {
  if (spec.url !== "yo://terminal") {
    // Web content never renders in a Glyphh window — app-resolver routes web
    // apps to the user's real browser before this is reached.
    throw new Error(`not an Electron-hosted app: ${spec.slug} (${spec.url})`);
  }
  const win = new BrowserWindow({
    ...(bounds ?? {}),
    width: bounds?.width ?? DEFAULT_W,
    height: bounds?.height ?? DEFAULT_H,
    title: spec.name,
    show: false,
    backgroundColor: themedBackground(),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, "terminal-preload.js"),
    },
  });
  void win.loadURL(rendererFile("terminal.html"));
  win.once("ready-to-show", () => win.show());
  win.on("closed", () => {
    if (windows.get(spec.slug)?.win === win) windows.delete(spec.slug);
  });
  windows.set(spec.slug, { win, spec });
  return win;
}

/** Slide Glyphh-hosted windows that were opened "full" (≥70% of the current
 *  display work area) into the new workspace — the collapse/expand slide.
 *  Cascaded utility windows stay put. */
export function retileFullWindows(): void {
  const area = workspaceArea();
  const d = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
  for (const { win } of windows.values()) {
    if (win.isDestroyed()) continue;
    const b = win.getBounds();
    if (b.width >= d.width * 0.7 || Math.abs(b.width - area.width) < 80) {
      win.setBounds(area);
    }
  }
}

function cascadeBounds(): Electron.Rectangle {
  const area = workspaceArea();
  const offset = (cascade++ % 8) * CASCADE_STEP;
  const width = Math.min(DEFAULT_W, area.width);
  const height = Math.min(DEFAULT_H, area.height);
  return {
    x: Math.min(area.x + 60 + offset, area.x + area.width - width),
    y: Math.min(area.y + 40 + offset, area.y + area.height - height),
    width,
    height,
  };
}

/** Open (or focus) the app's window, cascaded on the display under the cursor. */
export function openAppWindow(spec: AppWindowSpec): void {
  const existing = windows.get(spec.slug);
  if (existing && !existing.win.isDestroyed()) {
    if (existing.win.isMinimized()) existing.win.restore();
    existing.win.focus();
    return;
  }
  createAppWindow(spec, cascadeBounds());
}

/** Slide a Glyphh-hosted window in from the left, ending full-screen (work
 *  area) — `.dip terminal` / the command overlay's big-open motion. */
export function openAppWindowSlide(spec: AppWindowSpec): void {
  const wa = workspaceArea();
  const target: Electron.Rectangle = { x: wa.x, y: wa.y, width: wa.width, height: wa.height };
  const existing = windows.get(spec.slug);
  if (existing && !existing.win.isDestroyed()) {
    if (existing.win.isMinimized()) existing.win.restore();
    existing.win.setBounds(target);
    existing.win.focus();
    return;
  }
  const start: Electron.Rectangle = { ...target, x: wa.x - wa.width };
  const win = createAppWindow(spec, start);
  animateSlideX(win, start.x, target.x, wa.y, wa.width, wa.height);
}

function animateSlideX(win: BrowserWindow, fromX: number, toX: number, y: number, w: number, h: number): void {
  const steps = 14;
  let i = 0;
  const timer = setInterval(() => {
    if (win.isDestroyed()) { clearInterval(timer); return; }
    i++;
    const t = Math.min(1, i / steps);
    const eased = 1 - Math.pow(1 - t, 3); // easeOutCubic
    win.setBounds({ x: Math.round(fromX + (toX - fromX) * eased), y, width: w, height: h });
    if (i >= steps) { clearInterval(timer); if (!win.isDestroyed()) win.setBounds({ x: toX, y, width: w, height: h }); }
  }, 16);
}

/** Open (or move) a Glyphh-hosted window at exact screen bounds — used to
 *  tile the terminal into a layout cell. */
export function openAppWindowAt(spec: AppWindowSpec, bounds: Electron.Rectangle): void {
  const existing = windows.get(spec.slug);
  if (existing && !existing.win.isDestroyed()) {
    existing.win.setBounds(bounds);
    if (existing.win.isMinimized()) existing.win.restore();
    existing.win.focus();
    return;
  }
  createAppWindow(spec, bounds);
}

export function focusAppWindow(slug: string): boolean {
  const entry = windows.get(slug);
  if (!entry || entry.win.isDestroyed()) return false;
  if (entry.win.isMinimized()) entry.win.restore();
  entry.win.focus();
  return true;
}

export function closeAppWindow(slug: string): boolean {
  const entry = windows.get(slug);
  if (!entry || entry.win.isDestroyed()) return false;
  entry.win.close();
  return true;
}

export interface AppWindowInfo {
  app: string;
  name: string;
  url: string | null;
  title: string | null;
  focused: boolean;
}

export function listAppWindows(): AppWindowInfo[] {
  const out: AppWindowInfo[] = [];
  for (const [slug, { win, spec }] of windows) {
    if (win.isDestroyed()) continue;
    out.push({
      app: slug,
      name: spec.name,
      url: spec.url,
      title: win.getTitle() || spec.name,
      focused: win.isFocused(),
    });
  }
  return out;
}

// ── Layouts ────────────────────────────────────────────────

/** Server saved_layouts shape (saved-layout-service): equal-fraction grid. */
export interface LayoutSpec {
  name: string;
  cols: number;
  rows: number;
  cells: Array<{ panelId: string; col: number; row: number; colSpan: number; rowSpan: number }>;
}

export function closeAllAppWindows(): void {
  for (const { win } of windows.values()) {
    if (!win.isDestroyed()) win.close();
  }
  windows.clear();
}
