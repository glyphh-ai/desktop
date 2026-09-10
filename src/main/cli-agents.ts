/**
 * cli-agents.ts — AGENTS as CLI configs (the build after THE PURGE,
 * 2026-09-10). An agent is a named, icon-carrying pre-config for a CLI
 * (Claude first): the command to run, plus optional Glyphh MCP wiring.
 *
 *   ~/.glyphh/agents/<id>/agent.json   — { id, name, icon, cmd, mcp, … }
 *   ~/.glyphh/agents/<id>/mcp.json     — written when mcp is on: the
 *                                        --mcp-config file pointing the CLI
 *                                        at this machine's local MCP server
 *
 * "Open" anywhere (echo card, layout cell) plays the pre-config: the
 * composed command types into a fresh terminal panel. The list rows carry
 * the FULL composed command so renderers open synchronously; cli-agent-open
 * just makes sure the local MCP server is up first.
 */

import fs from "fs";
import path from "path";
import { homedir } from "os";
import { ipcMain } from "electron";
import { startLocalMcpServer, localMcpStatus, localMcpGenToken } from "./local-mcp-server.js";

export const AGENTS_DIR = path.join(homedir(), ".glyphh", "agents");

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
  createdAt: string;
  updatedAt: string;
}

/** What renderers get: the row plus the fully composed command to run. */
export type CliAgentListed = CliAgentRow & { command: string };

const agentFile = (id: string): string => path.join(AGENTS_DIR, id, "agent.json");
const mcpFile = (id: string): string => path.join(AGENTS_DIR, id, "mcp.json");
/** The secret side of `apiKey`: NAME="value" lines the composed command
 *  sources invisibly (`set -a; . file; set +a`) — the value never types
 *  into the visible terminal and never rides agent.json. */
const envFile = (id: string): string => path.join(AGENTS_DIR, id, "env");

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
  fs.mkdirSync(path.join(AGENTS_DIR, id), { recursive: true });
  fs.writeFileSync(envFile(id), `${name}="${value.replace(/"/g, '\\"')}"\n`, { encoding: "utf-8", mode: 0o600 });
}

const slug = (name: string): string =>
  name.trim().toLowerCase().replace(/[^\w.-]+/g, "-").replace(/^-+|-+$/g, "") || "agent";

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
    return row;
  } catch {
    return null;
  }
}

