/**
 * cli-agents.ts — THE LOOPS: Glyphh's own, and the vendor CLIs (Claude Code,
 * Codex, Gemini, Copilot, Cursor) the user installed and signed in to.
 *
 * A loop's record is a small pre-config: the command to run, the model it
 * starts on, the folder, the permission it opens with, whether the Glyphh MCP
 * server is wired in, and the member's own on/off switch. A loop with no
 * record yet runs on its defaults. This module composes every line a loop is
 * launched with, and makes sure what that line needs is live first:
 *
 *   the terminal    composeCommand       the line a terminal card plays
 *   the chat        composeClaudeChat    Claude's long-lived stream-json lane
 *                   composeHeadless      one print-mode turn per send (the rest)
 *   unattended      composeHeadlessLine  a task slot or schedule: text in, text out
 *
 * and the files beside each loop:
 *
 *   ~/.glyphh/users/<id>/loops/<cli>/agent.json         the record
 *   ~/.glyphh/users/<id>/loops/<cli>/mcp.json           --mcp-config: the local MCP server
 *   ~/.glyphh/users/<id>/loops/<cli>/mcp.unattended.json  the same, through the unattended door
 *   ~/.glyphh/users/<id>/loops/<cli>/env                the gateway route's address + token (0600)
 *
 * The chat engines themselves are glyphh-cli-bridge.ts; the CLIs' own session
 * stores are cli-sessions.ts; which route a launch takes is cli-route.ts.
 */

import fs from "fs";
import path from "path";
import { homedir } from "os";
import { execFileSync, spawn } from "child_process";
import { ipcMain } from "electron";
import { userScopedPath } from "./app-paths.js";
import { CLI_BIN, CLI_IDS, CLI_NAMES, HEADLESS_CLIS, VENDOR_CLI_IDS, isCliId, type CliId } from "./cli-ids.js";
import {
  CLI_GATEWAY_PREF, GATEWAY_CLIS, directModelFor, gatewayEnvFileBody, gatewayModelFor, resolveCliRoute, routeEnvPrefix, routeModelVars,
  type CliRoute, type RouteHints,
} from "./cli-route.js";
import { LOGIN_CMD } from "./cli-auth.js";
import { missingCli } from "./cli-install.js";
import { deleteCliSession, listCliSessions } from "./cli-sessions.js";
import { startLocalMcpServer, localMcpStatus, localMcpGenToken, localMcpTokenValid } from "./local-mcp-server.js";
import { UNATTENDED_HIDDEN, UNATTENDED_MCP_PATH } from "./unattended-tools.js";
import { getPreference } from "./stores/preferences-db.js";
import { defaultModel, hasChatModel, readStoredProviders } from "./providers.js";
import { routerEndpoint } from "./router-server.js";
import { getWorkingDirectory } from "./working-directory.js";
import { bundledGlyphhCli } from "./bundled-cli.js";
import { broadcast } from "./broadcast.js";
import { hostDialect, andThen, cd as shCd, invoke, quote, setVar, shellInvocation, type Dialect } from "./shell-dialect.js";

export const AGENTS_DIR = (): string => userScopedPath("loops");

/** The permission a loop OPENS with, in Settings' words: safe = read and plan
 *  only · ask = the CLI's own prompting · auto = run without prompting. */
export type LoopPermissionDefault = "safe" | "ask" | "auto";

export interface CliAgentRow {
  id: CliId;
  name: string;
  cli: CliId;
  /** The command the CLI is invoked by (a wrapper or a full path works too). */
  cmd: string;
  /** The model a launch starts on when the session names none; "" = the
   *  CLI's own default (direct) or the user's default chat model (gateway). */
  model: string;
  /** Wire the Glyphh local MCP server into the CLI. */
  mcp: boolean;
  /** The folder a terminal starts in when the session has none; "" = the workbench's. */
  cwd: string;
  /** What a terminal open does with the loop's session (a workspace slot overrides):
   *    keep — re-attach the parked terminal if one survives; else start.
   *    new  — always a fresh session; closing kills the terminal.
   *    last — re-attach if parked; else the CLI resumes its own last one. */
  session: "keep" | "new" | "last";
  permission: LoopPermissionDefault;
  /** The member's own switch. A loop that is off is refused, never rerouted;
   *  the Glyphh loop is always on — it is the default every chat falls to. */
  enabled: boolean;
  updatedAt?: string;
}

/** The session's mode (the composer's chip) — the vocabulary every surface speaks. */
export type SessionPermission = "ask" | "plan" | "acceptEdits" | "auto";
export const SESSION_PERMISSIONS: readonly SessionPermission[] = ["ask", "plan", "acceptEdits", "auto"];

/** What renderers get: the record plus what the loop can do, and the line a
 *  terminal plays with no overrides (so a card can open synchronously). */
export type CliAgentListed = CliAgentRow & {
  command: string;
  /** Runs unattended (a task slot, a schedule). */
  headless: boolean;
  /** The session modes the agent PANEL can honor for this loop. */
  modes: SessionPermission[];
  /** The router can carry it (cli-route.ts GATEWAY_CLIS). */
  gatewayCapable: boolean;
};

const agentFile = (id: string): string => path.join(AGENTS_DIR(), id, "agent.json");
export const mcpFile = (id: string): string => path.join(AGENTS_DIR(), id, "mcp.json");
const unattendedMcpFile = (id: string): string => path.join(AGENTS_DIR(), id, "mcp.unattended.json");
export const envFile = (id: string): string => path.join(AGENTS_DIR(), id, "env");

