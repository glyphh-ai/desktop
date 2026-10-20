/**
 * The Glyphh loop end to end over a scripted gateway: a tool round runs a
 * built-in against a real temp folder, a shell step PARKS on an approval and
 * the answer resumes it, plan mode denies, the gateway-off and no-model
 * refusals read as themselves, stop aborts, and a lent MCP server's tools join
 * the toolset and are called by their real names.
 */
import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GlyphhLoop, GATEWAY_OFF_MESSAGE, NO_MODEL_MESSAGE, type LoopEvent } from "../../src/loop/loop.js";
import { MAX_TOOL_ROUNDS, roundsPausedMessage } from "../../src/loop/core.js";

type ToolCall = { id: string; name: string; input: unknown };
type Reply = { thinking?: { text: string; signature: string }; text?: string; tool?: ToolCall; tools?: ToolCall[]; stop: "end_turn" | "tool_use" };

/** SSE for one model reply. */
function sseReply(r: Reply): string {
  const ev = (e: string, d: unknown): string => `event: ${e}\ndata: ${JSON.stringify(d)}\n\n`;
  let out = ev("message_start", { type: "message_start", message: { usage: { input_tokens: 10 } } });
  let idx = 0;
  if (r.thinking) {
    out += ev("content_block_start", { type: "content_block_start", index: idx, content_block: { type: "thinking", thinking: "", signature: "" } });
    out += ev("content_block_delta", { type: "content_block_delta", index: idx, delta: { type: "thinking_delta", thinking: r.thinking.text } });
    out += ev("content_block_delta", { type: "content_block_delta", index: idx, delta: { type: "signature_delta", signature: r.thinking.signature } });
    out += ev("content_block_stop", { type: "content_block_stop", index: idx });
    idx++;
  }
  if (r.text) {
    out += ev("content_block_start", { type: "content_block_start", index: idx, content_block: { type: "text", text: "" } });
    out += ev("content_block_delta", { type: "content_block_delta", index: idx, delta: { type: "text_delta", text: r.text } });
    out += ev("content_block_stop", { type: "content_block_stop", index: idx });
    idx++;
  }
  for (const t of [...(r.tool ? [r.tool] : []), ...(r.tools ?? [])]) {
    out += ev("content_block_start", { type: "content_block_start", index: idx, content_block: { type: "tool_use", id: t.id, name: t.name, input: {} } });
    out += ev("content_block_delta", { type: "content_block_delta", index: idx, delta: { type: "input_json_delta", partial_json: JSON.stringify(t.input) } });
    out += ev("content_block_stop", { type: "content_block_stop", index: idx });
    idx++;
  }
  out += ev("message_delta", { type: "message_delta", delta: { stop_reason: r.stop }, usage: { output_tokens: 5 } });
  out += ev("message_stop", { type: "message_stop" });
  return out;
}

/** A scripted gateway (+ optional MCP server): replies in order; records bodies. */
function fakeWire(
  replies: Reply[],
  mcp?: { tools: Array<{ name: string; description: string }>; toolsFor?: (url: string) => Array<{ name: string; description: string }>; call: (name: string, args: unknown) => string },
  /** Per-model latency, so a test can prove two calls really overlapped. */
  delayByModel?: Record<string, number>,
) {
  const bodies: Array<Record<string, unknown>> = [];
  const mcpCalls: Array<{ name: string; args: unknown }> = [];
  const fetchLike = async (url: string, init: RequestInit): Promise<Response> => {
    if (url.endsWith("/v1/messages")) {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      bodies.push(body);
      // The reply is claimed when the request ARRIVES, then held for the
      // model's latency: two overlapping calls must not swap scripts.
      const r = replies.shift();
      const wait = delayByModel?.[String(body.model)] ?? 0;
      if (wait) await new Promise((res) => setTimeout(res, wait));
      if (!r) return new Response(JSON.stringify({ error: { message: "script exhausted" } }), { status: 500 });
      return new Response(sseReply(r), { status: 200, headers: { "content-type": "text/event-stream" } });
    }
    if (url.endsWith("/mcp") && mcp) {
      const req = JSON.parse(String(init.body)) as { id?: number; method: string; params?: { name?: string; arguments?: unknown } };
      if (req.method === "notifications/initialized") return new Response(null, { status: 202 });
      const result = req.method === "initialize" ? { protocolVersion: "2025-03-26", capabilities: {}, serverInfo: { name: "fake" } }
        : req.method === "tools/list" ? { tools: (mcp.toolsFor ? mcp.toolsFor(url) : mcp.tools).map((t) => ({ ...t, inputSchema: { type: "object", properties: {} } })) }
        : req.method === "tools/call" ? (mcpCalls.push({ name: req.params?.name ?? "", args: req.params?.arguments }), { content: [{ type: "text", text: mcp.call(req.params?.name ?? "", req.params?.arguments) }] })
        : {};
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: req.id, result }), { status: 200, headers: { "content-type": "application/json", "mcp-session-id": "s1" } });
    }
    return new Response("not found", { status: 404 });
  };
  return { fetchLike, bodies, mcpCalls };
}

const gateway = async () => ({ baseUrl: "https://gw", token: "k" });

/** A folder for turns that are not ABOUT the folder: a Code turn now refuses
 *  to run without one (the session is sandboxed to it). */
const SCRATCH = mkdtempSync(join(tmpdir(), "gl-scratch-"));

/** The engine's behaviour is under test here, not the OS sandbox (which
 *  cannot nest inside the sandbox these tests may themselves run in); the
 *  sandbox has its own tests. */
const plainShell = (sh: string, cmd: string) => ({ file: sh, args: ["-lc", cmd], sandboxed: false });

