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


// ── Per-layout Glyphh placement (the old Settings "screen layout" dock,
//    reborn as a LAYOUT property) ─────────────────────────────────────────

/**
 * Where the Glyphh agent sits relative to the workspace:
 *
 *   rail   the agent is a workbench SLOT (`view:"coding"`) — today's default, and what
 *          every layout with no opinion resolves to.
 *   left   the agent docks to the left edge; the whole right side is the layout manager.
 *   right  mirrored.
 *   center the agent docks to the BOTTOM as a collapsed one-line bar, layout above it.
 *   none   no agent on screen at all.
 *
 * `center` IS collapsed mode — there is deliberately no second `collapsed` flag, which
 * would be a second source of truth for one thing.
 */
export type GlyphhPlacementMode = "rail" | "left" | "right" | "center" | "none";
export interface GlyphhPlacement {
  mode: GlyphhPlacementMode;
  /**
   * Docked width as a fraction of the work area — LEFT/RIGHT only. `center` ignores it
   * (the bar is content-height); a resizable bar height would need its own field rather
   * than an overload of a width fraction clamped to 0.2–0.6.
   */
  fraction?: number;
}

const clampFraction = (f: number): number => Math.max(0.2, Math.min(0.6, f));

