/**
 * panel-stream.ts — the WEB renderer's streamed-panel component.
 *
 * On the desktop an app panel is a native <webview>. On the WEB, a <webview>
 * does nothing (it is Electron-only), so when the user is on web AND their
 * desktop is attached, this component is the drop-in replacement: it opens a
 * page ON the desktop (over the attach relay) and renders it here — a canvas of
 * relayed JPEG frames (phase 1) or a WebRTC <video> track (phase 2), with full
 * mouse/keyboard/wheel/resize input sent back. When the desktop is NOT attached
 * it renders an honest "connect your desktop to view this live" state instead of
 * a dead rectangle.
 *
 * SOURCE-AGNOSTIC: this component talks ONLY to the relay's panel.* surface and
 * the frame/nav/webrtc push shapes. It has no idea whether the frames originate
 * on the user's desktop or (later) a session pod — the same component renders
 * either, because the desktop and a pod satisfy the identical PanelSource
 * contract on the far side (see src/main/panel-source.ts). Nothing here changes
 * when a pod source lands.
 *
 * Transport selection (phase 2): the component ALWAYS starts on the JPEG canvas
 * (it works everywhere), sends `hello{webrtc:true}`, and if the desktop answers
 * with an offer and media flows, swaps the canvas for the <video>. If WebRTC
 * can't connect (no TURN, blocked UDP, werift/ffmpeg absent on the desktop) the
 * desktop tells it `transport:"screencast"` and the JPEG path — which never
 * stopped — carries on. A small badge surfaces which transport is live.
 */

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
  const w = window as unknown as { __GLYPHH_API_URL__?: string };
  return (w.__GLYPHH_API_URL__ || "https://api.glyphh.ai").replace(/\/$/, "");
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

export interface StreamedPanelOptions {
  url: string;
  /** Preferred capture quality 1–100 (JPEG path). */
  quality?: number;
  /** Try to negotiate WebRTC (phase 2). Default true; the JPEG path is the
   *  automatic fallback, so turning this off just forces JPEG. */
  webrtc?: boolean;
  /** Top-frame navigation on the far side (drives the caller's address bar). */
  onNav?: (url: string, title: string) => void;
}

export interface StreamedPanelHandle {
  /** The root element to place in the panel holder. */
  readonly el: HTMLElement;
  /** Which transport is currently carrying video. */
  transport(): "webrtc" | "screencast";
  /** Drive the far page: address-bar navigation + history + reload. */
  navigate(url: string): void;
  back(): void;
  forward(): void;
  reload(): void;
  /** The far page's current top-frame URL (last nav push). */
  currentUrl(): string;
  /** Tear down: close the panel on the far side + the sockets/peer. Idempotent. */
  dispose(): void;
}

const RPC_TIMEOUT_MS = 15_000;

/**
 * Mount a streamed panel into a fresh element. Returns immediately with a handle
 * whose `.el` can be appended anywhere; the connect + open happen asynchronously
 * and surface their state in the UI. `dispose()` (or the element being removed
 * from the DOM — we self-observe) tears everything down.
 */
