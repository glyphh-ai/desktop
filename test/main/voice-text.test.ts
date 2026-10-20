import { describe, expect, it } from "vitest";
import { PARTIAL_EVERY_MS, PARTIAL_MIN_MS, dictationText, partialDue, transcribeErrorText } from "../../src/renderer/help/voice-text.js";

describe("a failed transcription says why on the chip (his report, 2026-10-07)", () => {
  it("strips Electron's remote-method wrapper and names the server's reason", () => {
    const e = new Error("Error invoking remote method 'voice-transcribe': Error: Glyphh won't run this: elevenlabs/scribe_v1 has no price on file");
    expect(transcribeErrorText(e)).toBe("Transcription failed — Glyphh won't run this: elevenlabs/scribe_v1 has no price on file");
    expect(transcribeErrorText(new Error("GlyphhError: the recording is too large"))).toBe("Transcription failed — the recording is too large");
    expect(transcribeErrorText("network down")).toBe("Transcription failed — network down");
  });
  it("has a line even for a bare failure", () => {
    expect(transcribeErrorText(undefined)).toBe("Transcription failed.");
    expect(transcribeErrorText(new Error(""))).toBe("Transcription failed.");
  });
});

describe("the live transcript in the box (his order, 2026-10-07)", () => {
  it("rides after the text that was there, one space between, and replaces its own earlier partial", () => {
    expect(dictationText("", "hello there")).toBe("hello there");
    expect(dictationText("Fix the", "sync bug")).toBe("Fix the sync bug");
    expect(dictationText("Fix the ", "sync bug")).toBe("Fix the sync bug");
    expect(dictationText("Fix the", "  ")).toBe("Fix the");
    const base = "Draft:";
    const first = dictationText(base, "hel");
    expect(dictationText(base, "hello world")).not.toBe(first);
    expect(dictationText(base, "hello world")).toBe("Draft: hello world");
  });
  it("a partial is due every interval once the take is long enough and none is in flight", () => {
    const t0 = 10_000;
    expect(partialDue(t0 + PARTIAL_MIN_MS - 1, t0, 0, false)).toBe(false);
    expect(partialDue(t0 + PARTIAL_MIN_MS, t0, 0, false)).toBe(true);
    expect(partialDue(t0 + PARTIAL_MIN_MS, t0, 0, true)).toBe(false);
    const last = t0 + 3_000;
    expect(partialDue(last + PARTIAL_EVERY_MS - 1, t0, last, false)).toBe(false);
    expect(partialDue(last + PARTIAL_EVERY_MS, t0, last, false)).toBe(true);
  });
});
