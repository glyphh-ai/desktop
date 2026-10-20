/**
 * Relay run (desktop side) — the frame translation + message assembly that turn a
 * local CLI run into the wire frames the mobile UI reads. Pure, no Electron.
 */
import { describe, it, expect } from "vitest";
import { toWireFrame, baseMessages, turnText, relayPermission } from "../../src/main/attach-run-frames.js";

const AT = 1_700_000_000_000;
const wf = (ch: string, data: Record<string, unknown>, seq = 0) => toWireFrame(ch, data, seq, "r1", AT);

describe("toWireFrame — every glyphh-agent:* event maps to its HarnessWireFrame", () => {
  it("stamps seq/runId/at on every frame", () => {
    expect(wf("glyphh-agent:delta", { delta: "hi" }, 7)).toMatchObject({ type: "delta", delta: "hi", seq: 7, runId: "r1", at: AT });
  });
  it("delta defaults an empty string, done coerces stopped, error defaults a message", () => {
    expect(wf("glyphh-agent:delta", {})).toMatchObject({ type: "delta", delta: "" });
    expect(wf("glyphh-agent:done", {})).toMatchObject({ type: "done", stopped: false });
    expect(wf("glyphh-agent:done", { stopped: true })).toMatchObject({ stopped: true });
    expect(wf("glyphh-agent:error", {})).toMatchObject({ type: "error", error: "run failed" });
  });
  it("tool carries phase/name/title/preview through and never lets the payload clobber the type", () => {
    expect(wf("glyphh-agent:tool", { phase: "done", name: "Edit", title: "Edit /a/b.ts", preview: "[+3 -1]" })).toMatchObject({ type: "tool", phase: "done", name: "Edit", title: "Edit /a/b.ts", preview: "[+3 -1]" });
    expect(wf("glyphh-agent:tool", { type: "delta", name: "Read" })).toMatchObject({ type: "tool", name: "Read" });
  });
  it("approval and ask keep their ids + payload", () => {
    expect(wf("glyphh-agent:approval", { id: "apr-1", kind: "command", title: "rm", detail: "danger" })).toMatchObject({ type: "approval", id: "apr-1", kind: "command", title: "rm", detail: "danger" });
    expect(wf("glyphh-agent:ask", { id: "ask-1", questions: [{ question: "which?" }] })).toMatchObject({ type: "ask", id: "ask-1", questions: [{ question: "which?" }] });
  });
  it("progress normalizes numbers and credits carries dollars per the contract", () => {
    expect(wf("glyphh-agent:progress", { inTokens: 10, outTokens: 20 })).toMatchObject({ type: "progress", inTokens: 10, outTokens: 20 });
    expect(wf("glyphh-agent:progress", {})).toMatchObject({ inTokens: 0, outTokens: 0 });
    expect(wf("glyphh-agent:credits", { usd: 0.0123 })).toMatchObject({ type: "credits", usd: 0.0123 });
    expect(wf("glyphh-agent:credits", { creditsMicro: 1234 })).toMatchObject({ type: "credits", usd: 0 });
  });
  it("permission and prompt ride the stream; an unknown channel is dropped", () => {
    expect(wf("glyphh-agent:permission", { permission: "plan" })).toMatchObject({ type: "permission", permission: "plan" });
    expect(wf("glyphh-agent:prompt", { text: "hi" })).toMatchObject({ type: "prompt", text: "hi" });
    expect(wf("glyphh-agent:mystery", { x: 1 })).toBeNull();
  });
  // THE SWARM RIDES THE WIRE (his report, 2026-10-05: "on the web the agents
  // stream is not coming through to the Agents work panel").
  const child = { childId: "r1#1", slug: "researcher", name: "Researcher", model: "cheap" };
  it("a sub-agent's delta, thinking, tool and approval ride WITH their agent tag", () => {
    expect(wf("glyphh-agent:delta", { delta: "swarm", agent: child })).toEqual({ type: "delta", delta: "swarm", agent: child, seq: 0, runId: "r1", at: AT });
    expect(wf("glyphh-agent:thinking", { text: "hmm", agent: child })).toMatchObject({ type: "thinking", text: "hmm", agent: child });
    expect(wf("glyphh-agent:tool", { phase: "start", name: "read", title: "read a.ts", agent: child })).toMatchObject({ type: "tool", phase: "start", name: "read", title: "read a.ts", agent: child });
    expect(wf("glyphh-agent:approval", { id: "apr-2", kind: "command", title: "rm", detail: "d", agent: child })).toMatchObject({ type: "approval", id: "apr-2", agent: child });
  });
  it("the parent's frames carry no tag, and its thinking rides as its own frame", () => {
    expect(wf("glyphh-agent:delta", { delta: "parent" })).toEqual({ type: "delta", delta: "parent", seq: 0, runId: "r1", at: AT });
    expect(wf("glyphh-agent:thinking", { text: "let me see" })).toEqual({ type: "thinking", text: "let me see", seq: 0, runId: "r1", at: AT });
    expect(wf("glyphh-agent:thinking", {})).toMatchObject({ type: "thinking", text: "" });
    expect(wf("glyphh-agent:delta", { delta: "x", agent: "not-a-ref" })).not.toHaveProperty("agent");
  });
  it("an agent's start and done become `agent` frames: who, on what, asked what, and how it ended", () => {
    expect(wf("glyphh-agent:agent", { phase: "start", agent: child, task: "find pricing" })).toEqual({ type: "agent", phase: "start", agent: child, task: "find pricing", seq: 0, runId: "r1", at: AT });
    expect(wf("glyphh-agent:agent", { phase: "done", agent: child, failed: true, summary: "403" })).toEqual({ type: "agent", phase: "done", agent: child, failed: true, summary: "403", seq: 0, runId: "r1", at: AT });
    expect(wf("glyphh-agent:agent", { phase: "done", agent: child, failed: 0, summary: "ok" })).toMatchObject({ failed: false });
    expect(wf("glyphh-agent:agent", { phase: "start" })).toBeNull();
  });
});

