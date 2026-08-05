/**
 * panel-webrtc-core.ts — the PURE, electron-free half of the phase-2 WebRTC
 * path: the signaling vocabulary + its validation, the transport-selection rule,
 * ICE-server parsing, and the ffmpeg argv builder.
 *
 * Kept apart from panel-webrtc.ts (which imports Electron + werift + spawns
 * ffmpeg) so these decisions — "is this a valid signaling frame?", "which
 * transport does this subscriber end up on?", "what argv encodes this panel?" —
 * are unit-testable with no browser, no peer connection, and no Electron import.
 * The stateful module imports these and never re-implements them. Ported from
 * rrotor's panel/signal.ts + panel/encoder.ts.
 *
 * Secret hygiene: nothing here logs. SDP and ICE candidate strings carry DTLS
 * fingerprints and host IPs; {@link describeCandidate} lets a caller log a
 * candidate's TYPE + PROTOCOL without emitting the line itself.
 */

/** One trickled ICE candidate; `null` (or empty line) = end-of-candidates. */
export interface PanelIceCandidate {
  candidate: string;
  sdpMid?: string | null;
  sdpMLineIndex?: number | null;
}

/** Which video transport a subscriber is on. */
export type PanelTransport = "webrtc" | "screencast";

/** Client → desktop signaling (validated by {@link parseSignal}). */
export type WebrtcSignal =
  | { type: "hello"; webrtc: boolean; codecs?: string[] }
  | { type: "answer"; sdp: string }
  | { type: "ice"; candidate: PanelIceCandidate | null };

/** Desktop → client control frames pushed on the panel channel. `offer`/`ice`/
 *  `transport` are what phase 2 adds to the panel push union. */
export type WebrtcOut =
  | { type: "offer"; sdp: string }
  | { type: "ice"; candidate: PanelIceCandidate | null }
  | { type: "transport"; transport: PanelTransport; reason: string };

const SIGNAL_TYPES: ReadonlySet<string> = new Set(["hello", "answer", "ice"]);
const MAX_SDP_BYTES = 64 * 1024;
const MAX_CANDIDATE_CHARS = 1024;

/** Cheap discriminator: is this decoded frame addressed to WebRTC signaling? */
export function isWebrtcSignal(raw: unknown): raw is WebrtcSignal {
  return !!raw && typeof raw === "object" && SIGNAL_TYPES.has((raw as { type?: string }).type ?? "");
}

/** Validate one inbound signaling frame; returns null on anything malformed (a
 *  hostile WS peer must never take a panel down). Ported from rrotor/signal.ts. */
export function parseSignal(raw: unknown): WebrtcSignal | null {
  if (!raw || typeof raw !== "object") return null;
  const msg = raw as Record<string, unknown>;
  if (msg.type === "hello") {
    const codecs = Array.isArray(msg.codecs) ? msg.codecs.filter((c): c is string => typeof c === "string").slice(0, 8) : undefined;
    return { type: "hello", webrtc: msg.webrtc === true, ...(codecs?.length ? { codecs } : {}) };
  }
  if (msg.type === "answer") {
    const sdp = typeof msg.sdp === "string" ? msg.sdp : "";
    if (!sdp.startsWith("v=") || Buffer.byteLength(sdp) > MAX_SDP_BYTES) return null;
    return { type: "answer", sdp };
  }
  if (msg.type === "ice") {
    if (msg.candidate == null) return { type: "ice", candidate: null };
    if (typeof msg.candidate !== "object") return null;
    const c = msg.candidate as Record<string, unknown>;
    const line = typeof c.candidate === "string" ? c.candidate : "";
    if (!line) return { type: "ice", candidate: null };
    if (line.length > MAX_CANDIDATE_CHARS) return null;
    return {
      type: "ice",
      candidate: {
        candidate: line,
        sdpMid: typeof c.sdpMid === "string" ? c.sdpMid : null,
        sdpMLineIndex: Number.isFinite(Number(c.sdpMLineIndex)) ? Number(c.sdpMLineIndex) : null,
      },
    };
  }
  return null;
}

/** Candidate TYPE + PROTOCOL for logging without emitting the (IP-bearing) line. */
export function describeCandidate(line: string): { type: string; protocol: string } {
  const typ = /\btyp\s+(\w+)/.exec(line);
  const parts = line.replace(/^a=/, "").split(/\s+/);
  const protocol = parts[2] && /^(udp|tcp)$/i.test(parts[2]) ? parts[2].toLowerCase() : "unknown";
  return { type: typ?.[1] ?? "unknown", protocol };
}

export interface TransportDecision { transport: PanelTransport; reason: string }

