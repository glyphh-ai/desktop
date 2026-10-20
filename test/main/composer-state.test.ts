/**
 * composer-state.test.ts — the composer's bottom-right slot as a pure rule
 * (src/renderer/help/composer-state.ts): one primary button whose face
 * follows the state, the two voice presentations, and the level-meter maths
 * (his order, 2026-10-07, Claude's composer as the reference).
 */
import { describe, expect, it } from "vitest";
import {
  LISTENING_PLACEHOLDER, METER_DOTS, composerListening, composerPrimary, composerSlot, composerTakesEnter,
  levelBarWidth, levelOf, meterDots, rmsOf, type ComposerState,
} from "../../src/renderer/help/composer-state.js";

const st = (p: Partial<ComposerState> = {}): ComposerState => ({ text: "", running: false, voice: "off", ...p });

describe("composerPrimary — one button, its face follows the state", () => {
  it("empty + idle: no send button (the voice pair sits there)", () => {
    expect(composerSlot(st())).toBe("voice");
    expect(composerPrimary(st())).toBe("none");
  });
  it("whitespace is still empty", () => {
    expect(composerPrimary(st({ text: "  \n " }))).toBe("none");
  });
  it("text typed + idle: the accent ↑ send button", () => {
    expect(composerSlot(st({ text: "hi" }))).toBe("send");
    expect(composerPrimary(st({ text: "hi" }))).toBe("send");
  });
  it("a turn in flight: Stop, whether or not the box holds text", () => {
    expect(composerPrimary(st({ running: true }))).toBe("stop");
    expect(composerPrimary(st({ running: true, text: "a note" }))).toBe("stop");
  });
  it("the run settling returns the slot to empty / typed", () => {
    expect(composerPrimary(st({ running: false, text: "a note" }))).toBe("send");
    expect(composerPrimary(st({ running: false }))).toBe("none");
  });
  it("transcribing reads as idle (the mic dims; the text lands next)", () => {
    expect(composerSlot(st({ voice: "transcribing" }))).toBe("voice");
    expect(composerSlot(st({ voice: "transcribing", text: "so far" }))).toBe("send");
  });
});

describe("voice states", () => {
  it("push-to-talk listening: the meter + ✕ ✓, no primary, the Listening… placeholder", () => {
    const s = st({ voice: "ptt" });
    expect(composerSlot(s)).toBe("ptt");
    expect(composerPrimary(s)).toBe("none");
    expect(composerListening(s)).toBe(true);
    expect(LISTENING_PLACEHOLDER).toBe("Listening…");
  });
  it("hands-free listening: the mic stays, the ▮▮▮ Stop pill joins", () => {
    const s = st({ voice: "free" });
    expect(composerSlot(s)).toBe("free");
    expect(composerPrimary(s)).toBe("none");
    expect(composerListening(s)).toBe(true);
  });
  it("a listening recorder wins over a run and over typed text", () => {
    expect(composerSlot(st({ voice: "ptt", running: true, text: "x" }))).toBe("ptt");
    expect(composerSlot(st({ voice: "free", running: true, text: "x" }))).toBe("free");
  });
  it("idle states are not listening", () => {
    expect(composerListening(st())).toBe(false);
    expect(composerListening(st({ text: "hi" }))).toBe(false);
    expect(composerListening(st({ running: true }))).toBe(false);
    expect(composerListening(st({ voice: "transcribing" }))).toBe(false);
  });
});

describe("composerTakesEnter", () => {
  it("sends only in the typed state, queues mid-run, ignores while listening", () => {
    expect(composerTakesEnter(st())).toBe(false);
    expect(composerTakesEnter(st({ text: "hi" }))).toBe(true);
    expect(composerTakesEnter(st({ running: true }))).toBe(true);
    expect(composerTakesEnter(st({ voice: "ptt", text: "hi" }))).toBe(false);
    expect(composerTakesEnter(st({ voice: "free", text: "hi" }))).toBe(false);
  });
});

describe("level meter maths", () => {
  it("rmsOf: silence is 0, a full square wave is 1, empty is 0", () => {
    expect(rmsOf(new Uint8Array(64).fill(128))).toBe(0);
    const sq = new Uint8Array(64);
    for (let i = 0; i < 64; i++) sq[i] = i % 2 ? 0 : 256 - 1;   // ±~1
    expect(rmsOf(sq)).toBeCloseTo(0.996, 2);
    expect(rmsOf([])).toBe(0);
  });
  it("levelOf: gain 5, clamped, NaN/negatives read as silence", () => {
    expect(levelOf(0)).toBe(0);
    expect(levelOf(0.1)).toBeCloseTo(0.5, 6);
    expect(levelOf(0.5)).toBe(1);
    expect(levelOf(NaN)).toBe(0);
    expect(levelOf(-1)).toBe(0);
  });
  it("levelBarWidth: a whole percent of the track, 0..100", () => {
    expect(levelBarWidth(0)).toBe(0);
    expect(levelBarWidth(0.337)).toBe(34);
    expect(levelBarWidth(1)).toBe(100);
    expect(levelBarWidth(4)).toBe(100);
    expect(levelBarWidth(NaN)).toBe(0);
  });
  it("meterDots: 10 dots by default, all within 8–12", () => {
    expect(METER_DOTS).toBeGreaterThanOrEqual(8);
    expect(METER_DOTS).toBeLessThanOrEqual(12);
    expect(meterDots(0.5)).toHaveLength(METER_DOTS);
    expect(meterDots(0.5, 8)).toHaveLength(8);
  });
  it("silence: a row of small, dim, equal dots", () => {
    const dots = meterDots(0);
    for (const d of dots) { expect(d.h).toBeCloseTo(0.18, 6); expect(d.a).toBeCloseTo(0.35, 6); }
  });
  it("a loud moment bulges at the centre and stays within 0..1", () => {
    const dots = meterDots(1);
    const c = (dots.length - 1) / 2;
    const mid = dots[Math.floor(c)];
    expect(mid.h).toBeGreaterThan(dots[0].h);
    expect(mid.a).toBeGreaterThan(dots[0].a);
    expect(dots[0].h).toBeCloseTo(dots[dots.length - 1].h, 6);   // symmetric
    for (const d of dots) { expect(d.h).toBeLessThanOrEqual(1); expect(d.a).toBeLessThanOrEqual(1); expect(d.h).toBeGreaterThan(0); }
  });
  it("height and opacity grow with the level", () => {
    const lo = meterDots(0.2)[5], hi = meterDots(0.8)[5];
    expect(hi.h).toBeGreaterThan(lo.h);
    expect(hi.a).toBeGreaterThan(lo.a);
  });
});
