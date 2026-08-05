/**
 * Pure-unit coverage for the phase-2 WebRTC decision + signaling logic. No
 * Electron, no werift, no ffmpeg spawn — these are the parts that decide "is
 * this a valid signaling frame", "which transport does this subscriber get",
 * and "what argv encodes this panel", and they must hold regardless of the
 * stateful machinery around them.
 */
import { describe, it, expect } from "vitest";
import {
  parseSignal, isWebrtcSignal, decideTransport, parseIceServers, ffmpegArgs,
  configFromEnv, describeCandidate, evenDim,
} from "../../src/main/panel-webrtc-core.js";

describe("parseSignal", () => {
  it("accepts a hello and normalizes codecs", () => {
    expect(parseSignal({ type: "hello", webrtc: true, codecs: ["h264", 5, "vp8"] })).toEqual({ type: "hello", webrtc: true, codecs: ["h264", "vp8"] });
  });
  it("rejects an answer that is not SDP", () => {
    expect(parseSignal({ type: "answer", sdp: "not-sdp" })).toBeNull();
    expect(parseSignal({ type: "answer", sdp: "v=0\r\n..." })).toEqual({ type: "answer", sdp: "v=0\r\n..." });
  });
  it("treats a null/empty candidate as end-of-candidates", () => {
    expect(parseSignal({ type: "ice", candidate: null })).toEqual({ type: "ice", candidate: null });
    expect(parseSignal({ type: "ice", candidate: { candidate: "" } })).toEqual({ type: "ice", candidate: null });
  });
  it("passes a well-formed candidate through", () => {
    const line = "candidate:1 1 udp 2113937151 192.168.1.2 54321 typ host";
    expect(parseSignal({ type: "ice", candidate: { candidate: line, sdpMid: "0", sdpMLineIndex: 0 } })).toEqual({
      type: "ice", candidate: { candidate: line, sdpMid: "0", sdpMLineIndex: 0 },
    });
  });
  it("rejects an over-long candidate line and non-objects", () => {
    expect(parseSignal({ type: "ice", candidate: { candidate: "a".repeat(2000) } })).toBeNull();
    expect(parseSignal(42)).toBeNull();
    expect(parseSignal({ type: "nope" })).toBeNull();
  });
  it("isWebrtcSignal discriminates the three signaling types only", () => {
    expect(isWebrtcSignal({ type: "hello" })).toBe(true);
    expect(isWebrtcSignal({ type: "frame" })).toBe(false);
    expect(isWebrtcSignal(null)).toBe(false);
  });
});

describe("decideTransport — screencast is the floor", () => {
  const base = { clientWantsWebrtc: true, desktopCanWebrtc: true, mediaFlowing: false, timedOut: false };
  it("is webrtc ONLY when media is flowing", () => {
    expect(decideTransport({ ...base, mediaFlowing: true }).transport).toBe("webrtc");
  });
  it("falls back when the client never asked", () => {
    expect(decideTransport({ ...base, clientWantsWebrtc: false }).transport).toBe("screencast");
  });
  it("falls back when the desktop can't encode", () => {
    expect(decideTransport({ ...base, desktopCanWebrtc: false }).transport).toBe("screencast");
  });
  it("falls back on timeout", () => {
    expect(decideTransport({ ...base, timedOut: true }).transport).toBe("screencast");
  });
  it("a failure wins over flowing media (a peer that died must fall back)", () => {
    expect(decideTransport({ ...base, mediaFlowing: true, failure: "peer failed" }).transport).toBe("screencast");
  });
});

describe("parseIceServers — TURN wiring", () => {
  it("parses a bare STUN url", () => {
    expect(parseIceServers("stun:stun.l.google.com:19302")).toEqual([{ urls: "stun:stun.l.google.com:19302" }]);
  });
  it("splits a TURN url into urls + credentials", () => {
    expect(parseIceServers("turn:user:pass@turn.example.com:3478")).toEqual([{ urls: "turn:turn.example.com:3478", username: "user", credential: "pass" }]);
  });
  it("handles an empty / undefined config", () => {
    expect(parseIceServers(undefined)).toEqual([]);
    expect(parseIceServers("")).toEqual([]);
  });
});

describe("ffmpegArgs — JPEG stdin → H.264 RTP", () => {
  const cfg = configFromEnv({});
  it("reads a JPEG stream from stdin and writes RTP to loopback", () => {
    const args = ffmpegArgs(cfg, 1280, 800, 41000).join(" ");
    expect(args).toContain("-f image2pipe");
    expect(args).toContain("-c:v mjpeg -i pipe:0");
    expect(args).toContain("-c:v libx264");
    expect(args).toContain("rtp://127.0.0.1:41000");
  });
  it("uses crf quality with the bitrate as a ceiling (maxrate), not a target", () => {
    const args = ffmpegArgs({ ...cfg, crf: 26, bitrateKbps: 2500 }, 640, 480, 5000);
    expect(args).toContain("-crf");
    expect(args).toContain("-maxrate");
  });
  it("forces even dimensions for 4:2:0 chroma", () => {
    expect(evenDim(801)).toBe(800);
    expect(evenDim(800)).toBe(800);
    const args = ffmpegArgs(cfg, 801, 601, 5000).join(" ");
    expect(args).toContain("scale=800:600");
  });
});

describe("configFromEnv", () => {
  it("defaults sanely and clamps fps", () => {
    const c = configFromEnv({ PANEL_WEBRTC_FPS: "120" });
    expect(c.fps).toBe(60);
    expect(c.bitrateKbps).toBe(2500);
  });
  it("reads TURN servers + the ffmpeg path from env", () => {
    const c = configFromEnv({ PANEL_ICE_SERVERS: "turn:u:p@h:3478", PANEL_FFMPEG_PATH: "/usr/bin/ffmpeg" });
    expect(c.iceServers).toHaveLength(1);
    expect(c.ffmpegPath).toBe("/usr/bin/ffmpeg");
  });
});

describe("describeCandidate — logs type/proto without the IP", () => {
  it("extracts type and protocol", () => {
    expect(describeCandidate("candidate:1 1 udp 2113937151 192.168.1.2 54321 typ host")).toEqual({ type: "host", protocol: "udp" });
    expect(describeCandidate("garbage")).toEqual({ type: "unknown", protocol: "unknown" });
  });
});
