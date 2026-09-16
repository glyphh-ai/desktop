/**
 * cli-agents.ts — LOOPS: the CLI pre-configs (the build after THE PURGE,
 * 2026-09-10; renamed Agents → Loops 2026-09-11 on his ruling — "the loops
 * should in fact be loops but they are what we are currently calling
 * agents"). A loop is a named, icon-carrying pre-config for a CLI (Claude
 * first): the command to run, plus optional Glyphh MCP wiring. THE CLI IS
 * THE LOOP — Glyphh owns no agent-loop logic of its own.
 *
 *   ~/.glyphh/loops/<id>/agent.json    — { id, name, icon, cmd, mcp, … }
 *   ~/.glyphh/loops/<id>/mcp.json      — written when mcp is on: the
 *                                        --mcp-config file pointing the CLI
 *                                        at this machine's local MCP server
 *
 * The directory moved from agents/ (glyphh-home-migrate.ts); the FILE names
 * inside stay agent.json — they are per-loop records, not a surface name,
 * and rewriting them would churn every install for nothing.
 *
 * "Open" anywhere (echo card, layout cell) plays the pre-config: the
 * composed command types into a fresh terminal panel. The list rows carry
 * the FULL composed command so renderers open synchronously; cli-agent-open
 * just makes sure the local MCP server is up first.
 */

import fs from "fs";
import path from "path";
import { userScopedPath } from "./app-paths.js";
import { homedir } from "os";
import { ipcMain } from "electron";
import { startLocalMcpServer, localMcpStatus, localMcpGenToken } from "./local-mcp-server.js";
import { preferencesByPrefix } from "./stores/preferences-db";
import { gatewayCreds, mcpCreds, writeGatewayEnv, clearGatewayEnv, primeGatewayEnv, writeBaseUrlOnly, type GatewayCreds } from "./gateway-token.js";
import { bridgeWrap } from "./memory-bridge.js";
import { getClient } from "./glyphh-client.js";

export const AGENTS_DIR = (): string => userScopedPath("loops");

export interface CliAgentRow {
  id: string;
  name: string;
  /** Which CLI this agent drives — branded ones carry their marks; "custom"
   *  uses the emoji icon. More CLIs join this union as they're wired. */
  cli: "claude" | "codex" | "gemini" | "copilot" | "cursor" | "custom";
  /** Small glyph for lists (an emoji or short text) — custom CLIs only. */
  icon: string;
  /** The command line the terminal plays on open (before MCP wiring). */
  cmd: string;
  /** Starting model — composed as the CLI's model flag; "" = the CLI's own
   *  default. A workspace cell's model override beats this at open. */
  model: string;
  /** Wire the Glyphh local MCP server into the CLI (--mcp-config). */
  mcp: boolean;
  /** Start the terminal here (like a workspace's working folder). "" = current. */
  cwd: string;
  /** Glyphh's ONE permission vocabulary, projected onto each CLI's native
   *  controls (the loop enforces; we only standardize the words):
   *  safe = read/plan only · ask = the CLI's default prompting · auto = run
   *  without prompting. Absent = ask. */
  permission?: "safe" | "ask" | "auto";
  /** Pass an API key to the CLI: the env-var NAME rides here; the VALUE
   *  lives in the agent's env file (0600) and is never readable back — list
   *  rows carry only a first/last glimpse (`hint`) for recognition. */
  apiKey: { name: string; hint: string } | null;
  /** What an open does with the agent's session (a workspace cell can
   *  override per slot):
   *    keep — re-attach the parked terminal if one survives; else start.
   *    new  — always a fresh session; closing kills the terminal.
   *    last — re-attach if parked; else start the CLI RESUMING its own last
   *           conversation (claude --continue / codex resume --last). */
  session: "keep" | "new" | "last";
  /** The member's own switch in Settings -> Loops. Policy decides what is
   *  OFFERED; this is what they turned on. Absent = on, so a loop that
   *  predates the switch keeps working. */
  enabled?: boolean;
  createdAt: string;
  updatedAt: string;
}

/** What renderers get: the row plus the fully composed command to run. */
export type CliAgentListed = CliAgentRow & { command: string };

const agentFile = (id: string): string => path.join(AGENTS_DIR(), id, "agent.json");
const mcpFile = (id: string): string => path.join(AGENTS_DIR(), id, "mcp.json");
/** The secret side of `apiKey`: NAME="value" lines the composed command
 *  sources invisibly (`set -a; . file; set +a`) — the value never types
 *  into the visible terminal and never rides agent.json. */
const envFile = (id: string): string => path.join(AGENTS_DIR(), id, "env");

const keyHint = (value: string): string =>
  value.length <= 8 ? `${value.slice(0, 2)}…` : `${value.slice(0, 4)}…${value.slice(-4)}`;

function readEnvValue(id: string, name: string): string {
  try {
    const m = new RegExp(`^${name.replace(/[^\w]/g, "")}="(.*)"$`, "m").exec(fs.readFileSync(envFile(id), "utf-8"));
    return m?.[1] ?? "";
  } catch {
    return "";
  }
}

function writeEnvValue(id: string, name: string, value: string): void {
  fs.mkdirSync(path.join(AGENTS_DIR(), id), { recursive: true });
  fs.writeFileSync(envFile(id), `${name}="${value.replace(/"/g, '\\"')}"\n`, { encoding: "utf-8", mode: 0o600 });
}

const slug = (name: string): string =>
  name.trim().toLowerCase().replace(/[^\w.-]+/g, "-").replace(/^-+|-+$/g, "") || "agent";

/** A loop's row — saved, or the virtual default for a bare CLI id. The
 *  model-list seam (loop-models.ts) reads it to know which endpoint to ask. */
export function agentRowFor(id: string): CliAgentRow | null {
  const srv = orgLoops?.get(id);
  if (srv) return rowFromServer(srv);
  // With a roster loaded, an id it does not carry is a loop the org turned
  // off — not a local file to fall back on.
  if (orgLoops) return null;
  return readAgent(id) ?? defaultRowFor(id);
}

/** The loop's OWN vendor key value (its env file), "" when none. Never logged. */
export function loopKeyValue(id: string, name: string): string {
  return readEnvValue(id, name);
}

