/**
 * cli-bridge.test.ts — the vendor CLIs as chat engines (glyphh-cli-bridge.ts):
 * claude's stream-json frames and codex's JSONL events onto the panel's
 * channels, the approval round trip on claude's control channel, a stop that
 * is never a failure, and the per-CLI session binding a chat resumes on.
 *
 * The CLI processes are fakes: what the bridge writes to stdin is recorded,
 * and the test plays the CLI's side on stdout.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

const ledger = { start: vi.fn(), update: vi.fn(), done: vi.fn() };
vi.mock("../../src/main/agent-live", () => ({
  agentLive: ledger,
  noteRunDelta: () => {},
  registerRunRebinder: () => {},
}));
const commitBackgroundTurn = vi.fn();
vi.mock("../../src/main/agent-ipc", () => ({ commitBackgroundTurn: (...a: unknown[]) => commitBackgroundTurn(...a) }));
vi.mock("../../src/main/glyphh-agent-attachments", () => ({ validAttachments: (a: unknown) => (Array.isArray(a) ? a : []) }));
let route: "direct" | "gateway" = "direct";
vi.mock("../../src/main/cli-agents", () => ({
  RESUMABLE_HEADLESS: new Set(["codex"]),
  prepareCliLaunch: async () => ({ route, mcp: true }),
  launchModel: (_row: unknown, _route: string, picked?: string) => picked ?? "",
  composeClaudeChat: (_row: unknown, o: { model: string; resumeId?: string }) => `claude-chat model=${o.model} resume=${o.resumeId ?? ""}`,
  composeHeadless: (row: { cli: string }, prompt: string, o: { resumeId?: string }) => `${row.cli}-turn resume=${o.resumeId ?? ""} prompt=${prompt}`,
  withPriorTurns: (_h: unknown, text: string) => `[prior] ${text}`,
}));

/** A CLI process the test drives: stdin is captured, stdout is ours to write. */
class FakeProc extends EventEmitter {
  stdin = { write: vi.fn((_s: string) => true), end: vi.fn() };
  stdout = new PassThrough();
  stderr = new PassThrough();
  exitCode: number | null = null;
  kill = vi.fn(() => { this.exit(null); return true; });
  line = "";
  /** One stream-json / JSONL frame from the CLI. */
  say(frame: object | string): void { this.stdout.emit("data", Buffer.from(`${typeof frame === "string" ? frame : JSON.stringify(frame)}\n`)); }
  exit(code: number | null): void { this.exitCode = code ?? 143; this.emit("exit", code); }
  written(): Array<Record<string, unknown>> { return this.stdin.write.mock.calls.map((c) => JSON.parse(String(c[0])) as Record<string, unknown>); }
}
const procs: FakeProc[] = [];
vi.mock("node:child_process", () => ({
  spawn: (_sh: string, args: string[]) => { const p = new FakeProc(); p.line = args[args.length - 1] ?? ""; procs.push(p); return p; },
}));

const B = await import("../../src/main/glyphh-cli-bridge");

/** A panel: every frame it was sent, by channel. */
function panel() {
  const sent: Array<[string, Record<string, unknown>]> = [];
  let destroyed = false;
  const wc = { id: 7, isDestroyed: () => destroyed, send: (ch: string, p: Record<string, unknown>) => { sent.push([ch, p]); } };
  return { wc: wc as never, sent, close: () => { destroyed = true; }, of: (ch: string) => sent.filter(([c]) => c === `glyphh-agent:${ch}`).map(([, p]) => p) };
}

const ROW = (cli: string) => ({ id: cli, name: cli[0]!.toUpperCase() + cli.slice(1), cli, cmd: cli, model: "", mcp: true, cwd: "", session: "keep", permission: "ask", enabled: true }) as never;
let n = 0;
const turn = (cli: string, over: Record<string, unknown> = {}) => ({ chatId: `chat-${++n}`, row: ROW(cli), text: "hello", history: [], workdir: "/", permission: "ask" as const, ...over });

beforeEach(() => {
  B.shutdownGlyphhCliBridge();
  procs.length = 0;
  ledger.start.mockClear(); ledger.update.mockClear(); ledger.done.mockClear();
  commitBackgroundTurn.mockClear();
  route = "direct";
});

