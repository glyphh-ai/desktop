/**
 * panel-host.ts — SPIKE: stream a panel from the user's OWN machine to a web
 * client over the attach relay.
 *
 * This is the desktop half of the "the browser is the user's real machine"
 * proof. It reimplements rrotor's Fly panel-pod screencast (which drove a
 * headless Chromium over Playwright CDP) against Electron's built-in CDP —
 * `webContents.debugger` — on a REAL, headful, persistent-session BrowserWindow.
 * The point of doing it on-machine instead of in a pod:
 *   • the page renders in the USER'S residential browser → sites that block
 *     datacenter IPs / iframing (claude.ai, google) load fine;
 *   • it uses the user's LOGGED-IN sessions (persistent partition cookies) →
 *     no re-auth, the whole reason for this model.
 *
 * Transport is the existing attach socket (attach-client.ts):
 *   • control: server → `req` → these relay handlers (panel.open/input/close);
 *   • video:   this pushes each JPEG `Page.screencastFrame` UP the socket as a
 *     `push` frame (pushToAttach) → server fans it to the subscribed web client.
 *     base64 JPEG over WS — deliberately the SIMPLEST transport that proves the
 *     claim; the bandwidth cost is measured, and where WebRTC (phase 2) would
 *     cut it is called out in the report.
 *
 * Input is dispatched back into the page via CDP `Input.dispatch*` — the SAME
 * pure mapping (panel-input.ts) the pod used, so a click/keypress/scroll in the
 * web canvas lands in the real page identically.
 */

import { BrowserWindow } from "electron";
import { registerRelayHandler } from "./relay-client.js";
import { pushToAttach } from "./attach-client.js";
import { toCdp, resizeMetrics, clampDim } from "./panel-input.js";
import type { InputEvent } from "./panel-input.js";

/** A raw CDP `Page.screencastFrame` payload (the fields we use). */
interface ScreencastFramePayload {
  data: string;
  sessionId: number;
  metadata?: { deviceWidth?: number; deviceHeight?: number };
}

interface Panel {
  id: string;
  win: BrowserWindow;
  quality: number;
  frames: number;
  bytes: number;
  startedAt: number;
}

const panels = new Map<string, Panel>();
let seq = 0;

/**
 * The frame/nav sink. Production pushes up the attach socket; the spike harness
 * swaps in its own socket to prove the path against a local relay. Injectable so
 * the desktop-capture code under test is identical in both.
 */
let push: (channel: string, data: unknown) => void = (channel, data) => { pushToAttach(channel, data); };
export function setPanelPushSink(fn: (channel: string, data: unknown) => void): void { push = fn; }

function mintPanelId(): string {
  return `pnl-${Date.now().toString(36)}-${(++seq).toString(36)}`;
}

/** CDP send over the webContents debugger, typed loosely (Electron types it as unknown). */
function cdp(win: BrowserWindow, method: string, params?: Record<string, unknown>): Promise<unknown> {
  return win.webContents.debugger.sendCommand(method, params ?? {});
}

/**
 * Open a real page and start the screencast. Frames flow out via pushToAttach on
 * the panel's channel (its id) — the web client subscribes to that channel.
 */
