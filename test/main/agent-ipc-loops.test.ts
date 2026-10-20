/**
 * agent-ipc-loops.test.ts — a turn runs on the chat's loop: Glyphh's own
 * when it names none, the CLI it names otherwise, and a loop that is unknown
 * or turned off is refused in words — never rerouted. The panel's controls
 * (stop, mode, approvals) reach whichever engine holds the chat.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-ipc-loops-"));
const folder = path.join(dir, "work");
fs.mkdirSync(folder, { recursive: true });

const handlers = new Map<string, (e: unknown, ...a: unknown[]) => unknown>();
vi.mock("electron", () => ({
  ipcMain: { handle: (ch: string, fn: (e: unknown, ...a: unknown[]) => unknown) => { handlers.set(ch, fn); } },
  webContents: { getAllWebContents: () => [] },
  dialog: {},
}));
vi.mock("../../src/main/app-paths", () => ({
  GLYPHH_DIR: path.join(dir, "machine"), getActiveUserId: () => "local", userScopedDir: () => dir, userScopedPath: (...s: string[]) => path.join(dir, ...s),
}));
vi.mock("../../src/main/local-mcp-server", () => ({ startLocalMcpServer: async () => ({ ok: true }) }));
vi.mock("../../src/main/cli-session-watch", () => ({ startCliSessionWatch: () => {} }));
vi.mock("../../src/main/cli-sessions", () => ({ cliTranscript: (id: string) => ({ ok: false, error: `no ${id}` }) }));
const enabled: Record<string, boolean> = {};
vi.mock("../../src/main/cli-agents", () => ({
  agentRowFor: (id: string) => ({ id, name: id === "claude" ? "Claude" : id, cli: id, cmd: id, model: "", mcp: true, cwd: "", session: "keep", permission: "ask", enabled: enabled[id] !== false }),
}));
const bridge = {
  runCliTurn: vi.fn(async () => ({ runId: "cli-run" })),
  stopCliChat: vi.fn(() => true),
  setCliPermission: vi.fn(() => false),
  isCliApproval: vi.fn((id: string) => id.includes(":cli-")),
  respondCliApproval: vi.fn(() => true),
  bindCliSession: vi.fn(() => true),
  cliSessionOf: vi.fn(() => "sid-claude"),
  cliChatKnown: vi.fn(() => false),
  cliChatUsage: vi.fn(() => null),
};
vi.mock("../../src/main/glyphh-cli-bridge", () => bridge);
const loop = {
  runGlyphhLoopTurn: vi.fn(async () => ({ runId: "loop-run" })),
  glyphhLoopHas: vi.fn(() => false),
  stopGlyphhLoop: vi.fn(() => true),
  setGlyphhLoopPermission: vi.fn(() => true),
  isGlyphhApproval: vi.fn((id: string) => /:g\d+$/.test(id)),
  respondGlyphhApproval: vi.fn(() => true),
  glyphhLoopUsage: vi.fn(() => ({ inTokens: 1, outTokens: 2, cacheRead: 3 })),
  compactGlyphhLoop: vi.fn(async () => ({ ok: true })),
};
vi.mock("../../src/main/glyphh-loop", () => loop);

const I = await import("../../src/main/agent-ipc");
I.registerAgentIpc();

function sender() {
  const sent: Array<[string, Record<string, unknown>]> = [];
  return { wc: { id: 1, isDestroyed: () => false, send: (ch: string, p: Record<string, unknown>) => { sent.push([ch, p]); } } as never, sent };
}

beforeEach(() => {
  for (const f of [...Object.values(bridge), ...Object.values(loop)]) f.mockClear();
  for (const k of Object.keys(enabled)) delete enabled[k];
  I.upsertStoredChat("c1", { title: "t", workdir: folder, messages: [{ role: "user", text: "do the thing" }] });
});

describe("a turn runs on the chat's loop", () => {
  it("no loop named: the Glyphh loop", async () => {
    const s = sender();
    expect(await I.runAgentTurn(s.wc, { chatId: "c1", workdir: folder })).toEqual({ runId: "loop-run" });
    expect(loop.runGlyphhLoopTurn).toHaveBeenCalledWith(s.wc, expect.objectContaining({ chatId: "c1" }), "do the thing");
    expect(bridge.runCliTurn).not.toHaveBeenCalled();
  });

  it("a CLI named: that CLI, with its persisted session, route and the chat's history", async () => {
    const s = sender();
    expect(await I.runAgentTurn(s.wc, { chatId: "c1", workdir: folder, loop: "claude", cliSessionId: "sid-1", route: { session: true }, permission: "plan", model: "m" })).toEqual({ runId: "cli-run" });
    expect(bridge.runCliTurn).toHaveBeenCalledWith(s.wc, expect.objectContaining({
      chatId: "c1", text: "do the thing", workdir: folder, permission: "plan", model: "m", cliSessionId: "sid-1", route: { session: true },
      row: expect.objectContaining({ cli: "claude" }), history: [expect.objectContaining({ role: "user", text: "do the thing" })],
    }));
    expect(loop.runGlyphhLoopTurn).not.toHaveBeenCalled();
  });

  it("an unknown loop is refused in words, and nothing runs", async () => {
    const s = sender();
    await I.runAgentTurn(s.wc, { chatId: "c1", workdir: folder, loop: "default" });
    expect(s.sent.map(([ch]) => ch)).toEqual(["glyphh-agent:error", "glyphh-agent:done"]);
    expect(String(s.sent[0]![1].error)).toContain('no "default" loop');
    expect(s.sent[1]![1]).toMatchObject({ stopped: true });
    expect(loop.runGlyphhLoopTurn).not.toHaveBeenCalled();
    expect(bridge.runCliTurn).not.toHaveBeenCalled();
  });

  it("a loop turned off is refused, never rerouted", async () => {
    enabled.codex = false;
    const s = sender();
    await I.runAgentTurn(s.wc, { chatId: "c1", workdir: folder, loop: "codex" });
    expect(String(s.sent[0]![1].error)).toContain("turned off in Settings");
    expect(bridge.runCliTurn).not.toHaveBeenCalled();
    expect(loop.runGlyphhLoopTurn).not.toHaveBeenCalled();
  });

  it("a CLI launch that cannot come up is said in the panel", async () => {
    bridge.runCliTurn.mockRejectedValueOnce(new Error("router failed to listen"));
    const s = sender();
    await I.runAgentTurn(s.wc, { chatId: "c1", workdir: folder, loop: "claude" });
    expect(String(s.sent[0]![1].error)).toBe("Claude could not start: router failed to listen");
  });

  it("still refuses a turn with no folder before anything else", async () => {
    await expect(I.runAgentTurn(sender().wc, { chatId: "c1", loop: "claude" })).rejects.toThrow(/NO_WORKDIR/);
  });
});

describe("the panel's controls reach the engine that holds the chat", () => {
  it("stop: our loop when it holds the chat, else the CLI", () => {
    loop.glyphhLoopHas.mockReturnValueOnce(true);
    expect(I.stopAgentChat("c1")).toBe(true);
    expect(loop.stopGlyphhLoop).toHaveBeenCalledWith("c1");
    expect(bridge.stopCliChat).not.toHaveBeenCalled();
    expect(I.stopAgentChat("c2")).toBe(true);
    expect(bridge.stopCliChat).toHaveBeenCalledWith("c2");
  });

  it("approvals: a CLI's id to the bridge, ours to the loop", () => {
    expect(I.respondAgentApproval("c1:cli-req-1", true)).toBe(true);
    expect(bridge.respondCliApproval).toHaveBeenCalledWith("c1:cli-req-1", true);
    expect(I.respondAgentApproval("c1:g3", false)).toBe(true);
    expect(loop.respondGlyphhApproval).toHaveBeenCalledWith("c1:g3", false);
    expect(I.respondAgentApproval("nobody", true)).toBe(false);
  });

  it("mode: a live CLI first, else our loop", () => {
    loop.glyphhLoopHas.mockReturnValueOnce(true);
    expect(I.setAgentPermission("c1", "auto")).toBe(true);
    expect(bridge.setCliPermission).toHaveBeenCalledWith("c1", "auto");
    expect(loop.setGlyphhLoopPermission).toHaveBeenCalledWith("c1", "auto");
  });
});

describe("the hop's channels", () => {
  it("session-of: the chat itself on the Glyphh loop, the bound session on a CLI", () => {
    const of = handlers.get("glyphh-agent-session-of")!;
    expect(of({}, { chatId: "c1", cli: "glyphh" })).toBe("c1");
    expect(of({}, { chatId: "c1", cli: "claude" })).toBe("sid-claude");
    expect(of({}, { chatId: "" })).toBeNull();
  });

  it("bind-session: a vendor CLI only", () => {
    const bind = handlers.get("glyphh-agent-bind-session")!;
    expect(bind({}, { chatId: "c1", cliSessionId: "s", cli: "codex" })).toBe(true);
    expect(bridge.bindCliSession).toHaveBeenCalledWith("c1", "codex", "s");
    expect(bind({}, { chatId: "c1", cliSessionId: "s", cli: "glyphh" })).toBe(false);
    expect(bind({}, { chatId: "c1", cliSessionId: "s", cli: "bogus" })).toBe(false);
  });

  it("compact: a CLI session compacts in its own terminal", async () => {
    const compact = handlers.get("glyphh-agent-compact")!;
    expect(await compact({}, { chatId: "c1", loop: "codex" })).toMatchObject({ ok: false, reason: expect.stringContaining("/compact") });
    expect(await compact({}, { chatId: "c1" })).toEqual({ ok: true });
  });
});