/** The panel's chat store: the Glyphh CLI reads and writes it too, so the >_
 *  hop opens the same conversation (`glyphh --resume <chatId>`). */
const agentSessionsFile = (): string => userScopedPath("agent-sessions.json");

function defaultRowFor(id: CliId): CliAgentRow {
  return { id, name: CLI_NAMES[id], cli: id, cmd: CLI_BIN[id], model: "", mcp: true, cwd: "", session: "keep", permission: "ask", enabled: true };
}

const SESSIONS = new Set(["keep", "new", "last"]);
const PERMS = new Set(["safe", "ask", "auto"]);

/** The loop's record over its defaults; null for an id that is not a loop. */
export function agentRowFor(id: string): CliAgentRow | null {
  if (!isCliId(id)) return null;
  const row = defaultRowFor(id);
  let saved: Partial<CliAgentRow> = {};
  try { saved = JSON.parse(fs.readFileSync(agentFile(id), "utf-8")) as Partial<CliAgentRow>; } catch { return row; }
  if (typeof saved.cmd === "string" && saved.cmd.trim()) row.cmd = saved.cmd.trim();
  if (typeof saved.model === "string") row.model = saved.model.trim();
  if (typeof saved.cwd === "string") row.cwd = saved.cwd.trim();
  if (typeof saved.mcp === "boolean") row.mcp = saved.mcp;
  if (typeof saved.session === "string" && SESSIONS.has(saved.session)) row.session = saved.session;
  if (typeof saved.permission === "string" && PERMS.has(saved.permission)) row.permission = saved.permission;
  row.enabled = id === "glyphh" || saved.enabled !== false;
  if (typeof saved.updatedAt === "string") row.updatedAt = saved.updatedAt;
  return row;
}

function writeAgent(row: CliAgentRow): void {
  const file = agentFile(row.id);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const { name: _name, cli: _cli, ...stored } = row;
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(stored, null, 2), "utf-8");
  fs.renameSync(`${file}.tmp`, file);
}

/** Patch a loop's record. Settings saves one field at a time, so anything the
 *  input leaves out keeps its stored value. */
export function saveAgent(input: Partial<Omit<CliAgentRow, "name" | "cli">> & { id: string }): CliAgentRow {
  const row = agentRowFor(String(input.id));
  if (!row) throw new Error(`unknown loop: ${String(input.id)}`);
  if (input.cmd !== undefined) {
    const cmd = String(input.cmd).trim();
    if (!cmd) throw new Error(`a loop needs a command (e.g. ${CLI_BIN[row.cli]})`);
    row.cmd = cmd;
  }
  if (input.model !== undefined) row.model = String(input.model).trim();
  if (input.cwd !== undefined) row.cwd = String(input.cwd).trim();
  if (input.mcp !== undefined) row.mcp = !!input.mcp;
  if (input.session !== undefined && SESSIONS.has(input.session)) row.session = input.session;
  if (input.permission !== undefined && PERMS.has(input.permission)) row.permission = input.permission;
  if (input.enabled !== undefined) {
    if (row.cli === "glyphh" && !input.enabled) throw new Error("the Glyphh loop is the default and cannot be turned off");
    row.enabled = !!input.enabled;
  }
  row.updatedAt = new Date().toISOString();
  writeAgent(row);
  return row;
}

// ── MCP wiring: the local server, as each CLI reads it ───────────────────────

/** Upsert ONE server entry into an mcpServers JSON file, every other key preserved. */
function upsertMcpServer(file: string, key: string, entry: Record<string, unknown>): void {
  let cfg: Record<string, unknown> = {};
  try { cfg = JSON.parse(fs.readFileSync(file, "utf-8")) as Record<string, unknown>; } catch { /* first write */ }
  const servers = (cfg.mcpServers && typeof cfg.mcpServers === "object" ? cfg.mcpServers : {}) as Record<string, unknown>;
  servers[key] = entry;
  cfg.mcpServers = servers;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(cfg, null, 2), "utf-8");
}

/** The loop's minted bearer, read back from its mcp.json. */
function mcpTokenOf(id: string): string {
  try {
    const cfg = JSON.parse(fs.readFileSync(mcpFile(id), "utf-8")) as { mcpServers?: { glyphh?: { headers?: { Authorization?: string } } } };
    return /^Bearer (.+)$/.exec(cfg.mcpServers?.glyphh?.headers?.Authorization ?? "")?.[1] ?? "";
  } catch {
    return "";
  }
}

/** (Re)write the loop's --mcp-config file against the CURRENT port. The bearer
 *  grants loopback access to this machine's own tool surface only, and a token
 *  the server no longer honors is replaced rather than handed out again. */
function ensureMcpConfig(id: string): string {
  const { port } = localMcpStatus();
  let token = mcpTokenOf(id);
  if (!token || !localMcpTokenValid(token)) token = localMcpGenToken(`agent:${id}`, 365).token;
  upsertMcpServer(mcpFile(id), "glyphh", { type: "http", url: `http://127.0.0.1:${port}/mcp`, headers: { Authorization: `Bearer ${token}` } });
  return token;
}

/** The bearer, minted if missing or stale — every reader goes through here,
 *  so a CLI that only reads the token (codex) never ships without one. */
function ensureMcpToken(id: string): string {
  const have = mcpTokenOf(id);
  return have && localMcpTokenValid(have) ? have : ensureMcpConfig(id);
}

/** Gemini, Copilot and Cursor read their MCP servers from their own settings
 *  files, not a launch flag: the same mutation their own `mcp add` performs. */
