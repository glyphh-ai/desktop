/**
 * panel-webrtc.ts — PHASE 2: the desktop becomes a WebRTC peer so panel video
 * leaves the control plane and goes P2P to the web client, at a fraction of the
 * base64-JPEG-over-WebSocket bandwidth.
 *
 * This is the desktop port of rrotor's Fly panel-pod WebRTC path (werift for
 * ICE/DTLS/SRTP, ffmpeg for the encode). The division of labour is identical to
 * the pod's, and it is the point of the design:
 *
 *   ffmpeg (native)  encodes to already-payloadized H.264 RTP
 *   werift (pure TS) does ICE, DTLS and SRTP and forwards those RTP packets
 *   this file        drives signaling over the attach relay, mirrors packets to
 *                    the peer, and decides when the client is really on WebRTC
 *
 * WHAT DIFFERS FROM THE POD — the capture input. The pod grabs an X display
 * (`ffmpeg -f x11grab`) because its Chromium paints into Xvfb. The DESKTOP has
 * no X display: the panel is an off-screen BrowserView whose pixels we already
 * pull as CDP JPEG frames (panel-host.ts). So here ffmpeg's INPUT is those JPEG
 * frames piped to its stdin (`-f image2pipe -c:v mjpeg -i pipe:0`); the OUTPUT
 * stage — H.264 baseline + zerolatency → RTP over loopback → werift track — is
 * the pod's verbatim (see {@link ffmpegArgs} in panel-webrtc-core.ts). Node still
 * never touches a pixel in JS: a JPEG buffer CDP already produced goes to ffmpeg
 * stdin, RTP comes back on a UDP socket and is handed to `track.writeRtp`.
 *
 * NOTHING HERE IS REQUIRED. werift is imported DYNAMICALLY; ffmpeg is located at
 * runtime. If werift is absent, ffmpeg is absent, ICE never completes, or the
 * encoder dies — every path ends in the same place: the client stays on the
 * phase-1 JPEG screencast it never stopped receiving, and a `transport` control
 * frame tells it which path is live. WebRTC is an optimisation over a transport
 * that already works; it is never a dependency (werift/ffmpeg are OPTIONAL deps).
 *
 * TURN: two NAT'd consumer peers (a desktop behind a home router and a browser
 * behind another) frequently cannot connect directly — STUN discovers a
 * reflexive address but symmetric NAT defeats it. A TURN relay is the fallback.
 * This module is TURN-READY but stands up no infra: `PANEL_ICE_SERVERS` (env)
 * supplies STUN/TURN URLs+creds, handed to werift. What must be DEPLOYED is in
 * the report; here we only consume the config.
 *
 * Secret hygiene: SDP and ICE candidate lines carry DTLS fingerprints and host
 * IPs and are NEVER logged.
 */

import { spawn, type ChildProcess } from "node:child_process";
import * as dgram from "node:dgram";
import type { PanelSource } from "./panel-source.js";
import { ElectronPanelSource } from "./panel-host.js";
import {
  parseSignal, decideTransport, configFromEnv, ffmpegArgs,
  type PanelIceCandidate, type WebrtcOut, type WebrtcConfig, type TransportDecision,
} from "./panel-webrtc-core.js";

// Re-export the pure surface panel-host + the relay speak against.
export { isWebrtcSignal, parseSignal, decideTransport } from "./panel-webrtc-core.js";
export type { WebrtcSignal, WebrtcOut, PanelTransport, TransportDecision } from "./panel-webrtc-core.js";

/** Resolve an ffmpeg binary: explicit env, else the optional `ffmpeg-static`
 *  package if installed, else "ffmpeg" on PATH. Never throws. */
async function resolveFfmpeg(explicit: string | undefined): Promise<string> {
  if (explicit) return explicit;
  try {
    // Variable specifier so tsc doesn't resolve the optional package at build
    // time — it's an OPTIONAL runtime dependency, not a build one.
    const spec = "ffmpeg-static";
    const mod = (await import(spec)) as unknown as { default?: string } | string;
    const p = typeof mod === "string" ? mod : mod.default;
    if (p) return p;
  } catch { /* not installed — fall through */ }
  return "ffmpeg";
}

// ── werift, loaded dynamically (never a hard dependency) ─────────────────────

