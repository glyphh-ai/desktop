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
  /** Small glyph for lists (an emoji or short text). */
  icon: string;
  /** The command line the terminal plays on open (before MCP wiring). */
  cmd: string;
  /** Wire the Glyphh local MCP server into the CLI (--mcp-config). */
  mcp: boolean;
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
    return row && row.id ? row : null;
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

/** The one composition rule: mcp-on appends --mcp-config <file>. The agent
 *  rides the USER'S own CLI auth (their ~/.claude login) — Glyphh injects
 *  nothing else yet; the gateway's ANTHROPIC_BASE_URL seam lands here later. */
function composeCommand(row: CliAgentRow): string {
  if (!row.mcp) return row.cmd;
  return `${row.cmd} --mcp-config "${mcpFile(row.id)}"`;
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
  ipcMain.handle("cli-agents-save", (_e, input: { id?: string; name: string; icon?: string; cmd: string; mcp?: boolean }) => {
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
        icon: String(input.icon ?? existing?.icon ?? "").trim(),
        cmd,
        mcp: input.mcp !== false,
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
        const r = await startLocalMcpServer();
        if (!r.ok) return { ok: false, error: r.error ?? "local MCP server failed to start" };
      }
      return { ok: true, command: composeCommand(row), name: row.name };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });
}
