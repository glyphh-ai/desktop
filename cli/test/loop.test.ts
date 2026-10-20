/**
 * loop.test.ts — the turn over a SCRIPTED engine. `runLoopTurn` is the whole
 * chat path, so the contract under test is the event→handler map: streamed
 * deltas, tool receipts (a denial reads as denied), progress, the PARKED
 * approval round trip, an unanswerable approval refused rather than hung, Esc
 * stopping the run, and an error event settling the turn with its message.
 */

import { describe, it, expect, vi } from "vitest";
import type { LoopEmit, LoopEvent, LoopTurn } from "@glyphh/sdk/loop";
import { runLoopTurn, loopPermission, type LoopEngine, type LoopTurnHandlers } from "../src/loop.js";
import { parseFlags, permissionFlag } from "../src/flags.js";
import { EFFORTS, effortOf } from "../src/types.js";

type Step = Parameters<LoopEmit>[0] | ((emit: LoopEmit, eng: FakeEngine) => void | Promise<void>);

class FakeEngine implements LoopEngine {
  turn: LoopTurn | null = null;
  stops: string[] = [];
  answers: Array<{ id: string; allow: boolean }> = [];
  private waiters = new Map<string, () => void>();
  constructor(private readonly script: Step[]) {}
  async run(turn: LoopTurn, emit: LoopEmit): Promise<{ runId: string }> {
    this.turn = turn;
    for (const step of this.script) {
      if (typeof step === "function") await step(emit, this);
      else emit(step);
    }
    return { runId: "r1" };
  }
  stop(chatId: string): boolean { this.stops.push(chatId); return true; }
  respondApproval(id: string, allow: boolean): boolean {
    this.answers.push({ id, allow });
    this.waiters.get(id)?.();
    return true;
  }
  forgetAll(): void { /* nothing to drop */ }
  /** Resolves when `id` is answered — a script step awaits it to PARK. */
  answered(id: string): Promise<void> { return new Promise((r) => this.waiters.set(id, r)); }
}

const client = {} as never;
const ev = (e: LoopEvent): LoopEvent & { runId: string } => ({ runId: "r1", ...e });

function handlers(): LoopTurnHandlers & { deltas: string[]; thoughts: string[]; starts: string[]; dones: Array<{ name: string; failed: boolean; denied: boolean }>; progress: Array<[number, number]>; notes: string[] } {
  const h = {
    deltas: [] as string[], thoughts: [] as string[], starts: [] as string[], dones: [] as Array<{ name: string; failed: boolean; denied: boolean }>, progress: [] as Array<[number, number]>, notes: [] as string[],
    onDelta: (t: string) => { h.deltas.push(t); },
    onThinking: (t: string) => { h.thoughts.push(t); },
    onToolStart: (name: string) => { h.starts.push(name); },
    onToolDone: (name: string, r: { failed: boolean; denied: boolean }) => { h.dones.push({ name, failed: r.failed, denied: r.denied }); },
    onProgress: (up: number, down: number) => { h.progress.push([up, down]); },
    onNote: (t: string) => { h.notes.push(t); },
  };
  return h;
}

const base = { client, model: "m", chatId: "c1", history: [] as Array<{ role: "user" | "assistant"; content: string }>, prompt: "hi", permission: "default" as const };

