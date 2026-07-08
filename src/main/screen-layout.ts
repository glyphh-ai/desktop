/**
 * Screen layout — docks the Glyphh window to one screen edge ("split") or
 * leaves it free ("full", today's behavior). While docked, the rest of the
 * display is the WORKSPACE: every consumer that used to place app windows on
 * the display's workArea calls workspaceArea() instead, so apps/layouts open
 * beside Glyphh rather than under it.
 *
 * The shared edge is draggable — we listen to normal window resizes while
 * docked and persist the resulting fraction (debounced) to the user's server
 * profile (users.screen_layout via PATCH /api/user/me), with a local
 * preference cache for instant apply on boot.
 */

import { BrowserWindow, screen } from "electron";
import { getPreference, setPreference } from "./preferences";
import { serverGetAuthed, serverPatchAuthed } from "./auth";

export type ScreenLayoutMode = "full" | "left" | "right" | "top" | "bottom";
export interface ScreenLayout { mode: ScreenLayoutMode; fraction: number }

interface Rect { x: number; y: number; width: number; height: number }

const PREF_KEY = "screenLayout";
const MIN_FRACTION = 0.15;
const MAX_FRACTION = 0.85;
/** Below this remaining width/height the split is unusable — fall back to the
 *  full work area rather than cramming app windows into a sliver. */
const MIN_WORKSPACE_PX = 240;

let win: BrowserWindow | null = null;
let current: ScreenLayout = { mode: "full", fraction: 0.5 };
let applying = false;
let persistTimer: ReturnType<typeof setTimeout> | null = null;

// ── Rail collapse — shrink the window to just the left rail ──────────────
let railCollapsed = false;
let expandedBounds: Rect | null = null;
let prevMinSize: [number, number] | null = null;
const workspaceChangeCbs: Array<() => void> = [];

/** Registered callbacks fire after the window's footprint changes (collapse,
 *  expand, dock-mode change) so open workspace apps can slide/retile. */
export function onWorkspaceChange(cb: () => void): void {
  workspaceChangeCbs.push(cb);
}
function fireWorkspaceChange(): void {
  for (const cb of workspaceChangeCbs) { try { cb(); } catch { /* noop */ } }
}

/** Stepped bounds tween (~180ms ease-out) — the collapse/expand slide. */
function tweenBounds(w: BrowserWindow, to: Rect, done?: () => void): void {
  const from = w.getBounds();
  const STEPS = 12;
  let i = 0;
  applying = true;
  const timer = setInterval(() => {
    i++;
    const t = i / STEPS;
    const e = 1 - Math.pow(1 - t, 3); // ease-out cubic
    const mix = (a: number, b: number) => Math.round(a + (b - a) * e);
    try {
      w.setBounds({ x: mix(from.x, to.x), y: mix(from.y, to.y), width: mix(from.width, to.width), height: mix(from.height, to.height) });
    } catch { /* window gone */ }
    if (i >= STEPS) {
      clearInterval(timer);
      setTimeout(() => { applying = false; }, 50);
      done?.();
    }
  }, 15);
}

function railWidth(): number {
  const w = Number(getPreference("codeRailWidth", 232)) || 232;
  return Math.max(180, Math.min(420, w)) + 6;
}

export function isRailCollapsed(): boolean { return railCollapsed; }

/** Collapse to the rail (right edge slides left) or expand back out. Fires
 *  workspace-change afterwards so open apps/layouts slide to fit. */
export function setRailCollapsed(next: boolean): boolean {
  if (!win || win.isDestroyed() || next === railCollapsed) return railCollapsed;
  if (next) {
    expandedBounds = win.getBounds();
    prevMinSize = win.getMinimumSize() as [number, number];
    win.setMinimumSize(160, Math.min(prevMinSize[1] || 300, 300));
    const b = win.getBounds();
    railCollapsed = true;
    tweenBounds(win, { x: b.x, y: b.y, width: railWidth(), height: b.height }, fireWorkspaceChange);
  } else {
    railCollapsed = false;
    const target = expandedBounds && screen.getDisplayMatching(expandedBounds).id === displayFor(win).id
      ? expandedBounds
      : win.getBounds();
    tweenBounds(win, target, () => {
      if (prevMinSize) { try { win?.setMinimumSize(prevMinSize[0], prevMinSize[1]); } catch { /* noop */ } }
      // Re-snap to the dock rect when split (covers display changes).
      if (current.mode !== "full") apply();
      fireWorkspaceChange();
    });
  }
  return railCollapsed;
}

export function toggleRailCollapsed(): boolean {
  return setRailCollapsed(!railCollapsed);
}

const clampFraction = (f: number) => Math.min(MAX_FRACTION, Math.max(MIN_FRACTION, f));

function displayFor(w: BrowserWindow) {
  return screen.getDisplayMatching(w.getBounds());
}