function readAgent(id: string): CliAgentRow | null {
  try {
    const row = JSON.parse(fs.readFileSync(agentFile(id), "utf-8")) as CliAgentRow;
    if (!row || !row.id) return null;
    row.cli = ["custom", "codex", "gemini", "copilot", "cursor"].includes(row.cli) ? row.cli : "claude";
    row.cwd = typeof row.cwd === "string" ? row.cwd : "";
    row.model = typeof row.model === "string" ? row.model : "";
    // legacy rows carried a keepAlive boolean — false maps to "new"
    const legacyKeep = (row as unknown as { keepAlive?: boolean }).keepAlive;
    row.session = row.session === "new" || row.session === "last" ? row.session
      : legacyKeep === false ? "new" : "keep";
    row.apiKey = row.apiKey && typeof row.apiKey === "object" && row.apiKey.name ? row.apiKey : null;
    row.enabled = row.enabled !== false;
    return row;
  } catch {
    return null;
  }
}

// ── THE ROSTER RIDES THE SERVER SEAM (his ruling, 2026-09-15) ───────────────
// The org's loops and their pre-config come from /api/loops/available — the
// org admin's Loops page decides what every member's terminal starts with.
// Nothing about a loop is kept on disk any more except the member's OWN
// vendor key (the BYOK lane), which stays in the loop's 0600 env file.
// Offline, or before sign-in, the branded defaults stand in.
interface ServerLoop {
  cli: string; name: string; provider: string; enabled: boolean; icon: string; cmd: string;
  mcp: boolean; session: "keep" | "new" | "last"; permission: "safe" | "ask" | "auto"; cwd: string; updatedAt?: string | null;
}
let orgLoops: Map<string, ServerLoop> | null = null;
let orgLoopsAt = 0;
let orgLoopsInflight: Promise<void> | null = null;
const ORG_LOOPS_TTL_MS = 60_000;

/** Refresh the roster from the server; a failure keeps the last good roster
 *  (or the defaults) and retries on the next call — never a blocked composer. */
export async function ensureOrgLoops(force = false): Promise<void> {
  if (!force && orgLoops && Date.now() - orgLoopsAt < ORG_LOOPS_TTL_MS) return;
  if (orgLoopsInflight) return orgLoopsInflight;
  orgLoopsInflight = (async () => {
    try {
      const rows = await getClient().http.get<ServerLoop[]>("/api/loops/available");
      if (Array.isArray(rows)) {
        orgLoops = new Map(rows.filter((r) => r && r.cli).map((r) => [r.cli, r]));
        orgLoopsAt = Date.now();
      }
    } catch (err) {
      console.warn("[agents] org loops unavailable — defaults stand:", err instanceof Error ? err.message : String(err));
      orgLoopsAt = Date.now() - ORG_LOOPS_TTL_MS + 10_000; // retry in 10s
    } finally {
      orgLoopsInflight = null;
    }
  })();
  return orgLoopsInflight;
}

/** A roster row as the desktop's loop record: the org's pre-config plus the
 *  member's own key (local, write-only) when they set one. */
function rowFromServer(l: ServerLoop): CliAgentRow {
  const local = readAgent(l.cli);
  const cli = (["codex", "gemini", "copilot", "cursor"].includes(l.cli) ? l.cli : "claude") as CliAgentRow["cli"];
  const now = new Date().toISOString();
  return {
    id: l.cli, name: l.name, cli, icon: l.icon || "", cmd: l.cmd || l.cli, model: "",
    mcp: l.mcp !== false, cwd: l.cwd || "", session: l.session ?? "keep", permission: l.permission ?? "ask",
    apiKey: local?.apiKey ?? null, enabled: l.enabled !== false,
    createdAt: local?.createdAt ?? now, updatedAt: l.updatedAt ?? local?.updatedAt ?? now,
  };
}

function writeAgent(row: CliAgentRow): void {
  const dir = path.join(AGENTS_DIR(), row.id);
  fs.mkdirSync(dir, { recursive: true });
  const file = agentFile(row.id);
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(row, null, 2), "utf-8");
  fs.renameSync(`${file}.tmp`, file);
}

/** (Re)write the agent's --mcp-config file against the CURRENT port. The
 *  bearer token mints once per agent and lives inside this file — it grants
 *  loopback access to this machine's own tool surface, nothing remote. */
function ensureMcpConfig(id: string): void {
  const { port } = localMcpStatus();
  let token: string | undefined;
  try {
    const existing = JSON.parse(fs.readFileSync(mcpFile(id), "utf-8")) as {
      mcpServers?: { glyphh?: { headers?: { Authorization?: string } } };
    };
    token = /^Bearer (.+)$/.exec(existing.mcpServers?.glyphh?.headers?.Authorization ?? "")?.[1];
  } catch { /* first write */ }
  if (!token) token = localMcpGenToken(`agent:${id}`, 365).token;
  fs.mkdirSync(path.join(AGENTS_DIR(), id), { recursive: true });
  upsertMcpServer(mcpFile(id), "glyphh", {
    type: "http",
    url: `http://127.0.0.1:${port}/mcp`,
    headers: { Authorization: `Bearer ${token}` },
  });
}

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

/** The REMOTE MCP server — the gateway's /mcp, where the org's connections
 *  (Pipedream apps, custom servers) live (his ruling, 2026-09-14: "the MCP
 *  server becomes remote"). The member's own gateway key authenticates it,
 *  so every tool call is metered to them and reaches THEIR connected
 *  accounts. Written into every CLI's MCP seam beside the local entry. */
function ensureRemoteMcp(id: string, cli: string, creds: GatewayCreds | null): void {
  if (!creds) return;
  const entry = { type: "http", url: `${creds.baseUrl.replace(/\/$/, "")}/mcp`, headers: { Authorization: `Bearer ${creds.token}` } };
  upsertMcpServer(mcpFile(id), "glyphh_gateway", entry);
  if (cli === "gemini") upsertMcpServer(path.join(homedir(), ".gemini", "settings.json"), "glyphh_gateway", { httpUrl: entry.url, headers: entry.headers });
  if (cli === "copilot") upsertMcpServer(path.join(homedir(), ".copilot", "mcp-config.json"), "glyphh_gateway", entry);
  if (cli === "cursor") upsertMcpServer(path.join(homedir(), ".cursor", "mcp.json"), "glyphh_gateway", { url: entry.url, headers: entry.headers });
}

/** The agent's minted bearer, read back from its mcp.json. */
function mcpTokenOf(id: string): string {
  try {
    const cfg = JSON.parse(fs.readFileSync(mcpFile(id), "utf-8")) as {
      mcpServers?: { glyphh?: { headers?: { Authorization?: string } } };
    };
    return /^Bearer (.+)$/.exec(cfg.mcpServers?.glyphh?.headers?.Authorization ?? "")?.[1] ?? "";
  } catch {
    return "";
  }
}

/** Gemini's MCP seam is its settings file, not a launch flag — the same
 *  mutation its own `gemini mcp add` performs: upsert mcpServers.glyphh into
 *  ~/.gemini/settings.json (created if absent, every other key preserved). */