async function openPanel(url: string, viewport: { width: number; height: number }, quality: number): Promise<{ panelId: string }> {
  if (!/^https?:\/\//i.test(url)) throw new Error("panel.open requires an http(s) { url }");
  const id = mintPanelId();
  const width = clampDim(viewport?.width, 1280);
  const height = clampDim(viewport?.height, 800);

  // HEADFUL, imageful, PERSISTENT default session — this is the whole point:
  // the user's real cookies/logins apply, and a real GPU-backed page renders.
  // show:false keeps it off-screen (the user watches it in the web client), but
  // it is a genuine rendered window, not offscreen/headless.
  const win = new BrowserWindow({
    show: false,
    width,
    height,
    webPreferences: {
      // default partition → the user's persistent session (logged-in cookies).
      sandbox: false,
      contextIsolation: true,
      javascript: true,
      images: true,
    },
  });

  const panel: Panel = { id, win, quality, frames: 0, bytes: 0, startedAt: Date.now() };
  panels.set(id, panel);

  // Load the page FIRST, then attach CDP. Attaching the debugger + `Page.enable`
  // on a webContents that has never navigated (still at the initial empty doc)
  // makes Electron's `sendCommand` hang indefinitely — the CDP session never
  // acknowledges. A committed navigation first avoids that entirely.
  await win.loadURL(url).catch((err) => {
    push(id, { type: "nav", url, title: `load error: ${(err as Error).message}` });
  });

  // Attach Electron's built-in CDP.
  try {
    win.webContents.debugger.attach("1.3");
  } catch (err) {
    win.destroy();
    panels.delete(id);
    throw new Error(`could not attach debugger: ${(err as Error).message}`);
  }

  // Screencast frames → push up the attach socket, then ACK (mandatory: Chromium
  // stalls the cast until each frame is ACKed).
  win.webContents.debugger.on("message", (_e, method, params) => {
    if (method === "Page.screencastFrame") {
      const p = params as ScreencastFramePayload;
      panel.frames++;
      panel.bytes += p.data?.length ?? 0;
      push(id, {
        type: "frame",
        data: p.data,
        format: "jpeg",
        meta: {
          deviceWidth: p.metadata?.deviceWidth ?? width,
          deviceHeight: p.metadata?.deviceHeight ?? height,
        },
        at: Date.now(),
      });
      void cdp(win, "Page.screencastFrameAck", { sessionId: p.sessionId }).catch(() => {});
    } else if (method === "Page.frameNavigated") {
      const nav = params as { frame?: { parentId?: string; url?: string } };
      // top-level only
      if (nav.frame && !nav.frame.parentId) {
        push(id, { type: "nav", url: nav.frame.url ?? win.webContents.getURL(), title: win.webContents.getTitle() });
      }
    }
  });
  await cdp(win, "Page.enable");
  await cdp(win, "Page.startScreencast", {
    format: "jpeg",
    quality,
    maxWidth: width,
    maxHeight: height,
    everyNthFrame: 1,
  });
  // Force at least one frame for a STATIC page: the screencast only emits on a
  // visual change, and a page that finished painting before the cast started
  // would otherwise produce nothing until the user interacts. invalidate()
  // schedules a repaint → a keyframe.
  try { win.webContents.invalidate(); } catch { /* noop */ }

  // Announce the first nav so the web client's address bar tracks reality.
  push(id, { type: "nav", url: win.webContents.getURL() || url, title: win.webContents.getTitle() });
  return { panelId: id };
}

async function inputPanel(panelId: string, ev: InputEvent): Promise<void> {
  const panel = panels.get(panelId);
  if (!panel || panel.win.isDestroyed()) throw new Error(`panel ${panelId} is not open`);
  if (ev?.type === "resize") {
    const cmd = resizeMetrics(ev.width, ev.height);
    await cdp(panel.win, cmd.method, cmd.params).catch(() => {});
    // Restart the cast at the new size.
    await cdp(panel.win, "Page.startScreencast", {
      format: "jpeg",
      quality: panel.quality,
      maxWidth: clampDim(ev.width, 1280),
      maxHeight: clampDim(ev.height, 800),
      everyNthFrame: 1,
    }).catch(() => {});
    return;
  }
  const cmd = toCdp(ev);
  if (!cmd) return;
  await cdp(panel.win, cmd.method, cmd.params).catch(() => {});
}

function closePanel(panelId: string): { closed: boolean; frames: number; bytes: number; uptimeMs: number } {
  const panel = panels.get(panelId);
  if (!panel) return { closed: false, frames: 0, bytes: 0, uptimeMs: 0 };
  const stats = { closed: true, frames: panel.frames, bytes: panel.bytes, uptimeMs: Date.now() - panel.startedAt };
  try {
    if (!panel.win.isDestroyed()) {
      try { panel.win.webContents.debugger.detach(); } catch { /* noop */ }
      panel.win.destroy();
    }
  } catch { /* noop */ }
  panels.delete(panelId);
  return stats;
}

/** Register the panel relay methods. Call once at boot (alongside installAttachHandlers). */
export function installPanelHost(): void {
  registerRelayHandler("panel.open", async (params) => {
    const p = params as { url?: string; width?: number; height?: number; quality?: number } | null;
    const url = String(p?.url ?? "");
    const viewport = { width: Number(p?.width) || 1280, height: Number(p?.height) || 800 };
    const quality = Math.min(100, Math.max(1, Number(p?.quality) || 70));
    return openPanel(url, viewport, quality);
  });

  registerRelayHandler("panel.input", async (params) => {
    const p = params as { panelId?: string; event?: InputEvent } | null;
    const panelId = String(p?.panelId ?? "");
    if (!panelId || !p?.event) throw new Error("panel.input requires { panelId, event }");
    await inputPanel(panelId, p.event);
    return { ok: true };
  });

  registerRelayHandler("panel.close", async (params) => {
    const p = params as { panelId?: string } | null;
    const panelId = String(p?.panelId ?? "");
    if (!panelId) throw new Error("panel.close requires { panelId }");
    return closePanel(panelId);
  });

  registerRelayHandler("panel.stats", async (params) => {
    const p = params as { panelId?: string } | null;
    const panel = panels.get(String(p?.panelId ?? ""));
    if (!panel) return { open: false };
    return { open: true, frames: panel.frames, bytes: panel.bytes, uptimeMs: Date.now() - panel.startedAt };
  });
}

/** Tear every panel down (app quit). */
export function closeAllPanels(): void {
  for (const id of [...panels.keys()]) closePanel(id);
}
