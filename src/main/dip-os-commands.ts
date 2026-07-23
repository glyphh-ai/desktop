/**
 * dip-os-commands — the OS-WINDOW arrangement verbs of `.dip`, restored from
 * the OS-window era (f922339 → cut in e1b6f45) onto the new native backends.
 * Unlike the panel verbs in command-parser (which arrange Glyphh's own
 * workbench panels), these arrange EVERY visible app window on the machine.
 *
 * Grammar (dispatched from command-parser's handleDip):
 *   dip minAll / min all    minimize every open window (Glyphh's too)
 *   dip min [app]           minimize the focused (or named) window
 *   dip expAll / exp all    expand every window to fill the workspace
 *   dip exp [app]           toggle the focused (or named) window full ↔ prior
 *   dip os grid             tile ALL open OS windows into a grid
 *   dip os split a b …      tile the named apps' windows side by side
 *   dip os min/exp/…        the same verbs, namespaced (panel grid/split
 *                           keep the bare names — they came first here)
 */

import { BrowserWindow } from "electron";
import {
  arrangeGrid, arrangeSplit, expandAll, toggleExpandFocused, toggleExpandWindow,
  minimizeAll, minimizeFocused, minimizeWindow, osWindowsSupported,
  listWindows, windowMatches, frontWindow, type OsWindow,
} from "./os-window-manager.js";

const norm = (s: string) => s.trim().toLowerCase();

/** Minimize Glyphh's own windows too — the OS minimize-all can miss frameless
 *  Electron windows (they expose no AX minimize attribute). */
function minimizeGlyphhWindows(): void {
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed() && w.isVisible() && w.isMinimizable()) w.minimize();
  }
}

/** Named window for "min <app>" / "exp <app>" — process-name matched. */
async function namedWindow(name: string): Promise<OsWindow | null> {
  return (await listWindows()).find((w) => windowMatches(w, name)) ?? null;
}

/** Bare `min`/`exp` target the window the user means — which is never Glyphh
 *  itself (the command was typed INTO Glyphh, so Glyphh is frontmost by the
 *  time it runs). Prefer the frontmost foreign window; the enumeration is
 *  front-to-back, so the first non-Glyphh hit is the one under Glyphh. */
const isGlyphhProc = (p: string) => /glyphh|electron/i.test(p);
async function frontForeignWindow(): Promise<OsWindow | null> {
  const front = await frontWindow().catch(() => null);
  if (front && !isGlyphhProc(front.proc)) return front;
  const wins = await listWindows().catch(() => []);
  return wins.find((w) => !isGlyphhProc(w.proc)) ?? front;
}

/**
 * Try to run `.dip` args as an OS-window verb. Returns the user-facing result
 * string, or null when the args aren't an OS verb (caller keeps dispatching).
 */
export async function tryDipOsCommand(argsIn: string[]): Promise<string | null> {
  let args = argsIn;
  let namespaced = false;
  if (norm(args[0] || "") === "os") {
    namespaced = true;
    args = args.slice(1);
    if (args.length === 0) return "usage: dip os <grid|split …|min|minAll|exp|expAll>";
  }
  const verb = norm(args[0] || "");
  const rest = args.slice(1);

  // Bare grid/split belong to the WORKBENCH PANEL verbs — only the `os`
  // namespace reaches the OS-window versions of those two.
  const osVerbs = namespaced
    ? ["grid", "split", "min", "minall", "exp", "expall"]
    : ["min", "minall", "exp", "expall"];
  if (!osVerbs.includes(verb)) return null;

  if (!osWindowsSupported()) return "window management isn't supported on this platform yet";

  try {
    if (verb === "grid") {
      const r = await arrangeGrid();
      const extra = r.minimized ? `, minimized ${r.minimized} that didn't fit` : "";
      return `gridded ${r.gridded} window${r.gridded === 1 ? "" : "s"}${extra}`;
    }
    if (verb === "split") {
      const apps = rest.join(" ").split(/[|,]|\s+/).map((s) => s.trim()).filter(Boolean);
      if (apps.length < 2) return "usage: dip os split <app-1> <app-2> …";
      const n = await arrangeSplit(apps);
      if (n === 0) return `no open windows matched: ${apps.join(", ")}`;
      return `split ${n} window${n === 1 ? "" : "s"}`;
    }

    // "min all" / "exp all" also accepted as two words.
    const allWord = norm(rest[0] || "") === "all";
    const namedArg = !allWord ? rest.join(" ").trim() : "";

    if (verb === "minall" || (verb === "min" && allWord)) {
      await minimizeAll();
      minimizeGlyphhWindows();
      return "minimized all windows";
    }
    if (verb === "min") {
      if (namedArg) {
        const w = await namedWindow(namedArg);
        if (!w) return `no open window matched "${namedArg}"`;
        await minimizeWindow(w.id);
        return `minimized ${w.proc}`;
      }
      const w = await frontForeignWindow();
      if (!w) { await minimizeFocused(); return "minimized"; }
      await minimizeWindow(w.id);
      return `minimized ${w.proc}`;
    }
    if (verb === "expall" || (verb === "exp" && allWord)) {
      const n = await expandAll();
      return `expanded ${n} window${n === 1 ? "" : "s"}`;
    }
    // verb === "exp"
    if (namedArg) {
      const w = await namedWindow(namedArg);
      if (!w) return `no open window matched "${namedArg}"`;
      await toggleExpandWindow(w);
      return `toggled expand on ${w.proc}`;
    }
    const w = await frontForeignWindow();
    if (!w) { await toggleExpandFocused(); return "toggled expand"; }
    await toggleExpandWindow(w);
    return `toggled expand on ${w.proc}`;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}
