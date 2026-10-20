/**
 * attach-run-ring.test.ts — every turn's frame ring (main/attach-run-ring.ts):
 * frames translate and keep their seq, a thread finds its newest RUNNING run
 * first, a done/error closes the ring, `from` is exclusive.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { clearRings, recordFrame, framesSince, ringForThread, ringOf, openRing } from "../../src/main/attach-run-ring.js";

describe("attach-run-ring — a desktop turn's frames, for a page that watches it", () => {
  beforeEach(() => clearRings());

  it("records a turn prompt-first with rising seqs and serves them from a cursor", () => {
    recordFrame("r1", "chat-a", "glyphh-agent:prompt", { text: "hi" }, 10);
    recordFrame("r1", "chat-a", "glyphh-agent:delta", { delta: "he" }, 11);
    recordFrame("r1", "chat-a", "glyphh-agent:delta", { delta: "llo" }, 12);
    expect(framesSince("r1", -1).map((f) => [f.seq, f.type])).toEqual([[0, "prompt"], [1, "delta"], [2, "delta"]]);
    expect(framesSince("r1", 1).map((f) => f.seq)).toEqual([2]);
    expect(ringOf("r1")?.status).toBe("running");
  });

  it("a channel with no wire shape records nothing and burns no seq", () => {
    expect(recordFrame("r1", "chat-a", "glyphh-agent:nonsense", {})).toBeNull();
    recordFrame("r1", "chat-a", "glyphh-agent:delta", { delta: "x" });
    expect(framesSince("r1", -1).map((f) => f.seq)).toEqual([0]);
  });

  it("done and error close the ring", () => {
    recordFrame("r1", "chat-a", "glyphh-agent:delta", { delta: "x" });
    recordFrame("r1", "chat-a", "glyphh-agent:done", { stopped: false });
    expect(ringOf("r1")?.status).toBe("done");
    recordFrame("r2", "chat-a", "glyphh-agent:error", { error: "boom" });
    expect(ringOf("r2")?.status).toBe("error");
  });

  it("a thread's newest run: running beats finished, newer beats older", () => {
    expect(ringForThread("chat-a")).toBeNull();
    openRing("old", "chat-a", 1); recordFrame("old", "chat-a", "glyphh-agent:done", {}, 2);
    openRing("mid", "chat-a", 5); recordFrame("mid", "chat-a", "glyphh-agent:done", {}, 6);
    expect(ringForThread("chat-a")?.runId).toBe("mid");
    openRing("live", "chat-a", 3);
    expect(ringForThread("chat-a")?.runId).toBe("live");
    openRing("other", "chat-b", 9);
    expect(ringForThread("chat-a")?.runId).toBe("live");
    expect(ringForThread("chat-b")?.runId).toBe("other");
  });
});