describe("baseMessages / turnText / relayPermission", () => {
  it("builds the turn from the caller's history, or just the prompt", () => {
    expect(baseMessages({}, "hi")).toEqual([{ role: "user", content: "hi" }]);
    expect(baseMessages({ messages: [{ role: "user", text: "a" }, { role: "assistant", content: "b" }, { role: "user", text: "" }] }, "x")).toEqual([{ role: "user", content: "a" }, { role: "assistant", content: "b" }]);
  });
  it("sends the last user message of a history as this turn's text", () => {
    expect(turnText({ messages: [{ role: "user", text: "a" }, { role: "assistant", text: "b" }, { role: "user", text: "c" }] }, "p")).toBe("c");
    expect(turnText({}, "p")).toBe("p");
  });
  it("reads the relaying client's permission, retires bypass, ignores junk", () => {
    expect(relayPermission("acceptEdits")).toBe("acceptEdits");
    expect(relayPermission("bypass")).toBe("auto");
    expect(relayPermission("yolo")).toBeUndefined();
  });
});

import { frameTargets, markRelaySink, isRelaySink } from "../../src/main/attach-run-frames.js";

describe("frameTargets — a relay originator keeps its frames when a desktop panel adopts the run", () => {
  const panelA = { id: "a" };
  const panelB = { id: "b" };
  it("a turn nobody adopted streams to the panel that started it", () => {
    expect(frameTargets(panelA, undefined)).toEqual([panelA]);
    expect(frameTargets(panelA, panelA)).toEqual([panelA]);
  });
  it("a desktop panel adopting a desktop turn REPLACES the first panel", () => {
    expect(frameTargets(panelA, panelB)).toEqual([panelB]);
  });
  it("a desktop panel adopting a RELAYED turn is added beside the relay sink, never instead of it", () => {
    const sink = { id: "relay" };
    markRelaySink(sink);
    expect(isRelaySink(sink)).toBe(true);
    expect(isRelaySink(panelA)).toBe(false);
    expect(frameTargets(sink, panelB)).toEqual([sink, panelB]);
    expect(frameTargets(sink, undefined)).toEqual([sink]);
  });
});