function ensureSettingsMcp(id: string, cli: CliId): void {
  const { port } = localMcpStatus();
  const auth = { headers: { Authorization: `Bearer ${ensureMcpToken(id)}` } };
  const url = `http://127.0.0.1:${port}/mcp`;
  if (cli === "gemini") upsertMcpServer(path.join(homedir(), ".gemini", "settings.json"), "glyphh", { httpUrl: url, ...auth });
  if (cli === "copilot") upsertMcpServer(path.join(homedir(), ".copilot", "mcp-config.json"), "glyphh", { type: "http", url, ...auth });
  if (cli === "cursor") upsertMcpServer(path.join(homedir(), ".cursor", "mcp.json"), "glyphh", { url, ...auth });
}

/** The unattended door for a headless run: the same token, the path with no
 *  screen tools behind it. Claude reads it as its --mcp-config; gemini as the
 *  `glyphh_unattended` entry of its settings file. */
function ensureUnattendedMcpConfig(id: string, cli: CliId): void {
  const { port } = localMcpStatus();
  const auth = { headers: { Authorization: `Bearer ${ensureMcpToken(id)}` } };
  const url = `http://127.0.0.1:${port}${UNATTENDED_MCP_PATH}`;
  upsertMcpServer(unattendedMcpFile(id), "glyphh", { type: "http", url, ...auth });
  if (cli === "gemini") upsertMcpServer(path.join(homedir(), ".gemini", "settings.json"), "glyphh_unattended", { httpUrl: url, ...auth });
}

/** Pin the CLI's OWN theme to the app's — the terminal palette covers most of
 *  it; these cover the truecolor chrome. One key changes, the rest survives. */
function ensureCliTheme(cli: CliId, light: boolean): void {
  const pin = (file: string, value: string): void => {
    let cfg: Record<string, unknown> = {};
    try { cfg = JSON.parse(fs.readFileSync(file, "utf-8")) as Record<string, unknown>; } catch { /* first write */ }
    cfg.theme = value;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(cfg, null, 2), "utf-8");
  };
  if (cli === "claude") pin(path.join(homedir(), ".claude.json"), light ? "light" : "dark");
  if (cli === "gemini") pin(path.join(homedir(), ".gemini", "settings.json"), light ? "Default Light" : "Default");
}

/** The gateway route's address and token in the loop's env file (0600): the
 *  line sources it, so the token never types into a visible terminal. */
function writeGatewayEnv(id: string, endpoint: { url: string; token: string }): void {
  const file = envFile(id);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, gatewayEnvFileBody(endpoint), { encoding: "utf-8", mode: 0o600 });
  fs.chmodSync(file, 0o600);
}

/**
 * EVERY LAUNCH COMES UP THE SAME WAY — a terminal open, a chat turn, an
 * unattended run: the local MCP server and the CLI's MCP seam (when the loop
 * wires it), then the route, and on the gateway the router's listener and the
 * env file pointing at it. Returns the route taken and whether MCP is wired; a
 * failed MCP start leaves the launch running without our tools, never stopped.
 */
export async function prepareCliLaunch(row: CliAgentRow, hints?: RouteHints): Promise<{ route: CliRoute; mcp: boolean }> {
  let mcp = false;
  if (row.mcp) {
    const r = await startLocalMcpServer();
    if (r.ok) {
      ensureMcpConfig(row.id);
      ensureSettingsMcp(row.id, row.cli);
      mcp = true;
    } else {
      console.warn("[agents] local MCP server unavailable; launching without it:", r.error);
    }
  }
  const route = resolveCliRoute(row.cli, hints, !!getPreference<boolean>(CLI_GATEWAY_PREF, false), hasChatModel());
  if (route === "gateway") writeGatewayEnv(row.id, await routerEndpoint());
  return { route, mcp };
}

// ── what each CLI is told ────────────────────────────────────────────────────

/**
 * The session's mode as each CLI's own flag ("" = the CLI's default, which is
 * Ask). One table for the terminal and the print modes: every flag here is
 * accepted by both.
 */
const PERM_FLAGS: Record<CliId, Partial<Record<SessionPermission, string>>> = {
  claude: { plan: " --permission-mode plan", acceptEdits: " --permission-mode acceptEdits", auto: " --dangerously-skip-permissions" },
  // `codex exec` has no --full-auto; its sandbox flag is the accept-edits shape.
  codex: { plan: " --sandbox read-only", acceptEdits: " --sandbox workspace-write", auto: " --dangerously-bypass-approvals-and-sandbox" },
  gemini: { acceptEdits: " --approval-mode auto_edit", auto: " --yolo" },
  copilot: { acceptEdits: " --allow-all-tools", auto: " --allow-all" },
  // cursor-agent: --mode plan is read-only, --auto-review lets a classifier run
  // the safe calls and ask about the rest, --force runs everything.
  cursor: { plan: " --mode plan", acceptEdits: " --auto-review", auto: " --force" },
  glyphh: { plan: " --permission plan", acceptEdits: " --permission acceptEdits", auto: " --permission bypass" },
};

/**
 * Which CLIs can ASK the user mid-turn in the agent panel. Claude's chat lane
 * takes `--permission-prompt-tool stdio`, so each request rides our control
 * channel and becomes an approval card; our own loop asks natively. The other
 * print modes either run a call or refuse it with nobody to ask, so offering
 * Ask there promises a prompt that cannot arrive.
 */
const CAN_PROMPT: ReadonlySet<CliId> = new Set<CliId>(["claude", "glyphh"]);

/** The session modes a loop can honor on a surface. In a terminal the CLI
 *  prompts the user itself, so Ask always works. */