/**
 * The ONE rule that picks a subscriber's transport. Screencast is the floor: a
 * subscriber gets it unless WebRTC has PROVEN itself (client asked, desktop can,
 * peer connected, media flowing). Every other branch resolves to screencast with
 * a reason — the non-negotiable automatic-fallback requirement as a pure fn.
 * `failure` wins over `mediaFlowing`: a peer that carried media and THEN died
 * must fall back, not stay on a dead transport.
 */
export function decideTransport(i: {
  clientWantsWebrtc: boolean;
  desktopCanWebrtc: boolean;
  mediaFlowing: boolean;
  timedOut: boolean;
  failure?: string;
}): TransportDecision {
  if (i.failure) return { transport: "screencast", reason: `webrtc failed: ${i.failure}` };
  if (!i.clientWantsWebrtc) return { transport: "screencast", reason: "client did not request webrtc" };
  if (!i.desktopCanWebrtc) return { transport: "screencast", reason: "desktop has no encoder (werift/ffmpeg absent)" };
  if (i.mediaFlowing) return { transport: "webrtc", reason: "peer connected, media flowing" };
  if (i.timedOut) return { transport: "screencast", reason: "webrtc negotiation timed out" };
  return { transport: "screencast", reason: "webrtc negotiating" };
}

/** The per-panel encoder configuration. */
export interface WebrtcConfig {
  fps: number;
  bitrateKbps: number;
  crf: number;
  keyint: number;
  payloadType: number;
  pktSize: number;
  negotiationTimeoutMs: number;
  iceServers: Array<{ urls: string; username?: string; credential?: string }>;
  iceUseTcp: boolean;
  ffmpegPath: string | undefined;
}

/** `"stun:a:3478,turn:user:pass@b:3478"` → werift iceServers shape. PURE. */
export function parseIceServers(raw: string | undefined): Array<{ urls: string; username?: string; credential?: string }> {
  return (raw ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((entry) => {
      const m = /^(turns?):([^:@]+):([^@]+)@(.+)$/.exec(entry);
      if (m) return { urls: `${m[1]}:${m[4]}`, username: m[2], credential: m[3] };
      return { urls: entry };
    });
}

/** Build the encoder config from env, with laptop-sane defaults. PURE. */
export function configFromEnv(env: NodeJS.ProcessEnv): WebrtcConfig {
  const num = (raw: string | undefined, fallback: number): number => {
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? n : fallback;
  };
  return {
    fps: Math.min(60, num(env.PANEL_WEBRTC_FPS, 30)),
    bitrateKbps: num(env.PANEL_WEBRTC_BITRATE_KBPS, 2500),
    crf: Math.min(51, num(env.PANEL_WEBRTC_CRF, 26)),
    keyint: num(env.PANEL_WEBRTC_KEYINT, 300),
    payloadType: 96,
    pktSize: 1200,
    negotiationTimeoutMs: num(env.PANEL_WEBRTC_TIMEOUT_MS, 6000),
    iceServers: parseIceServers(env.PANEL_ICE_SERVERS),
    iceUseTcp: env.PANEL_ICE_TCP === "1",
    ffmpegPath: env.PANEL_FFMPEG_PATH,
  };
}

/** H.264 needs even dimensions for 4:2:0 chroma. */
export function evenDim(n: number): number {
  const v = Math.max(2, Math.round(Number.isFinite(n) ? n : 2));
  return v % 2 === 0 ? v : v - 1;
}

/**
 * ffmpeg argv: a JPEG stream on stdin → H.264 baseline/zerolatency → RTP over
 * loopback. PURE — no spawn, no fs, no env.
 *
 * crf (quality) with the bitrate as a CEILING, not a target, is the single
 * biggest bandwidth win over average-bitrate rate control: an idle page costs
 * almost nothing while a pathological one still can't exceed the budget. The long
 * keyint pairs with on-demand encoder start (connect == a keyframe for free).
 */
export function ffmpegArgs(cfg: WebrtcConfig, width: number, height: number, rtpPort: number): string[] {
  const w = evenDim(width);
  const h = evenDim(height);
  return [
    "-hide_banner", "-loglevel", "error", "-nostdin",
    "-f", "image2pipe", "-framerate", String(cfg.fps), "-c:v", "mjpeg", "-i", "pipe:0",
    "-an",
    "-vf", `scale=${w}:${h},format=yuv420p`,
    "-c:v", "libx264", "-profile:v", "baseline", "-preset", "ultrafast", "-tune", "zerolatency",
    "-crf", String(cfg.crf),
    "-x264-params", `keyint=${cfg.keyint}:min-keyint=${cfg.keyint}:scenecut=0:repeat-headers=1`,
    "-b:v", `${cfg.bitrateKbps}k`, "-maxrate", `${cfg.bitrateKbps}k`, "-bufsize", `${cfg.bitrateKbps * 2}k`,
    "-f", "rtp", "-payload_type", String(cfg.payloadType),
    `rtp://127.0.0.1:${rtpPort}?pkt_size=${cfg.pktSize}`,
  ];
}