describe("runLoopTurn", () => {
  it("streams deltas, maps tool events to receipts, and resolves with the full answer", async () => {
    const eng = new FakeEngine([
      ev({ type: "setup", phase: "ready", model: "m", loop: "glyphh" }),
      ev({ type: "delta", delta: "Hel" }), ev({ type: "delta", delta: "lo" }),
      ev({ type: "tool", phase: "start", name: "bash", title: "bash ls" }),
      ev({ type: "tool", phase: "done", name: "bash", title: "bash ls", failed: false, preview: "a b" }),
      ev({ type: "tool", phase: "done", name: "write_file", title: "write_file x", failed: true, preview: "not permitted in this mode" }),
      ev({ type: "progress", inTokens: 12, outTokens: 3, cacheReadTokens: 0 }),
      ev({ type: "done", stopped: false }),
    ]);
    const h = handlers();
    const r = await runLoopTurn({ ...base, engine: eng, cwd: "/w", history: [{ role: "user", content: "a" }, { role: "assistant", content: "b" }] }, h);
    expect(r).toEqual({ text: "Hello", stopped: false });
    expect(h.deltas).toEqual(["Hel", "lo"]);
    expect(h.starts).toEqual(["bash"]);
    expect(h.dones).toEqual([{ name: "bash", failed: false, denied: false }, { name: "write_file", failed: true, denied: true }]);
    expect(h.progress).toEqual([[12, 3]]);
    // The engine got the turn's contract: chat id, model, permission word, folder, seed history.
    expect(eng.turn).toEqual({ chatId: "c1", text: "hi", model: "m", permission: "ask", workdir: "/w", history: [{ role: "user", text: "a" }, { role: "assistant", text: "b" }] });
  });

  it("an approval PARKS the run and the answer resumes it", async () => {
    const eng = new FakeEngine([
      ev({ type: "approval", id: "c1:g1", kind: "command", title: "bash rm x", detail: "{}" }),
      async (_emit, e) => { await e.answered("c1:g1"); },
      ev({ type: "delta", delta: "ran" }),
      ev({ type: "done", stopped: false }),
    ]);
    const h = handlers();
    let seen: { kind: string; title: string } | null = null;
    const r = await runLoopTurn({ ...base, engine: eng }, {
      ...h,
      onApproval: (req, answer) => { seen = { kind: req.kind, title: req.title }; setTimeout(() => answer(true), 0); },
    });
    expect(seen).toEqual({ kind: "command", title: "bash rm x" });
    expect(eng.answers).toEqual([{ id: "c1:g1", allow: true }]);
    expect(r.text).toBe("ran");
  });

  it("an unanswerable approval is refused rather than left hanging", async () => {
    const eng = new FakeEngine([
      ev({ type: "approval", id: "c1:g1", kind: "edit", title: "edit_file a", detail: "" }),
      ev({ type: "done", stopped: false }),
    ]);
    await runLoopTurn({ ...base, engine: eng }, handlers());
    expect(eng.answers).toEqual([{ id: "c1:g1", allow: false }]);
  });

  it("Esc (an aborted signal) stops the run and keeps the partial answer", async () => {
    const ctl = new AbortController();
    const eng = new FakeEngine([
      ev({ type: "delta", delta: "part" }),
      (emit) => { ctl.abort(); emit(ev({ type: "error", error: "aborted" })); emit(ev({ type: "done", stopped: true })); },
    ]);
    const r = await runLoopTurn({ ...base, engine: eng, signal: ctl.signal }, handlers());
    expect(eng.stops).toEqual(["c1"]);
    expect(r).toEqual({ text: "part", stopped: true });
  });

  it("an error event settles the turn with the message instead of throwing", async () => {
    const eng = new FakeEngine([ev({ type: "error", error: "anthropic 429: rate limited" }), ev({ type: "done", stopped: true })]);
    const r = await runLoopTurn({ ...base, engine: eng }, handlers());
    expect(r.error).toBe("anthropic 429: rate limited");
    expect(r.stopped).toBe(true);
  });

  it("a handler that throws never takes the run down", async () => {
    const eng = new FakeEngine([ev({ type: "delta", delta: "x" }), ev({ type: "done", stopped: false })]);
    const h = handlers();
    const r = await runLoopTurn({ ...base, engine: eng }, { ...h, onDelta: () => { throw new Error("renderer"); } });
    expect(r.text).toBe("x");
  });
});

describe("loopPermission", () => {
  it("maps the four standard modes onto the loop's words", () => {
    expect(loopPermission("default")).toBe("ask");
    expect(loopPermission("acceptEdits")).toBe("acceptEdits");
    expect(loopPermission("plan")).toBe("plan");
    expect(loopPermission("bypass")).toBe("auto");
  });
});

