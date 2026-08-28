/**
 * agent-dock — PROTOTYPE: the REAL Echo agent, anchored to the bottom of
 * whatever desktop app is frontmost.
 *
 * The retired desktop-layout system (v2.3.0, "Glyphh stops managing the
 * desktop") moved OTHER apps' windows — the buggy half. This resurrects only
 * the safe half: a native helper (native/agent-dock-helper) WATCHES the
 * frontmost window via CGWindowList (no permission needed, nothing is moved)
 * and this module keeps a transparent always-on-top window glued to the
 * bottom band of that window — following move/resize, hiding when the target
 * minimizes/closes, re-anchoring when the user switches apps.
 *
 * The window loads home.html?solo=agent — the SAME page, preload and agent
 * the workbench uses, so the pill is pixel-identical with all its controls
 * (workdir, lock, drips, sessions, peek, drag geometry). Behavior maps 1:1:
 * the foreign app plays the role Echo's cards play, so the agent auto-hides
 * (covered tuck + hover reveal) unless the lock (echoAgentLock) pins it up.
 *
 * Mouse events over anything but the agent's own pixels are forwarded to the
 * app beneath (setIgnoreMouseEvents + the renderer's elementFromPoint sync in
 * home.ts) — the transparent band never steals the target app's clicks.
 *
 * ⌘⇧G toggles attach mode. macOS only; no-op elsewhere. The helper is
 * compiled on first use with swiftc when the binary is missing (dev
 * prototype — a real build step would live in scripts/).
 */

import { app, BrowserWindow, globalShortcut, ipcMain } from "electron";
import { spawn, spawnSync, ChildProcess } from "child_process";
import { createInterface } from "readline";
import fs from "fs";
import path from "path";

