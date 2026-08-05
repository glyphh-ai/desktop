/**
 * panel-host.ts — stream a panel from the user's OWN machine to a web client
 * over the attach relay.
 *
 * This is the desktop half of the "the browser IS the user's real machine"
 * model. When the app is opened on WEB and this desktop is attached, an app
 * panel that would be a native <webview> on the desktop instead renders HERE, on
 * the machine, and is streamed to the browser: the page loads in the user's real
 * residential browser with their logged-in cookies (sites that block datacenter
 * IPs / iframing — claude.ai, google — load fine, and no re-auth is needed),
 * frames go up to the cloud, and the web canvas draws them + sends input back.
 *
 * Layering — the WHERE-does-the-page-live seam is deliberate:
 *   • {@link PanelSource} (panel-source.ts) is the source-agnostic contract:
 *     open / input / resize / close / stats for ONE panel. The relay, the wire
 *     frames, and the web component are written against it and do not care where
 *     frames come from.
 *   • {@link ElectronPanelSource} (this file) satisfies it for the DESKTOP: a
 *     real off-screen Electron BrowserView, captured via Chromium's built-in CDP
 *     (webContents.debugger + Page.startScreencast → JPEG), input replayed via
 *     Input.dispatch*.
 *   • A future PodPanelSource (session pod) satisfies the SAME contract by
 *     driving the pod's browser; `createPanelSource` is the ONE factory a pod
 *     source plugs into. Nothing else changes.
 *
 * The MANAGER (installPanelHost) owns the panel registry, the relay methods
 * (panel.open/input/close/stats/webrtc), and the push sink (frames →
 * pushToAttach → server fan-out). It never touches Chromium directly — that is
 * the source's job.
 *
 * Transport is the existing attach socket (attach-client.ts): control comes DOWN
 * as `req` frames the relay handlers answer; video goes UP as `push` frames on
 * the panel's channel (its id), which the server relays to the subscribed web
 * client. base64 JPEG over WS is the phase-1 transport; phase 2 (panel-webrtc.ts)
 * negotiates a WebRTC peer for the media and falls back to this automatically.
 */

import { BrowserWindow, BrowserView } from "electron";
import { registerRelayHandler } from "./relay-client.js";
import { pushToAttach } from "./attach-client.js";
import { toCdp, resizeMetrics, clampDim } from "./panel-input.js";
import type { InputEvent } from "./panel-input.js";
import type { PanelSource, PanelSink, PanelOpenOptions, PanelSourceStats } from "./panel-source.js";
import { maybeStartWebrtc, handleWebrtcSignal, isWebrtcSignal, closeWebrtc, feedJpeg } from "./panel-webrtc.js";

/** A raw CDP `Page.screencastFrame` payload (the fields we use). */
interface ScreencastFramePayload {
  data: string;
  sessionId: number;
  metadata?: { deviceWidth?: number; deviceHeight?: number };
}

/**
 * ElectronPanelSource — the DESKTOP {@link PanelSource}: a real, off-screen
 * Electron page rendered with the user's persistent session, captured over CDP.
 *
 * "Off-screen" here means the capture surface is a {@link BrowserView} parented
 * to a hidden, unshown host {@link BrowserWindow} — a genuine, GPU-backed,
 * imageful, persistent-partition page (the user's real cookies apply), never
 * painted to the user's display. It is NOT `webPreferences.offscreen` (that
 * path is software-rendered and drops GPU acceleration); the CDP screencast is
 * what carries the pixels, and it works on a real on-GPU view that simply has no
 * on-screen window.
 */
export class ElectronPanelSource implements PanelSource {
  private host: BrowserWindow | null = null;
  private view: BrowserView | null = null;
  private quality = 70;
  private width = 1280;
  private height = 800;
  private frames = 0;
  private bytes = 0;
  private startedAt = 0;
  private closed = false;

  constructor(readonly id: string, private readonly sink: PanelSink) {}

  private get wc(): Electron.WebContents | null {
    return this.view && !this.view.webContents.isDestroyed() ? this.view.webContents : null;
  }

  /** CDP send over the view's debugger, typed loosely (Electron types it unknown). */
  private cdp(method: string, params?: Record<string, unknown>): Promise<unknown> {
    const wc = this.wc;
    if (!wc) return Promise.reject(new Error("panel view is gone"));
    return wc.debugger.sendCommand(method, params ?? {});
  }

