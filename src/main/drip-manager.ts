/**
 * drip-manager.ts — the DESKTOP host for drip effects.
 *
 * The effect generators, registries, and recipe grammar live in the shared,
 * electron-free module src/shared/drip-effects.ts (the web runner renders the
 * same docs). This file owns what only the desktop has: transparent overlay
 * BrowserWindows (full-screen over every app, or windowed over the yo window)
 * and the custom-preset store: the drips table of ~/.glyphh user-state.sqlite.
 */

import { BrowserWindow, screen } from "electron";
import { getLocalDb } from "./local-db";
import { getMainWindowRef } from "./main-window-ref";
import { dripId, dripRecordOf } from "../shared/member-library";
import {
  BUILTIN_EFFECTS,
  ONE_SHOT_EFFECTS,
  buildLoopHtml,
  buildOneShotHtml,
  oneShotSafetyMs,
  parseDripRecipe,
} from "../shared/drip-effects";

// The classic import surface (agent tools, command parser) stays on this module.
export { BUILTIN_EFFECTS, BUILTIN_EFFECT_LIST, ONE_SHOT_EFFECTS, LOOP_EFFECTS } from "../shared/drip-effects";
export type { BuiltinEffectInfo } from "../shared/drip-effects";

// ── Custom drip presets ──────────────────────��──────────────

export interface CustomDrip {
  name: string;
  recipe: string;
}


// ── DripManager ─────────────────────────────────────────────
//
// Custom drip presets are rows in the drips table of the user-state SQLite.
// The in-memory `customs` cache
// keeps the synchronous `.drip` command path working; better-sqlite3 writes
// are sync, so the command path and the Drips tab IPC share one code path.

/** How long a Settings "Preview" may hold the screen before it tears itself down. */
const PREVIEW_MAX_MS = 12_000;

// Module singleton — main.ts registers its instance so tool surfaces
// (Glyphh, relay) can reach the running manager without importing main.
let current: DripManager | null = null;
export function setDripManagerInstance(m: DripManager): void { current = m; }
export function getDripManagerInstance(): DripManager | null { return current; }

export class DripManager {
  private customs: Record<string, string> = {};   // name → recipe (cache)
  private persistent = new Map<string, BrowserWindow>();
  private mainWindow: BrowserWindow | null = null;

  constructor() {
    this.refreshFromDb();
  }

  setMainWindow(win: BrowserWindow): void { this.mainWindow = win; }

  /** Reload the cache from SQLite (non-fatal before initLocalDb). */
  refreshFromDb(): void {
    try {
      const rows = getLocalDb().prepare("SELECT name, recipe FROM drips").all() as Array<{ name: string; recipe: string }>;
      const customs: Record<string, string> = {};
      for (const r of rows) customs[r.name] = r.recipe;
      this.customs = customs;
    } catch { /* keep existing cache */ }
  }

  /** Refresh then list — the drips-list IPC path. */
  async refreshAndList(): Promise<CustomDrip[]> {
    this.refreshFromDb();
    return this.listCustoms();
  }

  listCustoms(): CustomDrip[] {
    return Object.entries(this.customs).map(([name, recipe]) => ({ name, recipe }));
  }

  /** Save a preset — cache + SQLite in one sync step, stamped with this
   *  machine's clock; the sync pushes it. */
  saveCustom(name: string, recipe: string): string {
    const rec = dripRecordOf(name, recipe);
    this.customs[rec.name] = rec.recipe;
    try {
      getLocalDb().prepare(
        `INSERT INTO drips (name, recipe, updated_at, updated_ms) VALUES (?, ?, datetime('now'), ?)
         ON CONFLICT(name) DO UPDATE SET recipe = excluded.recipe, updated_at = excluded.updated_at, updated_ms = excluded.updated_ms`,
      ).run(rec.name, rec.recipe, Date.now());
    } catch (err) {
      return `failed to save drip "${rec.name}": ${err instanceof Error ? err.message : String(err)}`;
    }
    return `saved drip "${rec.name}" → ${rec.recipe}`;
  }

  /** The Drips tab IPC rides the same sync save. */
  async saveCustomAsync(name: string, recipe: string): Promise<string> {
    return this.saveCustom(name, recipe);
  }