interface WeriftTrack { writeRtp(packet: Buffer): void; stop(): void }
interface WeriftPc {
  connectionState: string;
  localDescription: { sdp: string } | null;
  connectionStateChange: { subscribe(fn: (s: string) => void): unknown };
  onIceCandidate: { subscribe(fn: (c: { candidate: string; sdpMid?: string; sdpMLineIndex?: number } | undefined) => void): unknown };
  addTransceiver(track: WeriftTrack, opts: { direction: string }): unknown;
  createOffer(): Promise<{ sdp: string }>;
  setLocalDescription(desc?: unknown): Promise<unknown>;
  setRemoteDescription(desc: { type: string; sdp: string }): Promise<void>;
  addIceCandidate(candidate: unknown): Promise<void>;
  close(): Promise<void>;
}
interface WeriftModule {
  RTCPeerConnection: new (config: Record<string, unknown>) => unknown;
  MediaStreamTrack: new (props: { kind: string }) => unknown;
  RTCRtpCodecParameters: new (props: Record<string, unknown>) => unknown;
}

let weriftPromise: Promise<WeriftModule | null> | null = null;
async function loadWerift(): Promise<WeriftModule | null> {
  if (!weriftPromise) {
    const spec = "werift";
    weriftPromise = import(spec).then((m) => m as unknown as WeriftModule).catch(() => null);
  }
  return weriftPromise;
}

// ── the JPEG → ffmpeg → RTP encoder ──────────────────────────────────────────

/**
 * Feeds the panel's CDP JPEG frames into ffmpeg and emits H.264 RTP packets.
 *
 * ffmpeg reads a JPEG stream on stdin and writes RTP to a loopback UDP socket;
 * we read that socket and hand packets to the consumer. RTP over loopback (not
 * stdout) is deliberate — ffmpeg's RTP muxer already does correct H.264
 * payloadization (fragmentation units, marker bits, timestamps), the one
 * genuinely error-prone part to re-derive in TS. We bind the RTCP sibling port
 * too so a datagram to a closed local port can't ECONNREFUSED the muxer.
 */
class JpegRtpEncoder {
  private proc: ChildProcess | null = null;
  private rtp: dgram.Socket | null = null;
  private rtcp: dgram.Socket | null = null;
  private consumer: ((packet: Buffer) => void) | null = null;
  bytesOut = 0;

  constructor(
    private readonly cfg: WebrtcConfig,
    private readonly width: number,
    private readonly height: number,
    private readonly onExit: (reason: string) => void,
  ) {}

  async start(onRtp: (packet: Buffer) => void): Promise<void> {
    this.consumer = onRtp;
    const ffmpeg = await resolveFfmpeg(this.cfg.ffmpegPath);
    const rtpPort = await this.bindLoopback();
    const proc = spawn(ffmpeg, ffmpegArgs(this.cfg, this.width, this.height, rtpPort), { stdio: ["pipe", "ignore", "pipe"] });
    this.proc = proc;
    proc.stderr?.on("data", () => { /* surfaced only on failure via onExit */ });
    proc.on("error", (err) => this.fail(`ffmpeg spawn failed: ${err.message}`));
    proc.on("exit", (code) => { if (code) this.fail(`ffmpeg exited (${code})`); });
    // If ffmpeg dies immediately (missing binary/codec), fail fast so the peer
    // falls back rather than waiting out the negotiation timeout.
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(resolve, 250);
      proc.once("exit", (code) => { clearTimeout(t); if (code) reject(new Error(`ffmpeg exited immediately (${code})`)); });
      proc.once("error", (err) => { clearTimeout(t); reject(err); });
    });
  }

  private bindLoopback(): Promise<number> {
    return new Promise((resolve, reject) => {
      const rtp = dgram.createSocket("udp4");
      this.rtp = rtp;
      rtp.on("message", (msg) => {
        this.bytesOut += msg.length;
        try { this.consumer?.(msg); } catch { /* consumer dropped */ }
      });
      rtp.on("error", (err) => this.fail(`rtp socket: ${err.message}`));
      rtp.bind(0, "127.0.0.1", () => {
        const port = rtp.address().port;
        const rtcp = dgram.createSocket("udp4");
        this.rtcp = rtcp;
        rtcp.on("error", () => { /* rtcp is best-effort */ });
        rtcp.bind(port + 1, "127.0.0.1", () => resolve(port));
      });
      rtp.once("error", reject);
    });
  }

  /** Push one JPEG frame (raw bytes, no data: prefix) into ffmpeg. */
  writeJpeg(jpeg: Buffer): void {
    try { this.proc?.stdin?.write(jpeg); } catch { /* backpressure/broken pipe — drop */ }
  }

  private fail(reason: string): void {
    this.stop();
    this.onExit(reason);
  }

  stop(): void {
    const proc = this.proc; this.proc = null;
    if (proc) { try { proc.stdin?.end(); } catch { /* noop */ } try { proc.kill("SIGKILL"); } catch { /* noop */ } }
    for (const s of [this.rtp, this.rtcp]) { try { s?.close(); } catch { /* noop */ } }
    this.rtp = null; this.rtcp = null; this.consumer = null;
  }
}

