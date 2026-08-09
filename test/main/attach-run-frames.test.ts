/**
 * Relay run (desktop side) — the frame translation + message assembly that turn a
 * local harness run into the wire frames the mobile UI reads. Pure, no Electron.
 */
import { describe, it, expect } from "vitest";
import { toWireFrame, baseMessages } from "../../src/main/attach-run-frames.js";

const AT = 1_700_000_000_000;
const wf = (ch: string, data: Record<string, unknown>, seq = 0) => toWireFrame(ch, data, seq, "r1", AT);

describe("toWireFrame — every glyphh-agent:* event maps to its HarnessWireFrame", () => {
  it("stamps seq/runId/at on every frame", () => {
    const f = wf("glyphh-agent:delta", { delta: "hi" }, 7)!;
    expect(f).toMatchObject({ type: "delta", delta: "hi", seq: 7, runId: "r1", at: AT });
  });

  it("delta defaults an empty string (never undefined)", () => {
    expect(wf("glyphh-agent:delta", {})).toMatchObject({ type: "delta", delta: "" });
  });

  it("tool carries phase/name/title/diff through", () => {
    const f = wf("glyphh-agent:tool", { phase: "done", name: "Edit", title: "Edit /a/b.ts", preview: "[+3 -1]" })!;
    expect(f).toMatchObject({ type: "tool", phase: "done", name: "Edit", title: "Edit /a/b.ts", preview: "[+3 -1]" });
  });

  it("approval and ask keep their ids + payload", () => {
    expect(wf("glyphh-agent:approval", { id: "apr-1", kind: "command", title: "rm", detail: "danger" }))
      .toMatchObject({ type: "approval", id: "apr-1", kind: "command", title: "rm", detail: "danger" });
    expect(wf("glyphh-agent:ask", { id: "ask-1", questions: [{ question: "which?" }] }))
      .toMatchObject({ type: "ask", id: "ask-1", questions: [{ question: "which?" }] });
  });

  it("progress + credits normalize numbers", () => {
    expect(wf("glyphh-agent:progress", { inTokens: 10, outTokens: 20 })).toMatchObject({ type: "progress", inTokens: 10, outTokens: 20 });
    expect(wf("glyphh-agent:credits", { creditsMicro: 1234 })).toMatchObject({ type: "credits", creditsMicro: 1234 });
    expect(wf("glyphh-agent:progress", {})).toMatchObject({ inTokens: 0, outTokens: 0 });
  });

  it("done coerces stopped to a boolean", () => {
    expect(wf("glyphh-agent:done", { stopped: true })).toMatchObject({ type: "done", stopped: true });
    expect(wf("glyphh-agent:done", {})).toMatchObject({ type: "done", stopped: false });
  });

  it("error defaults a message", () => {
    expect(wf("glyphh-agent:error", { error: "boom" })).toMatchObject({ type: "error", error: "boom" });
    expect(wf("glyphh-agent:error", {})).toMatchObject({ type: "error", error: "run failed" });
  });

  it("an unknown channel maps to null (dropped, never a bad frame)", () => {
    expect(wf("glyphh-agent:mystery", { x: 1 })).toBeNull();
    expect(wf("some-other-ipc", {})).toBeNull();
  });

  it("never lets the emit payload clobber the frame type", () => {
    // A stray `type` in data must not win over the real mapping.
    expect(wf("glyphh-agent:tool", { type: "delta", name: "Read" })).toMatchObject({ type: "tool", name: "Read" });
  });
});

describe("baseMessages — the turn's messages from the caller", () => {
  it("falls back to a single user message from the prompt", () => {
    expect(baseMessages({}, "hello")).toEqual([{ role: "user", content: "hello" }]);
  });

  it("maps a history array, accepting text OR content and normalizing roles", () => {
    const msgs = baseMessages({ messages: [
      { role: "user", text: "q1" },
      { role: "assistant", content: "a1" },
      { role: "system", text: "s" },     // non-user → assistant
    ] }, "ignored");
    expect(msgs).toEqual([
      { role: "user", content: "q1" },
      { role: "assistant", content: "a1" },
      { role: "assistant", content: "s" },
    ]);
  });

  it("drops empty messages", () => {
    expect(baseMessages({ messages: [{ role: "user", text: "" }, { role: "user", text: "keep" }] }, "x"))
      .toEqual([{ role: "user", content: "keep" }]);
  });

  it("uses the prompt when history is present but empty", () => {
    expect(baseMessages({ messages: [] }, "fallback")).toEqual([{ role: "user", content: "fallback" }]);
  });
});
