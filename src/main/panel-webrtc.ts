/**
 * panel-webrtc.ts — the phase-2 WebRTC seam for streamed panels.
 *
 * PHASE 1 (this revision): the seam is present but INERT. A client that sends
 * `hello{webrtc:true}` is answered with `transport:"screencast"` and the panel
 * carries on over the phase-1 JPEG relay. This keeps the panel.webrtc relay
 * method + the transport-selection rule live and testable now, while the actual
 * peer + encoder (which turn media P2P) land in phase 2 without touching the
 * relay, the wire vocabulary, or the web component.
 *
 * The wire vocabulary and the pure {@link decideTransport} rule are the parts
 * phase 2 does NOT get to re-invent — they are fixed here so both phases speak
 * the same signaling and make the same fallback decision.
 */

import type { PanelSource } from "./panel-source.js";

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

/** Desktop → client control frames pushed on the panel channel. */
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

export interface TransportDecision { transport: PanelTransport; reason: string }

/**
 * The ONE rule that picks a subscriber's transport. Screencast is the floor: a
 * subscriber gets it unless WebRTC has PROVEN itself (client asked, desktop can,
 * peer connected, media flowing). Every other branch resolves to screencast with
 * a reason — the non-negotiable automatic-fallback requirement as a pure fn.
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

// ── phase-1 inert manager: always screencast ─────────────────────────────────

/** Handle a client `hello`. Phase 1: no peer/encoder yet, so always answer with
 *  a screencast verdict. Phase 2 replaces this body with the werift peer. */
export async function maybeStartWebrtc(_panelId: string, _source: PanelSource, send: (msg: WebrtcOut) => void): Promise<TransportDecision> {
  const decision = decideTransport({ clientWantsWebrtc: true, desktopCanWebrtc: false, mediaFlowing: false, timedOut: false });
  send({ type: "transport", transport: decision.transport, reason: decision.reason });
  return decision;
}

/** Route an answer/ice signal. Phase 1: no peer, so drop it. */
export async function handleWebrtcSignal(_panelId: string, _raw: unknown): Promise<{ ok: true }> {
  return { ok: true };
}

/** Tear down a panel's peer. Phase 1: nothing to do. */
export async function closeWebrtc(_panelId: string): Promise<void> {
  /* no peer in phase 1 */
}

/** Feed a JPEG frame to a live encoder. Phase 1: no encoder, so no-op. */
export function feedJpeg(_panelId: string, _base64Jpeg: string): void {
  /* no encoder in phase 1 */
}