/** Snap the window into its docked rect on its current display. */
function apply(): void {
  if (!win || win.isDestroyed() || current.mode === "full") return;
  const wa = displayFor(win).workArea;
  const fr = clampFraction(current.fraction);
  let b: Rect;
  switch (current.mode) {
    case "left":
      b = { x: wa.x, y: wa.y, width: Math.round(wa.width * fr), height: wa.height };
      break;
    case "right": {
      const w = Math.round(wa.width * fr);
      b = { x: wa.x + wa.width - w, y: wa.y, width: w, height: wa.height };
      break;
    }
    case "top":
      b = { x: wa.x, y: wa.y, width: wa.width, height: Math.round(wa.height * fr) };
      break;
    default: {
      const h = Math.round(wa.height * fr);
      b = { x: wa.x, y: wa.y + wa.height - h, width: wa.width, height: h };
    }
  }
  applying = true;
  try { win.setBounds(b); } finally { setTimeout(() => { applying = false; }, 50); }
}

function persist(): void {
  setPreference(PREF_KEY, current);
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    persistTimer = null;
    void serverPatchAuthed("/api/user/me", { screenLayout: current }).catch(() => {
      /* offline — the local cache re-syncs on the next set */
    });
  }, 800);
}

/** The user dragged the shared edge — recompute the docked fraction. */
function onResize(): void {
  if (!win || win.isDestroyed() || applying || railCollapsed || current.mode === "full") return;
  const wa = displayFor(win).workArea;
  const b = win.getBounds();
  const fr = current.mode === "left" || current.mode === "right"
    ? b.width / Math.max(1, wa.width)
    : b.height / Math.max(1, wa.height);
  const next = clampFraction(Math.round(fr * 1000) / 1000);
  if (Math.abs(next - current.fraction) < 0.005) return;
  current = { ...current, fraction: next };
  persist();
}

export function getScreenLayout(): ScreenLayout {
  return current;
}

export function setScreenLayout(next: Partial<ScreenLayout>): ScreenLayout {
  const mode = (["full", "left", "right", "top", "bottom"] as ScreenLayoutMode[])
    .includes(next.mode as ScreenLayoutMode) ? next.mode as ScreenLayoutMode : current.mode;
  const fraction = clampFraction(Number.isFinite(next.fraction as number) ? (next.fraction as number) : current.fraction);
  current = { mode, fraction };
  // Changing the dock while collapsed expands first — the dock rect IS the
  // expanded footprint.
  if (railCollapsed) setRailCollapsed(false);
  apply();
  persist();
  fireWorkspaceChange();
  return current;
}

/** Boot: apply the cached layout instantly, then reconcile with the server. */
export function initScreenLayout(mainWindow: BrowserWindow): void {
  win = mainWindow;
  const cached = getPreference<ScreenLayout | null>(PREF_KEY, null);
  if (cached && cached.mode) current = { mode: cached.mode, fraction: clampFraction(cached.fraction ?? 0.5) };
  apply();
  win.on("resize", onResize);
  void serverGetAuthed<{ screenLayout?: ScreenLayout | null }>("/api/user/me")
    .then((me) => {
      const sl = me.screenLayout;
      if (!sl || !sl.mode) return;
      if (sl.mode === current.mode && Math.abs((sl.fraction ?? 0.5) - current.fraction) < 0.005) return;
      current = { mode: sl.mode, fraction: clampFraction(sl.fraction ?? 0.5) };
      setPreference(PREF_KEY, current);
      apply();
    })
    .catch(() => { /* signed out / offline — cached layout stands */ });
}

/**
 * The region app windows should occupy: the work area under the cursor minus
 * the docked Glyphh window (when split and on the same display). Falls back
 * to the full work area in full mode, on other displays, or when the
 * remainder is too small to be useful.
 */
export function workspaceArea(): Rect {
  const d = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  const wa = d.workArea;
  if (current.mode === "full" || !win || win.isDestroyed()) return wa;
  if (displayFor(win).id !== d.id) return wa;
  const b = win.getBounds();
  let r: Rect;
  switch (current.mode) {
    case "left": {
      const edge = b.x + b.width;
      r = { x: edge, y: wa.y, width: wa.x + wa.width - edge, height: wa.height };
      break;
    }
    case "right":
      r = { x: wa.x, y: wa.y, width: b.x - wa.x, height: wa.height };
      break;
    case "top": {
      const edge = b.y + b.height;
      r = { x: wa.x, y: edge, width: wa.width, height: wa.y + wa.height - edge };
      break;
    }
    default:
      r = { x: wa.x, y: wa.y, width: wa.width, height: b.y - wa.y };
  }
  return r.width >= MIN_WORKSPACE_PX && r.height >= MIN_WORKSPACE_PX ? r : wa;
}