// ── the JPEG tee: panel-host feeds each screencast frame here so a live encoder
//    consumes the SAME frames the JPEG path relays (no double capture) ─────────

const jpegTees = new Map<string, (jpeg: Buffer) => void>();

/** panel-host calls this with each base64 JPEG it relays; when a WebRTC encoder
 *  is live for that panel the frame is also fed to ffmpeg. No tee → no-op. */
export function feedJpeg(panelId: string, base64Jpeg: string): void {
  const tee = jpegTees.get(panelId);
  if (!tee) return;
  try { tee(Buffer.from(base64Jpeg, "base64")); } catch { /* bad frame — drop */ }
}

// ── one peer per panel (single self-only viewer) ─────────────────────────────

const MEDIA_FLOWING_PACKETS = 8;

/**
 * The WebRTC peer for ONE panel. Owns the offer/answer/ICE exchange, the
 * negotiation deadline, the encoder, and the transport verdict. A panel has a
 * single self-only viewer (the user's own browser), so one peer per panel.
 */
class PanelPeer {
  private pc: WeriftPc | null = null;
  private track: WeriftTrack | null = null;
  private encoder: JpegRtpEncoder | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private packetsSent = 0;
  private mediaFlowing = false;
  private failure: string | undefined;
  private closed = false;
  transport: TransportDecision = { transport: "screencast", reason: "webrtc not started" };

  constructor(
    private readonly panelId: string,
    private readonly source: PanelSource,
    private readonly cfg: WebrtcConfig,
    private readonly send: (msg: WebrtcOut) => void,
  ) {}

  /** Build the peer + encoder, send the offer. Any failure resolves to a
   *  screencast verdict rather than throwing — the caller has a working panel
   *  either way. Only a local ElectronPanelSource has a capturable JPEG stream;
   *  a pod source would carry its own encoder path (out of scope here). */
  async start(): Promise<TransportDecision> {
    try {
      const werift = await loadWerift();
      if (!werift) throw new Error("werift not installed");
      if (!(this.source instanceof ElectronPanelSource)) throw new Error("source has no local capture");

      const { width, height } = this.source.viewport();
      this.encoder = new JpegRtpEncoder(this.cfg, width, height, (reason) => { this.failure = reason; this.publish({}); });

      const pc = new werift.RTCPeerConnection({
        codecs: { video: [this.codecParams(werift)] },
        iceUseTcp: this.cfg.iceUseTcp,
        ...(this.cfg.iceServers.length ? { iceServers: this.cfg.iceServers } : {}),
      }) as unknown as WeriftPc;
      this.pc = pc;

      const track = new werift.MediaStreamTrack({ kind: "video" }) as unknown as WeriftTrack;
      this.track = track;
      pc.addTransceiver(track, { direction: "sendonly" });

      pc.onIceCandidate.subscribe((candidate) => {
        if (this.closed) return;
        if (!candidate) { this.send({ type: "ice", candidate: null }); return; }
        this.send({ type: "ice", candidate: { candidate: candidate.candidate, sdpMid: candidate.sdpMid ?? null, sdpMLineIndex: candidate.sdpMLineIndex ?? null } });
      });
      pc.connectionStateChange.subscribe((state) => { void this.onState(state); });

      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      this.send({ type: "offer", sdp: pc.localDescription?.sdp ?? offer.sdp });

      // The fallback deadline starts at the OFFER, so a client that never answers
      // is failed over just like one whose UDP is dropped.
      this.timer = setTimeout(() => {
        if (this.mediaFlowing || this.closed) return;
        this.publish({ timedOut: true });
      }, this.cfg.negotiationTimeoutMs);
      if (typeof this.timer.unref === "function") this.timer.unref();

      this.publish({});
      return this.transport;
    } catch (err) {
      this.failure = (err as Error).message;
      this.publish({});
      return this.transport;
    }
  }