async function collect(loop: GlyphhLoop, turn: Parameters<GlyphhLoop["run"]>[0], onEvent?: (ev: LoopEvent, loop: GlyphhLoop) => void): Promise<LoopEvent[]> {
  const events: LoopEvent[] = [];
  const t = turn.workdir || turn.space === "work" ? turn : { ...turn, workdir: SCRATCH };
  await loop.run(t, (ev) => { events.push(ev); onEvent?.(ev, loop); });
  return events;
}

describe("GlyphhLoop", () => {
  it("refuses without a gateway credential, and without a model, in its own words", async () => {
    const off = new GlyphhLoop({ shell: plainShell, gateway: async () => null });
    const e1 = await collect(off, { chatId: "c1", text: "hi", model: "m" });
    expect(e1.map((e) => e.type)).toEqual(["error", "done"]);
    expect((e1[0] as { error: string }).error).toBe(GATEWAY_OFF_MESSAGE);
    const on = new GlyphhLoop({ shell: plainShell, gateway });
    const e2 = await collect(on, { chatId: "c2", text: "hi", model: "" });
    expect((e2[0] as { error: string }).error).toBe(NO_MODEL_MESSAGE);
  });

  it("runs a tool round against the working folder and streams the answer", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gl-"));
    writeFileSync(join(dir, "a.txt"), "alpha\n");
    const wire = fakeWire([
      { text: "Reading.", tool: { id: "t1", name: "read_file", input: { path: "a.txt" } }, stop: "tool_use" },
      { text: "It says alpha.", stop: "end_turn" },
    ]);
    const loop = new GlyphhLoop({ shell: plainShell, gateway, fetch: wire.fetchLike, host: "terminal" });
    const events = await collect(loop, { chatId: "c", text: "what is in a.txt?", model: "claude-x", workdir: dir, permission: "ask" });
    const types = events.map((e) => e.type);
    expect(types[0]).toBe("setup");
    expect(types).toContain("delta");
    const tools = events.filter((e) => e.type === "tool");
    expect(tools).toHaveLength(2);
    expect(tools[0]).toEqual({ type: "tool", phase: "start", name: "read_file", title: "read_file a.txt", runId: expect.any(String) });
    // The done frame says what the step did, for the host to draw.
    expect(tools[1]).toMatchObject({ type: "tool", phase: "done", name: "read_file", title: "read_file a.txt", failed: false, preview: "alpha", detail: { kind: "read", lines: 2 } });
    expect(events[events.length - 1]).toEqual({ type: "done", stopped: false, runId: expect.any(String) });
    // The second request carried the tool result and the cached system prompt.
    const second = wire.bodies[1]!;
    const msgs = second.messages as Array<{ role: string; content: unknown }>;
    // The newest message carries the conversation's cache breakpoint on the
    // wire (his question, 2026-10-07): the transcript before it is read back.
    expect(msgs[msgs.length - 1]).toEqual({ role: "user", content: [{ type: "tool_result", tool_use_id: "t1", is_error: false, content: "alpha\n", cache_control: { type: "ephemeral" } }] });
    expect(msgs[0]).toEqual({ role: "user", content: "what is in a.txt?" });   // earlier turns stay bare: ONE breakpoint, always the newest
    expect((wire.bodies[0]!.messages as Array<{ content: unknown }>)[0]!.content).toEqual([{ type: "text", text: "what is in a.txt?", cache_control: { type: "ephemeral" } }]);
    expect((second.system as Array<{ cache_control?: unknown; text: string }>)[0]!.cache_control).toEqual({ type: "ephemeral" });
    expect((second.system as Array<{ text: string }>)[0]!.text).toContain("terminal");
    expect(second.model).toBe("claude-x");
    expect(loop.has("c")).toBe(true);
  });

  it("standing text is a second CACHED system block; recalled facts ride the user's message (2026-10-07)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gl-"));
    const wire = fakeWire([{ text: "ok", stop: "end_turn" }]);
    const loop = new GlyphhLoop({
      shell: plainShell, gateway, fetch: wire.fetchLike,
      standing: async () => "Be brief.",
      facts: async (q) => `You remember: ${q} was asked before.`,
    });
    await collect(loop, { chatId: "s", text: "hi", model: "claude-x", workdir: dir, permission: "ask" });
    const body = wire.bodies[0]!;
    const system = body.system as Array<{ text: string; cache_control?: unknown }>;
    expect(system).toHaveLength(2);
    expect(system[1]).toEqual({ type: "text", text: "Be brief.", cache_control: { type: "ephemeral" } });
    const first = (body.messages as Array<{ role: string; content: unknown }>)[0]!;
    expect(first.content).toEqual([
      { type: "text", text: "hi" },
      { type: "text", text: "You remember: hi was asked before.", cache_control: { type: "ephemeral" } },
    ]);
  });

  it("a shell step PARKS on an approval; the answer resumes it; a denial is a tool_result the model sees", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gl-"));
    const wire = fakeWire([
      { tool: { id: "t1", name: "bash", input: { command: "echo hi" } }, stop: "tool_use" },
      { tool: { id: "t2", name: "bash", input: { command: "echo no" } }, stop: "tool_use" },
      { text: "done", stop: "end_turn" },
    ]);
    const loop = new GlyphhLoop({ shell: plainShell, gateway, fetch: wire.fetchLike });
    let asked = 0;
    const events = await collect(loop, { chatId: "c", text: "run", model: "m", workdir: dir, permission: "ask" }, (ev, l) => {
      if (ev.type === "approval") {
        asked++;
        expect(GlyphhLoop.isApproval(ev.id)).toBe(true);
        expect(ev.kind).toBe("command");
        // allow the first, deny the second — answered on a later tick like a UI would
        setTimeout(() => l.respondApproval(ev.id, asked === 1), 0);
      }
    });
    expect(asked).toBe(2);
    const dones = events.filter((e): e is Extract<LoopEvent, { type: "tool"; phase: "done" }> => e.type === "tool" && e.phase === "done");
    expect(dones[0]!.failed).toBe(false);
    expect(dones[0]!.preview).toContain("hi");
    expect(dones[1]!.failed).toBe(true);
    expect(dones[1]!.preview).toBe("not permitted in this mode");
    const third = wire.bodies[2]!.messages as Array<{ content: unknown }>;
    expect(third[third.length - 1]!.content).toEqual([{ type: "tool_result", tool_use_id: "t2", is_error: true, content: "The user declined this step.", cache_control: { type: "ephemeral" } }]);
  });

  it("plan mode denies edits without asking, and reads freely", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gl-"));
    const wire = fakeWire([
      { tool: { id: "t1", name: "write_file", input: { path: "x", content: "y" } }, stop: "tool_use" },
      { tool: { id: "t2", name: "list_dir", input: {} }, stop: "tool_use" },
      { text: "ok", stop: "end_turn" },
    ]);
    const loop = new GlyphhLoop({ shell: plainShell, gateway, fetch: wire.fetchLike });
    const events = await collect(loop, { chatId: "c", text: "go", model: "m", workdir: dir, permission: "plan" });
    expect(events.some((e) => e.type === "approval")).toBe(false);
    const dones = events.filter((e): e is Extract<LoopEvent, { type: "tool"; phase: "done" }> => e.type === "tool" && e.phase === "done");
    expect(dones.map((d) => [d.name, d.failed])).toEqual([["write_file", true], ["list_dir", false]]);
  });

  it("a turn that reaches the step limit SAYS it paused, and continue resumes with its steps in context (his report, 2026-10-08)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gl-"));
    writeFileSync(join(dir, "a.txt"), "alpha\n");
    const step = (i: number): Reply => ({ tool: { id: `t${i}`, name: "read_file", input: { path: "a.txt" } }, stop: "tool_use" });
    const wire = fakeWire([
      ...Array.from({ length: MAX_TOOL_ROUNDS }, (_, i) => step(i)),
      { text: "Carrying on: done.", stop: "end_turn" },
    ]);
    const loop = new GlyphhLoop({ shell: plainShell, gateway, fetch: wire.fetchLike });
    const first = await collect(loop, { chatId: "c", text: "do a long job", model: "m", workdir: dir, permission: "auto" });
    expect(wire.bodies).toHaveLength(MAX_TOOL_ROUNDS);
    const said = first.filter((e) => e.type === "delta").map((e) => (e as { delta: string }).delta).join("");
    expect(said).toBe(roundsPausedMessage(MAX_TOOL_ROUNDS));
    expect(first[first.length - 1]).toEqual({ type: "done", stopped: false, runId: expect.any(String) });
    // "continue": the next request still carries the last step's result, then
    // the pause note as the assistant's word, then the new message.
    await collect(loop, { chatId: "c", text: "continue", model: "m", workdir: dir, permission: "auto" });
    const msgs = wire.bodies[MAX_TOOL_ROUNDS]!.messages as Array<{ role: string; content: unknown }>;
    expect(msgs.slice(-3).map((m) => m.role)).toEqual(["user", "assistant", "user"]);
    expect(JSON.stringify(msgs[msgs.length - 3]!.content)).toContain(`"tool_use_id":"t${MAX_TOOL_ROUNDS - 1}"`);
    expect(JSON.stringify(msgs[msgs.length - 2]!.content)).toContain("paused after");
  });

  it("a turn that fails reports the error and is NOT settled as stopped", async () => {
    const broken = async (): Promise<Response> =>
      new Response(JSON.stringify({ error: { type: "invalid_request_error", message: "gateway said no" } }), { status: 400, headers: { "content-type": "application/json" } });
    const loop = new GlyphhLoop({ shell: plainShell, gateway, fetch: broken });
    const events: LoopEvent[] = [];
    await loop.run({ workdir: SCRATCH, chatId: "c", text: "hi", model: "m" }, (ev) => events.push(ev));
    expect(events.some((e) => e.type === "error")).toBe(true);
    expect(events[events.length - 1]).toEqual({ type: "done", stopped: false, runId: expect.any(String) });
  });

  it("stop() aborts a running turn and settles it as stopped", async () => {
    const wire = fakeWire([{ text: "…", stop: "end_turn" }]);
    const slow = async (url: string, init: RequestInit): Promise<Response> => {
      await new Promise((r, j) => { const t = setTimeout(r, 200); init.signal?.addEventListener("abort", () => { clearTimeout(t); j(new Error("aborted")); }); });
      return wire.fetchLike(url, init);
    };
    const loop = new GlyphhLoop({ shell: plainShell, gateway, fetch: slow });
    const events: LoopEvent[] = [];
    const p = loop.run({ workdir: SCRATCH, chatId: "c", text: "hi", model: "m" }, (ev) => events.push(ev));
    await new Promise((r) => setTimeout(r, 20));
    expect(loop.stop("c")).toBe(true);
    await p;
    expect(events[events.length - 1]).toEqual({ type: "done", stopped: true, runId: expect.any(String) });
    expect(events.some((e) => e.type === "error")).toBe(false);
  });

  it("lends MCP servers: their tools join the toolset under safe names and are called by their real names", async () => {
    const wire = fakeWire(
      [{ tool: { id: "t1", name: "mcp_tool_search", input: { query: "gmail" } }, stop: "tool_use" }, { text: "found", stop: "end_turn" }],
      { tools: [{ name: "mcp_tool_search", description: "find a tool" }, { name: "weird/name", description: "x" }], call: (name, args) => `${name}:${JSON.stringify(args)}` },
    );
    const loop = new GlyphhLoop({
      gateway, fetch: wire.fetchLike,
      mcpServers: async () => [{ name: "glyphh-app", url: "https://gw/mcp", headers: { authorization: "Bearer k" }, tag: "Glyphh" }],
    });
    // default mode: a SEARCH is a read by name, so it runs without an approval
    const events = await collect(loop, { chatId: "c", text: "find gmail", model: "m", permission: "ask" });
    expect(events.some((e) => e.type === "approval")).toBe(false);
    const tools = (wire.bodies[0]!.tools as Array<{ name: string }>).map((t) => t.name);
    expect(tools).toContain("read_file");
    expect(tools).toContain("mcp_tool_search");
    expect(tools).toContain("weird_name");
    expect(wire.mcpCalls).toEqual([{ name: "mcp_tool_search", args: { query: "gmail" } }]);
    const done = events.find((e) => e.type === "tool" && e.phase === "done") as { preview: string };
    expect(done.preview).toContain("mcp_tool_search:");
  });

  it("toolNames lists the toolset after a turn, and compactNow folds the conversation into a summary", async () => {
    const wire = fakeWire([
      { text: "hi there", stop: "end_turn" },
      { text: "SUMMARY: greeted", stop: "end_turn" },
    ]);
    const loop = new GlyphhLoop({ shell: plainShell, gateway, fetch: wire.fetchLike });
    expect(loop.toolNames("c")).toEqual([]);
    expect((await loop.compactNow("c")).ok).toBe(false);
    await collect(loop, { chatId: "c", text: "hello", model: "m" });
    expect(loop.toolNames("c")).toContain("bash");
    const events: LoopEvent[] = [];
    const r = await loop.compactNow("c", (ev) => events.push(ev));
    expect(r).toEqual({ ok: true });
    expect(events.some((e) => e.type === "delta" && e.delta.includes("compacted"))).toBe(true);
    // The summary request went to the gateway with the chat's model.
    expect(wire.bodies[1]!.model).toBe("m");
    expect(String((wire.bodies[1]!.messages as Array<{ content: string }>)[0]!.content)).toContain("user: hello");
  });

  it("THE BELT IS FIXED; everything else is FOUND (his order, 2026-09-29: the tool list must scale with installs and connections)", async () => {
    const wire = fakeWire(
      [
        { tool: { id: "t1", name: "find_tools", input: { query: "schedule a task every Monday" } }, stop: "tool_use" },
        { tool: { id: "t2", name: "call_tool", input: { name: "schedule_save", arguments: { cron: "0 9 * * 1" } } }, stop: "tool_use" },
        { tool: { id: "t3", name: "call_tool", input: { name: "gmail_send_email", arguments: { to: "sam@x.co" } } }, stop: "tool_use" },
        { tool: { id: "t4", name: "call_tool", input: { name: "happy_shoes_add_to_cart", arguments: { sku: "A1" } } }, stop: "tool_use" },
        { text: "done", stop: "end_turn" },
        { text: "hi", stop: "end_turn" },
      ],
      {
        tools: [],
        toolsFor: (url) => url.startsWith("https://local")
          ? [{ name: "panels_open", description: "open a panel" }, { name: "schedule_save", description: "save a schedule that runs a task on a clock" }]
          // A member key lists the gateway's search pair, never the catalog.
          : [{ name: "mcp_tool_search", description: "find a tool" }, { name: "mcp_tool_call", description: "call it" }],
        call: (name, args) => name === "mcp_tool_search" ? JSON.stringify([{ name: "gmail_send_email", description: "send mail" }]) : `${name}:${JSON.stringify(args)}`,
      },
    );
    const appRuns: unknown[] = [];
    const loop = new GlyphhLoop({
      gateway, fetch: wire.fetchLike, shell: plainShell,
      mcpServers: async () => [
        { name: "glyphh-app", url: "https://local/mcp", tag: "Glyphh", core: { work: new Set(["panels_open"]), code: new Set(["panels_open"]) } },
        { name: "gateway", url: "https://gw/mcp", tag: "connection" },
      ],
      catalog: async () => [{
        name: "happy_shoes_add_to_cart", description: "Add a sneaker to the cart", family: "app: Happy Shoes",
        run: async (args) => { appRuns.push(args); return { text: "added", failed: false }; },
      }],
      skills: async () => [{ slug: "build-glyphh-app", name: "Build a Glyphh app", description: "Author a Glyphh app bundle" }],
      // The host keeps artifacts, so the artifact pair rides the belt (never called here).
      artifacts: { publish: async () => { throw new Error("not in this test"); }, read: async () => { throw new Error("not in this test"); } },
    });
    const events = await collect(loop, { chatId: "codey", text: "set it up", model: "m", space: "code", permission: "auto" });
    const code = (wire.bodies[0]!.tools as Array<{ name: string; description: string }>);
    const names = code.map((t) => t.name);
    // The belt: the builtins, the host's core, the one pair. Nothing that grows.
    expect(names).toContain("read_file");
    expect(names).toContain("panels_open");
    expect(names).toContain("find_tools");
    expect(names).toContain("call_tool");
    for (const hidden of ["schedule_save", "gmail_send_email", "mcp_tool_search", "mcp_tool_call", "happy_shoes_add_to_cart"]) expect(names).not.toContain(hidden);
    // The map tells the model what exists before it searches.
    expect(code.find((t) => t.name === "find_tools")!.description).toContain("app: Happy Shoes (1)");
    // The prompt says how to reach the rest, and indexes the skills.
    const system = (wire.bodies[0]!.system as Array<{ text: string }>)[0]!.text;
    expect(system).toContain("find_tools searches everything else");
    expect(system).toContain("- build-glyphh-app: Author a Glyphh app bundle");
    // One search answers from the machine AND the connected accounts.
    const found = JSON.parse(String((wire.bodies[1]!.messages as Array<{ content: unknown }>).at(-1)!.content && (wire.bodies[1]!.messages as Array<{ content: Array<{ content: string }> }>).at(-1)!.content[0]!.content));
    expect(found.on_this_machine.map((t: { name: string }) => t.name)).toEqual(["schedule_save"]);
    expect(found.connected_accounts).toEqual([{ name: "gmail_send_email", description: "send mail" }]);
    // call_tool routes each to where it lives, under its real name.
    expect(wire.mcpCalls).toEqual([
      { name: "mcp_tool_search", args: { query: "schedule a task every Monday", top_k: 8 } },
      { name: "schedule_save", args: { cron: "0 9 * * 1" } },
      { name: "mcp_tool_call", args: { tool_name: "gmail_send_email", arguments: { to: "sam@x.co" } } },
    ]);
    expect(appRuns).toEqual([{ sku: "A1" }]);
    // The step view names the tool that ran, not the pair.
    const titles = events.filter((e) => e.type === "tool" && e.phase === "done").map((e) => (e as { title: string }).title);
    expect(titles.some((t) => t.startsWith("schedule_save"))).toBe(true);
    // WORK: the same belt without the builtins; the publish tool rides in both spaces.
    await collect(loop, { chatId: "worky", text: "hello", model: "m", space: "work" });
    expect((wire.bodies[5]!.tools as Array<{ name: string }>).map((t) => t.name).sort()).toEqual(["artifact_publish", "artifact_read", "call_tool", "find_tools", "panels_open"]);
  });

  it("a find_tools that matches nothing says so, and the working set ranks a used tool first", async () => {
    const { searchCatalog } = await import("../../src/loop/catalog.js");
    const run = async () => ({ text: "", failed: false });
    const entries = [
      { name: "tasks_list", description: "List the user's tasks", family: "tasks", run },
      { name: "task_run", description: "Run one of the user's tasks now", family: "tasks", run },
    ];
    expect(searchCatalog(entries, "run a task", 5, new Map()).map((e) => e.name)).toEqual(["task_run", "tasks_list"]);
    expect(searchCatalog(entries, "list tasks", 5, new Map([["task_run", 1]])).map((e) => e.name)[0]).toBe("tasks_list");
    expect(searchCatalog(entries, "tasks", 5, new Map([["task_run", 1]])).map((e) => e.name)[0]).toBe("task_run");
    expect(searchCatalog(entries, "the and", 5, new Map())).toEqual([]);
  });

  it("spawns a sub-agent on ITS OWN model, briefs it, and hands its answer back", async () => {
    // His order, 2026-09-29: "I just want the local agent to spawn sub-agents
    // based on definitions the user can create with model slots running our
    // full agent loop." The slot is the point: the child runs on its own model.
    const wire = fakeWire([
      { tool: { id: "t1", name: "spawn_agent", input: { agent: "researcher", task: "find the pricing page" } }, stop: "tool_use" },
      { text: "pricing is at /pricing", stop: "end_turn" },   // the child's own turn
      { text: "Found it: /pricing", stop: "end_turn" },        // the parent, with the answer
    ]);
    const loop = new GlyphhLoop({
      gateway, fetch: wire.fetchLike,
      agents: async () => [{ slug: "researcher", name: "Researcher", description: "Reads the web", prompt: "You research and report facts.", model: "cheap-model" }],
    });
    const events = await collect(loop, { chatId: "swarm", text: "where is pricing?", model: "big-model" });

    // The child's request went out on the agent's model, with its brief.
    expect(wire.bodies[1]!.model).toBe("cheap-model");
    const childSystem = (wire.bodies[1]!.system as Array<{ text: string }>).map((b) => b.text).join("\n");
    expect(childSystem).toContain("You research and report facts.");
    expect(childSystem).toContain('You are "Researcher"');
    // A child cannot spawn: one level of fan-out.
    expect((wire.bodies[1]!.tools as Array<{ name: string }>).map((t) => t.name)).not.toContain("spawn_agent");
    // The parent's next call carries the child's answer as the tool result.
    expect(JSON.stringify(wire.bodies[2]!.messages)).toContain("pricing is at /pricing");
    // And the host was told, by name and model, so it can render the child.
    const start = events.find((e) => e.type === "agent" && e.phase === "start") as { agent: { name: string; model: string }; task: string };
    expect(start.agent).toMatchObject({ slug: "researcher", name: "Researcher", model: "cheap-model" });
    expect(start.task).toBe("find the pricing page");
    const fin = events.find((e) => e.type === "agent" && e.phase === "done") as { failed: boolean; summary: string };
    expect(fin.failed).toBe(false);
    expect(fin.summary).toContain("pricing");
    // The child's own steps ride the parent's run, tagged with the child.
    const childDelta = events.find((e) => e.type === "delta" && (e as { agent?: { slug: string } }).agent?.slug === "researcher");
    expect(childDelta).toBeTruthy();
  });

  it("runs two agents asked for in ONE message at the same time", async () => {
    // The slow agent is asked for FIRST. Run in series its answer would land
    // first; in parallel the fast one finishes while the slow one is waiting.
    const wire = fakeWire(
      [
        {
          tools: [
            { id: "t1", name: "spawn_agent", input: { agent: "slow", task: "a" } },
            { id: "t2", name: "spawn_agent", input: { agent: "fast", task: "b" } },
          ],
          stop: "tool_use",
        },
        { text: "slow done", stop: "end_turn" },
        { text: "fast done", stop: "end_turn" },
        { text: "both back", stop: "end_turn" },
      ],
      undefined,
      { "slow-model": 60, "fast-model": 1 },
    );
    const loop = new GlyphhLoop({
      gateway, fetch: wire.fetchLike,
      agents: async () => [
        { slug: "slow", name: "Slow", prompt: "You are slow.", model: "slow-model" },
        { slug: "fast", name: "Fast", prompt: "You are fast.", model: "fast-model" },
      ],
    });
    const events = await collect(loop, { chatId: "pair", text: "do both", model: "big-model" });
    const finished = events
      .filter((e): e is LoopEvent & { type: "agent"; phase: "done"; agent: { slug: string } } => e.type === "agent" && e.phase === "done")
      .map((e) => e.agent.slug);
    expect(finished).toEqual(["fast", "slow"]);
    // Both answers reach the parent, in the order the model asked for them.
    const sent = JSON.stringify(wire.bodies[3]!.messages);
    expect(sent.indexOf("slow done")).toBeLessThan(sent.indexOf("fast done"));
  });

  it("a CLI agent is run headless by the host, with the brief's model and the chat's folder (his order, 2026-10-07)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gl-"));
    const wire = fakeWire([
      { tool: { id: "t1", name: "spawn_agent", input: { agent: "coder", task: "fix the typo", context: "in README" } }, stop: "tool_use" },
      { text: "done", stop: "end_turn" },
    ]);
    const ran: unknown[] = [];
    const loop = new GlyphhLoop({
      shell: plainShell, gateway, fetch: wire.fetchLike,
      agents: async () => [{ slug: "coder", name: "Coder", kind: "cli", cli: "claude", prompt: "You fix code.", model: "claude-sonnet" }],
      runCliAgent: async (def, task, opts) => { ran.push({ cli: def.cli, task, model: opts.model, workdir: opts.workdir }); return { text: "typo fixed", failed: false }; },
    });
    const events = await collect(loop, { chatId: "cli", text: "go", model: "m", workdir: dir, permission: "auto" });
    expect(ran).toEqual([{ cli: "claude", task: "fix the typo\n\nContext from the main agent:\nin README", model: "claude-sonnet", workdir: dir }]);
    // The spawn tool names the kind so the model knows what it is handing work to.
    const spawn = (wire.bodies[0]!.tools as Array<{ name: string; description: string }>).find((t) => t.name === "spawn_agent")!;
    expect(spawn.description).toContain("a claude agent, run headless on this machine on claude-sonnet");
    // No loop child ran: only the parent's two requests went out, and the answer rode the tool_result.
    expect(wire.bodies).toHaveLength(2);
    expect(JSON.stringify(wire.bodies[1]!.messages)).toContain("typo fixed");
    const done = events.find((e) => e.type === "agent" && e.phase === "done") as { failed: boolean; summary: string };
    expect(done).toMatchObject({ failed: false, summary: "typo fixed" });
    // A host without the seam says so instead of running the loop in its place.
    const wire2 = fakeWire([
      { tool: { id: "t1", name: "spawn_agent", input: { agent: "coder", task: "x" } }, stop: "tool_use" },
      { text: "ok", stop: "end_turn" },
    ]);
    const bare = new GlyphhLoop({ shell: plainShell, gateway, fetch: wire2.fetchLike, agents: async () => [{ slug: "coder", name: "Coder", kind: "cli", cli: "codex", prompt: "p" }] });
    await collect(bare, { chatId: "cli2", text: "go", model: "m", workdir: dir, permission: "auto" });
    expect(JSON.stringify(wire2.bodies[1]!.messages)).toContain("cannot run one headless");
  });

  it("an agent made mid-conversation can be handed work on the next turn", async () => {
    // His order, 2026-09-29: agents are made from any surface, including an
    // agent_save the loop itself calls. The belt is cached per chat, so the
    // host says the roster changed and the next turn is built with it.
    let roster: Array<{ slug: string; name: string; prompt: string }> = [];
    const wire = fakeWire([{ text: "one", stop: "end_turn" }, { text: "two", stop: "end_turn" }]);
    const loop = new GlyphhLoop({ shell: plainShell, gateway, fetch: wire.fetchLike, agents: async () => roster });
    await collect(loop, { chatId: "mid", text: "hello", model: "m" });
    expect((wire.bodies[0]!.tools as Array<{ name: string }>).map((t) => t.name)).not.toContain("spawn_agent");
    roster = [{ slug: "researcher", name: "Researcher", prompt: "You research." }];
    loop.invalidateTools();
    await collect(loop, { chatId: "mid", text: "again", model: "m" });
    expect((wire.bodies[1]!.tools as Array<{ name: string }>).map((t) => t.name)).toContain("spawn_agent");
    // Same conversation: the first turn is still in the context.
    expect(JSON.stringify(wire.bodies[1]!.messages)).toContain("hello");
  });

  it("a member with no agents pays nothing for the feature", async () => {
    const wire = fakeWire([{ text: "hi", stop: "end_turn" }]);
    const loop = new GlyphhLoop({ shell: plainShell, gateway, fetch: wire.fetchLike, agents: async () => [] });
    await collect(loop, { chatId: "solo", text: "hello", model: "m" });
    expect((wire.bodies[0]!.tools as Array<{ name: string }>).map((t) => t.name)).not.toContain("spawn_agent");
  });

  it("a message sent mid-turn rides the NEXT turn; forgetAll drops every chat", async () => {
    // His report, 2026-09-23: typing while the agent works must not be refused
    // — it waits its turn and goes out when this one settles.
    const wire = fakeWire([{ text: "one", stop: "end_turn" }, { text: "two", stop: "end_turn" }]);
    const slow = async (url: string, init: RequestInit): Promise<Response> => { await new Promise((r) => setTimeout(r, 50)); return wire.fetchLike(url, init); };
    const loop = new GlyphhLoop({ shell: plainShell, gateway, fetch: slow });
    const first = loop.run({ workdir: SCRATCH, chatId: "c", text: "one", model: "m" }, () => undefined);
    await new Promise((r) => setTimeout(r, 5));
    const second: LoopEvent[] = [];
    await loop.run({ workdir: SCRATCH, chatId: "c", text: "two", model: "m" }, (ev) => second.push(ev));
    expect(second).toEqual([]);   // queued, not refused
    await first;
    await new Promise((r) => setTimeout(r, 120));   // the drained turn runs
    const sent = wire.bodies.at(-1)!.messages as Array<{ role: string; content: unknown }>;
    expect(sent.at(-1)).toEqual({ role: "user", content: [{ type: "text", text: "two", cache_control: { type: "ephemeral" } }] });   // the wire's cache breakpoint rides the newest message
    // A chat with nothing to say while busy still gets the busy answer.
    const busy: LoopEvent[] = [];
    const running = loop.run({ workdir: SCRATCH, chatId: "c", text: "three", model: "m" }, () => undefined);
    await new Promise((r) => setTimeout(r, 5));
    await loop.run({ workdir: SCRATCH, chatId: "c", text: "", model: "m" }, (ev) => busy.push(ev));
    expect(busy[0]!.type).toBe("error");
    await running;
    loop.forgetAll();
    expect(loop.has("c")).toBe(false);
  });
});

