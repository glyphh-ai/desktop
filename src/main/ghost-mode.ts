/**
 * ghost-mode — summon the coding agent as a translucent overlay ON TOP of
 * whatever app is in front, without leaving it.
 *
 * A global hotkey (Cmd+Shift+G / Ctrl+Shift+G) toggles a frameless, transparent,
 * always-on-top window that fills the display under the cursor and loads the
 * renderer in `?solo=ghost` mode — a floating glass card with the Coding Agent
 * over a dim, blurred backdrop that lets the app behind show through. Esc, a
 * backdrop click (→ "ghost-close" IPC), or the hotkey again dismisses it and
 * focus returns to the app you were in.
 *
 * It rides at "screen-saver" level and is visible on fullscreen spaces, so it
 * appears even over a fullscreen editor or browser.
 */

import { BrowserWindow, globalShortcut, ipcMain, nativeTheme, screen } from "electron";
import { execFile } from "child_process";
import path from "path";
import { getClient } from "./glyphh-client";
import { getPreference, setPreference } from "./stores/preferences-db";

let ghostWin: BrowserWindow | null = null;
/** The summon-time TARGET app bounds — snap halves are computed against
 *  these, not the ghost's own (possibly already-snapped) bounds. */
let targetBounds: Bounds | null = null;

export type GhostHalf = "full" | "left" | "right" | "top" | "bottom";

/** A half (or all) of the target bounds, clamped to the window minimums. */
function snapBounds(t: Bounds, half: GhostHalf): Bounds {
  const w2 = Math.max(320, Math.round(t.width / 2));
  const h2 = Math.max(240, Math.round(t.height / 2));
  switch (half) {
    case "left": return { x: t.x, y: t.y, width: w2, height: t.height };
    case "right": return { x: t.x + t.width - w2, y: t.y, width: w2, height: t.height };
    case "top": return { x: t.x, y: t.y, width: t.width, height: h2 };
    case "bottom": return { x: t.x, y: t.y + t.height - h2, width: t.width, height: h2 };
    default: return t;
  }
}

/** What a summon opens with: the model to select + the first prompt. */
interface GhostOpts { model?: string; prompt?: string }

// ── @-mention catalog ────────────────────────────────────────────────────────
// "@<provider-alias>-<model-alias>" resolves against the platform catalog. The
// renderer needs SYNCHRONOUS matching (Enter must be consumed or not, no await),
// so main serves a flat lookup map — every alias/slug/bare-id combination →
// model id — cached briefly.
let mentionCache: { at: number; pairs: Record<string, string> } | null = null;
const MENTION_TTL_MS = 5 * 60_000;

async function mentionPairs(): Promise<Record<string, string>> {
  if (mentionCache && Date.now() - mentionCache.at < MENTION_TTL_MS) return mentionCache.pairs;
  const client = getClient();
  const [providers, models] = await Promise.all([client.catalog.providers(), client.catalog.models()]);
  const byProvider = new Map(providers.map((p) => [p.slug, p]));
  const pairs: Record<string, string> = {};
  for (const m of models) {
    const p = byProvider.get(m.providerSlug);
    const bare = m.id.startsWith(`${m.providerSlug}::`) ? m.id.slice(m.providerSlug.length + 2) : m.id;
    const providerKeys = [p?.alias, m.providerSlug].filter((v): v is string => !!v);
    const modelKeys = [m.alias, bare].filter((v): v is string => !!v);
    for (const pk of providerKeys) {
      for (const mk of modelKeys) pairs[`${pk.toLowerCase()}-${mk.toLowerCase()}`] = m.id;
    }
  }
  mentionCache = { at: Date.now(), pairs };
  return pairs;
}

interface Bounds { x: number; y: number; width: number; height: number }

/**
 * Bounds of the app window that is frontmost RIGHT NOW — read before our own
 * window steals focus, so Ghost Mode can size itself exactly over it. macOS via
 * System Events (needs Accessibility permission); null elsewhere or on failure.
 */
function frontmostWindowBounds(): Promise<Bounds | null> {
  if (process.platform !== "darwin") return Promise.resolve(null);
  const script =
    'tell application "System Events" to tell (first application process whose frontmost is true) to get {position, size} of front window';
  return new Promise((resolve) => {
    execFile("osascript", ["-e", script], { timeout: 1500 }, (err, stdout) => {
      if (err) { resolve(null); return; }
      const n = String(stdout).trim().split(",").map((s) => parseInt(s.trim(), 10));
      if (n.length !== 4 || n.some((v) => Number.isNaN(v)) || n[2] < 80 || n[3] < 80) { resolve(null); return; }
      resolve({ x: n[0], y: n[1], width: n[2], height: n[3] });
    });
  });
}

/** Centered fallback when the active window's bounds can't be read. */
function centeredFallback(): Bounds {
  const wa = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
  const width = Math.min(980, Math.round(wa.width * 0.9));
  const height = Math.min(760, Math.round(wa.height * 0.82));
  return { x: Math.round(wa.x + (wa.width - width) / 2), y: Math.round(wa.y + (wa.height - height) / 2), width, height };
}

