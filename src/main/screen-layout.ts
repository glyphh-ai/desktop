/**
 * Rail collapse — shrink the Glyphh window to just the left rail and expand
 * it back, with a short bounds tween.
 *
 * (This file used to also dock the window to a screen edge so OS app windows
 * could tile beside it. OS windows are retired — apps render as workbench
 * panels inside the Code page — so the docking modes, their settings UI, and
 * the users.screen_layout server field are gone with them.)
 */

import { BrowserWindow, screen } from "electron";
import { getPreference } from "./stores/preferences-db";

interface Rect { x: number; y: number; width: number; height: number }

let win: BrowserWindow | null = null;
let applying = false;

let railCollapsed = false;
let expandedBounds: Rect | null = null;
let prevMinSize: [number, number] | null = null;

/** Boot: hand the main window over so collapse/expand can drive its bounds. */
export function initRailCollapse(mainWindow: BrowserWindow): void {
  win = mainWindow;
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

/** Collapse to the rail (right edge slides left) or expand back out. */
export function setRailCollapsed(next: boolean): boolean {
  if (!win || win.isDestroyed() || next === railCollapsed || applying) return railCollapsed;
  if (next) {
    expandedBounds = win.getBounds();
    prevMinSize = win.getMinimumSize() as [number, number];
    win.setMinimumSize(160, Math.min(prevMinSize[1] || 300, 300));
    const b = win.getBounds();
    railCollapsed = true;
    tweenBounds(win, { x: b.x, y: b.y, width: railWidth(), height: b.height });
  } else {
    railCollapsed = false;
    const target = expandedBounds && screen.getDisplayMatching(expandedBounds).id === screen.getDisplayMatching(win.getBounds()).id
      ? expandedBounds
      : win.getBounds();
    tweenBounds(win, target, () => {
      if (prevMinSize) { try { win?.setMinimumSize(prevMinSize[0], prevMinSize[1]); } catch { /* noop */ } }
    });
  }
  return railCollapsed;
}

export function toggleRailCollapsed(): boolean {
  return setRailCollapsed(!railCollapsed);
}

/**
 * The screen area OS app windows should tile into (os-window-manager's grid /
 * split / expand geometry). Derived from the Glyphh window's actual bounds
 * rather than stored mode state: when Glyphh hugs the left or right edge of
 * the active display (rail-collapsed or docked by a layout), apps tile into
 * the space BESIDE it; otherwise they get the full work area.
 */
export function workspaceArea(): Rect {
  const d = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  const wa = d.workArea;
  if (!win || win.isDestroyed() || win.isMinimized()) return { ...wa };
  if (screen.getDisplayMatching(win.getBounds()).id !== d.id) return { ...wa };
  const b = win.getBounds();
  const MIN_WORKSPACE_PX = 240; // below this the split is unusable — go full
  const slim = b.width < wa.width * 0.7; // a near-full window isn't a dock
  // Top-docked (full-width band hugging the top edge): apps tile BELOW it.
  const short = b.height < wa.height * 0.7;
  if (!slim && short && b.y <= wa.y + 8) {
    const edge = b.y + b.height;
    const h = wa.y + wa.height - edge;
    if (h >= MIN_WORKSPACE_PX) return { x: wa.x, y: edge, width: wa.width, height: h };
  }
  if (slim && b.x <= wa.x + 8) {
    const edge = b.x + b.width;
    const w = wa.x + wa.width - edge;
    if (w >= MIN_WORKSPACE_PX) return { x: edge, y: wa.y, width: w, height: wa.height };
  } else if (slim && b.x + b.width >= wa.x + wa.width - 8) {
    const w = b.x - wa.x;
    if (w >= MIN_WORKSPACE_PX) return { x: wa.x, y: wa.y, width: w, height: wa.height };
  }
  return { ...wa };
}

// ── Per-layout Glyphh placement (the old Settings "screen layout" dock,
//    reborn as a LAYOUT property) ─────────────────────────────────────────

export type GlyphhPlacementMode = "top" | "bottom" | "full" | "rail" | "left" | "right" | "none";
export interface GlyphhPlacement {
  mode: GlyphhPlacementMode;
  /** Docked width as a fraction of the work area (left/right modes);
   *  docked HEIGHT fraction for the top mode. */
  fraction?: number;
}

const clampFraction = (f: number): number => Math.max(0.2, Math.min(0.6, f));

/**
 * Place the Glyphh window for a DESKTOP layout and return the screen area the
 * layout's app windows should tile into:
 *   top   → dock Glyphh across the top of the screen; grid gets the space
 *           below (the default for desktop layouts — his rule, 2026-08-21)
 *   rail  → collapse to the left rail; the rest of the display is the grid
 *   left  → dock Glyphh to the left edge at `fraction`; grid gets the right
 *   right → the mirror image
 *   none  → leave the window alone; the grid gets the full work area
 */
export function placeGlyphhForLayout(placement: GlyphhPlacement): Rect {
  const display = win && !win.isDestroyed() ? screen.getDisplayMatching(win.getBounds()) : screen.getPrimaryDisplay();
  const wa = display.workArea;
  if (!win || win.isDestroyed() || placement.mode === "none") return { ...wa };

  if (placement.mode === "top") {
    // A compact strip by default — just enough for the close-layout bar; an
    // explicit fraction (layout editor) buys Glyphh a real share of the screen.
    const gh = placement.fraction
      ? Math.round(wa.height * clampFraction(placement.fraction))
      : 148;
    setRailCollapsed(false);
    tweenBounds(win, { x: wa.x, y: wa.y, width: wa.width, height: gh });
    return { x: wa.x, y: wa.y + gh, width: wa.width, height: wa.height - gh };
  }

  if (placement.mode === "bottom") {
    const gh = placement.fraction
      ? Math.round(wa.height * clampFraction(placement.fraction))
      : 148;
    setRailCollapsed(false);
    tweenBounds(win, { x: wa.x, y: wa.y + wa.height - gh, width: wa.width, height: gh });
    return { x: wa.x, y: wa.y, width: wa.width, height: wa.height - gh };
  }

  if (placement.mode === "full") {
    // Glyphh keeps the whole work area; the layout tiles OVER it (the old
    // "full" dock from the e1b6f457^ screen-layout settings).
    setRailCollapsed(false);
    tweenBounds(win, { ...wa });
    return { ...wa };
  }

  if (placement.mode === "rail") {
    setRailCollapsed(true);
    const w = railWidth();
    tweenBounds(win, { x: wa.x, y: wa.y, width: w, height: wa.height });
    return { x: wa.x + w, y: wa.y, width: wa.width - w, height: wa.height };
  }

  const fr = clampFraction(placement.fraction ?? 1 / 3);
  const gw = Math.round(wa.width * fr);
  setRailCollapsed(false);
  if (placement.mode === "left") {
    tweenBounds(win, { x: wa.x, y: wa.y, width: gw, height: wa.height });
    return { x: wa.x + gw, y: wa.y, width: wa.width - gw, height: wa.height };
  }
  tweenBounds(win, { x: wa.x + wa.width - gw, y: wa.y, width: gw, height: wa.height });
  return { x: wa.x, y: wa.y, width: wa.width - gw, height: wa.height };
}
