/**
 * drip-manager.ts — the DESKTOP host for drip effects.
 *
 * The effect generators, registries, and recipe grammar live in the shared,
 * electron-free module src/shared/drip-effects.ts (the web runner renders the
 * same docs). This file owns what only the desktop has: transparent overlay
 * BrowserWindows (full-screen over every app, or windowed over the yo window)
 * and the server-authoritative custom-preset cache.
 */

import { BrowserWindow, screen } from "electron";
import { getClient } from "./glyphh-client";
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

interface ServerDrip { id: string; name: string; recipe: string; }

// ── DripManager ─────────────────────────────────────────────
//
// Custom drip presets are server-authoritative (yo-server's saved_drips, the
// same table the platform Drips page writes to). The in-memory `customs` cache
// keeps the synchronous `.drip` command path working; `ids` maps name→server
// UUID for patch/delete. The command path saves optimistically (updates the
// cache + writes in the background); the Drips tab IPC awaits the server.

// Module singleton — main.ts registers its instance so tool surfaces
// (Glyphh, relay) can reach the running manager without importing main.
let current: DripManager | null = null;
export function setDripManagerInstance(m: DripManager): void { current = m; }
export function getDripManagerInstance(): DripManager | null { return current; }

export class DripManager {
  private customs: Record<string, string> = {};   // name → recipe (cache)
  private ids: Record<string, string> = {};       // name → server UUID
  private persistent = new Map<string, BrowserWindow>();
  private mainWindow: BrowserWindow | null = null;

  constructor() {
    // Pull presets in the background; the cache serves until the fetch lands.
    void this.refreshFromServer();
  }

  setMainWindow(win: BrowserWindow): void { this.mainWindow = win; }

  /** Refresh the cache from the server (non-fatal offline / pre-auth). */
  async refreshFromServer(): Promise<void> {
    try {
      const items = await getClient().drips.list();
      const customs: Record<string, string> = {};
      const ids: Record<string, string> = {};
      for (const item of items) {
        const recipe = (item.data as { recipe?: string } | null)?.recipe;
        if (typeof recipe !== "string") continue;
        customs[item.name] = recipe;
        ids[item.name] = item.id;
      }
      this.customs = customs;
      this.ids = ids;
    } catch { /* keep existing cache */ }
  }

  /** Refresh then list — used by the drips-list IPC so the tab shows server truth. */
  async refreshAndList(): Promise<CustomDrip[]> {
    await this.refreshFromServer();
    return this.listCustoms();
  }

  listCustoms(): CustomDrip[] {
    return Object.entries(this.customs).map(([name, recipe]) => ({ name, recipe }));
  }

  private async persistSave(name: string, recipe: string): Promise<void> {
    const id = this.ids[name];
    const saved = await getClient().drips.save({ name, data: { recipe }, ...(id ? { id } : {}) });
    this.ids[name] = saved.id;
    const savedRecipe = (saved.data as { recipe?: string } | null)?.recipe;
    if (typeof savedRecipe === "string") this.customs[name] = savedRecipe;
  }

  /** Optimistic save for the `.drip save` command (execute()) — updates the
   *  cache now, writes to the server in the background. */
  saveCustom(name: string, recipe: string): string {
    this.customs[name] = recipe;
    void this.persistSave(name, recipe).catch(() => {});
    return `saved drip "${name}" → ${recipe}`;
  }

  /** Awaitable save for the Drips tab IPC — server-confirmed before returning. */
  async saveCustomAsync(name: string, recipe: string): Promise<string> {
    this.customs[name] = recipe;
    try { await this.persistSave(name, recipe); return `saved drip "${name}"`; }
    catch (err) { return `failed to save drip "${name}": ${err instanceof Error ? err.message : String(err)}`; }
  }

  private async persistDelete(name: string): Promise<void> {
    const id = this.ids[name];
    delete this.customs[name];
    delete this.ids[name];
    if (id) await getClient().drips.delete(id);
  }

  /** Optimistic delete for the command path. */
  deleteCustom(name: string): string {
    if (!(name in this.customs)) return `no custom drip "${name}"`;
    void this.persistDelete(name).catch(() => {});
    return `deleted drip "${name}"`;
  }

  /** Awaitable delete for the Drips tab IPC. */
  async deleteCustomAsync(name: string): Promise<string> {
    if (!(name in this.customs)) return `no custom drip "${name}"`;
    try { await this.persistDelete(name); return `deleted drip "${name}"`; }
    catch (err) { return `failed to delete drip "${name}": ${err instanceof Error ? err.message : String(err)}`; }
  }

  isEffect(name: string): boolean {
    return name in ONE_SHOT_EFFECTS || name in this.customs;
  }

  /** Parse and execute a drip command. Returns status string.
   *  `.drip .` (leading "." arg) plays IN-APP (windowed over the yo window);
   *  otherwise the effect plays FULL-SCREEN over every app (OS overlay). */
  execute(args: string[]): string {
    let fullscreen = true;
    if (args.length > 0 && args[0] === ".") { fullscreen = false; args = args.slice(1); }

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
      return this.executeRaw(this.customs[sub], fullscreen);
    }

    return this.executeRaw(args.join(" "), fullscreen);
  }

  /** Parse raw drip string: [count] [effects...] or [-1] [opacity] [effects...]
   *  (grammar lives in shared parseDripRecipe; customs expand via the cache). */
  private executeRaw(raw: string, fullscreen: boolean): string {
    const { count, opacity, effects } = parseDripRecipe(raw, (name) =>
      this.customs[name] ? this.resolveCustomEffects(name) : null);

    if (count === -1) {
      const op = opacity > 0 ? opacity : 0.5;
      for (const effect of effects) this.firePersistent(effect, op, fullscreen);
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

  private overlayBounds(fullscreen: boolean): Electron.Rectangle | null {
    if (fullscreen) return this.displayBounds();
    if (!this.mainWindow || this.mainWindow.isDestroyed()) return null;
    return this.mainWindow.getBounds();
  }

  private fireOneShot(effect: string, opacity = -1, fullscreen = false): void {
    const bounds = this.overlayBounds(fullscreen);
    if (!bounds) return;
    let html = buildOneShotHtml(effect, bounds.width, bounds.height);
    if (opacity > 0) html = html.replace("<body>", `<body style="opacity:${opacity}">`);
    const overlay = this.createOverlay(bounds, fullscreen);
    overlay.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
    overlay.webContents.on("console-message", (_e, _level, msg) => {
      if (msg === "__drip_close__" && !overlay.isDestroyed()) overlay.close();
    });
    setTimeout(() => { if (!overlay.isDestroyed()) overlay.close(); }, oneShotSafetyMs(effect));
  }

  private firePersistent(effect: string, opacity: number, fullscreen = false): void {
    const existing = this.persistent.get(effect);
    if (existing && !existing.isDestroyed()) {
      existing.close();
      this.persistent.delete(effect);
      return;
    }
    const bounds = this.overlayBounds(fullscreen);
    if (!bounds) return;
    const html = buildLoopHtml(effect, bounds.width, bounds.height, opacity);
    const overlay = this.createOverlay(bounds, fullscreen);
    overlay.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
    overlay.on("closed", () => this.persistent.delete(effect));
    this.persistent.set(effect, overlay);
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
      ...(fullscreen ? {} : { parent: this.mainWindow! }),
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