describe("the effort dial (his order, 2026-10-04: it returns to the desktop and reaches the model through the gateway)", () => {
  it("a turn's effort rides the model round as reasoning_effort, is kept for the next turn, and a new value replaces it", async () => {
    const wire = fakeWire([
      { text: "one", stop: "end_turn" },
      { text: "two", stop: "end_turn" },
      { text: "three", stop: "end_turn" },
      { text: "four", stop: "end_turn" },
    ]);
    const loop = new GlyphhLoop({ shell: plainShell, gateway, fetch: wire.fetchLike });
    await collect(loop, { chatId: "e", text: "a", model: "m" });
    expect(wire.bodies[0]).not.toHaveProperty("reasoning_effort");
    await collect(loop, { chatId: "e", text: "b", model: "m", effort: "high" });
    expect(wire.bodies[1]!.reasoning_effort).toBe("high");
    expect(wire.bodies[1]!.max_tokens).toBe(wire.bodies[0]!.max_tokens);
    // The chat keeps the dial when a turn does not set it.
    await collect(loop, { chatId: "e", text: "c", model: "m" });
    expect(wire.bodies[2]!.reasoning_effort).toBe("high");
    await collect(loop, { chatId: "e", text: "d", model: "m", effort: "low" });
    expect(wire.bodies[3]!.reasoning_effort).toBe("low");
  });

  it("a compaction never carries the effort", async () => {
    const wire = fakeWire([
      { text: "hi there", stop: "end_turn" },
      { text: "SUMMARY: greeted", stop: "end_turn" },
    ]);
    const loop = new GlyphhLoop({ shell: plainShell, gateway, fetch: wire.fetchLike });
    await collect(loop, { chatId: "c", text: "hello", model: "m", effort: "max" });
    expect(wire.bodies[0]!.reasoning_effort).toBe("max");
    expect((await loop.compactNow("c")).ok).toBe(true);
    expect(wire.bodies[1]).not.toHaveProperty("reasoning_effort");
  });

  it("a thinking block is shown as a thinking event and replays whole, signature included, on the tool round", async () => {
    const wire = fakeWire([
      { thinking: { text: "I should read it.", signature: "sig-abc" }, tool: { id: "t1", name: "read_file", input: { path: "a.txt" } }, stop: "tool_use" },
      { text: "done", stop: "end_turn" },
    ]);
    const dir = mkdtempSync(join(tmpdir(), "gl-think-"));
    writeFileSync(join(dir, "a.txt"), "x");
    const loop = new GlyphhLoop({ shell: plainShell, gateway, fetch: wire.fetchLike });
    const events = await collect(loop, { chatId: "t", text: "read a.txt", model: "m", workdir: dir, effort: "medium" });
    const thought = events.find((e) => e.type === "thinking") as { chatId: string; text: string } | undefined;
    expect(thought).toMatchObject({ type: "thinking", chatId: "t", text: "I should read it." });
    // The reasoning never leaks into the answer text.
    expect(events.filter((e) => e.type === "delta").map((e) => (e as { delta: string }).delta).join("")).not.toContain("I should read it.");
    // The second request replays the assistant message verbatim: the thinking
    // block, text and signature intact, ahead of the tool_use.
    const msgs = wire.bodies[1]!.messages as Array<{ role: string; content: unknown }>;
    const assistant = msgs.find((m) => m.role === "assistant")!;
    expect(assistant.content).toEqual([
      { type: "thinking", thinking: "I should read it.", signature: "sig-abc" },
      { type: "tool_use", id: "t1", name: "read_file", input: { path: "a.txt" } },
    ]);
  });

  it("a sub-agent inherits the parent's effort unless its definition sets one", async () => {
    const wire = fakeWire([
      {
        tools: [
          { id: "t1", name: "spawn_agent", input: { agent: "inherits", task: "a" } },
          { id: "t2", name: "spawn_agent", input: { agent: "own", task: "b" } },
        ],
        stop: "tool_use",
      },
      { text: "a done", stop: "end_turn" },
      { text: "b done", stop: "end_turn" },
      { text: "both back", stop: "end_turn" },
    ]);
    const loop = new GlyphhLoop({
      gateway, fetch: wire.fetchLike,
      agents: async () => [
        { slug: "inherits", name: "Inherits", prompt: "You inherit.", model: "m-inherit" },
        { slug: "own", name: "Own", prompt: "You dial your own.", model: "m-own", effort: "low" },
      ],
    });
    await collect(loop, { chatId: "swarm-effort", text: "go", model: "big", effort: "xhigh" });
    const byModel = Object.fromEntries(wire.bodies.map((b) => [String(b.model), b.reasoning_effort]));
    expect(byModel["big"]).toBe("xhigh");
    expect(byModel["m-inherit"]).toBe("xhigh");
    expect(byModel["m-own"]).toBe("low");
  });
});

