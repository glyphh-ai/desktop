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
  cli: "claude" | "codex" | "gemini" | "copilot" | "custom";
  /** Small glyph for lists (an emoji or short text) — custom CLIs only. */
  icon: string;
  /** The command line the terminal plays on open (before MCP wiring). */
  cmd: string;
  /** Wire the Glyphh local MCP server into the CLI (--mcp-config). */
  mcp: boolean;
  /** Start the terminal here (like a workspace's working folder). "" = current. */
  cwd: string;
  /** Closing the card parks the terminal session for the next open (true,
   *  the default) or kills it so every open starts fresh. A workspace cell's
   *  own "Maintain on close" OVERRIDES this when the agent rides a layout. */
  keepAlive: boolean;
  createdAt: string;
  updatedAt: string;
}

/** What renderers get: the row plus the fully composed command to run. */
export type CliAgentListed = CliAgentRow & { command: string };

const agentFile = (id: string): string => path.join(AGENTS_DIR, id, "agent.json");
const mcpFile = (id: string): string => path.join(AGENTS_DIR, id, "mcp.json");

const slug = (name: string): string =>
  name.trim().toLowerCase().replace(/[^\w.-]+/g, "-").replace(/^-+|-+$/g, "") || "agent";

function readAgent(id: string): CliAgentRow | null {
  try {
    const row = JSON.parse(fs.readFileSync(agentFile(id), "utf-8")) as CliAgentRow;
    if (!row || !row.id) return null;
    row.cli = ["custom", "codex", "gemini", "copilot"].includes(row.cli) ? row.cli : "claude";
    row.cwd = typeof row.cwd === "string" ? row.cwd : "";
    row.keepAlive = row.keepAlive !== false;
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

/** Per-CLI composition. The agent rides the USER'S own CLI auth (their
 *  ~/.claude login / ~/.codex auth) — Glyphh injects nothing else yet; the
 *  gateway's base-URL seam lands here later.
 *    claude — --mcp-config <file> (the JSON beside the agent)
 *    codex  — TOML -c overrides (streamable-HTTP MCP via the rmcp client)
 *    custom — the command verbatim; mcp.json sits beside the agent for
 *             whatever the CLI can consume */
function composeCommand(row: CliAgentRow): string {
  let base = row.cmd;
  if (row.mcp) {
    if (row.cli === "codex") {
      const { port } = localMcpStatus();
      const token = mcpTokenOf(row.id);
      // codex (v0.154 verified): streamable_http auth rides an ENV VAR, not
      // an inline bearer_token ("bearer_token is not supported for
      // streamable_http") — the shell line exports it just for this process.
      base = (token ? `GLYPHH_MCP_TOKEN="${token}" ` : "")
        + `${row.cmd} -c experimental_use_rmcp_client=true`
        + ` -c 'mcp_servers.glyphh.url="http://127.0.0.1:${port}/mcp"'`
        + (token ? ` -c 'mcp_servers.glyphh.bearer_token_env_var="GLYPHH_MCP_TOKEN"'` : "");
    } else if (row.cli === "claude") {
      base = `${row.cmd} --mcp-config "${mcpFile(row.id)}"`;
    }
    // gemini / copilot: nothing on the line — their settings-file seams are
    // written at open (ensureGeminiMcp / ensureCopilotMcp).
  }
  // The working folder leads the open — same contract as a workspace's.
  return row.cwd ? `cd "${row.cwd.replace(/"/g, '\\"')}" && ${base}` : base;
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

export function registerCliAgentsIpc(): void {
  ipcMain.handle("cli-agents-list", () => {
    try { return { ok: true, agents: listCliAgents() }; }
    catch (err) { return { ok: false, error: err instanceof Error ? err.message : String(err), agents: [] }; }
  });

  // Create-or-update: id is the slug of the FIRST name and never moves (echo
  // tiles + layout cells reference agent:<id>).
  ipcMain.handle("cli-agents-save", (_e, input: { id?: string; name: string; icon?: string; cmd: string; mcp?: boolean; cli?: string; cwd?: string; keepAlive?: boolean }) => {
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
        cli: ["custom", "codex", "gemini", "copilot"].includes(String(input.cli)) ? (input.cli as CliAgentRow["cli"]) : "claude",
        icon: String(input.icon ?? existing?.icon ?? "").trim(),
        cmd,
        mcp: input.mcp !== false,
        cwd: String(input.cwd ?? existing?.cwd ?? "").trim(),
        keepAlive: input.keepAlive !== undefined ? input.keepAlive !== false : existing?.keepAlive !== false,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      };
      writeAgent(row);
      if (row.mcp) ensureMcpConfig(id);
      return { ok: true, agent: { ...row, command: composeCommand(row) } };
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
  ipcMain.handle("cli-agent-open", async (_e, id: string) => {
    try {
      const row = readAgent(String(id));
      if (!row) return { ok: false, error: "agent not found" };
      if (row.mcp) {
        ensureMcpConfig(row.id);   // port may have changed since save
        if (row.cli === "gemini") ensureGeminiMcp(row.id);
        if (row.cli === "copilot") ensureCopilotMcp(row.id);
        const r = await startLocalMcpServer();
        if (!r.ok) return { ok: false, error: r.error ?? "local MCP server failed to start" };
      }
      return { ok: true, command: composeCommand(row), name: row.name };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });
}
