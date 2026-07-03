/**
 * main-window-ref — a tiny holder for the app's main (dashboard) window so
 * modules like app-resolver can focus it without importing main.ts (which
 * would be circular: main → command-window → app-resolver).
 */

import type { BrowserWindow } from "electron";

let ref: BrowserWindow | null = null;

export function setMainWindowRef(win: BrowserWindow): void {
  ref = win;
}

export function getMainWindowRef(): BrowserWindow | null {
  return ref && !ref.isDestroyed() ? ref : null;
}
