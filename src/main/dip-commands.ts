/**
 * dip-commands — the single entry point for a `.dip <…>` command, whether it
 * arrives from the global keytap (typed in any text box) or the command
 * overlay's input box. Keeping one runner means both surfaces behave identically.
 *
 * Grammar (leading "dip"/".dip" optional):
 *   dip <layout>            open a saved layout (OS windows tiled to the display)
 *   dip <app>               open an app in its own OS window
 *   dip a | b | c           open several apps
 *   dip split a b c         tile those apps side by side (columns)
 *   dip grid                tile ALL open OS windows into a grid
 *   dip minAll              minimize every open window
 *   dip min [app]           minimize the focused (or named) window
 *   dip expAll              expand every window to fill the screen
 *   dip exp [app]           toggle the focused (or named) window full ↔ prior
 */

import { BrowserWindow } from "electron";
import { openAppByRef, openLayoutByName } from "./app-resolver.js";
import {
  arrangeGrid, arrangeSplit, expandAll, toggleExpandFocused, toggleExpandWindow,
  minimizeAll, minimizeFocused, minimizeWindow, osWindowsSupported,
  listWindows, windowMatches, type OsWindow,
} from "./os-window-manager.js";

export interface DipResult { ok: boolean; message?: string; error?: string }

export interface DipContext {
  /** The window that was frontmost before the command surface (palette) took
   *  focus — `min`/`exp` with no argument act on this instead of "focused"
   *  (which would be Glyphh itself by the time the command runs). */
  focusTarget?: OsWindow | null;
}

const norm = (s: string) => s.trim().toLowerCase();

/** Minimize Glyphh's own windows too — the OS minimize-all can miss frameless
 *  Electron windows (they expose no AX minimize attribute). */
function minimizeGlyphhWindows(): void {
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed() && w.isVisible() && w.isMinimizable()) w.minimize();
  }
}

export async function runDip(input: string, ctx?: DipContext): Promise<DipResult> {
  // Strip an optional leading "dip" / ".dip".
  const text = String(input || "").trim().replace(/^\.?dip\b\s*/i, "").trim();
  if (!text) return { ok: false, error: "usage: dip <app|layout|grid|split …|min|minAll|exp|expAll>" };

  const parts = text.split(/\s+/);
  const verb = norm(parts[0]);
  const rest = parts.slice(1);

  /** Named window for "min <app>" / "exp <app>" — process-name matched. */
  const namedWindow = async (name: string): Promise<OsWindow | null> =>
    (await listWindows()).find((w) => windowMatches(w, name)) ?? null;

  try {
    // ── OS window arrangement verbs ──────────────────────────────
    if (["grid", "split", "min", "minall", "exp", "expall"].includes(verb)) {
      if (!osWindowsSupported()) return { ok: false, error: "window management isn't supported on this platform yet" };

      if (verb === "grid") {
        const r = await arrangeGrid();
        const extra = r.minimized ? `, minimized ${r.minimized} that didn't fit` : "";
        return { ok: true, message: `gridded ${r.gridded} window${r.gridded === 1 ? "" : "s"}${extra}` };
      }
      if (verb === "split") {
        const apps = rest.join(" ").split(/[|,]|\s+/).map((s) => s.trim()).filter(Boolean);
        if (apps.length < 2) return { ok: false, error: "usage: dip split <app-1> <app-2> …" };
        const n = await arrangeSplit(apps);
        if (n === 0) return { ok: false, error: `no open windows matched: ${apps.join(", ")}` };
        return { ok: true, message: `split ${n} window${n === 1 ? "" : "s"}` };
      }
      // "min all" / "exp all" also accepted as two words.
      const allWord = norm(rest[0] || "") === "all";
      if (verb === "minall" || (verb === "min" && allWord)) {
        await minimizeAll();
        minimizeGlyphhWindows();
        return { ok: true, message: "minimized all windows" };
      }
      // "min <app>" / "exp <app>" — target the named app's window.
      const namedArg = !allWord ? rest.join(" ").trim() : "";
      if (verb === "min") {
        if (namedArg) {
          const w = await namedWindow(namedArg);
          if (!w) return { ok: false, error: `no open window matched "${namedArg}"` };
          await minimizeWindow(w.id);
          return { ok: true, message: `minimized ${w.proc}` };
        }
        // Bare "min": the window the user was in before the palette took
        // focus; falls back to the live focused window (keytap-style calls).
        if (ctx?.focusTarget) await minimizeWindow(ctx.focusTarget.id);
        else await minimizeFocused();
        return { ok: true, message: "minimized" };
      }
      if (verb === "expall" || (verb === "exp" && allWord)) {
        const n = await expandAll();
        return { ok: true, message: `expanded ${n} window${n === 1 ? "" : "s"}` };
      }
      // verb === "exp"
      if (namedArg) {
        const w = await namedWindow(namedArg);
        if (!w) return { ok: false, error: `no open window matched "${namedArg}"` };
        await toggleExpandWindow(w);
        return { ok: true, message: `toggled expand on ${w.proc}` };
      }
      if (ctx?.focusTarget) await toggleExpandWindow(ctx.focusTarget);
      else await toggleExpandFocused();
      return { ok: true, message: "toggled expand" };
    }

    // ── open verbs ───────────────────────────────────────────────
    // "a | b | c" → open each app in its own window.
    if (text.includes("|")) {
      const names = text.split("|").map((s) => s.trim()).filter(Boolean);
      const opened: string[] = [];
      for (const n of names) opened.push((await openAppByRef(n)).slug);
      return { ok: true, message: `opened ${opened.join(", ")}` };
    }

    // Single token: a saved layout first, then an app.
    try {
      const r = await openLayoutByName(text, "screen");
      return { ok: true, message: `opened layout "${r.layout}"` };
    } catch {
      const app = await openAppByRef(text);
      return { ok: true, message: `opened ${app.name}` };
    }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