describe("A HOST TOOL ON THE BELT (2026-10-07: the worker's app doors)", () => {
  it("a catalog entry marked belt rides the belt by name and runs through runTool; the rest of the catalog is still found", async () => {
    const wire = fakeWire(
      [
        { tool: { id: "t1", name: "glyphh_app_scaffold", input: { name: "Inbox Pulse" } }, stop: "tool_use" },
        { text: "done", stop: "end_turn" },
      ],
      { tools: [], toolsFor: () => [], call: () => "" },
    );
    const runs: unknown[] = [];
    const loop = new GlyphhLoop({
      gateway, fetch: wire.fetchLike, shell: plainShell,
      mcpServers: async () => [],
      catalog: async () => [
        { name: "glyphh_app_scaffold", description: "write the starter", family: "apps", belt: true, run: async (args) => { runs.push(args); return { text: JSON.stringify({ dir: "/w/inbox-pulse" }), failed: false }; } },
        { name: "happy_shoes_add_to_cart", description: "Add a sneaker to the cart", family: "app: Happy Shoes", run: async () => ({ text: "added", failed: false }) },
      ],
    });
    const events = await collect(loop, { chatId: "belt", text: "build it", model: "m", space: "code", permission: "auto" });
    const names = (wire.bodies[0]!.tools as Array<{ name: string }>).map((t) => t.name);
    expect(names).toContain("glyphh_app_scaffold");
    expect(names).not.toContain("happy_shoes_add_to_cart");
    expect(names).toContain("find_tools");
    expect(runs).toEqual([{ name: "Inbox Pulse" }]);
    expect(events.some((e) => e.type === "tool" && e.phase === "done" && e.name === "glyphh_app_scaffold" && !e.failed)).toBe(true);
  });
});