export function modesFor(cli: CliId, surface: "panel" | "terminal" = "terminal"): SessionPermission[] {
  const askWorks = surface === "terminal" || CAN_PROMPT.has(cli);
  return SESSION_PERMISSIONS.filter((m) => (m === "ask" ? askWorks : !!PERM_FLAGS[cli][m]));
}

/** The loop's opening permission in the session's vocabulary. */
const rowPermission = (row: Pick<CliAgentRow, "permission">): SessionPermission =>
  row.permission === "safe" ? "plan" : row.permission === "auto" ? "auto" : "ask";

const permFlag = (cli: CliId, mode: SessionPermission): string => PERM_FLAGS[cli][mode] ?? "";

/** The effort levels claude (--effort) and codex (model_reasoning_effort) both accept. */
export const EFFORT_LEVELS: ReadonlySet<string> = new Set(["low", "medium", "high", "xhigh", "max"]);

/** A picked model as a flag value: quotes stripped, then double-quoted. */
const flagValue = (m: string): string => `"${m.replace(/"/g, "")}"`;

function modelFlag(cli: CliId, model: string): string {
  if (!model) return "";
  switch (cli) {
    case "gemini": return ` -m ${flagValue(model)}`;
    // Codex takes it as a -c override before any subcommand (codexModelOverride).
    case "codex": return "";
    default: return ` --model ${flagValue(model)}`;
  }
}

/** CODEX TAKES THE MODEL AS A CONFIG OVERRIDE: `-m` belongs to `codex exec`
 *  alone, and a resumed rollout keeps the model it was created with unless the
 *  config says otherwise. Like every codex override it comes BEFORE the
 *  subcommand; the single quotes make it reach codex as a TOML string. */
