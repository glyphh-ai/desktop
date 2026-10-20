import { describe, expect, it, vi } from "vitest";
import { createAgentLiveRegistry } from "../../src/main/agent-live-registry";

const run = (chatId: string, runId = `${chatId}:1`) => ({ chatId, cliSessionId: null, cli: "claude", runId, senderId: 7 });

describe("agent live registry", () => {
  it("lists a started chat and announces every change", () => {
    const announce = vi.fn();
    const reg = createAgentLiveRegistry(announce, () => 100);
    reg.start(run("a"));
    expect(reg.isRunning("a")).toBe(true);
    expect(reg.list()).toEqual([{ ...run("a"), startedAt: 100, status: "working" }]);
    expect(announce).toHaveBeenCalledTimes(1);
    reg.done("a");
    expect(reg.list()).toEqual([]);
    expect(announce).toHaveBeenCalledTimes(2);
  });

  it("keeps several chats running at once, oldest first", () => {
    let t = 0;
    const reg = createAgentLiveRegistry(() => {}, () => ++t);
    reg.start(run("b"));
    reg.start(run("a"));
    expect(reg.list().map((r) => r.chatId)).toEqual(["b", "a"]);
    reg.done("b");
    expect(reg.list().map((r) => r.chatId)).toEqual(["a"]);
  });

  it("a stale run's done never clears the newer turn; a bare done always does", () => {
    const reg = createAgentLiveRegistry(() => {});
    reg.start(run("a", "a:1"));
    reg.start(run("a", "a:2"));
    reg.done("a", "a:1");
    expect(reg.isRunning("a")).toBe(true);
    reg.done("a", "a:2");
    expect(reg.isRunning("a")).toBe(false);
    reg.start(run("a", "a:3"));
    reg.done("a");
    expect(reg.isRunning("a")).toBe(false);
  });

  it("update patches a running chat and stays quiet when nothing changed", () => {
    const announce = vi.fn();
    const reg = createAgentLiveRegistry(announce);
    reg.update("ghost", { cliSessionId: "x" });   // unknown chat: no-op
    expect(announce).not.toHaveBeenCalled();
    reg.start(run("a"));
    reg.update("a", { cliSessionId: "sid-1" });
    expect(reg.list()[0]?.cliSessionId).toBe("sid-1");
    expect(announce).toHaveBeenCalledTimes(2);
    reg.update("a", { cliSessionId: "sid-1" });
    expect(announce).toHaveBeenCalledTimes(2);
  });

  it("a restarted chat keeps its original start time", () => {
    let t = 10;
    const reg = createAgentLiveRegistry(() => {}, () => (t += 10));
    reg.start(run("a", "a:1"));
    reg.start(run("a", "a:2"));
    expect(reg.list()[0]).toMatchObject({ runId: "a:2", startedAt: 20 });
  });

  // HIS ORDER, 2026-09-29: green working, yellow waiting on the person, red
  // the last turn failed, and nothing on the ledger for an idle thread.
  it("carries the state, and a FAILED turn stays on the ledger while an ok one leaves", () => {
    const announce = vi.fn();
    const reg = createAgentLiveRegistry(announce, () => 5);
    reg.start(run("a"));
    expect(reg.list()[0]!.status).toBe("working");
    reg.update("a", { status: "waiting" });
    expect(reg.list()[0]!.status).toBe("waiting");
    expect(announce).toHaveBeenCalledTimes(2);
    reg.update("a", { status: "waiting" });
    expect(announce).toHaveBeenCalledTimes(2);   // nothing changed, nothing said
    reg.update("a", { status: "error" });
    reg.done("a", "a:1");
    expect(reg.list()[0]!.status).toBe("error");
    expect(reg.isRunning("a")).toBe(false);      // red, but not working
    reg.start(run("a", "a:2"));                  // the next turn clears the verdict
    expect(reg.list()[0]).toMatchObject({ status: "working", runId: "a:2" });
    reg.done("a", "a:2");
    expect(reg.list()).toEqual([]);
  });
});