function writeAgent(row: CliAgentRow): void {
  const dir = path.join(AGENTS_DIR, row.id);
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
  const cfg = {
    mcpServers: {
      glyphh: {
        type: "http",
        url: `http://127.0.0.1:${port}/mcp`,
        headers: { Authorization: `Bearer ${token}` },
      },
    },
  };
  fs.mkdirSync(path.join(AGENTS_DIR, id), { recursive: true });
  fs.writeFileSync(mcpFile(id), JSON.stringify(cfg, null, 2), "utf-8");
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
function modelFlag(cli: CliAgentRow["cli"], model: string): string {
  if (!model) return "";
  const m = model.replace(/"/g, "");
  switch (cli) {
    case "claude": return ` --model "${m}"`;
    case "codex": return ` -m "${m}"`;
    case "gemini": return ` -m "${m}"`;
    case "copilot": return ` --model "${m}"`;
    case "cursor": return ` --model "${m}"`;
    default: return "";
  }
}

/** resume: true = the CLI's continue-last; a string = a SPECIFIC session id
 *  (claude --resume <id> / codex resume <id>) — the rail Recents rides it. */
export interface OpenOverrides { model?: string; cwd?: string; resume?: boolean | string; prompt?: string; light?: boolean }

/** A HEADLESS one-shot: the CLI's print/exec mode with `prompt`, riding the
 *  same env file / model / MCP wiring an interactive open gets. The loop
 *  scheduler runs these. */
export function composeHeadless(agent: CliAgentListed, prompt: string, model?: string): string {
  const row = { ...agent } as CliAgentRow;
  const p = prompt.replace(/'/g, "'\\''");
  const m = (model ?? row.model ?? "").trim();
  let core: string;
  switch (row.cli) {
    case "claude":
      core = `${row.cmd}${modelFlag(row.cli, m)} -p '${p}'${row.mcp ? ` --mcp-config "${mcpFile(row.id)}"` : ""}`;
      break;
    case "codex": {
      const token = row.mcp ? mcpTokenOf(row.id) : "";
      const { port } = localMcpStatus();
      core = (token ? `GLYPHH_MCP_TOKEN="${token}" ` : "")
        + `${row.cmd}${modelFlag(row.cli, m)} exec '${p}'`
        + (row.mcp ? ` -c experimental_use_rmcp_client=true -c 'mcp_servers.glyphh.url="http://127.0.0.1:${port}/mcp"'`
          + (token ? ` -c 'mcp_servers.glyphh.bearer_token_env_var="GLYPHH_MCP_TOKEN"'` : "") : "");
      break;
    }
    case "gemini":
      core = `${row.cmd}${modelFlag(row.cli, m)} -p '${p}'`;
      break;
    default:
      throw new Error(`headless runs aren't wired for the ${row.cli} CLI yet — use claude, codex or gemini for scheduled loops`);
  }
  const line = row.cwd ? `cd "${row.cwd.replace(/"/g, '\\"')}" && ${core}` : core;
  return row.apiKey && fs.existsSync(envFile(row.id))
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
  let base = `${row.cmd}${resumePart}${modelFlag(row.cli, model)}${promptPart}`;
  if (row.mcp) {
    if (row.cli === "codex") {
      const { port } = localMcpStatus();
      const token = mcpTokenOf(row.id);
      // codex (v0.154 verified): streamable_http auth rides an ENV VAR, not
      // an inline bearer_token ("bearer_token is not supported for
      // streamable_http") — the shell line exports it just for this process.
      base = (token ? `GLYPHH_MCP_TOKEN="${token}" ` : "")
        + `${row.cmd}${resumePart}${modelFlag(row.cli, model)}${promptPart} -c experimental_use_rmcp_client=true`
        + ` -c 'mcp_servers.glyphh.url="http://127.0.0.1:${port}/mcp"'`
        + (token ? ` -c 'mcp_servers.glyphh.bearer_token_env_var="GLYPHH_MCP_TOKEN"'` : "");
    } else if (row.cli === "claude") {
      base = `${row.cmd}${resumePart}${modelFlag(row.cli, model)}${promptPart} --mcp-config "${mcpFile(row.id)}"`;
    }
    // gemini / copilot / cursor: nothing on the line — their settings-file
    // seams are written at open (ensureGeminiMcp / ensureCopilotMcp /
    // ensureCursorMcp).
  }
  // The working folder leads the open — same contract as a workspace's.
  const line = cwd ? `cd "${cwd.replace(/"/g, '\\"')}" && ${base}` : base;
  // The API key sources INVISIBLY — the terminal shows the file path, never
  // the value.
  return row.apiKey && fs.existsSync(envFile(row.id))
    ? `set -a; . "${envFile(row.id)}"; set +a; ${line}`
    : line;
}

export function listCliAgents(): CliAgentListed[] {
  let ids: string[] = [];
  try { ids = fs.readdirSync(AGENTS_DIR); } catch { return []; }
  const out: CliAgentListed[] = [];
  for (const id of ids) {
    const row = readAgent(id);
    if (row) out.push({ ...row, command: composeCommand(row) });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

// ── Recent CLI sessions — the rail's Recents list ───────────────────────────
// Claude's store is the source: ~/.claude/projects/<munged-cwd>/<id>.jsonl,
// one file per session. The head of the file carries the real cwd and the
// first user message; mtime orders the list. (Codex/Gemini read differently —
// they join here when their stores are wired.)

export interface CliSessionRow { id: string; cli: "claude"; title: string; cwd: string; mtime: number }

export function listCliSessions(limit = 20): CliSessionRow[] {
  const root = path.join(homedir(), ".claude", "projects");
  let dirs: string[] = [];
  try { dirs = fs.readdirSync(root); } catch { return []; }
  const files: Array<{ file: string; mtime: number }> = [];
  for (const d of dirs) {
    const dir = path.join(root, d);
    let names: string[] = [];
    try { names = fs.readdirSync(dir).filter((n) => n.endsWith(".jsonl")); } catch { continue; }
    for (const n of names) {
      try {
        const st = fs.statSync(path.join(dir, n));
        if (st.size > 0) files.push({ file: path.join(dir, n), mtime: st.mtimeMs });
      } catch { /* raced */ }
    }
  }
  files.sort((a, b) => b.mtime - a.mtime);
  const out: CliSessionRow[] = [];
  for (const f of files.slice(0, limit * 2)) {
    const row = readClaudeSessionHead(f.file, f.mtime);
    if (row) out.push(row);
    if (out.length >= limit) break;
  }
  return out;
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
  ipcMain.handle("cli-session-delete", (_e, id: string) => {
    try {
      const base = `${String(id)}.jsonl`;
      if (!/^[\w-]+\.jsonl$/.test(base)) throw new Error("bad session id");
      const root = path.join(homedir(), ".claude", "projects");
      for (const d of fs.readdirSync(root)) {
        const f = path.join(root, d, base);
        if (fs.existsSync(f)) { fs.rmSync(f); return { ok: true }; }
      }
      throw new Error("session not found");
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });
  ipcMain.handle("cli-sessions-list", () => {
    try { return { ok: true, sessions: listCliSessions() }; }
    catch (err) { return { ok: false, sessions: [], error: err instanceof Error ? err.message : String(err) }; }
  });
  ipcMain.handle("cli-agents-list", () => {
    try { return { ok: true, agents: listCliAgents() }; }
    catch (err) { return { ok: false, error: err instanceof Error ? err.message : String(err), agents: [] }; }
  });

  // Create-or-update: id is the slug of the FIRST name and never moves (echo
  // tiles + layout cells reference agent:<id>).
  ipcMain.handle("cli-agents-save", (_e, input: { id?: string; name: string; icon?: string; cmd: string; mcp?: boolean; cli?: string; cwd?: string; session?: string; model?: string; apiKeyOn?: boolean; apiKeyName?: string; apiKeyValue?: string }) => {
    try {
      const name = String(input.name ?? "").trim();
      const cmd = String(input.cmd ?? "").trim();
      if (!name) return { ok: false, error: "an agent needs a name" };
      if (!cmd) return { ok: false, error: "an agent needs a command (e.g. claude)" };
      const id = input.id ? String(input.id) : slug(name);
      const existing = readAgent(id);
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
        apiKey: existing?.apiKey ?? null,
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
      fs.rmSync(path.join(AGENTS_DIR, String(id)), { recursive: true, force: true });
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  // "Open" = make sure the pre-config's dependencies are live. The command
  // itself types into the terminal the renderer opens.
  ipcMain.handle("cli-agent-open", async (_e, id: string, overrides?: OpenOverrides) => {
    try {
      const row = readAgent(String(id));
      if (!row) return { ok: false, error: "agent not found" };
      if (overrides?.light !== undefined) {
        try {
          if (row.cli === "claude") ensureClaudeTheme(overrides.light);
          if (row.cli === "gemini") ensureGeminiTheme(overrides.light);
        } catch (err) {
          console.warn("[agents] theme pin failed:", err instanceof Error ? err.message : err);
        }
      }
      if (row.mcp) {
        ensureMcpConfig(row.id);   // port may have changed since save
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