  /** Delete a preset: the row goes, a tombstone is written, the sync pushes the remove. */
  deleteCustom(name: string): string {
    const id = dripId(name);
    if (!(id in this.customs)) return `no custom drip "${id}"`;
    delete this.customs[id];
    try { getLocalDb().prepare("DELETE FROM drips WHERE name = ?").run(id); } catch { /* cache already updated */ }
    return `deleted drip "${id}"`;
  }

  async deleteCustomAsync(name: string): Promise<string> {
    return this.deleteCustom(name);
  }

  isEffect(name: string): boolean {
    return name in ONE_SHOT_EFFECTS || name in this.customs;
  }

  /**
   * Parse and execute a drip command. Returns status string.
   * `.drip .` (leading "." arg) plays IN-APP (windowed over the yo window);
   * otherwise the effect plays FULL-SCREEN over every app (OS overlay).
   *
   * `opts.preview` is the Settings "Preview" button: it forces WINDOWED and bounds
   * the effect's lifetime. A preview must never seize every display — a full-screen
   * always-on-top overlay with no timeout reads exactly like a dead app.
   */
  execute(args: string[], opts: { preview?: boolean; maxMs?: number } = {}): string {
    let fullscreen = !opts.preview;
    if (args.length > 0 && args[0] === ".") { fullscreen = false; args = args.slice(1); }
    const maxMs = opts.maxMs ?? (opts.preview ? PREVIEW_MAX_MS : 0);

    if (args.length === 0) { this.fireOneShot("fireworks", -1, fullscreen); return ""; }

    const sub = args[0].toLowerCase();

    if (sub === "save" && args.length >= 3) {
      return this.saveCustom(args[1].toLowerCase(), args.slice(2).join(" "));
    }
    if (sub === "delete" && args[1]) {
      return this.deleteCustom(args[1].toLowerCase());
    }
    if (sub === "list") {
      const customs = this.listCustoms();
      const built = BUILTIN_EFFECTS.join(", ");
      const custom = customs.length ? customs.map(c => `${c.name} → ${c.recipe}`).join(", ") : "(none)";
      return `effects: ${built}\ncustom: ${custom}`;
    }
    if (sub === "stop") {
      this.stopAll();
      return "stopped all persistent effects";
    }

    // Check if first non-number arg is a custom
    if (args.length === 1 && this.customs[sub]) {
      return this.executeRaw(this.customs[sub], fullscreen, maxMs);
    }

    return this.executeRaw(args.join(" "), fullscreen, maxMs);
  }

  /** Parse raw drip string: [count] [effects...] or [-1] [opacity] [effects...]
   *  (grammar lives in shared parseDripRecipe; customs expand via the cache). */
  private executeRaw(raw: string, fullscreen: boolean, maxMs = 0): string {
    const { count, opacity, effects } = parseDripRecipe(raw, (name) =>
      this.customs[name] ? this.resolveCustomEffects(name) : null);

    if (count === -1) {
      const op = opacity > 0 ? opacity : 0.5;
      for (const effect of effects) this.firePersistent(effect, op, fullscreen, maxMs);
      return `drip: ${effects.join(" + ")} constant`;
    }

    for (let i = 0; i < count; i++) {
      for (let j = 0; j < effects.length; j++) {
        const delay = (i * effects.length + j) * 1500;
        const eff = effects[j];
        const op = opacity > 0 ? opacity : -1;
        setTimeout(() => this.fireOneShot(eff, op, fullscreen), delay);
      }
    }

    return count > 1 ? `drip: ${effects.join(" + ")} x${count}` : `drip: ${effects.join(" + ")}`;
  }

  private resolveCustomEffects(name: string): string[] {
    const recipe = this.customs[name];
    if (!recipe) return [name];
    return recipe.split(/\s+/).filter(p => {
      const n = parseFloat(p);
      return isNaN(n) || (n >= 1 && Number.isInteger(n));
    }).filter(p => p !== "-1");
  }