function ensureGeminiMcp(id: string): void {
  const { port } = localMcpStatus();
  const token = mcpTokenOf(id);
  const file = path.join(homedir(), ".gemini", "settings.json");
  let settings: Record<string, unknown> = {};
  try { settings = JSON.parse(fs.readFileSync(file, "utf-8")) as Record<string, unknown>; } catch { /* first write */ }
  const servers = (settings.mcpServers && typeof settings.mcpServers === "object" ? settings.mcpServers : {}) as Record<string, unknown>;
  servers.glyphh = {
    httpUrl: `http://127.0.0.1:${port}/mcp`,
    ...(token ? { headers: { Authorization: `Bearer ${token}` } } : {}),
  };
  settings.mcpServers = servers;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(settings, null, 2), "utf-8");
}

/** An agent passing GEMINI_API_KEY pre-selects key auth in the CLI's
 *  settings, skipping the first-run chooser (whose Google option now
 *  auto-fails for individual accounts). Both schema generations get the
 *  key — v0.4x reads top-level selectedAuthType, v0.5x+ security.auth. */
function ensureGeminiKeyAuth(): void {
  const file = path.join(homedir(), ".gemini", "settings.json");
  let settings: Record<string, unknown> = {};
  try { settings = JSON.parse(fs.readFileSync(file, "utf-8")) as Record<string, unknown>; } catch { /* first write */ }
  settings.selectedAuthType = "gemini-api-key";
  const security = (settings.security && typeof settings.security === "object" ? settings.security : {}) as Record<string, unknown>;
  const auth = (security.auth && typeof security.auth === "object" ? security.auth : {}) as Record<string, unknown>;
  auth.selectedType = "gemini-api-key";
  security.auth = auth;
  settings.security = security;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(settings, null, 2), "utf-8");
}

/** Pin the CLI's OWN theme to the app's (his order, 2026-09-10 — the ANSI
 *  palette covers most of it; these cover the truecolor chrome). Same upsert
 *  contract as every settings seam: one key changes, the rest survives. */
function ensureClaudeTheme(light: boolean): void {
  const file = path.join(homedir(), ".claude.json");
  let cfg: Record<string, unknown> = {};
  try { cfg = JSON.parse(fs.readFileSync(file, "utf-8")) as Record<string, unknown>; } catch { /* first write */ }
  cfg.theme = light ? "light" : "dark";
  fs.writeFileSync(file, JSON.stringify(cfg, null, 2), "utf-8");
}

function ensureGeminiTheme(light: boolean): void {
  const file = path.join(homedir(), ".gemini", "settings.json");
  let cfg: Record<string, unknown> = {};
  try { cfg = JSON.parse(fs.readFileSync(file, "utf-8")) as Record<string, unknown>; } catch { /* first write */ }
  cfg.theme = light ? "Default Light" : "Default";
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(cfg, null, 2), "utf-8");
}

/** Copilot CLI's seam is ~/.copilot/mcp-config.json — same upsert contract
 *  as Gemini's settings file: glyphh joins mcpServers, everything else stays. */
function ensureCopilotMcp(id: string): void {
  const { port } = localMcpStatus();
  const token = mcpTokenOf(id);
  const file = path.join(homedir(), ".copilot", "mcp-config.json");
  let cfg: Record<string, unknown> = {};
  try { cfg = JSON.parse(fs.readFileSync(file, "utf-8")) as Record<string, unknown>; } catch { /* first write */ }
  const servers = (cfg.mcpServers && typeof cfg.mcpServers === "object" ? cfg.mcpServers : {}) as Record<string, unknown>;
  servers.glyphh = {
    type: "http",
    url: `http://127.0.0.1:${port}/mcp`,
    ...(token ? { headers: { Authorization: `Bearer ${token}` } } : {}),
  };
  cfg.mcpServers = servers;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(cfg, null, 2), "utf-8");
}

/** cursor-agent's seam is ~/.cursor/mcp.json — the same upsert contract. */
function ensureCursorMcp(id: string): void {
  const { port } = localMcpStatus();
  const token = mcpTokenOf(id);
  const file = path.join(homedir(), ".cursor", "mcp.json");
  let cfg: Record<string, unknown> = {};
  try { cfg = JSON.parse(fs.readFileSync(file, "utf-8")) as Record<string, unknown>; } catch { /* first write */ }
  const servers = (cfg.mcpServers && typeof cfg.mcpServers === "object" ? cfg.mcpServers : {}) as Record<string, unknown>;
  servers.glyphh = {
    url: `http://127.0.0.1:${port}/mcp`,
    ...(token ? { headers: { Authorization: `Bearer ${token}` } } : {}),
  };
  cfg.mcpServers = servers;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(cfg, null, 2), "utf-8");
}

/** Per-CLI composition. The agent rides the USER'S own CLI auth (their
 *  ~/.claude login / ~/.codex auth) — Glyphh injects nothing else yet; the
 *  gateway's base-URL seam lands here later.
 *    claude — --mcp-config <file> (the JSON beside the agent)
 *    codex  — TOML -c overrides (streamable-HTTP MCP via the rmcp client)
 *    custom — the command verbatim; mcp.json sits beside the agent for
 *             whatever the CLI can consume */
/** Each CLI's model flag — appended when the agent (or an override) names one. */
// ── The LOOP WRAPPER's capability matrix (his direction, 2026-09-11) ────────
// One declared profile per supported loop: what each CLI can do, and how
// Glyphh's permission vocabulary projects onto its native flags. Everything
// upstream (task slots, schedules, org loop pickers) filters against THIS
// instead of discovering gaps at runtime; adding a loop = a profile + a
// compose branch, nothing else.
//
// Flag names are the least stable part of every CLI's surface — an unknown
// projection is OMITTED (the CLI falls back to its own default prompting),
// never a hard error.

export interface CliProfile {
  /** Print/exec mode exists — schedules + task_run can ride this loop. */
  headless: boolean;
  /** `resume last` affordance (session mode "last"). */
  resumeLast: boolean;
  /** Resume a SPECIFIC session id (rail Recents / card dropdown). */
  resumeById: boolean;
  /** Takes a model flag on the line. */
  modelFlag: boolean;
  /** Glyphh local MCP wiring exists for this loop. */
  mcp: boolean;
  /** Honors a base-URL env override — the org router lane's seam. */
  baseUrlEnv: string[];
  /** Interactive permission projection; missing key = omit the flag. */
  perm: Partial<Record<"safe" | "auto", string>>;
  /** Headless projection (unattended runs prompt no one). */
  permHeadless: Partial<Record<"safe" | "auto", string>>;
}