async function openGhost(opts?: GhostOpts): Promise<void> {
  // A summon carries context (model + prompt) the window reads at load — an
  // already-open ghost reloads fresh rather than showing a stale session.
  if (ghostWin && !ghostWin.isDestroyed()) {
    if (!opts?.model && !opts?.prompt) { ghostWin.show(); ghostWin.focus(); return; }
    closeGhost();
  }
  // Size + position the overlay to EXACTLY match the target app's window.
  targetBounds = (await frontmostWindowBounds()) ?? centeredFallback();
  // The remembered snap (full / a half of the target app) applies on summon.
  const savedHalf = getPreference<GhostHalf>("ghostSnapHalf", "full");
  const bounds = snapBounds(targetBounds, savedHalf);
  ghostWin = new BrowserWindow({
    ...bounds,
    minWidth: 320,
    minHeight: 240,
    frame: false,
    transparent: true,
    resizable: true,
    movable: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    alwaysOnTop: true,
    hasShadow: false,
    skipTaskbar: true,
    show: false,
    backgroundColor: "#00000000",
    // REAL blur-behind: CSS backdrop-filter can only blur content inside the
    // page — it cannot touch the other apps behind a transparent window. The
    // OS compositor does that: vibrancy (macOS) / acrylic (Windows 11).
    // Blur-behind comes ONLY from the OS compositor (CSS cannot blur another
    // app). macOS vibrancy honors "Reduce transparency": with it ON, every
    // material renders opaque grey — which is why the frost kept reading as
    // "can't see behind it". So: real material when the system allows
    // transparency; otherwise stay crystal-clear and let the renderer paint a
    // FAKE frost (noise + tint) that keeps the app visible.
    ...(process.platform === "darwin" && !nativeTheme.prefersReducedTransparency
      ? { vibrancy: "hud" as const }
      : {}),
    ...(process.platform === "win32" ? { backgroundMaterial: "acrylic" as const } : {}),
    webPreferences: {
      preload: path.join(__dirname, "..", "renderer", "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: true,
    },
  });
  // Float above everything, including fullscreen apps and other overlays.
  ghostWin.setAlwaysOnTop(true, "screen-saver");
  ghostWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  ghostWin.on("closed", () => { ghostWin = null; });
  const query: Record<string, string> = { solo: "ghost" };
  // Tell the renderer which frost it's getting: "os" (a real material blurs
  // behind) or "css" (no material — paint the fake frost).
  const hasMaterial =
    (process.platform === "darwin" && !nativeTheme.prefersReducedTransparency) ||
    process.platform === "win32";
  query.gfrost = hasMaterial ? "os" : "css";
  if (opts?.model) query.gmodel = opts.model;
  if (opts?.prompt) query.gprompt = opts.prompt;
  void ghostWin.loadFile(path.join(__dirname, "..", "renderer", "home.html"), { query });
  ghostWin.once("ready-to-show", () => { ghostWin?.show(); ghostWin?.focus(); });
}

function closeGhost(): void {
  const w = ghostWin;
  ghostWin = null;
  try { if (w && !w.isDestroyed()) w.close(); } catch { /* already closing */ }
}

export function toggleGhost(): void {
  if (ghostWin && !ghostWin.isDestroyed()) closeGhost();
  else void openGhost();
}

export function isGhostOpen(): boolean {
  return !!(ghostWin && !ghostWin.isDestroyed());
}

/** Register the global hotkey + the renderer's close channel. Idempotent. */
export function registerGhostMode(): void {
  const accelerator = process.platform === "darwin" ? "Command+Shift+G" : "Control+Shift+G";
  try {
    globalShortcut.register(accelerator, toggleGhost);
  } catch { /* accelerator unavailable — non-fatal, ghost just won't hotkey */ }
  // The overlay renderer asks to dismiss itself (Esc / backdrop click).
  ipcMain.handle("ghost-close", () => { closeGhost(); return { ok: true }; });
  // Renderer-driven resize: transparent frameless windows don't get reliable
  // native edge-resize zones (the content covers them), so the overlay paints
  // its own grips and drives the window size through these two channels.
  ipcMain.handle("ghost-bounds", () => {
    if (!ghostWin || ghostWin.isDestroyed()) return null;
    return ghostWin.getBounds();
  });
  // Snap the ghost over a HALF of the target app (left/right/top/bottom) or
  // back to full. The choice persists and re-applies on the next summon.
  ipcMain.handle("ghost-snap", (_e, half: GhostHalf) => {
    if (!ghostWin || ghostWin.isDestroyed() || !targetBounds) return { ok: false };
    const which: GhostHalf = ["full", "left", "right", "top", "bottom"].includes(half) ? half : "full";
    ghostWin.setBounds(snapBounds(targetBounds, which));
    setPreference("ghostSnapHalf", which);
    return { ok: true, half: which };
  });
  ipcMain.handle("ghost-resize", (_e, size: { width?: number; height?: number }) => {
    if (!ghostWin || ghostWin.isDestroyed()) return { ok: false };
    const b = ghostWin.getBounds();
    ghostWin.setBounds({
      ...b,
      width: Math.max(320, Math.round(Number(size?.width) || b.width)),
      height: Math.max(240, Math.round(Number(size?.height) || b.height)),
    });
    return { ok: true };
  });
  // The @-mention alias table, flattened for synchronous renderer matching.
  ipcMain.handle("mention-catalog", async () => {
    try { return { ok: true, pairs: await mentionPairs() }; }
    catch (err) { return { ok: false, error: err instanceof Error ? err.message : String(err) }; }
  });
  // "@an-fable ship it" → open the ghost on that model with the prompt seeded.
  ipcMain.handle("ghost-summon", async (_e, model: string, prompt: string) => {
    await summonGhost(String(model || ""), String(prompt || ""));
    return { ok: true };
  });
}

/** Summon programmatically (panel injections route here, not through IPC). */
export function summonGhost(model: string, prompt: string): Promise<void> {
  mentionCache = null; // a summon implies the catalog is in use — refresh soon
  return openGhost({ model, prompt });
}

/** The flattened alias table, for surfaces that inject matchers into pages. */
export { mentionPairs };

/** Tear the overlay down on quit. globalShortcut.unregisterAll() runs elsewhere. */
export function destroyGhostMode(): void {
  closeGhost();
}