export function mountStreamedPanel(opts: StreamedPanelOptions): StreamedPanelHandle {
  const root = document.createElement("div");
  root.className = "streamed-panel";
  root.style.cssText = "position:relative;width:100%;height:100%;background:var(--bg-2, transparent);overflow:hidden;display:flex;flex-direction:column;";

  // The video surfaces. Canvas is always present (JPEG floor); the <video> is
  // shown only once WebRTC media flows, layered over the canvas.
  const canvas = document.createElement("canvas");
  canvas.width = 1280; canvas.height = 800; canvas.tabIndex = 0;
  canvas.style.cssText = "flex:1;min-height:0;width:100%;height:100%;object-fit:contain;background:transparent;outline:none;cursor:default;";
  const video = document.createElement("video");
  video.autoplay = true; video.muted = true; (video as HTMLVideoElement).playsInline = true;
  video.style.cssText = "position:absolute;inset:0;width:100%;height:100%;object-fit:contain;background:transparent;display:none;pointer-events:none;";

  const overlay = document.createElement("div");
  overlay.className = "streamed-panel-overlay";
  overlay.style.cssText = "position:absolute;inset:0;display:flex;align-items:center;justify-content:center;flex-direction:column;gap:10px;color:var(--text-2, #ccc);font:13px system-ui,sans-serif;text-align:center;padding:24px;z-index:3;";

  root.append(canvas, video, overlay);

  const ctx = canvas.getContext("2d");
  let ws: WebSocket | null = null;
  let panelId: string | null = null;
  let disposed = false;
  let seq = 0;
  const pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  let transport: "webrtc" | "screencast" = "screencast";
  let lastUrl = opts.url;
  let pc: RTCPeerConnection | null = null;

  function setOverlay(html: string | null): void {
    if (html == null) { overlay.style.display = "none"; overlay.innerHTML = ""; return; }
    overlay.style.display = "flex";
    overlay.innerHTML = html;
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
        const nav = push as NavPush;
        lastUrl = nav.url || lastUrl;
        opts.onNav?.(nav.url || "", nav.title || "");
        return;
      }
      case "offer": return void onOffer(d as OfferPush);
      case "ice": return void onRemoteIce(d as IcePush);
      case "transport": return onTransport(d as TransportPush);
    }
  }

  function drawFrame(f: FramePush): void {
    // While WebRTC carries media the canvas is hidden; keep decoding is wasteful.
    if (transport === "webrtc") return;
    const img = new Image();
    img.onload = () => {
      if (disposed) return;
      if (canvas.width !== img.width || canvas.height !== img.height) { canvas.width = img.width; canvas.height = img.height; }
      ctx?.drawImage(img, 0, 0);
    };
    img.src = "data:image/jpeg;base64," + f.data;
  }

  function onTransport(t: TransportPush): void {
    transport = t.transport;
    if (transport === "webrtc") { video.style.display = ""; canvas.style.pointerEvents = "none"; }
    else { video.style.display = "none"; video.srcObject = null; canvas.style.pointerEvents = ""; }
  }

  // ── phase 2: WebRTC as the client peer ─────────────────────────────────────
  async function startWebrtc(): Promise<void> {
    if (opts.webrtc === false) return;
    if (typeof RTCPeerConnection === "undefined") return;
    // Tell the desktop we can do WebRTC; it answers with an offer if it can too.
    // ICE servers for the CLIENT side come from the same env-config surface as
    // the desktop; the browser learns STUN/TURN from the offer's a=candidate
    // lines + its own config. We pass none here (the desktop announces its
    // reachable candidates); a TURN-only network still works because the desktop
    // offers its relay candidate.
    try { await call("panel.webrtc", { panelId, signal: { type: "hello", webrtc: true, codecs: ["h264"] } }); }
    catch { /* stay on screencast */ }
  }

  async function onOffer(o: OfferPush): Promise<void> {
    try {
      const peer = new RTCPeerConnection({ iceServers: clientIceServers() });
      pc = peer;
      peer.ontrack = (ev) => { if (ev.streams[0]) video.srcObject = ev.streams[0]; void video.play().catch(() => {}); };
      peer.onicecandidate = (ev) => { send("panel.webrtc", { panelId, signal: { type: "ice", candidate: ev.candidate ? ev.candidate.toJSON() : null } }); };
      peer.onconnectionstatechange = () => {
        if (peer.connectionState === "failed" || peer.connectionState === "disconnected") {
          // Desktop's decideTransport will also fail us over; hiding the video
          // here makes the canvas visible again immediately.
          transport = "screencast"; video.style.display = "none"; canvas.style.pointerEvents = ""; setBadge();
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

  /** Client-side ICE servers, config-driven (window.__GLYPHH_ICE_SERVERS__ =
   *  "stun:…,turn:user:pass@host:3478"). Empty by default — the desktop
   *  announces its own reachable candidates; a TURN is only needed when BOTH
   *  peers are NAT'd (see the report). */
  function clientIceServers(): RTCIceServer[] {
    const raw = (window as unknown as { __GLYPHH_ICE_SERVERS__?: string }).__GLYPHH_ICE_SERVERS__ || "";
    return raw.split(",").map((s) => s.trim()).filter(Boolean).map((entry) => {
      const m = /^(turns?):([^:@]+):([^@]+)@(.+)$/.exec(entry);
      if (m) return { urls: `${m[1]}:${m[4]}`, username: m[2], credential: m[3] };
      return { urls: entry };
    });
  }

  // ── input capture → panel.input ────────────────────────────────────────────
  function pt(e: MouseEvent | WheelEvent): { x: number; y: number } {
    const r = canvas.getBoundingClientRect();
    return { x: (e.clientX - r.left) * (canvas.width / r.width), y: (e.clientY - r.top) * (canvas.height / r.height) };
  }
  function modBits(e: MouseEvent | KeyboardEvent | WheelEvent): number {
    return (e.altKey ? 1 : 0) | (e.ctrlKey ? 2 : 0) | (e.metaKey ? 4 : 0) | (e.shiftKey ? 8 : 0);
  }
  const BTN = ["left", "middle", "right"] as const;
  function input(event: Record<string, unknown>): void { if (panelId) send("panel.input", { panelId, event }); }

  canvas.addEventListener("mousemove", (e) => { const { x, y } = pt(e); input({ type: "mouse", action: "move", x, y, buttons: e.buttons, mods: modBits(e) }); });
  canvas.addEventListener("mousedown", (e) => { canvas.focus(); const { x, y } = pt(e); input({ type: "mouse", action: "down", x, y, button: BTN[e.button] ?? "left", buttons: e.buttons, mods: modBits(e), clickCount: e.detail || 1 }); });
  canvas.addEventListener("mouseup", (e) => { const { x, y } = pt(e); input({ type: "mouse", action: "up", x, y, button: BTN[e.button] ?? "left", buttons: e.buttons, mods: modBits(e), clickCount: e.detail || 1 }); });
  canvas.addEventListener("contextmenu", (e) => e.preventDefault());
  canvas.addEventListener("wheel", (e) => { e.preventDefault(); const { x, y } = pt(e); input({ type: "wheel", x, y, dx: e.deltaX, dy: e.deltaY, mods: modBits(e) }); }, { passive: false });
  canvas.addEventListener("keydown", (e) => { e.preventDefault(); const text = e.key.length === 1 ? e.key : ""; input({ type: "key", action: "down", key: e.key, code: e.code, text, mods: modBits(e) }); });
  canvas.addEventListener("keyup", (e) => { e.preventDefault(); input({ type: "key", action: "up", key: e.key, code: e.code, mods: modBits(e) }); });

  // Resize: when the element's box changes, tell the far side to re-render at the
  // new device size (debounced to avoid a cast-restart storm during a drag).
  let resizeTimer: ReturnType<typeof setTimeout> | null = null;
  const ro = new ResizeObserver(() => {
    if (resizeTimer) clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      if (!panelId) return;
      const r = canvas.getBoundingClientRect();
      const width = Math.max(1, Math.round(r.width));
      const height = Math.max(1, Math.round(r.height));
      input({ type: "resize", width, height });
    }, 200);
  });
  ro.observe(root);

  // ── connect + open ─────────────────────────────────────────────────────────
  async function boot(): Promise<void> {
    const client = sdk();
    if (!client) { setOverlay(offlineHtml("Sign in to view this panel.")); return; }
    setOverlay(`<div>Connecting to your desktop…</div>`);

    // Honest offline state: check attach BEFORE opening a socket.
    let attached = false;
    try { attached = (await client.attach.status()).attached; } catch { attached = false; }
    if (disposed) return;
    if (!attached) { setOverlay(offlineHtml("Connect your desktop to view this live.")); return; }

    const token = await client.token().catch(() => null);
    if (disposed) return;
    if (!token) { setOverlay(offlineHtml("Sign in to view this panel.")); return; }

    await connect(token);
  }

  function connect(token: string): Promise<void> {
    return new Promise((resolve) => {
      const socket = new WebSocket(panelWsUrl(token));
      ws = socket;
      socket.onopen = async () => {
        try {
          // Open at the element's REAL box, not the canvas's 1280x800 default —
          // otherwise the page renders at the wrong size until the user happens
          // to resize (the ResizeObserver drops events while panelId is null).
          const box = root.getBoundingClientRect();
          const w0 = Math.max(1, Math.round(box.width)) || canvas.width;
          const h0 = Math.max(1, Math.round(box.height)) || canvas.height;
          const r = (await call("panel.open", { url: opts.url, width: w0, height: h0, quality: opts.quality ?? 70 })) as { panelId: string };
          panelId = r.panelId;
          // Layout may have settled while the socket/open round-tripped — sync
          // once now that resize events are deliverable.
          const after = root.getBoundingClientRect();
          const w1 = Math.max(1, Math.round(after.width));
          const h1 = Math.max(1, Math.round(after.height));
          if ((w1 !== w0 || h1 !== h0) && w1 > 1 && h1 > 1) input({ type: "resize", width: w1, height: h1 });
          setOverlay(null);
          canvas.focus();
          void startWebrtc();
        } catch (err) {
          setOverlay(offlineHtml((err as Error).message || "Could not open the panel."));
        }
        resolve();
      };
      socket.onclose = () => { if (!disposed) setOverlay(offlineHtml("Desktop disconnected.")); };
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

  function offlineHtml(msg: string): string {
    return `<div style="font-size:15px;color:#eee">${escapeHtml(msg)}</div>
      <div style="max-width:320px;color:#888">This app runs in your own browser session on your desktop. Open the Glyphh desktop app and sign in, then reopen this panel.</div>`;
  }

  void boot();

  function dispose(): void {
    if (disposed) return;
    disposed = true;
    try { ro.disconnect(); } catch { /* noop */ }
    if (resizeTimer) clearTimeout(resizeTimer);
    for (const [, p] of pending) { clearTimeout(p.timer); p.reject(new Error("panel disposed")); }
    pending.clear();
    try { pc?.close(); } catch { /* noop */ }
    pc = null;
    // Best-effort close on the far side, then the socket.
    if (panelId && ws && ws.readyState === WebSocket.OPEN) {
      try { ws.send(JSON.stringify({ t: "req", id: "close" + (++seq), method: "panel.close", params: { panelId } })); } catch { /* noop */ }
    }
    setTimeout(() => { try { ws?.close(); } catch { /* noop */ } }, 100);
  }

  const navCall = (action: "url" | "back" | "forward" | "reload", url?: string): void => {
    if (!panelId) return;
    void call("panel.nav", { panelId, action, url }).catch(() => { /* surfaced by nav push absence */ });
  };
  return {
    el: root,
    transport: () => transport,
    navigate: (url: string) => navCall("url", url),
    back: () => navCall("back"),
    forward: () => navCall("forward"),
    reload: () => navCall("reload"),
    currentUrl: () => lastUrl,
    dispose,
  };
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c] || c));
}