  async acceptAnswer(sdp: string): Promise<void> {
    if (!this.pc || this.closed) return;
    try { await this.pc.setRemoteDescription({ type: "answer", sdp }); }
    catch (err) { this.failure = `bad answer: ${(err as Error).message}`; this.publish({}); }
  }

  async acceptCandidate(candidate: PanelIceCandidate | null): Promise<void> {
    if (!this.pc || this.closed) return;
    try { await this.pc.addIceCandidate(candidate ?? null); } catch { /* trickle noise — never fatal */ }
  }

  private async onState(state: string): Promise<void> {
    if (this.closed) return;
    if (state === "connected") {
      try {
        // Encoder starts HERE (connect = keyframe for free). panel-host tees its
        // JPEG frames to us via feedJpeg → the registered tee below.
        await this.encoder!.start((packet) => this.writeRtp(packet));
        jpegTees.set(this.panelId, (jpeg) => this.encoder?.writeJpeg(jpeg));
      } catch (err) { this.failure = (err as Error).message; this.publish({}); }
      return;
    }
    if (state === "failed" || state === "closed" || state === "disconnected") {
      this.failure = `peer ${state}`;
      this.publish({});
    }
  }

  private writeRtp(packet: Buffer): void {
    if (this.closed || !this.track) return;
    try { this.track.writeRtp(packet); } catch { return; }
    this.packetsSent++;
    if (!this.mediaFlowing && this.packetsSent >= MEDIA_FLOWING_PACKETS) {
      this.mediaFlowing = true;
      this.publish({});
    }
  }

  private publish(extra: { timedOut?: boolean }): void {
    const next = decideTransport({
      clientWantsWebrtc: true,
      desktopCanWebrtc: true,
      mediaFlowing: this.mediaFlowing,
      timedOut: extra.timedOut === true,
      failure: this.failure,
    });
    if (next.transport === this.transport.transport && next.reason === this.transport.reason) return;
    this.transport = next;
    this.send({ type: "transport", transport: next.transport, reason: next.reason });
  }

  private codecParams(werift: WeriftModule): unknown {
    return new werift.RTCRtpCodecParameters({
      mimeType: "video/H264",
      clockRate: 90000,
      payloadType: this.cfg.payloadType,
      rtcpFeedback: [{ type: "nack" }, { type: "nack", parameter: "pli" }, { type: "goog-remb" }],
      parameters: "packetization-mode=1;level-asymmetry-allowed=1;profile-level-id=42e01f",
    });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    jpegTees.delete(this.panelId);
    try { this.encoder?.stop(); } catch { /* noop */ }
    this.encoder = null;
    try { this.track?.stop(); } catch { /* noop */ }
    this.track = null;
    const pc = this.pc; this.pc = null;
    if (pc) await pc.close().catch(() => { /* already closed */ });
  }
}

// ── manager: one peer per panel, keyed by panelId ────────────────────────────

const peers = new Map<string, PanelPeer>();

/**
 * Handle a client `hello` — the opt-in to WebRTC. Builds the peer + sends the
 * offer. Returns the transport decision; on any unavailability it is `screencast`
 * and the JPEG path carries on untouched.
 */
export async function maybeStartWebrtc(panelId: string, source: PanelSource, send: (msg: WebrtcOut) => void): Promise<TransportDecision> {
  await closeWebrtc(panelId); // idempotent restart
  const peer = new PanelPeer(panelId, source, configFromEnv(process.env), send);
  peers.set(panelId, peer);
  return peer.start();
}

/** Route an answer/ice signal to the panel's peer. */
export async function handleWebrtcSignal(panelId: string, raw: unknown): Promise<{ ok: true }> {
  const signal = parseSignal(raw);
  const peer = peers.get(panelId);
  if (!signal || !peer) return { ok: true };
  if (signal.type === "answer") await peer.acceptAnswer(signal.sdp);
  else if (signal.type === "ice") await peer.acceptCandidate(signal.candidate);
  return { ok: true };
}

/** Tear down a panel's peer (called on panel.close). Idempotent. */
export async function closeWebrtc(panelId: string): Promise<void> {
  const peer = peers.get(panelId);
  if (!peer) return;
  peers.delete(panelId);
  await peer.close();
}