export const CLI_PROFILES: Record<CliAgentRow["cli"], CliProfile> = {
  claude: {
    headless: true, resumeLast: true, resumeById: true, modelFlag: true, mcp: true,
    baseUrlEnv: ["ANTHROPIC_BASE_URL"],
    perm: { safe: " --permission-mode plan", auto: " --permission-mode bypassPermissions" },
    permHeadless: { auto: " --dangerously-skip-permissions" },
  },
  codex: {
    headless: true, resumeLast: true, resumeById: true, modelFlag: true, mcp: true,
    baseUrlEnv: ["OPENAI_BASE_URL"],
    perm: { safe: " --sandbox read-only", auto: " --full-auto" },
    permHeadless: { safe: " --sandbox read-only", auto: " --full-auto" },
  },
  gemini: {
    headless: true, resumeLast: false, resumeById: false, modelFlag: true, mcp: true,
    baseUrlEnv: ["GOOGLE_GEMINI_BASE_URL"],
    perm: { auto: " --yolo" },
    permHeadless: { auto: " --yolo" },
  },
  copilot: {
    headless: false, resumeLast: false, resumeById: false, modelFlag: false, mcp: true,
    baseUrlEnv: [],
    perm: {},
    permHeadless: {},
  },
  cursor: {
    headless: false, resumeLast: false, resumeById: false, modelFlag: false, mcp: true,
    baseUrlEnv: [],
    perm: {},
    permHeadless: {},
  },
  custom: {
    headless: false, resumeLast: false, resumeById: false, modelFlag: false, mcp: false,
    baseUrlEnv: [],
    perm: {},
    permHeadless: {},
  },
};

/** The agent's permission mode as this CLI's flag ("" when the mode is ask,
 *  unknown, or the loop has no such control). */
function permFlag(row: Pick<CliAgentRow, "cli" | "permission">, headless: boolean): string {
  const mode = row.permission;
  if (!mode || mode === "ask") return "";
  const table = headless ? CLI_PROFILES[row.cli]?.permHeadless : CLI_PROFILES[row.cli]?.perm;
  return table?.[mode] ?? "";
}