const codexModelOverride = (model: string): string => {
  const m = model.replace(/["']/g, "");
  return m ? ` -c 'model="${m}"'` : "";
};
/** Codex asks "Update available?" on its first run, and a print-mode turn
 *  would sit on that prompt forever; the update check is its own config switch. */
const CODEX_NO_UPDATE = " -c check_for_update_on_startup=false";
/** codex exec refuses a folder that is not a git checkout unless told to skip
 *  the check; the folder the user picked IS the trust decision. */
const CODEX_SKIP_GIT = " --skip-git-repo-check";

/** Codex's MCP seam: streamable HTTP through its rmcp client, the bearer read
 *  from an env var (an inline bearer_token is refused for streamable HTTP),
 *  and our server's tools run without codex's own prompt — `approve` in a
 *  terminal and a chat, `auto` unattended. Governance is the app's (Settings). */
function codexMcp(port: number, mcpPath: string, approval: "approve" | "auto"): string {
  return ` -c experimental_use_rmcp_client=true -c 'mcp_servers.glyphh.url="http://127.0.0.1:${port}${mcpPath}"'`
    + ` -c 'mcp_servers.glyphh.bearer_token_env_var="GLYPHH_MCP_TOKEN"' -c 'mcp_servers.glyphh.default_tools_approval_mode="${approval}"'`;
}

/** OUR TOOL SURFACE, NOT THE MACHINE'S: `--mcp-config` ADDS to the user's own
 *  Claude Code servers; with this flag the file we write is the whole surface
 *  for what WE launch. What the user runs themselves stays theirs. */
const STRICT_MCP = " --strict-mcp-config";

/**
 * The model a launch names, for its route: on the gateway one of the user's
 * own chat models (the pick, else their default), sent whole for the router;
 * direct, the pick (else the loop's own) in the CLI's vocabulary, or nothing
 * so the CLI's login decides.
 */
export function launchModel(row: Pick<CliAgentRow, "cli" | "model">, route: CliRoute, picked: string | undefined): string {
  const f = readStoredProviders();
  const want = String(picked ?? "").trim() || row.model;
  if (route === "gateway") return gatewayModelFor(want, f.models.filter((m) => m.type === "chat").map((m) => m.id), defaultModel("chat"));
  return directModelFor(row.cli, want, (pid) => f.providers.find((p) => p.id === pid)?.kind);
}

function expandHome(p: string): string {
  return p === "~" ? homedir() : p.startsWith("~/") ? path.join(homedir(), p.slice(2)) : p;
}

const isDirectory = (p: string): boolean => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };

/** The folder a launch starts in: the first EXISTING folder of the session's,
 *  the loop's, the workbench's, home. */
export function agentTerminalFolder(wanted: string | undefined, loopFolder?: string): string {
  for (const raw of [wanted, loopFolder, getWorkingDirectory()]) {
    const dir = expandHome((raw ?? "").trim());
    if (dir && path.isAbsolute(dir) && isDirectory(dir)) return dir;
  }
  return homedir();
}

/** resume: true = the CLI's continue-last; a string = a SPECIFIC session id. */
export interface OpenOverrides {
  model?: string;
  cwd?: string;
  resume?: boolean | string;
  prompt?: string;
  light?: boolean;
  /** The session's mode, carried across the >_ hop; else the loop's own. */
  permission?: SessionPermission;
  /** Where the route was chosen (session → cell → workspace); the member's default fills the rest. */
  route?: RouteHints;
}

/** The terminal line: what a terminal card plays to open the loop. */
export function composeCommand(row: CliAgentRow, ov: OpenOverrides, route: CliRoute, dialect?: Dialect): string {
  const d = dialect ?? hostDialect();
  const model = launchModel(row, route, ov.model);
  const cwd = expandHome((ov.cwd ?? row.cwd ?? "").trim());
  const perm = permFlag(row.cli, ov.permission ?? rowPermission(row));
  const rid = typeof ov.resume === "string" ? ov.resume.replace(/'/g, "") : "";
  const resumePart = !ov.resume ? ""
    : row.cli === "codex" ? (rid ? ` resume '${rid}'` : " resume --last")
    : row.cli === "gemini" ? (rid ? ` --resume '${rid}'` : " --resume latest")
    : (rid ? ` --resume '${rid}'` : " --continue");
  // An INITIAL PROMPT seeds the interactive session: claude, codex and glyphh
  // take it positionally, gemini via -i; the rest just open.
  const p0 = (ov.prompt ?? "").trim();
  const promptPart = !p0 ? ""
    : row.cli === "claude" || row.cli === "codex" || row.cli === "glyphh" ? ` ${quote(p0, d)}`
    : row.cli === "gemini" ? ` -i ${quote(p0, d)}`
    : "";
  const { port } = localMcpStatus();
  let base: string;
  if (row.cli === "glyphh") {
    // THE GLYPHH LOOP'S TERMINAL: the Glyphh CLI on the panel's own store and
    // the app's MCP server, so a chat carries across the hop both ways.
    const envPairs: Array<[string, string]> = [["GLYPHH_APP_SESSIONS", agentSessionsFile()]];
    if (row.mcp && port) envPairs.push(["GLYPHH_APP_MCP_URL", `http://127.0.0.1:${port}/mcp`], ["GLYPHH_APP_MCP_TOKEN", ensureMcpToken(row.id)]);
    const bundled = bundledGlyphhCli();
    if (bundled) envPairs.push(["ELECTRON_RUN_AS_NODE", "1"]);
    const env = envPairs.map(([k, v]) => setVar(k, v, d)).join("").trim();
    const bin = bundled ? invoke(process.execPath, [bundled], d) : row.cmd;
    // The folder was chosen in the app, so its trust question is answered.
    base = `${env} ${bin} --trust${resumePart}${modelFlag(row.cli, model)}${perm}${promptPart}`;
  } else if (row.cli === "codex") {
    const token = row.mcp ? ensureMcpToken(row.id) : "";
    base = (token ? `${setVar("GLYPHH_MCP_TOKEN", token, d).trim()} ` : "")
      + `${row.cmd}${CODEX_NO_UPDATE}${token ? codexMcp(port, "/mcp", "approve") : ""}${codexModelOverride(model)}${perm}${resumePart}${promptPart}`;
  } else if (row.cli === "claude") {
    const vars = routeModelVars(row.cli, route, model, d);
    base = `${vars ? `${vars} ` : ""}${row.cmd}${resumePart}${modelFlag(row.cli, model)}${perm}${promptPart}${row.mcp ? ` --mcp-config "${mcpFile(row.id)}"${STRICT_MCP}` : ""}`;
  } else {
    // gemini / copilot / cursor: their MCP seams are settings files written at launch.
    base = `${row.cmd}${resumePart}${modelFlag(row.cli, model)}${perm}${promptPart}`;
  }
  const line = cwd ? andThen([shCd(cwd, d), base], d) : base;
  const prefix = routeEnvPrefix(row.cli, route, envFile(row.id), d);
  return prefix ? `${prefix} ${line}` : line;
}

// ── the agent panel's lanes ──────────────────────────────────────────────────

/** WHO THE LOOP IS. Headless `claude -p` ships Claude Code's own persona; in
 *  the agent panel the CLI is the engine, not the speaker. Appended to — never
 *  replacing — the CLI's own tool prompt. */
const GLYPHH_IDENTITY = [
  "You are Glyphh, the user's agent, running inside the Glyphh desktop app on their own machine. The Claude Code CLI is the engine you run on, not who you are: do not introduce yourself as Claude Code, and never turn a request away because it is not about code.",
  "You help with whatever the user asks — research, planning, writing, everyday questions, and code alike. The working folder is context for file work, not a boundary on what you will do.",
  "The glyphh MCP tools reach the app itself: panels_available lists the user's saved apps, panels_open opens one of them or the app's browser as a panel, layouts_open arranges a saved workspace, models_available lists the models this user has set up, and the other glyphh tools cover the user's memory, tasks, skills and installed apps. When the user asks to open or show something, use those tools rather than describing how they could.",
  "When a step needs the user's permission the app asks them; a denied step is not a failure of yours — report it and continue.",
].join("\n");

/** Claude's chat-lane permission modes (--permission-mode). */
export const CLAUDE_PERMISSION_MODE: Record<SessionPermission, string> = {
  ask: "default", plan: "plan", acceptEdits: "acceptEdits", auto: "bypassPermissions",
};

export interface ClaudeChatOptions {
  permission: SessionPermission;
  /** Already resolved for the route (launchModel). */
  model: string;
  effort?: string;
  resumeId?: string;
  route: CliRoute;
  /** The local MCP server is wired for this launch. */
  mcp: boolean;
}

/**
 * CLAUDE'S CHAT LANE: one long-lived process per chat in bidirectional
 * stream-json, its permission prompts riding our control channel
 * (`--permission-prompt-tool stdio`) so each becomes an approval card.
 */
export function composeClaudeChat(row: CliAgentRow, o: ClaudeChatOptions, dialect?: Dialect): string {
  const d = dialect ?? hostDialect();
  const lvl = EFFORT_LEVELS.has(String(o.effort ?? "")) ? String(o.effort) : "";
  const rid = (o.resumeId ?? "").replace(/'/g, "");
  const vars = routeModelVars(row.cli, o.route, o.model, d);
  const line = `${vars ? `${vars} ` : ""}${row.cmd} -p --input-format stream-json --output-format stream-json --include-partial-messages --verbose`
    + ` --permission-mode ${CLAUDE_PERMISSION_MODE[o.permission]} --permission-prompt-tool stdio --append-system-prompt ${quote(GLYPHH_IDENTITY, d)}`
    + `${modelFlag("claude", o.model)}${lvl ? ` --effort ${lvl}` : ""}${rid ? ` --resume '${rid}'` : ""}`
    + `${o.mcp ? ` --mcp-config "${mcpFile(row.id)}"${STRICT_MCP}` : ""}`;
  const prefix = routeEnvPrefix(row.cli, o.route, envFile(row.id), d);
  return prefix ? `${prefix} ${line}` : line;
}

/** The CLIs whose print mode names its session, so a chat's turns chain
 *  through the CLI's own persisted session (codex exec --json says it). The
 *  rest print plain text with no id: each turn is told the conversation so far. */
export const RESUMABLE_HEADLESS: ReadonlySet<CliId> = new Set<CliId>(["codex"]);

export interface HeadlessTurnOptions {
  permission: SessionPermission;
  /** Already resolved for the route (launchModel). */
  model: string;
  effort?: string;
  resumeId?: string;
  /** The local MCP server is wired for this launch. */
  mcp: boolean;
}

/**
 * ONE PRINT-MODE TURN for the agent panel: codex, gemini, copilot and cursor
 * have no control channel, so each send is its own process. The line runs in
 * the chat's folder (the spawn's cwd); stdin is closed at once.
 */
export function composeHeadless(row: CliAgentRow, prompt: string, o: HeadlessTurnOptions, dialect?: Dialect): string {
  const d = dialect ?? hostDialect();
  const p = quote(prompt, d);
  const perm = permFlag(row.cli, o.permission);
  const rid = (o.resumeId ?? "").replace(/'/g, "");
  switch (row.cli) {
    case "codex": {
      const lvl = EFFORT_LEVELS.has(String(o.effort ?? "")) ? String(o.effort) : "";
      const token = o.mcp ? ensureMcpToken(row.id) : "";
      // EVERY -c OVERRIDE BEFORE `exec`: overrides after the subcommand replace
      // the ones before it, and the MCP block would silently drop out.
      return (token ? `${setVar("GLYPHH_MCP_TOKEN", token, d).trim()} ` : "")
        + `${row.cmd}${CODEX_NO_UPDATE}${token ? codexMcp(localMcpStatus().port, "/mcp", "approve") : ""}`
        + `${lvl ? ` -c 'model_reasoning_effort="${lvl}"'` : ""}${codexModelOverride(o.model)}${perm}`
        + ` exec${rid ? ` resume '${rid}'` : ""}${CODEX_SKIP_GIT} --json ${p}`;
    }
    case "gemini":
      return `${row.cmd}${modelFlag(row.cli, o.model)}${perm} -p ${p}`;
    case "copilot":
      // -p runs one prompt and exits; its MCP seam is ~/.copilot/mcp-config.json.
      return `${row.cmd}${modelFlag(row.cli, o.model)}${perm} --no-color -p ${p}`;
    case "cursor":
      // Nobody can answer a prompt here: without --approve-mcps every call to
      // our server comes back rejected, and an untrusted folder stops it dead.
      return `${row.cmd}${modelFlag(row.cli, o.model)}${perm} --approve-mcps --trust -p ${p} --output-format text`;
    default:
      throw new Error(`${row.name} runs on its own chat lane, not a print-mode turn`);
  }
}

/** How much of the conversation a turn with no resumable session is told. */
const PRIOR_CHARS = 12_000;

/**
 * THE CONVERSATION SO FAR, for a CLI whose print mode keeps no session we can
 * resume: the chat's earlier turns, newest kept when the budget runs out, ahead
 * of the new message. Without it every send would be a stranger's first turn.
 */
export function withPriorTurns(history: ReadonlyArray<{ role?: string; text?: string }>, text: string, budget = PRIOR_CHARS): string {
  const turns = history
    .filter((m) => (m.role === "user" || m.role === "assistant") && String(m.text ?? "").trim())
    .map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${String(m.text).trim()}`);
  // The store already holds THIS turn as its last user message.
  if (turns.length && turns[turns.length - 1] === `User: ${text.trim()}`) turns.pop();
  const kept: string[] = [];
  let used = 0;
  for (let i = turns.length - 1; i >= 0; i--) {
    const t = turns[i]!;
    if (used + t.length > budget) break;
    kept.unshift(t);
    used += t.length;
  }
  if (!kept.length) return text;
  return `<conversation_so_far>\n${kept.join("\n\n")}\n</conversation_so_far>\n\n${text}`;
}

// ── the unattended lane: a task slot, a schedule ─────────────────────────────

export interface HeadlessOverrides {
  model?: string;
  cwd?: string;
  route?: CliRoute;
}

/** The unattended print-mode line for one CLI — pure, so the tests prove each
 *  shape. Throws for a CLI with no unattended print mode. */
export function composeHeadlessLine(row: CliAgentRow, prompt: string, ov: HeadlessOverrides, dialect?: Dialect): string {
  if (!HEADLESS_CLIS.has(row.cli)) throw new Error(`${row.name} has no headless mode`);
  const d = dialect ?? hostDialect();
  const route = ov.route ?? "direct";
  const model = launchModel(row, route, ov.model);
  const cwd = expandHome((ov.cwd ?? "").trim());
  const p = quote(String(prompt ?? "").trim(), d);
  let base: string;
  if (row.cli === "codex") {
    const token = row.mcp ? ensureMcpToken(row.id) : "";
    base = (token ? `${setVar("GLYPHH_MCP_TOKEN", token, d).trim()} ` : "")
      + `${row.cmd}${CODEX_NO_UPDATE}${token ? codexMcp(localMcpStatus().port, UNATTENDED_MCP_PATH, "auto") : ""}${codexModelOverride(model)} exec${CODEX_SKIP_GIT} ${p}`;
  } else if (row.cli === "claude") {
    // The unattended door, and the screen tools denied by name as well: a
    // headless claude can never open a panel. `mcp__glyphh` pre-allows every
    // other tool of our server, since nobody is there to approve one.
    const mcp = row.mcp
      ? ` --allowedTools "mcp__glyphh" --disallowedTools ${[...UNATTENDED_HIDDEN].map((t) => `"mcp__glyphh__${t}"`).join(",")} --mcp-config "${unattendedMcpFile(row.id)}"${STRICT_MCP}`
      : "";
    const vars = routeModelVars(row.cli, route, model, d);
    base = `${vars ? `${vars} ` : ""}${row.cmd} -p ${p} --output-format text${modelFlag(row.cli, model)}${mcp}`;
  } else {
    // gemini: -y approves tool calls, since nobody is there to; only the
    // unattended entry of its settings file is let in.
    base = `${row.cmd} -p ${p} -y${row.mcp ? " --allowed-mcp-server-names glyphh_unattended" : ""}${modelFlag(row.cli, model)}`;
  }
  const line = cwd ? andThen([shCd(cwd, d), base], d) : base;
  const prefix = routeEnvPrefix(row.cli, route, envFile(row.id), d);
  return prefix ? `${prefix} ${line}` : line;
}

const HEADLESS_STDOUT_CAP = 200 * 1024;
const HEADLESS_STDERR_TAIL = 4 * 1024;
const HEADLESS_TIMEOUT_MS = 10 * 60 * 1000;

/** Run one composed line through the login shell (so the sourced env file and
 *  the member's PATH apply), capture what it printed, honor the abort signal
 *  and the clock. */
function runHeadlessLine(line: string, cwd: string, opts: { signal?: AbortSignal; timeoutMs?: number }): Promise<{ text: string; failed: boolean; error?: string }> {
  return new Promise((resolve) => {
    const [shell, args] = shellInvocation(hostDialect());
    const child = spawn(shell, [...args, line], { cwd, env: { ...process.env }, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    let settled = false;
    let why = "";
    const limit = opts.timeoutMs ?? HEADLESS_TIMEOUT_MS;
    const settle = (r: { text: string; failed: boolean; error?: string }): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
      resolve(r);
    };
    const kill = (reason: string): void => { why = reason; try { child.kill("SIGTERM"); } catch { /* already gone */ } };
    const onAbort = (): void => kill("stopped");
    const timer = setTimeout(() => kill(`timed out after ${Math.round(limit / 1000)}s`), limit);
    if (opts.signal?.aborted) onAbort();
    else opts.signal?.addEventListener("abort", onAbort, { once: true });
    child.stdout.on("data", (b: Buffer) => { if (out.length < HEADLESS_STDOUT_CAP) out += b.toString("utf-8").slice(0, HEADLESS_STDOUT_CAP - out.length); });
    child.stderr.on("data", (b: Buffer) => { err = (err + b.toString("utf-8")).slice(-HEADLESS_STDERR_TAIL); });
    child.on("error", (e) => settle({ text: out, failed: true, error: e.message }));
    child.on("close", (code) => {
      if (why) return settle({ text: out, failed: true, error: why });
      if (code === 0) return settle({ text: out, failed: false });
      settle({ text: out, failed: true, error: err.trim() || `${shell} exited ${code}` });
    });
  });
}

/**
 * A CLI LOOP, UNATTENDED: a task slot's CLI or a skill on a clock. It comes up
 * the way a terminal open does (prepareCliLaunch: MCP, route, router), then
 * the print-mode line runs in the slot's folder and its text is the answer.
 */
export async function runCliHeadless(
  id: string, prompt: string,
  opts: { model?: string; cwd?: string; route?: RouteHints; signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<{ text: string; failed: boolean; error?: string }> {
  try {
    const row = agentRowFor(String(id));
    if (!row) throw new Error(`unknown loop: ${String(id)}`);
    if (!row.enabled) throw new Error(`${row.name} is turned off in Settings`);
    if (!HEADLESS_CLIS.has(row.cli)) throw new Error(`${row.name} has no headless mode`);
    const missing = await missingCli(row);
    if (missing) throw new Error(`${row.name} is not installed (${missing.bin} is not on the PATH)${missing.install ? ` — install it with: ${missing.install}` : ""}`);
    const { route, mcp } = await prepareCliLaunch(row, opts.route);
    if (mcp) ensureUnattendedMcpConfig(row.id, row.cli);
    const cwd = agentTerminalFolder(opts.cwd, row.cwd);
    const line = composeHeadlessLine({ ...row, mcp }, prompt, { ...(opts.model ? { model: opts.model } : {}), cwd, route });
    console.warn("[agents] headless", JSON.stringify({ id: row.id, cwd, route, chars: prompt.length }));
    return await runHeadlessLine(line, cwd, { ...(opts.signal ? { signal: opts.signal } : {}), ...(opts.timeoutMs ? { timeoutMs: opts.timeoutMs } : {}) });
  } catch (err) {
    return { text: "", failed: true, error: err instanceof Error ? err.message : String(err) };
  }
}

// ── the list, and the IPC ────────────────────────────────────────────────────

export function listCliAgents(): CliAgentListed[] {
  return CLI_IDS.map((id) => agentRowFor(id)!).map((row) => ({
    ...row,
    command: composeCommand(row, {}, "direct"),
    headless: HEADLESS_CLIS.has(row.cli),
    modes: modesFor(row.cli, "panel"),
    gatewayCapable: GATEWAY_CLIS.has(row.cli),
  }));
}

/** The loops the member has on, for every renderer that filters by them. */
const enabledLoops = (): string[] => CLI_IDS.filter((id) => agentRowFor(id)?.enabled);

/** The command line, tokens blanked, for main's log. */
const loggable = (line: string): string => line.replace(/((?:GLYPHH_(?:APP_)?MCP_TOKEN)=)("[^"]*"|'[^']*'|\S+)/g, "$1…").replace(/\$env:(GLYPHH_(?:APP_)?MCP_TOKEN) = '[^']*'/g, "$env:$1 = '…'");

export function registerCliAgentsIpc(): void {
  ipcMain.handle("cli-agents-list", () => {
    try { return { ok: true, agents: listCliAgents(), gatewayDefault: !!getPreference<boolean>(CLI_GATEWAY_PREF, false), gatewayReady: hasChatModel() }; }
    catch (err) { return { ok: false, error: err instanceof Error ? err.message : String(err), agents: [] }; }
  });

  ipcMain.handle("cli-agents-save", (_e, input: Partial<Omit<CliAgentRow, "name" | "cli">> & { id: string }) => {
    try {
      const before = enabledLoops().join(",");
      const row = saveAgent(input);
      // A loop turned on or off leaves every picker and recents list at once.
      const after = enabledLoops();
      if (after.join(",") !== before) broadcast("cli-agents-changed", { enabled: after });
      const listed: CliAgentListed = { ...row, command: composeCommand(row, {}, "direct"), headless: HEADLESS_CLIS.has(row.cli), modes: modesFor(row.cli, "panel"), gatewayCapable: GATEWAY_CLIS.has(row.cli) };
      return { ok: true, agent: listed };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle("cli-sessions-list", (_e, p?: { limit?: number }) => {
    try {
      const on = VENDOR_CLI_IDS.filter((id) => agentRowFor(id)?.enabled);
      return { ok: true, sessions: listCliSessions(Math.min(200, Math.max(1, Number(p?.limit) || 40)), on) };
    } catch (err) {
      return { ok: false, sessions: [], error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle("cli-session-delete", (_e, id: string) => {
    try { deleteCliSession(String(id)); return { ok: true }; }
    catch (err) { return { ok: false, error: err instanceof Error ? err.message : String(err) }; }
  });

  // INSTALLED OR NOT, per loop, for Settings › Loops: the missing ones answer
  // with what to install and how to sign in. The bundled Glyphh CLI is always there.
  ipcMain.handle("cli-agents-missing", async () => {
    try {
      const rows = listCliAgents();
      const missing = await Promise.all(rows.map(async (row) => (row.cli === "glyphh" && bundledGlyphhCli() ? null : missingCli(row))));
      return { ok: true, missing: Object.fromEntries(rows.map((row, i) => [row.id, missing[i]])) };
    } catch (err) {
      return { ok: false, missing: {}, error: err instanceof Error ? err.message : String(err) };
    }
  });

  // SIGNING A CLI BACK IN: we cannot refresh someone else's login, so we open
  // a terminal on the command that can.
  ipcMain.handle("cli-login", (_e, cli: string) => {
    const command = LOGIN_CMD[String(cli)];
    if (!command) return { ok: false, error: `no sign-in command for ${String(cli)}` };
    try {
      if (process.platform === "darwin") {
        const script = ['tell application "Terminal"', "activate", `do script "${command.replace(/["\\]/g, "\\$&")}"`, "end tell"].flatMap((l) => ["-e", l]);
        execFileSync("osascript", script);
        return { ok: true, data: { command } };
      }
      spawn(process.env.SHELL || "/bin/bash", ["-lc", command], { detached: true, stdio: "ignore" }).unref();
      return { ok: true, data: { command } };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  // "Open" = the dependencies live (MCP server and seams, the route and its
  // router), then the composed line for the terminal the renderer opens. A
  // missing binary ALSO answers with what to install; the terminal opens
  // regardless — a wrong "missing" must never cost the hop.
  ipcMain.handle("cli-agent-open", async (_e, id: string, overrides?: OpenOverrides) => {
    try {
      const row = agentRowFor(String(id));
      if (!row) return { ok: false, error: `unknown loop: ${String(id)}` };
      if (!row.enabled) return { ok: false, error: `${row.name} is turned off in Settings` };
      const ov: OpenOverrides = overrides ?? {};
      const missing = row.cli === "glyphh" && bundledGlyphhCli() ? null : await missingCli(row);
      if (ov.light !== undefined) {
        try { ensureCliTheme(row.cli, ov.light); }
        catch (err) { console.warn("[agents] theme pin failed:", err instanceof Error ? err.message : err); }
      }
      const { route, mcp } = await prepareCliLaunch(row, ov.route);
      const cwd = agentTerminalFolder(ov.cwd, row.cwd);
      const command = composeCommand({ ...row, mcp }, { ...ov, cwd }, route);
      console.warn("[agents] open", JSON.stringify({ id: row.id, cwd, route, resume: ov.resume ?? null, missing: missing?.bin ?? null, command: loggable(command) }));
      return { ok: true, command, name: row.name, cwd, route, ...(missing ? { missing } : {}) };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });
}
