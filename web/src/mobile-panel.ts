/**
 * mobile-panel.ts — the MOBILE port of the WEB renderer's streamed-panel client
 * (src/renderer/panel-stream.ts). It opens a page ON the user's attached desktop
 * over the `/ws/panel` relay socket, renders the relayed video (WebRTC track when
 * it flows, base64-JPEG canvas as the always-on floor), and drives it with FULL
 * TOUCH input translated into the desktop's `panel.input` vocabulary.
 *
 * It is a hand port, not an import: the renderer component captures MOUSE
 * events; a phone has none, so pointer drive is touch-translated here. Text
 * entry IS shared — the hidden key proxy (src/renderer/panel-kb.ts, mounted by
 * both surfaces) is what lets the virtual keyboard type into a REMOTE field:
 * a tap focuses it (the user gesture iOS requires to raise the keyboard), and
 * it forwards committed text/keys/paste over panel.input. Everything else —
 * the wire protocol (`{t:"req",id,method,params}` req/res,
 * `{t:"push",channel,data}` frames), the WebRTC offer/answer/ice flow, the
 * JPEG floor, the transport swap, the coord scaling (touch → intrinsic stream
 * pixels) — matches panel-stream.ts and the desktop host
 * (src/main/panel-host.ts / panel-webrtc.ts) exactly.
 *
 * The module is framework-free (pure DOM); the React tray (mobile.tsx) mounts the
 * returned `.el` into a holder and reads the connection `state` for its overlay.
 */

import { mountPanelKb } from "../../src/renderer/panel-kb";

// ── the SDK handle the web bridge exposes (window.glyphhSdk) ─────────────────

interface SdkAttachStatus { attached: boolean; machines?: unknown[] }
interface SdkClient {
  token(): Promise<string | null>;
  attach: { status(): Promise<SdkAttachStatus> };
}

function sdk(): SdkClient | null {
  return (window as unknown as { glyphhSdk?: SdkClient }).glyphhSdk ?? null;
}

/** The API origin the web target boots against (bridge stamps it before us). */
function apiUrl(): string {
  const w = window as unknown as { __GLYPHH_API_URL__?: string; API_URL?: string };
  return (w.__GLYPHH_API_URL__ || w.API_URL || "https://api.glyphh.ai").replace(/\/$/, "");
}

/** ws(s):// base for /ws/panel, derived from the API origin. */
function panelWsUrl(token: string): string {
  const base = apiUrl().replace(/^http/, "ws");
  return `${base}/ws/panel?token=${encodeURIComponent(token)}`;
}

// ── wire shapes (mirror src/main/panel-host.ts + panel-webrtc.ts) ────────────

interface FramePush { type: "frame"; data: string; format: "jpeg"; meta: { deviceWidth: number; deviceHeight: number }; at: number }
interface NavPush { type: "nav"; url: string; title: string }
interface OfferPush { type: "offer"; sdp: string }
interface IcePush { type: "ice"; candidate: { candidate: string; sdpMid?: string | null; sdpMLineIndex?: number | null } | null }
interface TransportPush { type: "transport"; transport: "webrtc" | "screencast"; reason: string }
type PanelPush = FramePush | NavPush | OfferPush | IcePush | TransportPush | { type?: string };

/** Coarse lifecycle the React tray renders as an overlay (mirrors the web
 *  panel's "Connecting…" / "Desktop disconnected — Try again" states). */
export type PanelState =
  | "connecting"      // opening the socket + panel
  | "live"            // frames flowing — overlay hidden
  | "signed-out"      // no SDK / no token
  | "desktop-offline" // attach.status() says no desktop
  | "disconnected"    // socket dropped after being live
  | "failed";         // panel.open threw

export interface MobilePanelOptions {
  url: string;
  quality?: number;
  webrtc?: boolean;
  /** Called on every state change so the tray can paint its overlay. */
  onState?: (state: PanelState, detail?: string) => void;
  /** Top-frame navigation on the far side (drives the tray's title). */
  onNav?: (url: string, title: string) => void;
}

export interface MobilePanelHandle {
  /** The root element (the <video>+<canvas> surface) to place in the tray. */
  readonly el: HTMLElement;
  state(): PanelState;
  currentUrl(): string;
  /** Re-run the whole connect sequence (the "Try again" button). */
  retry(): void;
  /** Best-effort user-gesture play, for iOS autoplay-blocked video. */
  resumePlay(): void;
  /** Tear down: close the panel far-side + the socket/peer. Idempotent. */
  dispose(): void;
}