describe("runLoopTurn — the effort dial", () => {
  it("rides every turn to the engine, and the model's thinking reaches its own handler, never the answer", async () => {
    const eng = new FakeEngine([
      ev({ type: "thinking", chatId: "c1", text: "Let me " }), ev({ type: "thinking", chatId: "c1", text: "look." }),
      ev({ type: "delta", delta: "Done." }),
      ev({ type: "done", stopped: false }),
    ]);
    const h = handlers();
    const r = await runLoopTurn({ ...base, engine: eng, effort: "xhigh" }, h);
    expect(r).toEqual({ text: "Done.", stopped: false });
    expect(h.thoughts).toEqual(["Let me ", "look."]);
    expect(h.deltas).toEqual(["Done."]);
    expect(eng.turn?.effort).toBe("xhigh");
  });
  it("is absent from the turn when the TUI set none (the model's default)", async () => {
    const eng = new FakeEngine([ev({ type: "done", stopped: false })]);
    await runLoopTurn({ ...base, engine: eng }, handlers());
    expect(eng.turn).not.toHaveProperty("effort");
  });
  it("a thinking event with no handler is silently handled", async () => {
    const eng = new FakeEngine([ev({ type: "thinking", chatId: "c1", text: "hm" }), ev({ type: "done", stopped: false })]);
    const h = handlers();
    delete (h as Partial<LoopTurnHandlers>).onThinking;
    await expect(runLoopTurn({ ...base, engine: eng }, h)).resolves.toEqual({ text: "", stopped: false });
  });
});

describe("flags", () => {
  it("parses the desktop's launch line and a person's prompt", () => {
    expect(parseFlags(["--model", "claude-sonnet-5", "--permission", "plan", "fix", "the", "tests"])).toEqual({ model: "claude-sonnet-5", permission: "plan", prompt: "fix the tests" });
    expect(parseFlags(["--model=m", "--permission=bypass"])).toEqual({ model: "m", permission: "bypass" });
    expect(parseFlags([])).toEqual({});
  });
  it("every spelling of the modes maps; unknown words are ignored", () => {
    expect(permissionFlag("ask")).toBe("default");
    expect(permissionFlag("acceptEdits")).toBe("acceptEdits");
    expect(permissionFlag("readonly")).toBe("plan");
    expect(permissionFlag("auto")).toBe("bypass");
    expect(permissionFlag("bypassPermissions")).toBe("bypass");
    expect(permissionFlag("nope")).toBeUndefined();
    expect(parseFlags(["--permission", "nope"])).toEqual({});
    expect(parseFlags(["--dangerously-skip-permissions"])).toEqual({ permission: "bypass" });
    expect(parseFlags(["--trust", "--resume", "cmubx4a46", "--continue"])).toEqual({ trust: true, resume: "cmubx4a46", continueLast: true });
  });
  it("--effort takes the dial's five words, by word or by label", () => {
    expect(parseFlags(["--effort", "high", "go"])).toEqual({ effort: "high", prompt: "go" });
    expect(parseFlags(["--effort=max"])).toEqual({ effort: "max" });
    expect(parseFlags(["--effort", "Ultra"])).toEqual({ effort: "max" });
    expect(parseFlags(["--effort", "extra-high"])).toEqual({ effort: "xhigh" });
    expect(EFFORTS).toEqual(["low", "medium", "high", "xhigh", "max"]);
    expect(effortOf("nope")).toBeUndefined();
  });
  it("a bad --effort exits 2 and names the allowed list", () => {
    const err: string[] = [];
    const exit = vi.spyOn(process, "exit").mockImplementation(((code?: number) => { throw new Error(`exit ${code}`); }) as never);
    const write = vi.spyOn(process.stderr, "write").mockImplementation(((s: string) => { err.push(String(s)); return true; }) as never);
    try {
      expect(() => parseFlags(["--effort", "extreme"])).toThrow("exit 2");
      expect(() => parseFlags(["--effort"])).toThrow("exit 2");
      expect(err.join("")).toContain("--effort must be one of low, medium, high, xhigh, max");
    } finally {
      exit.mockRestore();
      write.mockRestore();
    }
  });
});