describe("claude — stream-json onto the panel's channels", () => {
  it("writes the user turn as a stream-json user message and marks the chat running", async () => {
    const p = panel();
    const t = turn("claude", { text: "hi there" });
    const { runId } = await B.runCliTurn(p.wc, t);
    expect(procs).toHaveLength(1);
    expect(procs[0]!.written()[0]).toEqual({ type: "user", message: { role: "user", content: [{ type: "text", text: "hi there" }] } });
    expect(ledger.start).toHaveBeenCalledWith(expect.objectContaining({ chatId: t.chatId, cli: "claude", runId }));
  });

  it("init names the session: bound per CLI, announced on setup for the renderer to persist", async () => {
    const p = panel();
    const t = turn("claude");
    await B.runCliTurn(p.wc, t);
    procs[0]!.say({ type: "system", subtype: "init", session_id: "sid-1", model: "claude-opus-5-5" });
    expect(p.of("setup")).toEqual([{ phase: "ready", chatId: expect.any(String), cli: "claude", route: "direct", model: "claude-opus-5-5", cliSessionId: "sid-1" }]);
    expect(B.cliSessionOf(t.chatId, "claude")).toBe("sid-1");
    expect(B.cliSessionOf(t.chatId, "codex")).toBeNull();
  });

  it("streams text deltas, opens and closes tool cards, and reports usage", async () => {
    const p = panel();
    const { runId } = await B.runCliTurn(p.wc, turn("claude"));
    const c = procs[0]!;
    c.say({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "Hel" } } });
    c.say({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "input_json_delta", partial_json: "{" } } });
    c.say({ type: "stream_event", event: { type: "content_block_start", content_block: { type: "tool_use", name: "Bash" } } });
    c.say({ type: "user", message: { content: [{ type: "tool_result", is_error: true }] } });
    c.say({ type: "stream_event", event: { type: "message_delta", usage: { output_tokens: 12 } } });
    c.say("not json — a keep-alive");
    expect(p.of("delta")).toEqual([{ runId, delta: "Hel" }]);
    expect(p.of("tool")).toEqual([{ runId, phase: "start", name: "Bash", title: "Bash" }, { runId, phase: "done", failed: true }]);
    expect(p.of("progress")).toEqual([{ runId, inTokens: 0, outTokens: 12 }]);
  });

  it("a success result ends the turn; the process stays for the next send", async () => {
    const p = panel();
    const t = turn("claude");
    const { runId } = await B.runCliTurn(p.wc, t);
    procs[0]!.say({ type: "result", subtype: "success", usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 50 } });
    expect(p.of("done")).toEqual([{ runId, stopped: false }]);
    expect(p.of("error")).toEqual([]);
    expect(B.cliChatUsage(t.chatId)).toEqual({ inTokens: 100, outTokens: 20, cacheRead: 50 });
    const second = await B.runCliTurn(p.wc, { ...t, text: "again" });
    expect(procs).toHaveLength(1);
    expect(second.runId).not.toBe(runId);
    expect(procs[0]!.written()[1]).toMatchObject({ type: "user" });
  });

  it("an error result says what went wrong in the user's words, with the sign-in fix when the login ran out", async () => {
    const p = panel();
    const { runId } = await B.runCliTurn(p.wc, turn("claude"));
    procs[0]!.say({ type: "result", subtype: "error_during_execution", is_error: true, result: "Failed to authenticate: OAuth session expired" });
    const [err] = p.of("error");
    expect(err).toMatchObject({ runId, fix: { kind: "signin", command: "claude" } });
    expect(String(err!.error)).toContain("login has expired");
    expect(p.of("done")).toEqual([{ runId, stopped: false }]);
    expect(ledger.update).toHaveBeenCalledWith(expect.any(String), { status: "error" });
  });

  it("an interrupt the CLI reports is a stop, not a failure", async () => {
    const p = panel();
    const { runId } = await B.runCliTurn(p.wc, turn("claude"));
    procs[0]!.say({ type: "result", subtype: "error_during_execution", is_error: true, result: "Request interrupted by user" });
    expect(p.of("error")).toEqual([]);
    expect(p.of("done")).toEqual([{ runId, stopped: true }]);
  });

  it("stop interrupts on the control channel, settles the run once, and keeps the process", async () => {
    const p = panel();
    const t = turn("claude");
    const { runId } = await B.runCliTurn(p.wc, t);
    expect(B.stopCliChat(t.chatId)).toBe(true);
    expect(procs[0]!.written().at(-1)).toMatchObject({ type: "control_request", request: { subtype: "interrupt" } });
    // The CLI's own is_error answer to the interrupt is ours, not an error.
    procs[0]!.say({ type: "result", subtype: "error_during_execution", is_error: true, result: "the run failed" });
    expect(p.of("error")).toEqual([]);
    expect(p.of("done")).toEqual([{ runId, stopped: true }]);
    expect(procs[0]!.kill).not.toHaveBeenCalled();
  });

  it("asks the panel before a tool runs, and answers the CLI with the person's choice", async () => {
    const p = panel();
    const t = turn("claude");
    await B.runCliTurn(p.wc, t);
    procs[0]!.say({ type: "control_request", request_id: "req-9", request: { subtype: "can_use_tool", tool_name: "Write", input: { path: "a.txt" } } });
    const [ask] = p.of("approval");
    expect(ask).toMatchObject({ id: `${t.chatId}:cli-req-9`, kind: "tool", title: "Write" });
    expect(String(ask!.detail)).toContain("a.txt");
    expect(B.isCliApproval(String(ask!.id))).toBe(true);
    expect(ledger.update).toHaveBeenCalledWith(t.chatId, { status: "waiting" });
    expect(B.respondCliApproval(String(ask!.id), false)).toBe(true);
    expect(procs[0]!.written().at(-1)).toEqual({ type: "control_response", response: { subtype: "success", request_id: "req-9", response: { behavior: "deny", message: "The user declined." } } });
    expect(B.respondCliApproval(String(ask!.id), true)).toBe(false);   // answered once
  });

  it("an allowed step carries no updatedInput at all (a null fails the CLI's validation)", async () => {
    const p = panel();
    const t = turn("claude");
    await B.runCliTurn(p.wc, t);
    procs[0]!.say({ type: "control_request", request_id: "r1", request: { subtype: "can_use_tool", tool_name: "Bash", input: {} } });
    B.respondCliApproval(`${t.chatId}:cli-r1`, true);
    expect(procs[0]!.written().at(-1)).toEqual({ type: "control_response", response: { subtype: "success", request_id: "r1", response: { behavior: "allow" } } });
  });

  it("Auto mode answers an ask itself — no card for a person who was promised none", async () => {
    const p = panel();
    await B.runCliTurn(p.wc, turn("claude", { permission: "auto" }));
    procs[0]!.say({ type: "control_request", request_id: "r2", request: { subtype: "can_use_tool", tool_name: "mcp__glyphh__panels_open" } });
    expect(p.of("approval")).toEqual([]);
    expect(procs[0]!.written().at(-1)).toMatchObject({ type: "control_response", response: { request_id: "r2", response: { behavior: "allow" } } });
  });

  it("a mode change mid-chat rides the control channel", async () => {
    const p = panel();
    const t = turn("claude");
    await B.runCliTurn(p.wc, t);
    expect(B.setCliPermission(t.chatId, "acceptEdits")).toBe(true);
    expect(procs[0]!.written().at(-1)).toMatchObject({ type: "control_request", request: { subtype: "set_permission_mode", mode: "acceptEdits" } });
    expect(p.of("permission")).toEqual([expect.objectContaining({ permission: "acceptEdits" })]);
  });

  it("a new model respawns the process on --resume of the same session; the old exit is quiet", async () => {
    const p = panel();
    const t = turn("claude", { model: "claude-opus-5-5" });
    await B.runCliTurn(p.wc, t);
    procs[0]!.say({ type: "system", subtype: "init", session_id: "sid-r" });
    procs[0]!.say({ type: "result", subtype: "success" });
    await B.runCliTurn(p.wc, { ...t, model: "claude-haiku-5-5" });
    expect(procs).toHaveLength(2);
    expect(procs[0]!.kill).toHaveBeenCalled();
    expect(procs[1]!.line).toBe("claude-chat model=claude-haiku-5-5 resume=sid-r");
    expect(p.of("error")).toEqual([]);
  });

  it("a route change respawns it too: the env is the process's for life", async () => {
    const p = panel();
    const t = turn("claude");
    await B.runCliTurn(p.wc, t);
    route = "gateway";
    await B.runCliTurn(p.wc, t);
    expect(procs).toHaveLength(2);
  });

  it("a crash says the CLI's own words, filtered of traces", async () => {
    const p = panel();
    const { runId } = await B.runCliTurn(p.wc, turn("claude"));
    procs[0]!.stderr.emit("data", Buffer.from("    at Object.<anonymous> (cli.js:1:1)\nError: something broke\n"));
    procs[0]!.exit(1);
    expect(p.of("error")).toEqual([{ runId, error: "Error: something broke" }]);
    expect(p.of("done")).toEqual([{ runId, stopped: false }]);
  });

  it("a turn nobody is listening to is committed by main", async () => {
    const p = panel();
    const t = turn("claude");
    await B.runCliTurn(p.wc, t);
    procs[0]!.say({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "the answer" } } });
    p.close();
    procs[0]!.say({ type: "result", subtype: "success" });
    expect(commitBackgroundTurn).toHaveBeenCalledWith(t.chatId, "the answer");
  });
});