  // Full screen of the display under the cursor (where the user is working).
  private displayBounds(): Electron.Rectangle {
    return screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).bounds;
  }

  /** The window a WINDOWED overlay parents to. `setMainWindow` is the wiring,
   *  but a missed call must not silently kill every preview (his report,
   *  2026-09-25) — the shared holder every other module reads is the fallback,
   *  and a destroyed handle re-reads it rather than going dark. */
  private hostWindow(): BrowserWindow | null {
    if (this.mainWindow && !this.mainWindow.isDestroyed()) return this.mainWindow;
    const ref = getMainWindowRef();
    if (ref) this.mainWindow = ref;
    return ref;
  }

  private overlayBounds(fullscreen: boolean): Electron.Rectangle | null {
    if (fullscreen) return this.displayBounds();
    return this.hostWindow()?.getBounds() ?? null;
  }

  private fireOneShot(effect: string, opacity = -1, fullscreen = false): void {
    const bounds = this.overlayBounds(fullscreen);
    if (!bounds) { console.warn("[drips] no host window — a windowed effect has nothing to parent to"); return; }
    let html = buildOneShotHtml(effect, bounds.width, bounds.height);
    if (opacity > 0) html = html.replace("<body>", `<body style="opacity:${opacity}">`);
    const overlay = this.createOverlay(bounds, fullscreen);
    overlay.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
    overlay.webContents.on("console-message", (_e, _level, msg) => {
      if (msg === "__drip_close__" && !overlay.isDestroyed()) overlay.close();
    });
    setTimeout(() => { if (!overlay.isDestroyed()) overlay.close(); }, oneShotSafetyMs(effect));
  }

  private firePersistent(effect: string, opacity: number, fullscreen = false, maxMs = 0): void {
    const existing = this.persistent.get(effect);
    if (existing && !existing.isDestroyed()) {
      existing.close();
      this.persistent.delete(effect);
      return;
    }
    const bounds = this.overlayBounds(fullscreen);
    if (!bounds) { console.warn("[drips] no host window — a windowed effect has nothing to parent to"); return; }
    const html = buildLoopHtml(effect, bounds.width, bounds.height, opacity);
    const overlay = this.createOverlay(bounds, fullscreen);
    overlay.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
    // A LOOP overlay used to live forever with no bound and no UI to kill it: a
    // full-screen, always-on-top, click-through window that renders as a black
    // sheet over every display while input passes straight through it. That is
    // indistinguishable from "the app died". Previews are always bounded.
    let timer: NodeJS.Timeout | null = null;
    if (maxMs > 0) {
      timer = setTimeout(() => { if (!overlay.isDestroyed()) overlay.close(); }, maxMs);
    }
    overlay.on("closed", () => {
      if (timer) clearTimeout(timer);
      this.persistent.delete(effect);
    });
    this.persistent.set(effect, overlay);
  }

  /** Is any persistent effect currently on screen? Drives the UI's stop affordance. */
  running(): string[] {
    return [...this.persistent.entries()].filter(([, ov]) => !ov.isDestroyed()).map(([name]) => name);
  }

  stopAll(): void {
    for (const ov of this.persistent.values()) { if (!ov.isDestroyed()) ov.close(); }
    this.persistent.clear();
  }

  cleanup(): void { this.stopAll(); }

  private createOverlay(bounds: Electron.Rectangle, fullscreen = false): BrowserWindow {
    const overlay = new BrowserWindow({
      // Full-screen: a top-level window so it floats over EVERY app. Windowed:
      // parented to the yo window so it only shows inside the app.
      ...(fullscreen ? {} : { parent: this.hostWindow() ?? undefined }),
      x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height,
      frame: false, transparent: true, hasShadow: false, resizable: false,
      backgroundColor: "#00000000", skipTaskbar: true, show: false,
      ...(fullscreen ? { alwaysOnTop: true, focusable: false } : {}),
      // backgroundThrottling: false — stacked drips cover each other, and
      // Chromium's occlusion tracker would throttle the covered overlays'
      // requestAnimationFrame to ~1fps (the "first drip stalls when the
      // second layers in" bug). Never throttle an effect overlay.
      webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
    });
    if (fullscreen) {
      overlay.setAlwaysOnTop(true, "screen-saver");
      overlay.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    }
    overlay.setIgnoreMouseEvents(true);
    overlay.once("ready-to-show", () => { if (!overlay.isDestroyed()) overlay.showInactive(); });
    return overlay;
  }
}