  async open(opts: PanelOpenOptions): Promise<void> {
    if (!/^https?:\/\//i.test(opts.url)) throw new Error("panel.open requires an http(s) { url }");
    this.quality = Math.min(100, Math.max(1, opts.quality || 70));
    this.width = clampDim(opts.width, 1280);
    this.height = clampDim(opts.height, 800);
    this.startedAt = Date.now();

    // A hidden host window to parent the capture view. show:false keeps it off
    // the user's display; the page still renders on the GPU (this is not
    // software offscreen). The default partition → the user's persistent
    // session, which is the whole point: their real logged-in cookies apply.
    const host = new BrowserWindow({ show: false, width: this.width, height: this.height });
    this.host = host;
    const view = new BrowserView({
      webPreferences: { sandbox: false, contextIsolation: true, javascript: true, images: true },
    });
    this.view = view;
    host.setBrowserView(view);
    view.setBounds({ x: 0, y: 0, width: this.width, height: this.height });

    // Load the page FIRST, then attach CDP. Attaching the debugger + `Page.enable`
    // on a webContents that has never navigated (still at the initial empty doc)
    // makes Electron's `sendCommand` hang indefinitely — the CDP session never
    // acknowledges. A committed navigation first avoids that entirely.
    await view.webContents.loadURL(opts.url).catch((err) => {
      this.sink({ type: "nav", url: opts.url, title: `load error: ${(err as Error).message}` });
    });
    if (this.closed) return;

    try {
      view.webContents.debugger.attach("1.3");
    } catch (err) {
      this.teardownSurface();
      throw new Error(`could not attach debugger: ${(err as Error).message}`);
    }

    view.webContents.debugger.on("message", (_e, method, params) => {
      if (method === "Page.screencastFrame") {
        const p = params as ScreencastFramePayload;
        this.frames++;
        this.bytes += p.data?.length ?? 0;
        // Tee the SAME frame to a live WebRTC encoder (no-op when none) so the
        // H.264 path reuses the capture instead of grabbing pixels twice.
        feedJpeg(this.id, p.data);
        this.sink({
          type: "frame",
          data: p.data,
          format: "jpeg",
          meta: {
            deviceWidth: p.metadata?.deviceWidth ?? this.width,
            deviceHeight: p.metadata?.deviceHeight ?? this.height,
          },
          at: Date.now(),
        });
        // Mandatory: Chromium stalls the cast until each frame is ACKed.
        void this.cdp("Page.screencastFrameAck", { sessionId: p.sessionId }).catch(() => {});
      } else if (method === "Page.frameNavigated") {
        const nav = params as { frame?: { parentId?: string; url?: string } };
        if (nav.frame && !nav.frame.parentId) {
          this.sink({ type: "nav", url: nav.frame.url ?? this.wc?.getURL() ?? "", title: this.wc?.getTitle() ?? "" });
        }
      }
    });

    await this.cdp("Page.enable");
    await this.startScreencast(this.width, this.height);

    // Force at least one frame for a STATIC page: the screencast only emits on a
    // visual change, and a page that finished painting before the cast started
    // would otherwise produce nothing until the user interacts. invalidate()
    // schedules a repaint → a keyframe.
    try { this.wc?.invalidate(); } catch { /* noop */ }

    // Announce the first nav so the web client's address bar tracks reality.
    this.sink({ type: "nav", url: this.wc?.getURL() || opts.url, title: this.wc?.getTitle() ?? "" });
  }

  private startScreencast(width: number, height: number): Promise<unknown> {
    return this.cdp("Page.startScreencast", {
      format: "jpeg",
      quality: this.quality,
      maxWidth: clampDim(width, 1280),
      maxHeight: clampDim(height, 800),
      everyNthFrame: 1,
    });
  }

  async input(ev: InputEvent): Promise<void> {
    if (this.closed || !this.wc) return;
    const cmd = toCdp(ev);
    if (!cmd) return;
    await this.cdp(cmd.method, cmd.params).catch(() => {});
  }

  async resize(width: number, height: number): Promise<void> {
    if (this.closed || !this.wc) return;
    this.width = clampDim(width, 1280);
    this.height = clampDim(height, 800);
    this.view?.setBounds({ x: 0, y: 0, width: this.width, height: this.height });
    const metrics = resizeMetrics(this.width, this.height);
    await this.cdp(metrics.method, metrics.params).catch(() => {});
    // Restart the cast at the new size, then force a keyframe (the resize alone
    // may not repaint a static page).
    await this.startScreencast(this.width, this.height).catch(() => {});
    try { this.wc?.invalidate(); } catch { /* noop */ }
  }

  private teardownSurface(): void {
    const view = this.view;
    this.view = null;
    if (view && !view.webContents.isDestroyed()) {
      try { view.webContents.debugger.detach(); } catch { /* not attached */ }
      try { (view.webContents as unknown as { close?: () => void }).close?.(); } catch { /* noop */ }
    }
    const host = this.host;
    this.host = null;
    if (host && !host.isDestroyed()) {
      try { if (view) host.removeBrowserView(view); } catch { /* already gone */ }
      try { host.destroy(); } catch { /* noop */ }
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    // Stop the cast before detaching so no frame is emitted mid-teardown.
    void this.cdp("Page.stopScreencast").catch(() => {});
    this.teardownSurface();
  }

  stats(): PanelSourceStats {
    return { frames: this.frames, bytes: this.bytes, uptimeMs: this.startedAt ? Date.now() - this.startedAt : 0 };
  }

  viewport(): { width: number; height: number } {
    return { width: this.width, height: this.height };
  }
}

// ── the manager: registry + relay methods + push sink ────────────────────────

const sources = new Map<string, PanelSource>();
let seq = 0;

/**
 * The frame/control sink. Production pushes up the attach socket; a test can
 * swap in its own so the capture code under test is identical to shipping.
 */
let push: (channel: string, data: unknown) => void = (channel, data) => { pushToAttach(channel, data); };
export function setPanelPushSink(fn: (channel: string, data: unknown) => void): void { push = fn; }

function mintPanelId(): string {
  return `pnl-${Date.now().toString(36)}-${(++seq).toString(36)}`;
}

/**
 * The ONE place a panel's origin is chosen. Today every panel is the local
 * machine → {@link ElectronPanelSource}. A session pod plugs in HERE: branch on
 * the open params (e.g. a `podId`) and return a PodPanelSource bound to that
 * pod's control channel. Everything downstream — the registry, the relay
 * methods, the wire frames, the web component — is unchanged.
 */
function createPanelSource(id: string, sink: PanelSink): PanelSource {
  return new ElectronPanelSource(id, sink);
}

async function openPanel(opts: PanelOpenOptions): Promise<{ panelId: string }> {
  const id = mintPanelId();
  const sink: PanelSink = (data) => push(id, data);
  const source = createPanelSource(id, sink);
  sources.set(id, source);
  try {
    await source.open(opts);
  } catch (err) {
    sources.delete(id);
    try { await source.close(); } catch { /* noop */ }
    throw err;
  }
  return { panelId: id };
}

async function inputPanel(panelId: string, ev: InputEvent): Promise<void> {
  const source = sources.get(panelId);
  if (!source) throw new Error(`panel ${panelId} is not open`);
  if (ev?.type === "resize") { await source.resize(ev.width, ev.height); return; }
  await source.input(ev);
}

async function closePanel(panelId: string): Promise<{ closed: boolean } & PanelSourceStats> {
  const source = sources.get(panelId);
  if (!source) return { closed: false, frames: 0, bytes: 0, uptimeMs: 0 };
  const stats = source.stats();
  try { await closeWebrtc(panelId); } catch { /* noop */ }
  try { await source.close(); } catch { /* noop */ }
  sources.delete(panelId);
  return { closed: true, ...stats };
}

/** Register the panel relay methods. Call once at boot (alongside installAttachHandlers). */
export function installPanelHost(): void {
  registerRelayHandler("panel.open", async (params) => {
    const p = params as { url?: string; width?: number; height?: number; quality?: number } | null;
    return openPanel({
      url: String(p?.url ?? ""),
      width: Number(p?.width) || 1280,
      height: Number(p?.height) || 800,
      quality: Math.min(100, Math.max(1, Number(p?.quality) || 70)),
    });
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
    const source = sources.get(String(p?.panelId ?? ""));
    if (!source) return { open: false };
    return { open: true, ...source.stats() };
  });

  // Phase 2 — WebRTC signaling rides the same relay. panel.webrtc carries the
  // client's hello/answer/ice; the desktop is the peer. When werift/ffmpeg are
  // unavailable this is a no-op and the JPEG path above carries on unchanged.
  registerRelayHandler("panel.webrtc", async (params) => {
    const p = params as { panelId?: string; signal?: unknown } | null;
    const panelId = String(p?.panelId ?? "");
    const source = sources.get(panelId);
    if (!source) throw new Error(`panel ${panelId} is not open`);
    if (!isWebrtcSignal(p?.signal)) throw new Error("panel.webrtc requires a { signal }");
    if ((p!.signal as { type?: string }).type === "hello") {
      return maybeStartWebrtc(panelId, source, (data) => push(panelId, data));
    }
    return handleWebrtcSignal(panelId, p!.signal);
  });
}

/** Tear every panel down (app quit). */
export function closeAllPanels(): void {
  for (const id of [...sources.keys()]) void closePanel(id);
}