describe("the binding a chat resumes on", () => {
  it("re-primes from the chat's persisted session after a restart", async () => {
    const p = panel();
    await B.runCliTurn(p.wc, turn("claude", { cliSessionId: "persisted" }));
    expect(procs[0]!.line).toContain("resume=persisted");
  });

  it("binds a session for the next cold start, never over a live process's own", async () => {
    expect(B.bindCliSession("chat-x", "codex", "sid-x")).toBe(true);
    expect(B.cliSessionOf("chat-x", "codex")).toBe("sid-x");
    expect(B.cliChatKnown("chat-x")).toBe(true);
    const p = panel();
    const t = turn("claude");
    await B.runCliTurn(p.wc, t);
    procs[0]!.say({ type: "system", subtype: "init", session_id: "live-sid" });
    expect(B.bindCliSession(t.chatId, "claude", "other")).toBe(false);
    expect(B.bindCliSession(t.chatId, "claude", "live-sid")).toBe(true);
    expect(B.bindCliSession("", "claude", "x")).toBe(false);
  });
});

describe("codex — JSONL onto the panel's channels", () => {
  it("maps thread, messages, items and usage", () => {
    expect(B.codexFrames({ type: "thread.started", thread_id: "th-1" }, "r")).toEqual({ sessionId: "th-1", frames: [] });
    expect(B.codexFrames({ type: "item.completed", item: { type: "agent_message", text: "Done." } }, "r").frames).toEqual([{ channel: "glyphh-agent:delta", payload: { runId: "r", delta: "Done.\n\n" } }]);
    expect(B.codexFrames({ type: "item.started", item: { type: "command_execution", command: "ls -la" } }, "r").frames).toEqual([{ channel: "glyphh-agent:tool", payload: { runId: "r", phase: "start", name: "command_execution", title: "ls -la" } }]);
    expect(B.codexFrames({ type: "item.started", item: { type: "mcp_tool_call", server: "glyphh", tool: "panels_open" } }, "r").frames[0]!.payload.title).toBe("glyphh: panels_open");
    expect(B.codexFrames({ type: "item.completed", item: { type: "command_execution", status: "failed" } }, "r").frames).toEqual([{ channel: "glyphh-agent:tool", payload: { runId: "r", phase: "done", failed: true } }]);
    expect(B.codexFrames({ type: "turn.completed", usage: { input_tokens: 9, output_tokens: 3 } }, "r").frames).toEqual([{ channel: "glyphh-agent:progress", payload: { runId: "r", inTokens: 9, outTokens: 3 } }]);
  });

  it("reads the older `msg` wrapping too, and skips what the panel has no card for", () => {
    expect(B.codexFrames({ msg: { type: "agent_message", message: "hi", session_id: "s-old" } }, "r")).toEqual({ sessionId: "s-old", frames: [{ channel: "glyphh-agent:delta", payload: { runId: "r", delta: "hi\n\n" } }] });
    expect(B.codexFrames({ type: "item.started", item: { type: "agent_message", text: "partial" } }, "r").frames).toEqual([]);
    expect(B.codexFrames({ type: "item.completed", item: { type: "reasoning", text: "thinking" } }, "r").frames).toEqual([]);
  });

  it("a turn streams its JSONL, captures the session, and the next send resumes it", async () => {
    const p = panel();
    const t = turn("codex");
    const { runId } = await B.runCliTurn(p.wc, t);
    const c = procs[0]!;
    expect(c.stdin.end).toHaveBeenCalled();
    expect(c.line).toBe("codex-turn resume= prompt=[prior] hello");
    c.say({ type: "thread.started", thread_id: "th-9" });
    c.say({ type: "item.completed", item: { type: "agent_message", text: "All set." } });
    c.exit(0);
    expect(p.of("delta")).toEqual([{ runId, delta: "All set.\n\n" }]);
    expect(p.of("setup").at(-1)).toMatchObject({ cli: "codex", cliSessionId: "th-9" });
    expect(p.of("done")).toEqual([{ runId, stopped: false }]);
    await B.runCliTurn(p.wc, { ...t, text: "more" });
    expect(procs[1]!.line).toBe("codex-turn resume=th-9 prompt=more");
  });

  it("a stopped turn is killed and settled once, never reported as failed", async () => {
    const p = panel();
    const t = turn("codex");
    const { runId } = await B.runCliTurn(p.wc, t);
    expect(B.stopCliChat(t.chatId)).toBe(true);
    expect(procs[0]!.kill).toHaveBeenCalled();
    expect(p.of("error")).toEqual([]);
    expect(p.of("done")).toEqual([{ runId, stopped: true }]);
  });
});