const RPC_TIMEOUT_MS = 15_000;

export function mountMobilePanel(opts: MobilePanelOptions): MobilePanelHandle {
  const root = document.createElement("div");
  root.className = "m-panel-surface";
  root.style.cssText = "position:relative;width:100%;height:100%;overflow:hidden;background:#000;touch-action:none;";

  // JPEG floor (always present) + the WebRTC <video> layered over it once media
  // flows. iOS Safari needs playsinline + muted for inline autoplay.
  const canvas = document.createElement("canvas");
  canvas.width = 1280; canvas.height = 800;
  canvas.style.cssText = "position:absolute;inset:0;width:100%;height:100%;object-fit:contain;background:#000;";
  const video = document.createElement("video");
  video.autoplay = true; video.muted = true; (video as HTMLVideoElement).playsInline = true;
  video.setAttribute("playsinline", ""); video.setAttribute("webkit-playsinline", "");
  video.style.cssText = "position:absolute;inset:0;width:100%;height:100%;object-fit:contain;background:#000;display:none;pointer-events:none;";
  root.append(canvas, video);

  const ctx = canvas.getContext("2d");
  let ws: WebSocket | null = null;
  let panelId: string | null = null;
  let disposed = false;
  let seq = 0;
  const pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  let transport: "webrtc" | "screencast" = "screencast";
  let lastUrl = opts.url;
  let pc: RTCPeerConnection | null = null;
  let everLive = false;
  let state: PanelState = "connecting";

  function setState(s: PanelState, detail?: string): void {
    state = s;
    opts.onState?.(s, detail);
  }

  function call(method: string, params: unknown): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (!ws || ws.readyState !== WebSocket.OPEN) { reject(new Error("panel socket not open")); return; }
      const id = "w" + (++seq);
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`panel.${method} timed out`)); }, RPC_TIMEOUT_MS);
      pending.set(id, { resolve, reject, timer });
      try { ws.send(JSON.stringify({ t: "req", id, method, params })); }
      catch (err) { clearTimeout(timer); pending.delete(id); reject(err as Error); }
    });
  }
  /** Fire-and-forget request (input events don't need a reply). */
  function send(method: string, params: unknown): void {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    try { ws.send(JSON.stringify({ t: "req", id: "i" + (++seq), method, params })); } catch { /* dropped */ }
  }

  // ── frame + control handling ───────────────────────────────────────────────
  function onPush(d: PanelPush): void {
    switch (d.type) {
      case "frame": return drawFrame(d as FramePush);
      case "nav": {
        const nav = d as NavPush;
        lastUrl = nav.url || lastUrl;
        opts.onNav?.(nav.url || "", nav.title || "");
        return;
      }
      case "offer": return void onOffer(d as OfferPush);
      case "ice": return void onRemoteIce(d as IcePush);
      case "transport": return onTransport(d as TransportPush);
    }
  }

  function markLive(): void {
    if (!everLive) { everLive = true; }
    if (state !== "live") setState("live");
  }

  function drawFrame(f: FramePush): void {
    if (transport === "webrtc") return; // video carries media; decoding JPEG is waste
    const img = new Image();
    img.onload = () => {
      if (disposed) return;
      if (canvas.width !== img.width || canvas.height !== img.height) { canvas.width = img.width; canvas.height = img.height; }
      ctx?.drawImage(img, 0, 0);
      markLive();
    };
    img.src = "data:image/jpeg;base64," + f.data;
  }

  function onTransport(t: TransportPush): void {
    transport = t.transport;
    if (transport === "webrtc") { video.style.display = ""; }
    else { video.style.display = "none"; video.srcObject = null; }
  }

  // ── WebRTC as the client peer (identical flow to panel-stream.ts) ───────────
  async function startWebrtc(): Promise<void> {
    if (opts.webrtc === false) return;
    if (typeof RTCPeerConnection === "undefined") return;
    try { await call("panel.webrtc", { panelId, signal: { type: "hello", webrtc: true, codecs: ["h264"] } }); }
    catch { /* stay on screencast */ }
  }

  async function onOffer(o: OfferPush): Promise<void> {
    try {
      const peer = new RTCPeerConnection({ iceServers: clientIceServers() });
      pc = peer;
      peer.ontrack = (ev) => {
        if (ev.streams[0]) video.srcObject = ev.streams[0];
        void video.play().then(markLive).catch(() => { /* iOS may block until a tap → resumePlay */ });
      };
      peer.onicecandidate = (ev) => { send("panel.webrtc", { panelId, signal: { type: "ice", candidate: ev.candidate ? ev.candidate.toJSON() : null } }); };
      peer.onconnectionstatechange = () => {
        if (peer.connectionState === "failed" || peer.connectionState === "disconnected") {
          transport = "screencast"; video.style.display = "none";
        }
      };
      await peer.setRemoteDescription({ type: "offer", sdp: o.sdp });
      const answer = await peer.createAnswer();
      await peer.setLocalDescription(answer);
      send("panel.webrtc", { panelId, signal: { type: "answer", sdp: answer.sdp } });
    } catch { /* stay on screencast */ }
  }

  async function onRemoteIce(m: IcePush): Promise<void> {
    if (!pc) return;
    try { await pc.addIceCandidate(m.candidate ?? undefined); } catch { /* trickle noise */ }
  }

  function clientIceServers(): RTCIceServer[] {
    const raw = (window as unknown as { __GLYPHH_ICE_SERVERS__?: string }).__GLYPHH_ICE_SERVERS__ || "";
    return raw.split(",").map((s) => s.trim()).filter(Boolean).map((entry) => {
      const m = /^(turns?):([^:@]+):([^@]+)@(.+)$/.exec(entry);
      if (m) return { urls: `${m[1]}:${m[4]}`, username: m[2], credential: m[3] };
      return { urls: entry };
    });
  }

  // ── touch capture → panel.input ─────────────────────────────────────────────
  // Map a touch point (client px) → panel/stream pixels using the SAME rect-ratio
  // scaling panel-stream.ts uses for the mouse: the surface object-fit:contains,
  // so we scale by the intrinsic media size over the element's box. The intrinsic
  // size is the <video>'s videoWidth/Height when WebRTC carries media, else the
  // canvas's decoded frame size (both track the desktop's real device size).
  function surfaceSize(): { w: number; h: number } {
    if (transport === "webrtc" && video.videoWidth > 0) return { w: video.videoWidth, h: video.videoHeight };
    return { w: canvas.width, h: canvas.height };
  }
  /** object-fit:contain letterboxes; project the touch through the drawn rect so
   *  a tap in the black bars maps to the nearest edge, not off-panel. */
  function toPanel(clientX: number, clientY: number): { x: number; y: number } {
    const r = root.getBoundingClientRect();
    const { w: sw, h: sh } = surfaceSize();
    const scale = Math.min(r.width / sw, r.height / sh);   // contain
    const drawnW = sw * scale, drawnH = sh * scale;
    const offX = (r.width - drawnW) / 2, offY = (r.height - drawnH) / 2;
    const x = (clientX - r.left - offX) / scale;
    const y = (clientY - r.top - offY) / scale;
    return { x: Math.max(0, Math.min(sw, x)), y: Math.max(0, Math.min(sh, y)) };
  }
  function input(event: Record<string, unknown>): void { if (panelId) send("panel.input", { panelId, event }); }

  // ── keyboard: the shared hidden key proxy (src/renderer/panel-kb.ts) ────────
  // iOS raises a virtual keyboard only for a focused local editable, and its
  // soft keyboard delivers text via beforeinput/composition rather than real
  // keydowns — the proxy captures both and forwards insertText batches plus
  // named special keys (the desktop derives VK codes). Copy/cut round-trip the
  // far page's selection back onto THIS device's clipboard.
  const kb = mountPanelKb(root, {
    key: (ev) => input(ev as unknown as Record<string, unknown>),
    insertText: (text) => input({ type: "insertText", text }),
    clipboard: (action) => { void remoteClipboard(action); },
  });
  async function remoteClipboard(action: "copy" | "cut"): Promise<void> {
    if (!panelId) return;
    try {
      const r = (await call("panel.clipboard", { panelId, action })) as { text?: string };
      if (r?.text) await navigator.clipboard?.writeText(r.text);
    } catch { /* nothing selected, or clipboard needs a fresher gesture — nothing to land */ }
  }

  // Gesture state machine. One finger = pointer (tap→click, drag→down/move/up,
  // hold→right-click). Two fingers = wheel/scroll (no button held). We send
  // move+down synthetically so text selection and drag-drop work on the far page.
  let touchMode: "none" | "pointer" | "scroll" = "none";
  let downSent = false;
  let startX = 0, startY = 0, lastX = 0, lastY = 0;
  let startT = 0;
  let longPressTimer: number | null = null;
  let longPressed = false;
  let scrollX = 0, scrollY = 0;   // last two-finger centroid (for wheel deltas)
  const TAP_SLOP = 8;             // px of movement still counted as a tap
  const LONG_PRESS_MS = 500;

  function clearLongPress(): void { if (longPressTimer) { clearTimeout(longPressTimer); longPressTimer = null; } }

  root.addEventListener("touchstart", (e) => {
    e.preventDefault();
    resumePlay();   // a touch is a user gesture — unblock iOS autoplay if it stuck
    if (e.touches.length === 1 && touchMode === "none") {
      touchMode = "pointer"; longPressed = false; downSent = false;
      const t = e.touches[0];
      const p = toPanel(t.clientX, t.clientY);
      startX = lastX = p.x; startY = lastY = p.y; startT = Date.now();
      // Move the cursor there first (hover targets), then arm the long-press.
      input({ type: "mouse", action: "move", x: p.x, y: p.y, buttons: 0, mods: 0 });
      clearLongPress();
      longPressTimer = window.setTimeout(() => {
        // Long-press → right-click at the origin. Suppress the later tap/drag.
        longPressed = true;
        input({ type: "mouse", action: "down", x: startX, y: startY, button: "right", buttons: 2, mods: 0, clickCount: 1 });
        input({ type: "mouse", action: "up", x: startX, y: startY, button: "right", buttons: 0, mods: 0, clickCount: 1 });
      }, LONG_PRESS_MS);
    } else if (e.touches.length >= 2) {
      // Escalate to a two-finger scroll; cancel any pending pointer/long-press and
      // release a held button so a half-started drag doesn't strand the mouse down.
      clearLongPress();
      if (downSent) { input({ type: "mouse", action: "up", x: lastX, y: lastY, button: "left", buttons: 0, mods: 0, clickCount: 1 }); downSent = false; }
      touchMode = "scroll";
      const c = centroid(e.touches);
      scrollX = c.x; scrollY = c.y;
    }
  }, { passive: false });

  root.addEventListener("touchmove", (e) => {
    e.preventDefault();
    if (touchMode === "pointer" && e.touches.length === 1) {
      const t = e.touches[0];
      const p = toPanel(t.clientX, t.clientY);
      const moved = Math.hypot(p.x - startX, p.y - startY);
      if (!longPressed && moved > TAP_SLOP && !downSent) {
        // Past the slop → this is a drag, not a tap. Press now, then track.
        clearLongPress();
        input({ type: "mouse", action: "down", x: startX, y: startY, button: "left", buttons: 1, mods: 0, clickCount: 1 });
        downSent = true;
      }
      lastX = p.x; lastY = p.y;
      input({ type: "mouse", action: "move", x: p.x, y: p.y, buttons: downSent ? 1 : 0, mods: 0 });
    } else if (touchMode === "scroll" && e.touches.length >= 2) {
      const c = centroid(e.touches);
      // Natural scroll: dragging content DOWN reveals content ABOVE → positive
      // wheel dy scrolls down, so invert the finger delta.
      const dx = scrollX - c.x, dy = scrollY - c.y;
      scrollX = c.x; scrollY = c.y;
      const p = toPanel(c.x, c.y);
      if (dx || dy) input({ type: "wheel", x: p.x, y: p.y, dx, dy, mods: 0 });
    }
  }, { passive: false });

  function endTouch(e: TouchEvent): void {
    e.preventDefault();
    if (touchMode === "pointer") {
      clearLongPress();
      if (longPressed) { /* right-click already fired */ }
      else if (downSent) {
        // End the drag.
        input({ type: "mouse", action: "up", x: lastX, y: lastY, button: "left", buttons: 0, mods: 0, clickCount: 1 });
      } else {
        // A tap: full down→up click at the origin.
        const quick = Date.now() - startT < 700;
        if (quick) {
          input({ type: "mouse", action: "down", x: startX, y: startY, button: "left", buttons: 1, mods: 0, clickCount: 1 });
          input({ type: "mouse", action: "up", x: startX, y: startY, button: "left", buttons: 0, mods: 0, clickCount: 1 });
          // The tap IS the user gesture iOS demands: focus the hidden key proxy
          // NOW so a tapped remote field can be typed into (there is no local
          // editable to focus — the page lives on the desktop).
          kb.focus();
        }
      }
    }
    // Only reset once every finger is up (a lifted second finger mid-scroll keeps
    // the gesture alive on the remaining touches otherwise).
    if (e.touches.length === 0) { touchMode = "none"; downSent = false; longPressed = false; }
    else if (touchMode === "scroll" && e.touches.length < 2) { touchMode = "none"; }
  }
  root.addEventListener("touchend", endTouch, { passive: false });
  root.addEventListener("touchcancel", endTouch, { passive: false });

  function centroid(touches: TouchList): { x: number; y: number } {
    let x = 0, y = 0;
    for (let i = 0; i < touches.length; i++) { x += touches[i].clientX; y += touches[i].clientY; }
    return { x: x / touches.length, y: y / touches.length };
  }

  // Resize: report the surface box to the far side so it renders at the phone's
  // aspect (debounced — an orientation change or a keyboard shouldn't storm it).
  let resizeTimer: ReturnType<typeof setTimeout> | null = null;
  const ro = new ResizeObserver(() => {
    if (resizeTimer) clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      if (!panelId) return;
      const r = root.getBoundingClientRect();
      const width = Math.max(1, Math.round(r.width));
      const height = Math.max(1, Math.round(r.height));
      if (width > 1 && height > 1) input({ type: "resize", width, height });
    }, 220);
  });
  ro.observe(root);

  // ── connect + open ───────────────────────────────────────────────────────────
  async function boot(): Promise<void> {
    // A retry after a drop closes the old socket first.
    if (ws) { try { ws.close(); } catch { /* noop */ } ws = null; }
    panelId = null; everLive = false;
    const client = sdk();
    if (!client) { setState("signed-out"); return; }
    setState("connecting");

    let attached = false;
    try { attached = (await client.attach.status()).attached; } catch { attached = false; }
    if (disposed) return;
    if (!attached) { setState("desktop-offline"); return; }

    const token = await client.token().catch(() => null);
    if (disposed) return;
    if (!token) { setState("signed-out"); return; }

    await connect(token);
  }

  function connect(token: string): Promise<void> {
    return new Promise((resolve) => {
      const socket = new WebSocket(panelWsUrl(token));
      ws = socket;
      socket.onopen = async () => {
        try {
          const box = root.getBoundingClientRect();
          const w0 = Math.max(1, Math.round(box.width)) || canvas.width;
          const h0 = Math.max(1, Math.round(box.height)) || canvas.height;
          const r = (await call("panel.open", { url: opts.url, width: w0, height: h0, quality: opts.quality ?? 60 })) as { panelId: string };
          panelId = r.panelId;
          const after = root.getBoundingClientRect();
          const w1 = Math.max(1, Math.round(after.width));
          const h1 = Math.max(1, Math.round(after.height));
          if ((w1 !== w0 || h1 !== h0) && w1 > 1 && h1 > 1) input({ type: "resize", width: w1, height: h1 });
          void startWebrtc();
          // Frames flip us to "live"; stay on "connecting" until the first paints.
        } catch (err) {
          setState("failed", (err as Error).message || undefined);
        }
        resolve();
      };
      socket.onclose = () => { if (!disposed) setState(everLive ? "disconnected" : "failed"); };
      socket.onerror = () => { /* onclose follows */ };
      socket.onmessage = (ev) => {
        let f: { t?: string; id?: string; ok?: boolean; result?: unknown; error?: string; channel?: string; data?: PanelPush };
        try { f = JSON.parse(String(ev.data)); } catch { return; }
        if (f.t === "res" && typeof f.id === "string") {
          const p = pending.get(f.id); if (!p) return; pending.delete(f.id); clearTimeout(p.timer);
          f.ok ? p.resolve(f.result) : p.reject(new Error(f.error || "panel error"));
        } else if (f.t === "push" && f.channel === panelId && f.data) {
          onPush(f.data);
        }
      };
    });
  }

  function resumePlay(): void {
    if (transport === "webrtc") void video.play().catch(() => { /* still blocked */ });
  }

  void boot();

  function dispose(): void {
    if (disposed) return;
    disposed = true;
    clearLongPress();
    kb.dispose();
    try { ro.disconnect(); } catch { /* noop */ }
    if (resizeTimer) clearTimeout(resizeTimer);
    for (const [, p] of pending) { clearTimeout(p.timer); p.reject(new Error("panel disposed")); }
    pending.clear();
    try { pc?.close(); } catch { /* noop */ }
    pc = null;
    if (panelId && ws && ws.readyState === WebSocket.OPEN) {
      try { ws.send(JSON.stringify({ t: "req", id: "close" + (++seq), method: "panel.close", params: { panelId } })); } catch { /* noop */ }
    }
    setTimeout(() => { try { ws?.close(); } catch { /* noop */ } }, 100);
  }

  return {
    el: root,
    state: () => state,
    currentUrl: () => lastUrl,
    retry: () => { if (!disposed) void boot(); },
    resumePlay,
    dispose,
  };
}