describe("a dropped stream is not a failed turn (his report, 2026-10-08)", () => {
  it("retries the round once when fetch says `terminated` before anything streamed", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gl-"));
    const wire = fakeWire([{ text: "all good", stop: "end_turn" }]);
    let dropped = 0;
    const flaky = async (url: string, init: RequestInit): Promise<Response> => {
      if (url.endsWith("/v1/messages") && dropped === 0) { dropped++; throw new TypeError("terminated"); }
      return wire.fetchLike(url, init);
    };
    const loop = new GlyphhLoop({ shell: plainShell, gateway, fetch: flaky });
    const events = await collect(loop, { chatId: "drop", text: "hi", model: "m", workdir: dir, permission: "auto" });
    expect(events.some((e) => e.type === "error")).toBe(false);
    expect(events.filter((e) => e.type === "delta").map((e) => (e as { delta: string }).delta).join("")).toBe("all good");
    expect(dropped).toBe(1);
  });
  it("a drop after text reached the member stands as the error it is; a gateway refusal is never retried", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gl-"));
    const half = new ReadableStream<Uint8Array>({
      start(ctl) {
        const enc = new TextEncoder();
        ctl.enqueue(enc.encode(`event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { usage: { input_tokens: 1 } } })}\n\n`));
        ctl.enqueue(enc.encode(`event: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } })}\n\n`));
        ctl.enqueue(enc.encode(`event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "partial" } })}\n\n`));
      },
      // The drop comes AFTER the queued chunks were read (erroring in start()
      // would discard the queue and nothing would have streamed).
      pull(ctl) { ctl.error(new TypeError("terminated")); },
    });
    let calls = 0;
    const midway = async (): Promise<Response> => { calls++; return new Response(half, { status: 200, headers: { "content-type": "text/event-stream" } }); };
    const loop = new GlyphhLoop({ shell: plainShell, gateway, fetch: midway });
    const events = await collect(loop, { chatId: "mid", text: "hi", model: "m", workdir: dir, permission: "auto" });
    expect(events.some((e) => e.type === "error")).toBe(true);
    expect(calls).toBe(1);
    let refusals = 0;
    const refusing = async (): Promise<Response> => { refusals++; return new Response(JSON.stringify({ error: { message: "budget exceeded" } }), { status: 402 }); };
    const loop2 = new GlyphhLoop({ shell: plainShell, gateway, fetch: refusing });
    const ev2 = await collect(loop2, { chatId: "ref", text: "hi", model: "m", workdir: dir, permission: "auto" });
    expect(ev2.some((e) => e.type === "error")).toBe(true);
    expect(refusals).toBe(1);
  });

  it("a catalog entry marked ask asks even in Auto; a readOnly one runs without asking; Plan denies the ask one", async () => {
    const runs: string[] = [];
    const entries = () => [
      { name: "crm_delete_contact", description: "Delete a contact", family: "connection: CRM", ask: true, run: async () => { runs.push("delete"); return { text: "deleted", failed: false }; } },
      { name: "crm_list_contacts", description: "List contacts", family: "connection: CRM", readOnly: true, run: async () => { runs.push("list"); return { text: "[]", failed: false }; } },
    ];
    const wire = fakeWire([
      { tools: [
        { id: "t1", name: "call_tool", input: { name: "crm_delete_contact", arguments: { id: 1 } } },
        { id: "t2", name: "call_tool", input: { name: "crm_list_contacts", arguments: {} } },
      ], stop: "tool_use" },
      { text: "done", stop: "end_turn" },
      { tool: { id: "t3", name: "call_tool", input: { name: "crm_delete_contact", arguments: { id: 2 } } }, stop: "tool_use" },
      { text: "done", stop: "end_turn" },
    ]);
    const loop = new GlyphhLoop({ gateway, fetch: wire.fetchLike, shell: plainShell, catalog: async () => entries() });
    const asked: string[] = [];
    await collect(loop, { chatId: "ask-auto", text: "tidy", model: "m", permission: "auto" }, (ev, l) => {
      if (ev.type === "approval") { asked.push(ev.title); setTimeout(() => l.respondApproval(ev.id, true), 0); }
    });
    expect(asked).toHaveLength(1);
    expect(asked[0]).toContain("crm_delete_contact");
    expect(runs.sort()).toEqual(["delete", "list"]);
    runs.length = 0;
    const plan = await collect(loop, { chatId: "ask-plan", text: "tidy", model: "m", permission: "plan" });
    expect(plan.some((e) => e.type === "approval")).toBe(false);
    expect(runs).toEqual([]);
  });
});