describe("print-mode CLIs with no session to resume", () => {
  it("stream their text as it arrives, told the conversation so far", async () => {
    const p = panel();
    const t = turn("gemini", { attachments: [{ kind: "file", path: "/tmp/a.txt", name: "a.txt" }] });
    const { runId } = await B.runCliTurn(p.wc, t);
    expect(procs[0]!.line).toBe("gemini-turn resume= prompt=[prior] hello\n\n@/tmp/a.txt");
    procs[0]!.stdout.emit("data", Buffer.from("line one\nline "));
    procs[0]!.stdout.emit("data", Buffer.from("two\n"));
    procs[0]!.exit(0);
    expect(p.of("delta").map((d) => d.delta).join("")).toBe("line one\nline two\n");
    expect(p.of("done")).toEqual([{ runId, stopped: false }]);
  });

  it("a failed exit is explained, with the CLI's own line kept", async () => {
    const p = panel();
    await B.runCliTurn(p.wc, turn("cursor"));
    procs[0]!.stderr.emit("data", Buffer.from("Error: rate limit exceeded (429)\n"));
    procs[0]!.exit(2);
    const [err] = p.of("error");
    expect(String(err!.error)).toContain("rate limiting");
    expect(String(err!.error)).toContain("cursor said: Error: rate limit exceeded (429)");
  });

  it("nothing to send is no turn at all", async () => {
    const p = panel();
    await B.runCliTurn(p.wc, turn("gemini", { text: "  " }));
    expect(procs).toHaveLength(0);
  });
});

describe("cliStderrSummary — what a failed turn says", () => {
  it("keeps the CLI's sentences and drops traces and JSON bodies", () => {
    const raw = ["2026-10-19 rmcp::transport::worker: closed", '{"error":{"message":"x"}}', "    at foo (bar.js:1:1)", "codex_core::util: retry", "Error: model not found", ""].join("\n");
    expect(B.cliStderrSummary(raw)).toBe("Error: model not found");
  });

  it("caps a dump at a few lines", () => {
    const raw = Array.from({ length: 20 }, (_, i) => `line ${i}`).join("\n");
    expect(B.cliStderrSummary(raw).split("\n")).toHaveLength(6);
  });
});