interface TargetInfo {
  pid: number;
  cgid: number;
  proc: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Height of the band over the target's bottom edge. Tall enough for the
 *  composer plus the peek thread (echoAgentMaxH defaults to 76vh of this). */
const BAND_HEIGHT = 760;

let helper: ChildProcess | null = null;
let dockWin: BrowserWindow | null = null;
let enabled = false;
let lastTarget: TargetInfo | null = null;

function helperBinary(): string | null {
  const dir = path.join(app.getAppPath(), "native", "agent-dock-helper");
  const bin = path.join(dir, "agent-dock-helper");
  if (fs.existsSync(bin)) return bin;
  const src = path.join(dir, "main.swift");
  if (!fs.existsSync(src)) return null;
  console.log("[agent-dock] compiling helper (first run)…");
  const res = spawnSync("swiftc", ["-O", "-o", bin, src], { encoding: "utf8" });
  if (res.status !== 0) {
    console.error("[agent-dock] helper compile failed:", res.stderr || res.error?.message);
    return null;
  }
  return bin;
}

function ensureDockWindow(): BrowserWindow {
  if (dockWin && !dockWin.isDestroyed()) return dockWin;
  dockWin = new BrowserWindow({
    width: 1200,
    height: BAND_HEIGHT,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: "#00000000",
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    hasShadow: false,
    webPreferences: {
      // Same surface as HomeView — the page IS home.html, agent-only mode.
      preload: path.join(__dirname, "..", "renderer", "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: true,
      backgroundThrottling: false, // must repaint while an inactive window
    },
  });
  // "floating" sits above every normal window (including the target app when
  // it is focused) but below the screen-saver-level scrims/palette.
  dockWin.setAlwaysOnTop(true, "floating");
  dockWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  // Pass-through by default; the renderer flips this off over the agent's
  // own pixels (forward:true keeps mousemove flowing so it can flip back).
  dockWin.setIgnoreMouseEvents(true, { forward: true });
  void dockWin.loadFile(path.join(__dirname, "..", "renderer", "home.html"), { query: { solo: "agent" } });
  dockWin.on("closed", () => { dockWin = null; });
  return dockWin;
}

/** Cover the target window's bottom band. CG and Electron share the same
 *  top-left-origin global point coordinates on macOS, so the rect maps
 *  straight through. The agent centers itself inside via its own CSS
 *  (--echo-agent-x/--echo-agent-w), exactly as it does over the Echo wall. */
function position(target: TargetInfo): void {
  const w = ensureDockWindow();
  // Never cover the target's title bar: whatever the hit-test logic does, the
  // close/zoom controls must stay physically outside this window.
  const height = Math.min(BAND_HEIGHT, target.height - 40);
  w.setBounds({
    x: target.x,
    y: target.y + target.height - height,
    width: target.width,
    height,
  });
  if (!w.isVisible()) w.showInactive();
}

function onEvent(evt: { event: string } & Partial<TargetInfo>): void {
  if (!enabled) return;
  if (evt.event === "front" && evt.proc !== undefined) {
    lastTarget = evt as TargetInfo;
    position(lastTarget);
  } else if (evt.event === "glyphh-front") {
    // A Glyphh window is the active app. If it is the DOCK itself (the user
    // clicked into the composer), the pill stays; any other Glyphh window —
    // the main app, a popout — hides it. The agent never shows over Glyphh.
    if (dockWin && !dockWin.isDestroyed() && !dockWin.isFocused() && dockWin.isVisible()) dockWin.hide();
  } else if (evt.event === "gone") {
    lastTarget = null;
    if (dockWin && !dockWin.isDestroyed() && dockWin.isVisible()) dockWin.hide();
  }
}

function startHelper(): void {
  if (helper) return;
  const bin = helperBinary();
  if (!bin) {
    console.error("[agent-dock] no helper binary — attach mode unavailable");
    enabled = false;
    return;
  }
  const dockCgid = (() => {
    try { return ensureDockWindow().getMediaSourceId().split(":")[1] || "0"; } catch { return "0"; }
  })();
  helper = spawn(bin, ["--exclude-cgid", dockCgid], { stdio: ["pipe", "pipe", "pipe"] });
  createInterface({ input: helper.stdout! }).on("line", (line) => {
    try { onEvent(JSON.parse(line)); } catch { /* partial line at shutdown */ }
  });
  helper.stderr?.on("data", (d: Buffer) => console.error("[agent-dock] helper:", d.toString().trim()));
  helper.on("exit", (code) => {
    helper = null;
    if (enabled) console.error(`[agent-dock] helper exited (${code})`);
  });
}

function stopHelper(): void {
  if (!helper) return;
  helper.stdin?.end();
  helper.kill();
  helper = null;
}

function setEnabled(on: boolean): void {
  if (on === enabled) return;
  enabled = on;
  console.log(`[agent-dock] attach mode ${on ? "ON" : "off"}`);
  if (on) {
    ensureDockWindow(); // page boots while the helper finds a target
    startHelper();
  } else {
    stopHelper();
    lastTarget = null;
    if (dockWin && !dockWin.isDestroyed()) dockWin.hide();
  }
}

export function registerAgentDockIpc(): void {
  if (process.platform !== "darwin") return;

  // The pill NEVER shows over Glyphh. The helper's glyphh-front covers app
  // activation, but focus moving BETWEEN Glyphh windows (pill → main window)
  // changes no frontmost app and fires no helper event — so hide on the
  // focus event itself. Focusing the dock (typing in the composer) keeps it.
  app.on("browser-window-focus", (_e, w) => {
    if (w === dockWin) return;
    if (dockWin && !dockWin.isDestroyed() && dockWin.isVisible()) dockWin.hide();
  });


  // The renderer (home.ts, ?solo=agent) drives click-through from
  // elementFromPoint — only the agent's pixels take the mouse.
  ipcMain.on("agent-dock:ignore-mouse", (event, ignore: boolean) => {
    if (!dockWin || dockWin.isDestroyed() || event.sender !== dockWin.webContents) return;
    dockWin.setIgnoreMouseEvents(!!ignore, ignore ? { forward: true } : undefined);
  });

  globalShortcut.register("CommandOrControl+Shift+G", () => setEnabled(!enabled));

  // Attach mode starts OFF — ⌘⇧G summons it. (The Aug 21 prototype started
  // ON, which was safe then because every IPC handler registered before
  // createWindow; today the dock window would boot at line ~490 of main's
  // boot and spray 'No handler registered' for everything that registers
  // later. Off-until-summoned kills the race and stops a surprise overlay
  // on every launch.)
}

export function disposeAgentDock(): void {
  enabled = false;
  stopHelper();
  if (dockWin && !dockWin.isDestroyed()) dockWin.destroy();
  dockWin = null;
}
