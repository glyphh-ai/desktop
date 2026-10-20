/**
 * cli-agents.test.ts — every line a loop is launched with: the terminal's,
 * Claude's stream-json chat lane, the print-mode turns, the unattended lane —
 * on both routes and in both shell dialects — plus the loop records and the
 * launch preparation that brings the route's router up.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "cli-agents-"));
const userDir = path.join(home, "user");
const osHome = path.join(home, "home");

vi.mock("electron", () => ({ ipcMain: { handle: () => {} }, app: { getAppPath: () => home }, webContents: { getAllWebContents: () => [] } }));
vi.mock("../../src/main/app-paths", () => ({ userScopedPath: (...s: string[]) => path.join(userDir, ...s) }));
vi.mock("node:os", async (orig) => {
  const real = await orig<typeof import("node:os")>();
  return { ...real, default: { ...real, homedir: () => osHome }, homedir: () => osHome };
});
vi.mock("os", async (orig) => {
  const real = await orig<typeof import("node:os")>();
  return { ...real, default: { ...real, homedir: () => osHome }, homedir: () => osHome };
});
let mcpUp = true;
vi.mock("../../src/main/local-mcp-server", () => ({
  startLocalMcpServer: async () => (mcpUp ? { ok: true } : { ok: false, error: "port busy" }),
  localMcpStatus: () => ({ running: mcpUp, port: 4777 }),
  localMcpGenToken: () => ({ token: "local-token" }),
  localMcpTokenValid: (t: string) => t === "local-token",
}));
const prefs = new Map<string, unknown>();
vi.mock("../../src/main/stores/preferences-db", () => ({ getPreference: (k: string, d: unknown) => (prefs.has(k) ? prefs.get(k) : d) }));
let chatModels = ["anthropic::claude-opus-5-5", "openai::gpt-5.1"];
vi.mock("../../src/main/providers", () => ({
  readStoredProviders: () => ({
    providers: [{ id: "anthropic", kind: "anthropic", name: "Anthropic" }, { id: "openai", kind: "openai", name: "OpenAI" }],
    models: chatModels.map((id) => ({ id, provider: id.split("::")[0], model: id.split("::")[1], type: "chat" })),
    defaults: {},
  }),
  defaultModel: () => chatModels[0] ?? "",
  hasChatModel: () => chatModels.length > 0,
}));
vi.mock("../../src/main/working-directory", () => ({ getWorkingDirectory: () => "" }));
let bundledCli: string | null = null;
vi.mock("../../src/main/bundled-cli", () => ({ bundledGlyphhCli: () => bundledCli }));
vi.mock("../../src/main/broadcast", () => ({ broadcast: () => {} }));
const routerEndpoint = vi.fn(async () => ({ url: "http://127.0.0.1:52011", token: "glyphh-router-secret" }));
vi.mock("../../src/main/router-server", () => ({ routerEndpoint: () => routerEndpoint() }));

const A = await import("../../src/main/cli-agents");
const row = (id: Parameters<typeof A.agentRowFor>[0]) => A.agentRowFor(id)!;
const ENV_FILE = path.join(userDir, "loops", "claude", "env");
const MCP_FILE = path.join(userDir, "loops", "claude", "mcp.json");

beforeEach(() => {
  fs.rmSync(userDir, { recursive: true, force: true });
  fs.rmSync(osHome, { recursive: true, force: true });
  fs.mkdirSync(osHome, { recursive: true });
  prefs.clear();
  chatModels = ["anthropic::claude-opus-5-5", "openai::gpt-5.1"];
  mcpUp = true;
  bundledCli = null;
  routerEndpoint.mockClear();
});

describe("the loop records", () => {
  it("every loop exists on its defaults before anything is saved, Glyphh first", () => {
    const rows = A.listCliAgents();
    expect(rows.map((r) => r.id)).toEqual(["glyphh", "claude", "codex", "gemini", "copilot", "cursor"]);
    expect(row("cursor")).toMatchObject({ cmd: "cursor-agent", mcp: true, session: "keep", permission: "ask", enabled: true, model: "" });
    expect(A.agentRowFor("custom")).toBeNull();
  });

  it("says what each loop can do", () => {
    const by = Object.fromEntries(A.listCliAgents().map((r) => [r.id, r]));
    expect(by.claude!.gatewayCapable).toBe(true);
    expect(by.codex!.gatewayCapable).toBe(false);
    expect(by.claude!.headless && by.codex!.headless && by.gemini!.headless).toBe(true);
    expect(by.cursor!.headless).toBe(false);
  });

  it("a save patches only what it names", () => {
    A.saveAgent({ id: "codex", model: "gpt-5.1" });
    A.saveAgent({ id: "codex", permission: "safe" });
    expect(row("codex")).toMatchObject({ model: "gpt-5.1", permission: "safe", cmd: "codex" });
  });

  it("a loop can be turned off — except Glyphh, the default every chat falls to", () => {
    A.saveAgent({ id: "gemini", enabled: false });
    expect(row("gemini").enabled).toBe(false);
    expect(() => A.saveAgent({ id: "glyphh", enabled: false })).toThrow(/cannot be turned off/);
    expect(() => A.saveAgent({ id: "codex", cmd: "  " })).toThrow(/needs a command/);
    expect(() => A.saveAgent({ id: "nope" })).toThrow(/unknown loop/);
  });

  it("ignores values a record cannot hold", () => {
    fs.mkdirSync(path.join(userDir, "loops", "claude"), { recursive: true });
    fs.writeFileSync(path.join(userDir, "loops", "claude", "agent.json"), JSON.stringify({ session: "forever", permission: "yolo", cmd: "", enabled: false }));
    expect(row("claude")).toMatchObject({ session: "keep", permission: "ask", cmd: "claude", enabled: false });
  });
});

describe("modes — what a surface may offer", () => {
  it("offers Ask in the panel only where the loop has a prompt route", () => {
    expect(A.modesFor("claude", "panel")).toEqual(["ask", "plan", "acceptEdits", "auto"]);
    expect(A.modesFor("glyphh", "panel")).toEqual(["ask", "plan", "acceptEdits", "auto"]);
    expect(A.modesFor("codex", "panel")).toEqual(["plan", "acceptEdits", "auto"]);
    expect(A.modesFor("gemini", "panel")).toEqual(["acceptEdits", "auto"]);
  });

  it("always offers Ask in a terminal, where the CLI prompts for itself", () => {
    expect(A.modesFor("gemini", "terminal")).toEqual(["ask", "acceptEdits", "auto"]);
  });
});

describe("composeCommand — what the terminal plays", () => {
  it("claude direct: its own login, the router's variables dropped, our MCP as the whole surface", () => {
    const line = A.composeCommand(row("claude"), {}, "direct", "posix");
    expect(line.startsWith('case "$ANTHROPIC_AUTH_TOKEN" in glyphh-router-*) unset ANTHROPIC_BASE_URL ANTHROPIC_AUTH_TOKEN;; esac; claude')).toBe(true);
    expect(line).toContain(`--mcp-config "${MCP_FILE}" --strict-mcp-config`);
    expect(line).not.toContain(ENV_FILE);
    expect(line).not.toContain("--model");
  });

  it("claude gateway: the env file sourced, the shadowing key dropped, the router model on --model and every alias", () => {
    const line = A.composeCommand(row("claude"), { model: "openai::gpt-5.1" }, "gateway", "posix");
    expect(line.startsWith(`set -a; . "${ENV_FILE}"; set +a; unset ANTHROPIC_API_KEY; `)).toBe(true);
    expect(line).toContain('--model "openai::gpt-5.1"');
    expect(line).toContain('ANTHROPIC_DEFAULT_HAIKU_MODEL="openai::gpt-5.1"');
    expect(line).toMatch(/ANTHROPIC_SMALL_FAST_MODEL="openai::gpt-5\.1" claude /);
    // The token itself never rides the line.
    expect(line).not.toContain("glyphh-router-secret");
  });

  it("claude gateway with no pick runs the user's default chat model", () => {
    expect(A.composeCommand(row("claude"), {}, "gateway", "posix")).toContain('--model "anthropic::claude-opus-5-5"');
  });

  it("claude direct names a model only in Claude's own vocabulary", () => {
    expect(A.composeCommand(row("claude"), { model: "anthropic::claude-opus-5-5" }, "direct", "posix")).toContain('--model "claude-opus-5-5"');
    expect(A.composeCommand(row("claude"), { model: "openai::gpt-5.1" }, "direct", "posix")).not.toContain("--model");
  });

  it("carries the session's mode across the hop, else the loop's own", () => {
    expect(A.composeCommand(row("claude"), { permission: "plan" }, "direct", "posix")).toContain(" --permission-mode plan");
    A.saveAgent({ id: "claude", permission: "auto" });
    expect(A.composeCommand(row("claude"), {}, "direct", "posix")).toContain(" --dangerously-skip-permissions");
    expect(A.composeCommand(row("claude"), { permission: "ask" }, "direct", "posix")).not.toContain("--permission");
  });

  it("codex: MCP through its rmcp client with the bearer in an env var, the model as a -c override before the subcommand", () => {
    const line = A.composeCommand(row("codex"), { model: "gpt-5.1", resume: "abc-123" }, "direct", "posix");
    expect(line.startsWith('GLYPHH_MCP_TOKEN="local-token" codex -c check_for_update_on_startup=false')).toBe(true);
    expect(line).toContain(`-c 'mcp_servers.glyphh.url="http://127.0.0.1:4777/mcp"'`);
    expect(line).toContain(`-c 'mcp_servers.glyphh.default_tools_approval_mode="approve"'`);
    expect(line.indexOf(`-c 'model="gpt-5.1"'`)).toBeLessThan(line.indexOf(" resume 'abc-123'"));
    expect(line).not.toContain("model_provider");
  });

  it("resumes the exact session a recents pick names, per CLI", () => {
    expect(A.composeCommand(row("claude"), { resume: "abc-123" }, "direct", "posix")).toContain("--resume 'abc-123'");
    expect(A.composeCommand(row("gemini"), { resume: true }, "direct", "posix")).toContain("--resume latest");
    expect(A.composeCommand(row("codex"), { resume: true }, "direct", "posix")).toContain(" resume --last");
    expect(A.composeCommand(row("cursor"), { resume: true }, "direct", "posix")).toContain(" --continue");
  });

  it("seeds a prompt the way each CLI takes one", () => {
    expect(A.composeCommand(row("claude"), { prompt: "it's here" }, "direct", "posix")).toContain(` 'it'\\''s here'`);
    expect(A.composeCommand(row("gemini"), { prompt: "hi" }, "direct", "posix")).toContain(" -i 'hi'");
    expect(A.composeCommand(row("copilot"), { prompt: "hi" }, "direct", "posix")).not.toContain("hi");
  });

  it("starts in the folder it was given", () => {
    expect(A.composeCommand(row("gemini"), { cwd: "/tmp/work" }, "direct", "posix")).toBe(`cd "/tmp/work" && gemini`);
  });

  it("the Glyphh CLI shares the panel's chat store and the app's MCP server", () => {
    const line = A.composeCommand(row("glyphh"), { resume: "chat-1", model: "openai::gpt-5.1" }, "direct", "posix");
    expect(line).toContain(`GLYPHH_APP_SESSIONS="${path.join(userDir, "agent-sessions.json")}"`);
    expect(line).toContain('GLYPHH_APP_MCP_URL="http://127.0.0.1:4777/mcp"');
    expect(line).toContain(" glyphh --trust --resume 'chat-1' --model \"openai::gpt-5.1\"");
    expect(line).not.toContain("ELECTRON_RUN_AS_NODE");
  });

  it("runs the CLI the app carries with the app's own binary, on both shells", () => {
    bundledCli = "/app/dist/cli/main.mjs";
    const sh = A.composeCommand(row("glyphh"), {}, "direct", "posix");
    expect(sh).toContain(' ELECTRON_RUN_AS_NODE="1"');
    expect(sh).toContain(`"${process.execPath}" "${bundledCli}" --trust`);
    const ps = A.composeCommand(row("glyphh"), {}, "direct", "powershell");
    expect(ps).toContain("$env:ELECTRON_RUN_AS_NODE = '1';");
    expect(ps).toContain(`& "${process.execPath}" "${bundledCli}" --trust`);
  });
});

describe("composed lines are in the shell's own dialect", () => {
  it("emits no POSIX-only syntax for PowerShell", () => {
    const line = A.composeCommand(row("claude"), { cwd: "C:\\Users\\me" }, "gateway", "powershell");
    expect(line).not.toContain("&&");
    expect(line).not.toMatch(/(^|\s)set [+-]a\b/);
    expect(line).not.toMatch(/(^|\s)unset\s/);
    expect(line).toContain("if ($?)");
    expect(line).toContain("Get-Content");
  });

  it("still emits the POSIX line on macOS/Linux", () => {
    const line = A.composeCommand(row("claude"), { cwd: "/Users/me" }, "gateway", "posix");
    expect(line).toContain(`cd "/Users/me" && `);
    expect(line).toContain("set -a;");
  });
});

describe("composeClaudeChat — Claude's long-lived chat lane", () => {
  const base = { permission: "ask" as const, model: "", route: "direct" as const, mcp: true };

  it("streams both ways, asks on our control channel, and introduces itself as Glyphh", () => {
    const line = A.composeClaudeChat(row("claude"), base, "posix");
    expect(line).toContain("claude -p --input-format stream-json --output-format stream-json --include-partial-messages --verbose");
    expect(line).toContain("--permission-mode default --permission-prompt-tool stdio");
    expect(line).toContain("--append-system-prompt 'You are Glyphh");
    expect(line).toContain(`--mcp-config "${MCP_FILE}" --strict-mcp-config`);
    expect(line.startsWith('case "$ANTHROPIC_AUTH_TOKEN" in glyphh-router-*)')).toBe(true);
  });

  it("maps the session's mode onto --permission-mode", () => {
    expect(A.composeClaudeChat(row("claude"), { ...base, permission: "auto" }, "posix")).toContain("--permission-mode bypassPermissions");
    expect(A.composeClaudeChat(row("claude"), { ...base, permission: "plan" }, "posix")).toContain("--permission-mode plan");
  });

  it("takes a known effort, a resume id and the model; drops an unknown effort", () => {
    const line = A.composeClaudeChat(row("claude"), { ...base, model: "claude-opus-5-5", effort: "high", resumeId: "sid-1" }, "posix");
    expect(line).toContain(' --model "claude-opus-5-5" --effort high --resume \'sid-1\'');
    expect(A.composeClaudeChat(row("claude"), { ...base, effort: "ludicrous" }, "posix")).not.toContain("--effort");
  });

  it("on the gateway, sources the router env and names the router model", () => {
    const line = A.composeClaudeChat(row("claude"), { ...base, route: "gateway", model: "openai::gpt-5.1" }, "posix");
    expect(line.startsWith(`set -a; . "${ENV_FILE}"; set +a; unset ANTHROPIC_API_KEY;`)).toBe(true);
    expect(line).toContain('--model "openai::gpt-5.1"');
  });

  it("leaves MCP off the line when the server is not wired", () => {
    expect(A.composeClaudeChat(row("claude"), { ...base, mcp: false }, "posix")).not.toContain("--mcp-config");
  });
});

describe("composeHeadless — one print-mode turn per send", () => {
  const base = { permission: "ask" as const, model: "", mcp: true };

  it("codex: every -c before exec, JSON out, the folder trusted, the chained session resumed", () => {
    const line = A.composeHeadless(row("codex"), "list files", { ...base, permission: "acceptEdits", model: "gpt-5.1", effort: "high", resumeId: "th-1" }, "posix");
    expect(line).toMatch(/ exec resume 'th-1' --skip-git-repo-check --json 'list files'$/);
    const exec = line.indexOf(" exec ");
    for (const flag of [`-c 'model="gpt-5.1"'`, `-c 'model_reasoning_effort="high"'`, "mcp_servers.glyphh.url", " --sandbox workspace-write"]) {
      expect(line.indexOf(flag), flag).toBeGreaterThan(-1);
      expect(line.indexOf(flag), flag).toBeLessThan(exec);
    }
  });

  it("codex with no session yet starts fresh", () => {
    expect(A.composeHeadless(row("codex"), "hi", base, "posix")).toMatch(/ exec --skip-git-repo-check --json 'hi'$/);
  });

  it("gemini, copilot and cursor print one answer with the session's mode", () => {
    expect(A.composeHeadless(row("gemini"), "hi", { ...base, permission: "auto", model: "gemini-2.5-pro" }, "posix")).toBe(`gemini -m "gemini-2.5-pro" --yolo -p 'hi'`);
    expect(A.composeHeadless(row("copilot"), "hi", { ...base, permission: "acceptEdits" }, "posix")).toBe("copilot --allow-all-tools --no-color -p 'hi'");
    expect(A.composeHeadless(row("cursor"), "hi", { ...base, permission: "plan" }, "posix")).toBe("cursor-agent --mode plan --approve-mcps --trust -p 'hi' --output-format text");
  });

  it("quotes the prompt in the shell's own dialect", () => {
    expect(A.composeHeadless(row("gemini"), "it's", base, "powershell")).toBe("gemini -p 'it''s'");
  });

  it("refuses the loops that have their own chat lane", () => {
    expect(() => A.composeHeadless(row("claude"), "hi", base, "posix")).toThrow(/own chat lane/);
    expect(() => A.composeHeadless(row("glyphh"), "hi", base, "posix")).toThrow(/own chat lane/);
  });
});

describe("withPriorTurns — the conversation for a CLI with nothing to resume", () => {
  it("leads the new message with the turns before it, the current one not repeated", () => {
    const out = A.withPriorTurns([{ role: "user", text: "first" }, { role: "assistant", text: "reply" }, { role: "user", text: "second" }], "second");
    expect(out).toBe("<conversation_so_far>\nUser: first\n\nAssistant: reply\n</conversation_so_far>\n\nsecond");
  });

  it("keeps the newest turns when the budget runs out, and sends a first turn bare", () => {
    const out = A.withPriorTurns([{ role: "user", text: "a".repeat(50) }, { role: "assistant", text: "keep me" }], "next", 20);
    expect(out).toContain("Assistant: keep me");
    expect(out).not.toContain("aaaa");
    expect(A.withPriorTurns([{ role: "user", text: "only" }], "only")).toBe("only");
  });
});

describe("composeHeadlessLine — the unattended lane", () => {
  it("claude: print mode through the unattended door, screen tools denied, ours pre-allowed", () => {
    const line = A.composeHeadlessLine(row("claude"), "say it's done", { route: "direct" }, "posix");
    expect(line).toContain(`claude -p 'say it'\\''s done' --output-format text`);
    expect(line).toContain('--allowedTools "mcp__glyphh"');
    expect(line).toContain(`--mcp-config "${path.join(userDir, "loops", "claude", "mcp.unattended.json")}" --strict-mcp-config`);
    expect(line).toContain('"mcp__glyphh__panels_open"');
    expect(line).toContain('"mcp__glyphh__rpa_run"');
    expect(line).not.toContain("--model");
  });

  it("claude on the gateway: the env, the router model", () => {
    const line = A.composeHeadlessLine(row("claude"), "go", { route: "gateway", model: "openai::gpt-5.1" }, "posix");
    expect(line.startsWith(`set -a; . "${ENV_FILE}"; set +a; unset ANTHROPIC_API_KEY;`)).toBe(true);
    expect(line).toContain('--model "openai::gpt-5.1"');
  });

  it("codex runs exec with the prompt last, through the unattended door, approvals auto", () => {
    const line = A.composeHeadlessLine(row("codex"), "list files", { model: "gpt-5.1" }, "posix");
    expect(line).toMatch(/codex .* exec --skip-git-repo-check 'list files'$/);
    expect(line).toContain(`-c 'model="gpt-5.1"'`);
    expect(line).toContain('default_tools_approval_mode="auto"');
    expect(line).toContain('mcp_servers.glyphh.url="http://127.0.0.1:4777/mcp-unattended"');
  });

  it("gemini runs -p with yolo approvals, only the unattended server let in", () => {
    expect(A.composeHeadlessLine(row("gemini"), "hi", { cwd: "/tmp/work" }, "posix")).toBe(`cd "/tmp/work" && gemini -p 'hi' -y --allowed-mcp-server-names glyphh_unattended`);
  });

  it("refuses a CLI with no unattended print mode", () => {
    for (const id of ["copilot", "cursor", "glyphh"] as const) {
      expect(() => A.composeHeadlessLine(row(id), "hi", {}, "posix")).toThrow(/has no headless mode/);
    }
  });
});

describe("prepareCliLaunch — what a launch needs, live", () => {
  it("gateway: starts the router and writes its address and token to a 0600 env file", async () => {
    const r = await A.prepareCliLaunch(row("claude"), { session: true });
    expect(r).toEqual({ route: "gateway", mcp: true });
    expect(routerEndpoint).toHaveBeenCalledTimes(1);
    expect(fs.readFileSync(ENV_FILE, "utf-8")).toBe('ANTHROPIC_BASE_URL="http://127.0.0.1:52011"\nANTHROPIC_AUTH_TOKEN="glyphh-router-secret"\n');
    expect(fs.statSync(ENV_FILE).mode & 0o777).toBe(0o600);
  });

  it("direct: no router, no env file", async () => {
    expect(await A.prepareCliLaunch(row("claude"), { session: false })).toEqual({ route: "direct", mcp: true });
    expect(routerEndpoint).not.toHaveBeenCalled();
    expect(fs.existsSync(ENV_FILE)).toBe(false);
  });

  it("takes the member's default when nothing else has an opinion", async () => {
    prefs.set("cliGateway", true);
    expect((await A.prepareCliLaunch(row("claude"))).route).toBe("gateway");
    chatModels = [];
    expect((await A.prepareCliLaunch(row("claude"))).route).toBe("direct");
  });

  it("wires the settings-file MCP seams the other CLIs read", async () => {
    await A.prepareCliLaunch(row("gemini"));
    const gem = JSON.parse(fs.readFileSync(path.join(osHome, ".gemini", "settings.json"), "utf-8")) as { mcpServers: Record<string, { httpUrl: string; headers: Record<string, string> }> };
    expect(gem.mcpServers.glyphh).toEqual({ httpUrl: "http://127.0.0.1:4777/mcp", headers: { Authorization: "Bearer local-token" } });
  });

  it("keeps launching without our tools when the MCP server cannot start", async () => {
    mcpUp = false;
    expect(await A.prepareCliLaunch(row("claude"), { session: false })).toEqual({ route: "direct", mcp: false });
  });
});