function modelFlag(cli: CliAgentRow["cli"], model: string): string {
  if (!model) return "";
  // A catalog id ("anthropic::claude-sonnet-5") from the org pickers; the CLI's flag takes the bare name.
  const m = model.replace(/"/g, "").replace(/^[a-z0-9_-]+::/i, "");
  switch (cli) {
    case "claude": return ` --model "${m}"`;
    case "codex": return ` -m "${m}"`;
    case "gemini": return ` -m "${m}"`;
    case "copilot": return ` --model "${m}"`;
    case "cursor": return ` --model "${m}"`;
    default: return "";
  }
}

/** The tool modes from Settings → Connections (Always allow / Needs approval /
 *  Never), projected onto Claude Code's own permission flags. "Never" is
 *  already enforced at the gateway (the tool is not served to this member);
 *  here it is also denied, and "Always allow" runs without a prompt. The
 *  gateway's tools reach Claude as mcp__glyphh_gateway__<server>-<tool>.
 *  Codex, Gemini and Copilot have no per-tool allow seam on their command
 *  line: for them Never holds at the gateway and the CLI prompts for the rest. */
function claudeToolFlags(): string {
  const modes = preferencesByPrefix<Record<string, string>>("connToolModes:");
  const allow: string[] = [];
  const deny: string[] = [];
  for (const [key, byTool] of Object.entries(modes)) {
    if (key.startsWith("app:") || !byTool || typeof byTool !== "object") continue;
    for (const [tool, mode] of Object.entries(byTool)) {
      const id = `mcp__glyphh_gateway__${tool.replace(/["'\s]/g, "")}`;
      if (mode === "allow") allow.push(id);
      else if (mode === "never") deny.push(id);
    }
  }
  const list = (flag: string, ids: string[]): string => (ids.length ? ` ${flag} ${ids.map((x) => `"${x}"`).join(" ")}` : "");
  return list("--allowedTools", allow) + list("--disallowedTools", deny);
}

/** resume: true = the CLI's continue-last; a string = a SPECIFIC session id
 *  (claude --resume <id> / codex resume <id>) — the rail Recents rides it. */
export interface OpenOverrides { model?: string; cwd?: string; resume?: boolean | string; prompt?: string; light?: boolean }

/** The SESSION's mode (the composer's chip: ask/plan/acceptEdits/auto)
 *  projected onto a CLI's headless flags. Provided per turn, it OVERRIDES
 *  the loop config's own permission — the chip must transition the current
 *  session (his report, 2026-09-14: codex stayed in ask whatever the chip
 *  said). "ask" maps to no flag: a non-interactive exec keeps its default. */
export type SessionPermission = "ask" | "plan" | "acceptEdits" | "auto";
const SESSION_PERM_HEADLESS: Record<CliAgentRow["cli"], Partial<Record<SessionPermission, string>>> = {
  claude: { plan: " --permission-mode plan", acceptEdits: " --permission-mode acceptEdits", auto: " --dangerously-skip-permissions" },
  codex: { plan: " --sandbox read-only", acceptEdits: " --full-auto", auto: " --dangerously-bypass-approvals-and-sandbox" },
  gemini: { acceptEdits: " --approval-mode auto_edit", auto: " --yolo" },
  copilot: { acceptEdits: " --allow-all-tools", auto: " --allow-all" }, cursor: {}, custom: {},
};

/** A HEADLESS one-shot: the CLI's print/exec mode with `prompt`, riding the
 *  same env file / model / MCP wiring an interactive open gets. The loop
 *  scheduler runs these (no session mode → the loop config's permission
 *  stands); chat turns pass the SESSION's mode, which wins. */
export function composeHeadless(agent: CliAgentListed, prompt: string, model?: string, sessionPerm?: SessionPermission, resumeId?: string): string {
  const row = { ...agent } as CliAgentRow;
  const p = prompt.replace(/'/g, "'\\''");
  const m = (model ?? row.model ?? "").trim();
  const perm = sessionPerm ? (SESSION_PERM_HEADLESS[row.cli]?.[sessionPerm] ?? "") : permFlag(row, true);
  const rid = (resumeId ?? "").replace(/'/g, "");
  let core: string;
  switch (row.cli) {
    case "claude":
      core = `${row.cmd}${modelFlag(row.cli, m)}${perm}${claudeToolFlags()}${rid ? ` --resume '${rid}'` : ""} -p '${p}'${row.mcp ? ` --mcp-config "${mcpFile(row.id)}"` : ""}`;
      break;
    case "codex": {
      const token = row.mcp ? mcpTokenOf(row.id) : "";
      const { port } = localMcpStatus();
      // Chained turns resume the CLI's own persisted session (codex 0.154:
      // `exec resume <id>`), so a chat's turns share one context.
      core = (token ? `GLYPHH_MCP_TOKEN="${token}" ` : "")
        + `${row.cmd}${modelFlag(row.cli, m)}${perm} exec${rid ? ` resume '${rid}'` : ""} '${p}'`
        + (row.mcp ? ` -c experimental_use_rmcp_client=true -c 'mcp_servers.glyphh.url="http://127.0.0.1:${port}/mcp"'`
          + (token ? ` -c 'mcp_servers.glyphh.bearer_token_env_var="GLYPHH_MCP_TOKEN"'` : "") : "");
      break;
    }
    case "gemini":
      core = `${row.cmd}${modelFlag(row.cli, m)}${perm} -p '${p}'`;
      break;
    case "copilot":
      // Copilot CLI 1.0: -p runs one prompt and exits; the MCP config rides inline (same mcpServers shape as Claude's file).
      core = `${row.cmd}${modelFlag(row.cli, m)}${perm}${rid ? ` --resume '${rid}'` : ""} --no-color -p '${p}'${row.mcp ? ` --additional-mcp-config "$(cat "${mcpFile(row.id)}")"` : ""}`;
      break;
    default:
      throw new Error(`headless runs aren't wired for the ${row.cli} CLI yet — use claude, codex, gemini or copilot for scheduled loops`);
  }
  const line = row.cwd ? `cd "${row.cwd.replace(/"/g, '\\"')}" && ${core}` : core;
  // Source the env file whenever it EXISTS, not only when a BYOK key is set:
  // the gateway injection writes the same file (base URL + minted key), and
  // gating on row.apiKey would have made the whole last mile a silent no-op.
  return fs.existsSync(envFile(row.id))
    ? `set -a; . "${envFile(row.id)}"; set +a; ${line}`
    : line;
}

function composeCommand(row: CliAgentRow, ov?: OpenOverrides): string {
  const model = (ov?.model ?? row.model ?? "").trim();
  const cwd = (ov?.cwd ?? row.cwd ?? "").trim();
  // RESUME: the CLI's own continue-last affordance. claude takes a flag;
  // codex resumes via a subcommand; CLIs without one just start fresh.
  const resumePart = ov?.resume
    ? row.cli === "claude" ? (typeof ov.resume === "string" ? ` --resume '${ov.resume.replace(/'/g, "")}'` : " --continue")
      : row.cli === "codex" ? (typeof ov.resume === "string" ? ` resume '${ov.resume.replace(/'/g, "")}'` : " resume --last")
      : row.cli === "gemini" ? (typeof ov.resume === "string" ? ` --resume '${ov.resume.replace(/'/g, "")}'` : " --resume latest")
      : ""
    : "";
  // An INITIAL PROMPT seeds the interactive session (claude/codex take it
  // positionally; gemini via -i); CLIs without the affordance just open.
  const p0 = (ov?.prompt ?? "").trim();
  const promptPart = p0
    ? (row.cli === "claude" || row.cli === "codex") ? ` '${p0.replace(/'/g, "'\\''")}'`
      : row.cli === "gemini" ? ` -i '${p0.replace(/'/g, "'\\''")}'`
      : ""
    : "";
  const permPart = permFlag(row, false);
  let base = `${row.cmd}${resumePart}${modelFlag(row.cli, model)}${promptPart}${permPart}`;
  if (row.mcp) {
    if (row.cli === "codex") {
      const { port } = localMcpStatus();
      const token = mcpTokenOf(row.id);
      // codex (v0.154 verified): streamable_http auth rides an ENV VAR, not
      // an inline bearer_token ("bearer_token is not supported for
      // streamable_http") — the shell line exports it just for this process.
      base = (token ? `GLYPHH_MCP_TOKEN="${token}" ` : "")
        + `${row.cmd}${resumePart}${modelFlag(row.cli, model)}${promptPart}${permPart} -c experimental_use_rmcp_client=true`
        + ` -c 'mcp_servers.glyphh.url="http://127.0.0.1:${port}/mcp"'`
        + (token ? ` -c 'mcp_servers.glyphh.bearer_token_env_var="GLYPHH_MCP_TOKEN"'` : "");
    } else if (row.cli === "claude") {
      base = `${row.cmd}${resumePart}${modelFlag(row.cli, model)}${promptPart}${permPart}${claudeToolFlags()} --mcp-config "${mcpFile(row.id)}"`;
    }
    // gemini / copilot / cursor: nothing on the line — their settings-file
    // seams are written at open (ensureGeminiMcp / ensureCopilotMcp /
    // ensureCursorMcp).
  }
  // The working folder leads the open — same contract as a workspace's.
  const line = cwd ? `cd "${cwd.replace(/"/g, '\\"')}" && ${base}` : base;
  // The API key sources INVISIBLY — the terminal shows the file path, never
  // the value.
  // Source the env file whenever it EXISTS, not only when a BYOK key is set:
  // the gateway injection writes the same file (base URL + minted key), and
  // gating on row.apiKey would have made the whole last mile a silent no-op.
  return fs.existsSync(envFile(row.id))
    ? `set -a; . "${envFile(row.id)}"; set +a; ${line}`
    : line;
}

/**
 * Write the gateway env for EVERY configured loop, so any launch path starts
 * proxied (his ruling, 2026-09-12 — ease of use, not enforcement). Called at
 * sign-in; `cli-agent-open` still refreshes the one loop it opens, which
 * covers a credential that changed mid-session.
 */
export async function primeAllLoopEnv(): Promise<void> {
  let ids: string[] = [];
  try { ids = fs.readdirSync(AGENTS_DIR()); } catch { return; }
  const loops: Array<{ id: string; cli: string; hasOwnKey: boolean }> = [];
  for (const id of ids) {
    const row = readAgent(id);
    if (row) loops.push({ id: row.id, cli: row.cli, hasOwnKey: !!row.apiKey });
  }
  await primeGatewayEnv(loops, (cli) => CLI_PROFILES[cli as keyof typeof CLI_PROFILES]?.baseUrlEnv ?? []);
}

/** The branded loops' out-of-the-box rows — what a FRESH account drives
 *  before it ever touches Settings → Loops. Virtual until a save/open
 *  materializes a file: an explicit row (even disabled) always wins. Without
 *  this a new user has NO loops at all — the composer's picker is stuck on
 *  "Default", the rail's recents have no agent to resume on, and a one-field
 *  Settings → Loops save dies on "a loop needs a name" because there is no
 *  existing row to patch (his report, 2026-09-14). */
const DEFAULT_LOOP_NAMES: Partial<Record<CliAgentRow["cli"], string>> = {
  claude: "Claude", codex: "Codex", gemini: "Gemini", copilot: "Copilot", cursor: "Cursor",
};
function defaultRowFor(id: string): CliAgentRow | null {
  const name = DEFAULT_LOOP_NAMES[id as CliAgentRow["cli"]];
  if (!name) return null;
  const now = new Date().toISOString();
  return {
    id, name, cli: id as CliAgentRow["cli"], icon: "", cmd: id,
    model: "", mcp: true, cwd: "", session: "keep", apiKey: null,
    createdAt: now, updatedAt: now,
  };
}

export function listCliAgents(): CliAgentListed[] {
  if (orgLoops) {
    return [...orgLoops.values()]
      .filter((l) => l.enabled !== false)
      .map((l) => rowFromServer(l))
      .map((row) => ({ ...row, command: composeCommand(row) }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }
  let ids: string[] = [];
  try { ids = fs.readdirSync(AGENTS_DIR()); } catch { ids = []; }
  const out: CliAgentListed[] = [];
  for (const id of ids) {
    const row = readAgent(id);
    if (row) out.push({ ...row, command: composeCommand(row) });
  }
  // EVERY branded loop exists (his report, 2026-09-14: the picker showed
  // only Claude while the rest were enabled) — an explicit row (even a
  // disabled one) always wins its slot; only absent loops get the virtual.
  for (const cli of Object.keys(DEFAULT_LOOP_NAMES)) {
    if (!out.some((r) => r.cli === cli)) {
      const def = defaultRowFor(cli)!;
      out.push({ ...def, command: composeCommand(def) });
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

// ── Recent CLI sessions — the rail's Recents list ───────────────────────────
// Each CLI's OWN store is the source (his order, 2026-09-10; codex joined
// 2026-09-14 — "the recents gap"):
//   claude — ~/.claude/projects/<munged-cwd>/<id>.jsonl, one file per session
//   codex  — ~/.codex/sessions/<yyyy>/<mm>/<dd>/rollout-<ts>-<id>.jsonl
// The head of each file carries the real cwd and the first user message;
// mtime orders the merged list. (Gemini joins when its store is wired.)

export interface CliSessionRow { id: string; cli: "claude" | "codex" | "gemini"; title: string; cwd: string; mtime: number }

/** Gemini CLI keeps a chat per session under ~/.gemini/tmp/<project>/chats/,
 *  with the project's folder named in .project_root beside it. */
function geminiSessionFiles(): Array<{ file: string; mtime: number; cli: "gemini"; cwd: string }> {
  const root = path.join(homedir(), ".gemini", "tmp");
  let projects: string[] = [];
  try { projects = fs.readdirSync(root); } catch { return []; }
  const files: Array<{ file: string; mtime: number; cli: "gemini"; cwd: string }> = [];
  for (const proj of projects) {
    const dir = path.join(root, proj, "chats");
    let cwd = "";
    try { cwd = fs.readFileSync(path.join(root, proj, ".project_root"), "utf-8").trim(); } catch { cwd = ""; }
    let names: string[] = [];
    try { names = fs.readdirSync(dir); } catch { continue; }
    for (const n of names) {
      if (!n.endsWith(".jsonl")) continue;
      try { const st = fs.statSync(path.join(dir, n)); if (st.size > 0) files.push({ file: path.join(dir, n), mtime: st.mtimeMs, cli: "gemini", cwd }); } catch { /* raced */ }
    }
  }
  return files;
}

/** Gemini chat head: the first line carries sessionId; the title is the first
 *  user message that isn't the CLI's own <session_context> preamble. */
function readGeminiSessionHead(file: string, mtime: number, cwd: string): CliSessionRow | null {
  let head = "";
  try {
    const fd = fs.openSync(file, "r");
    const buf = Buffer.alloc(131_072);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    fs.closeSync(fd);
    head = buf.toString("utf-8", 0, n);
  } catch { return null; }
  let id = "";
  let title = "";
  type Msg = { type?: string; content?: Array<{ text?: string }> | string };
  const consider = (m: Msg): void => {
    if (title || m.type !== "user") return;
    const text = Array.isArray(m.content) ? m.content.map((c) => c.text || "").join("") : String(m.content || "");
    const t = text.trim();
    if (t && !t.startsWith("<session_context>")) title = t;
  };
  for (const line of head.split("\n")) {
    if (!line.trim()) continue;
    let j: { sessionId?: string; $set?: { messages?: Msg[] }; $push?: { messages?: Msg | Msg[] }; messages?: Msg[] };
    try { j = JSON.parse(line) as typeof j; } catch { continue; }
    if (typeof j.sessionId === "string") id = j.sessionId;
    for (const m of j.$set?.messages ?? j.messages ?? []) consider(m);
    const pushed = j.$push?.messages;
    if (pushed) for (const m of Array.isArray(pushed) ? pushed : [pushed]) consider(m);
    if (id && title) break;
  }
  if (!id || !title) return null;
  return { id, cli: "gemini", title: title.replace(/\s+/g, " ").slice(0, 80), cwd, mtime };
}

function claudeSessionFiles(): Array<{ file: string; mtime: number; cli: "claude" }> {
  const root = path.join(homedir(), ".claude", "projects");
  let dirs: string[] = [];
  try { dirs = fs.readdirSync(root); } catch { return []; }
  const files: Array<{ file: string; mtime: number; cli: "claude" }> = [];
  for (const d of dirs) {
    const dir = path.join(root, d);
    let names: string[] = [];
    try { names = fs.readdirSync(dir).filter((n) => n.endsWith(".jsonl")); } catch { continue; }
    for (const n of names) {
      try {
        const st = fs.statSync(path.join(dir, n));
        if (st.size > 0) files.push({ file: path.join(dir, n), mtime: st.mtimeMs, cli: "claude" });
      } catch { /* raced */ }
    }
  }
  return files;
}

function codexSessionFiles(): Array<{ file: string; mtime: number; cli: "codex" }> {
  const root = path.join(homedir(), ".codex", "sessions");
  const files: Array<{ file: string; mtime: number; cli: "codex" }> = [];
  const walk = (dir: string, depth: number): void => {
    let names: string[] = [];
    try { names = fs.readdirSync(dir); } catch { return; }
    for (const n of names) {
      const p = path.join(dir, n);
      try {
        const st = fs.statSync(p);
        if (st.isDirectory()) { if (depth < 3) walk(p, depth + 1); }
        else if (n.endsWith(".jsonl") && st.size > 0) files.push({ file: p, mtime: st.mtimeMs, cli: "codex" });
      } catch { /* raced */ }
    }
  };
  walk(root, 0);
  return files;
}

export function listCliSessions(limit = 40): CliSessionRow[] {
  const files: Array<{ file: string; mtime: number; cli: "claude" | "codex" | "gemini"; cwd?: string }> = [...claudeSessionFiles(), ...codexSessionFiles(), ...geminiSessionFiles()];
  files.sort((a, b) => b.mtime - a.mtime);
  const out: CliSessionRow[] = [];
  for (const f of files.slice(0, limit * 3)) {
    const row = f.cli === "codex" ? readCodexSessionHead(f.file, f.mtime) : f.cli === "gemini" ? readGeminiSessionHead(f.file, f.mtime, f.cwd || "") : readClaudeSessionHead(f.file, f.mtime);
    if (row) out.push(row);
    if (out.length >= limit) break;
  }
  return out;
}

/** Codex rollout head: session_meta carries id + cwd; the title is the first
 *  REAL user message (instruction/environment preludes skipped). */
function readCodexSessionHead(file: string, mtime: number): CliSessionRow | null {
  let head = "";
  try {
    const fd = fs.openSync(file, "r");
    const buf = Buffer.alloc(65_536);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    fs.closeSync(fd);
    head = buf.toString("utf-8", 0, n);
  } catch { return null; }
  let id = "";
  let cwd = "";
  let title = "";
  for (const line of head.split("\n")) {
    if (!line.trim()) continue;
    let j: { type?: string; payload?: Record<string, unknown> };
    try { j = JSON.parse(line) as typeof j; } catch { continue; }
    const p = j.payload ?? {};
    if (j.type === "session_meta") {
      if (typeof p.id === "string") id = p.id;
      if (typeof p.cwd === "string") cwd = p.cwd;
    }
    if (!title && p.type === "message" && p.role === "user" && Array.isArray(p.content)) {
      const t = (p.content as Array<{ type?: string; text?: string }>)
        .find((c) => c.type === "input_text" && c.text)?.text ?? "";
      // codex prepends AGENTS.md instructions + environment context as user
      // messages — nothing a human typed; skip until the real first message.
      if (t && !/^(#|<INSTRUCTIONS|<environment_context|<ENVIRONMENT)/.test(t.trim())) title = t;
    }
    if (id && cwd && title) break;
  }
  if (!title) return null;   // meta-only file — nothing a human would resume
  // The filename tail carries the id too — the fallback when meta is absent.
  if (!id) id = /rollout-[\dT-]+-([0-9a-f-]{36})\.jsonl$/.exec(path.basename(file))?.[1] ?? "";
  if (!id) return null;
  title = title.replace(/\s+/g, " ").trim().slice(0, 80);
  return { id, cli: "codex", title, cwd, mtime };
}

function readClaudeSessionHead(file: string, mtime: number): CliSessionRow | null {
  let head = "";
  try {
    const fd = fs.openSync(file, "r");
    const buf = Buffer.alloc(32_768);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    fs.closeSync(fd);
    head = buf.toString("utf-8", 0, n);
  } catch { return null; }
  let cwd = "";
  let title = "";
  for (const line of head.split("\n")) {
    if (!line.trim()) continue;
    let j: Record<string, unknown>;
    try { j = JSON.parse(line) as Record<string, unknown>; } catch { continue; }
    if (!cwd && typeof j.cwd === "string") cwd = j.cwd;
    if (!title && j.type === "summary" && typeof j.summary === "string") title = j.summary;
    if (!title && j.type === "user") {
      const msg = (j.message as { content?: unknown } | undefined)?.content;
      if (typeof msg === "string") title = msg;
      else if (Array.isArray(msg)) {
        const t = msg.find((c) => (c as { type?: string }).type === "text") as { text?: string } | undefined;
        if (t?.text) title = t.text;
      }
    }
    if (cwd && title) break;
  }
  if (!title) return null;   // meta-only file — nothing a human would resume
  title = title.replace(/\s+/g, " ").trim().slice(0, 80);
  return { id: path.basename(file, ".jsonl"), cli: "claude", title, cwd, mtime };
}

export function registerCliAgentsIpc(): void {
  // The roster is server-side; warm it (a pre-sign-in miss just retries later).
  void ensureOrgLoops();
  ipcMain.handle("cli-session-delete", (_e, id: string) => {
    try {
      const base = `${String(id)}.jsonl`;
      if (!/^[\w-]+\.jsonl$/.test(base)) throw new Error("bad session id");
      const root = path.join(homedir(), ".claude", "projects");
      let dirs: string[] = [];
      try { dirs = fs.readdirSync(root); } catch { dirs = []; }
      for (const d of dirs) {
        const f = path.join(root, d, base);
        if (fs.existsSync(f)) { fs.rmSync(f); return { ok: true }; }
      }
      // codex — rollout filenames END with the session id.
      const hit = codexSessionFiles().find((f) => f.file.endsWith(`-${String(id)}.jsonl`));
      if (hit) { fs.rmSync(hit.file); return { ok: true }; }
      // gemini — the chat file's tail is the session id's first block; the head line carries the full id.
      const g = geminiSessionFiles().find((f) => { try { return fs.readFileSync(f.file, "utf-8").slice(0, 400).includes(`"sessionId":"${String(id)}"`); } catch { return false; } });
      if (g) { fs.rmSync(g.file); return { ok: true }; }
      throw new Error("session not found");
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });
  ipcMain.handle("cli-sessions-list", () => {
    try { return { ok: true, sessions: listCliSessions() }; }
    catch (err) { return { ok: false, sessions: [], error: err instanceof Error ? err.message : String(err) }; }
  });
  ipcMain.handle("cli-agents-list", async () => {
    await ensureOrgLoops();
    try { return { ok: true, agents: listCliAgents() }; }
    catch (err) { return { ok: false, error: err instanceof Error ? err.message : String(err), agents: [] }; }
  });

  // Create-or-update: id is the slug of the FIRST name and never moves (echo
  // tiles + layout cells reference agent:<id>).
  ipcMain.handle("cli-agents-save", (_e, input: { id?: string; name: string; icon?: string; cmd: string; mcp?: boolean; cli?: string; cwd?: string; session?: string; model?: string; permission?: string; enabled?: boolean; apiKeyOn?: boolean; apiKeyName?: string; apiKeyValue?: string }) => {
    try {
      // A PARTIAL save PATCHES an existing loop: Settings -> Loops saves one
      // field at a time (a toggle, a dropdown), and demanding the whole row
      // back on every change is how a toggle ends up writing nothing.
      const id = input.id ? String(input.id) : slug(String(input.name ?? ""));
      // A branded loop with no file yet patches over its virtual default row,
      // so Settings → Loops' one-field saves work on a fresh account.
      // The org's row is the base; a save here only ever adds the member's own key.
      const existing = agentRowFor(id) ?? readAgent(id) ?? defaultRowFor(id);
      const name = String(input.name ?? existing?.name ?? "").trim();
      const cmd = String(input.cmd ?? existing?.cmd ?? "").trim();
      if (!name) return { ok: false, error: "a loop needs a name" };
      if (!cmd) return { ok: false, error: "a loop needs a command (e.g. claude)" };
      const now = new Date().toISOString();
      const row: CliAgentRow = {
        id,
        name,
        cli: ["custom", "codex", "gemini", "copilot", "cursor"].includes(String(input.cli)) ? (input.cli as CliAgentRow["cli"]) : "claude",
        icon: String(input.icon ?? existing?.icon ?? "").trim(),
        cmd,
        mcp: input.mcp !== false,
        cwd: String(input.cwd ?? existing?.cwd ?? "").trim(),
        model: String(input.model ?? existing?.model ?? "").trim(),
        session: input.session === "new" || input.session === "last" ? input.session
          : input.session === "keep" ? "keep" : (existing?.session ?? "keep"),
        permission: input.permission === "safe" || input.permission === "auto" ? input.permission
          : input.permission === "ask" ? "ask" : (existing?.permission ?? "ask"),
        apiKey: existing?.apiKey ?? null,
        enabled: input.enabled === undefined ? existing?.enabled !== false : !!input.enabled,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      };
      // API key: WRITE-ONLY. Toggle off deletes the secret; a new value (or a
      // renamed var carrying the old value) rewrites the 0600 env file; an
      // untouched value field changes nothing.
      if (input.apiKeyOn === false) {
        row.apiKey = null;
        try { fs.rmSync(envFile(id), { force: true }); } catch { /* gone */ }
      } else if (input.apiKeyOn === true) {
        const keyName = String(input.apiKeyName ?? row.apiKey?.name ?? "").trim().replace(/[^\w]/g, "");
        if (!keyName) return { ok: false, error: "the API key needs a variable name (e.g. GEMINI_API_KEY)" };
        const typed = String(input.apiKeyValue ?? "").trim();
        const value = typed || (row.apiKey ? readEnvValue(id, row.apiKey.name) : "");
        if (!value) return { ok: false, error: "paste the API key value" };
        writeEnvValue(id, keyName, value);
        row.apiKey = { name: keyName, hint: keyHint(value) };
      }
      writeAgent(row);
      if (row.mcp) ensureMcpConfig(id);
      return { ok: true, agent: { ...row, command: composeCommand(row) } };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  // Remove ONLY the stored key — the env file leaves the disk, the agent stays.
  ipcMain.handle("cli-agents-key-delete", (_e, id: string) => {
    try {
      const row = readAgent(String(id));
      if (!row) return { ok: false, error: "agent not found" };
      try { fs.rmSync(envFile(row.id), { force: true }); } catch { /* gone */ }
      row.apiKey = null;
      row.updatedAt = new Date().toISOString();
      writeAgent(row);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle("cli-agents-delete", (_e, id: string) => {
    try {
      fs.rmSync(path.join(AGENTS_DIR(), String(id)), { recursive: true, force: true });
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  // "Open" = make sure the pre-config's dependencies are live. The command
  // itself types into the terminal the renderer opens.
  ipcMain.handle("cli-agent-open", async (_e, id: string, overrides?: OpenOverrides) => {
    await ensureOrgLoops();
    try {
      // The virtual default Claude loop opens like a saved one (the same row
      // listCliAgents serves) — nothing is written until the user configures it.
      const row = agentRowFor(String(id));
      if (!row) return { ok: false, error: "this loop isn't enabled for your organization" };
      if (overrides?.light !== undefined) {
        try {
          if (row.cli === "claude") ensureClaudeTheme(overrides.light);
          if (row.cli === "gemini") ensureGeminiTheme(overrides.light);
        } catch (err) {
          console.warn("[agents] theme pin failed:", err instanceof Error ? err.message : err);
        }
      }
      // THE GATEWAY INJECTION (the last mile): point the CLI at the router
      // and hand it this member's minted key, so the role's models, rate and
      // budget bind and the spend lands under their name. BYOK WINS — a loop
      // the member gave its own key keeps using it; re-routing their traffic
      // through our meter without asking would be the wrong surprise.
      const cliProfile = CLI_PROFILES[row.cli];
      if (cliProfile?.baseUrlEnv.length) {
        // THE MEMORY BRIDGE (his order, 2026-09-14): when enabled, the
        // Anthropic-wire lane (claude, v1) routes through the loopback
        // bridge — capture + fact injection; every other shape stays
        // untouched. The bridge forwards auth as-is, so it wraps the
        // gateway lane AND the CLI's own login alike.
        const bridged = row.cli === "claude" ? await bridgeWrap("https://api.anthropic.com").catch(() => null) : null;
        if (row.apiKey) {
          if (bridged) writeBaseUrlOnly(row.id, row.cli, cliProfile.baseUrlEnv, bridged);
          else clearGatewayEnv(row.id, row.cli, cliProfile.baseUrlEnv);
        } else {
          const creds = await gatewayCreds();
          // No creds is a NORMAL answer (no plan, closed trial, offline) —
          // the loop then runs on whatever the CLI is already logged into.
          if (creds) {
            const wrapped = row.cli === "claude" ? await bridgeWrap(creds.baseUrl).catch(() => null) : null;
            writeGatewayEnv(row.id, row.cli, cliProfile.baseUrlEnv, wrapped ? { ...creds, baseUrl: wrapped } : creds);
          } else if (bridged) {
            writeBaseUrlOnly(row.id, row.cli, cliProfile.baseUrlEnv, bridged);
          } else {
            clearGatewayEnv(row.id, row.cli, cliProfile.baseUrlEnv);
          }
        }
      }
      if (row.mcp) {
        ensureMcpConfig(row.id);   // port may have changed since save
        ensureRemoteMcp(row.id, row.cli, await mcpCreds());
        if (row.cli === "gemini") {
          ensureGeminiMcp(row.id);
          if (row.apiKey?.name === "GEMINI_API_KEY") ensureGeminiKeyAuth();
        }
        if (row.cli === "copilot") ensureCopilotMcp(row.id);
        if (row.cli === "cursor") ensureCursorMcp(row.id);
        const r = await startLocalMcpServer();
        if (!r.ok) return { ok: false, error: r.error ?? "local MCP server failed to start" };
      }
      return { ok: true, command: composeCommand(row, overrides), name: row.name };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });
}
