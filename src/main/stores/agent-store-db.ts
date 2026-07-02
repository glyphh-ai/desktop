/**
 * AgentStoreDb — SQLite-backed CRUD for the user's Agents registry.
 *
 * Drop-in replacement for the file-based agent-store.ts.
 * Same public API shape, backed by the local-db singleton.
 *
 * systemPrompt is stored PLAINTEXT (system_prompt column) — it's agent
 * instructions, not a secret, and encrypting it via safeStorage meant every
 * agent list/load hit the OS keychain. Legacy rows with the old
 * safeStorage-encrypted system_prompt_enc column get migrated to plaintext
 * once, on first read (see rowToAgent) — a single decrypt, never repeated.
 */

import { getLocalDb, decryptField } from "../local-db";
import { serverGetAuthed, serverPostAuthed, serverPatchAuthed, serverDeleteAuthed } from "../auth";

// ── Agent identity types — single source of truth ──────────
// (Formerly in the file-based agent-store.ts, now removed. This SQLite store
// is the one and only agents registry.)

export type AgentType = "local" | "remote";

export interface Guardrails {
  max_input_tokens_per_turn?: number;
  max_output_tokens_per_turn?: number;
  max_tokens_per_session?: number;
  max_turns?: number;
  rate_limit_rpm?: number;
  auto_stop_idle_seconds?: number;
}

export interface RemoteConfig {
  preferred_tier?: "premiere" | "standard" | "low" | "any";
  preferred_providers?: string[];
  default_idle_minutes?: number;
  active_reservation_id?: string;
  active_provider_handle?: string;
}

export interface AgentConfig {
  id: string;             // slug
  name: string;
  type: AgentType;

  role?: string;
  systemPrompt?: string;

  /** Public-facing identity. Falls back to identicon when avatar_url is unset. */
  avatar_url?: string;
  /** Short tagline shown in profile/leaderboard cards. */
  bio?: string;

  /** Apps this agent has access to (for tools and context). Slugs from ~/yo/apps/. */
  apps?: string[];
  /** Per-app tool/skill selection — which panel tools and MCP tools each app exposes. */
  appConfigs?: Record<string, { allowAll?: boolean; panelTools?: string[]; mcpTools?: string[] }>;
  /** Skills this agent can run. Names from the skill registry. */
  skills?: string[];
  /** Built-in tools the agent is allowed to call (read/write/shell/git/...). */
  builtin_tools?: string[];
  /** MCP server names the agent has access to. */
  mcp_servers?: string[];

  /** Model used by this agent (provider + name). Falls back to global llmConfig if unset. */
  model_provider?: string;
  model_name?: string;

  /**
   * How this agent runs inside a swarm:
   *  - "full"     — a full agent loop (tools, files, multi-turn). Default.
   *  - "readonly" — a one-shot model turn (debate / think, no tools).
   */
  mode?: "full" | "readonly";

  /** If true, this agent is published to yo-server and discoverable for cyphers. */
  joinable?: boolean;

  remote?: RemoteConfig;
  guardrails?: Guardrails;
  tool_permissions?: {
    shell?: "full" | "read" | "disabled";
    file_system?: "full" | "read" | "disabled";
    git?: "full" | "read" | "disabled";
    browser?: "full" | "read" | "disabled";
    mcp?: "full" | "read" | "disabled";
  };

  meta?: {
    createdAt: string;
    updatedAt: string;
    description?: string;
  };
}

// ── Row shape from SQLite ──────────────────────────────────

interface AgentRow {
  id: string;
  name: string;
  type: string;
  role: string | null;
  system_prompt: string | null;
  system_prompt_enc: string | null;
  joinable: number;
  apps_json: string | null;
  skills_json: string | null;
  builtin_tools_json: string | null;
  mcp_servers_json: string | null;
  guardrails_json: string | null;
  remote_json: string | null;
  config_json: string | null;
  avatar_url: string | null;
  bio: string | null;
  created_at: string;
  updated_at: string;
}

// ── Conversion helpers ─────────────────────────────────────

function rowToAgent(row: AgentRow): AgentConfig {
  const agent: AgentConfig = {
    id: row.id,
    name: row.name,
    type: row.type as AgentType,
  };

  if (row.role) agent.role = row.role;
  if (row.system_prompt) {
    agent.systemPrompt = row.system_prompt;
  } else if (row.system_prompt_enc) {
    // One-time legacy migration off safeStorage — decrypt once, persist as
    // plaintext, never touch the keychain for this row again.
    try {
      const plaintext = decryptField(row.system_prompt_enc);
      agent.systemPrompt = plaintext;
      getLocalDb().prepare("UPDATE agents SET system_prompt = ?, system_prompt_enc = NULL WHERE id = ?").run(plaintext, row.id);
    } catch { /* leave systemPrompt unset rather than fail the whole load */ }
  }
  if (row.joinable) agent.joinable = true;
  if (row.apps_json) agent.apps = JSON.parse(row.apps_json);
  if (row.skills_json) agent.skills = JSON.parse(row.skills_json);
  if (row.builtin_tools_json) agent.builtin_tools = JSON.parse(row.builtin_tools_json);
  if (row.mcp_servers_json) agent.mcp_servers = JSON.parse(row.mcp_servers_json);
  if (row.guardrails_json) agent.guardrails = JSON.parse(row.guardrails_json);
  if (row.remote_json) agent.remote = JSON.parse(row.remote_json);
  if (row.avatar_url) agent.avatar_url = row.avatar_url;
  if (row.bio) agent.bio = row.bio;

  // Restore extra config fields (model_provider, model_name, etc.)
  if (row.config_json) {
    const extra = JSON.parse(row.config_json);
    Object.assign(agent, extra);
  }

  agent.meta = {
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    description: row.config_json ? JSON.parse(row.config_json)._description : undefined,
  };

  return agent;
}

function agentToParams(cfg: AgentConfig, existingCreatedAt?: string) {
  const now = new Date().toISOString();

  // Extra fields that don't have dedicated columns go into config_json
  const extra: Record<string, unknown> = {};
  if (cfg.model_provider) extra.model_provider = cfg.model_provider;
  if (cfg.model_name) extra.model_name = cfg.model_name;
  if (cfg.mode) extra.mode = cfg.mode;
  if (cfg.appConfigs && Object.keys(cfg.appConfigs).length > 0) extra.appConfigs = cfg.appConfigs;
  if (cfg.tool_permissions) extra.tool_permissions = cfg.tool_permissions;
  if (cfg.meta?.description) extra._description = cfg.meta.description;

  return {
    id: cfg.id,
    name: cfg.name,
    type: cfg.type || "local",
    role: cfg.role || null,
    system_prompt: cfg.systemPrompt || null,
    joinable: cfg.joinable ? 1 : 0,
    apps_json: cfg.apps ? JSON.stringify(cfg.apps) : null,
    skills_json: cfg.skills ? JSON.stringify(cfg.skills) : null,
    builtin_tools_json: cfg.builtin_tools ? JSON.stringify(cfg.builtin_tools) : null,
    mcp_servers_json: cfg.mcp_servers ? JSON.stringify(cfg.mcp_servers) : null,
    guardrails_json: cfg.guardrails ? JSON.stringify(cfg.guardrails) : null,
    remote_json: cfg.remote ? JSON.stringify(cfg.remote) : null,
    config_json: Object.keys(extra).length > 0 ? JSON.stringify(extra) : null,
    avatar_url: cfg.avatar_url || null,
    bio: cfg.bio || null,
    created_at: existingCreatedAt || cfg.meta?.createdAt || now,
    updated_at: now,
  };
}

// ── Public API ─────────────────────────────────────────────

export function listAgents(): AgentConfig[] {
  const db = getLocalDb();
  const rows = db.prepare(
    "SELECT * FROM agents ORDER BY name COLLATE NOCASE"
  ).all() as AgentRow[];
  return rows.map(rowToAgent);
}

export function getAgent(id: string): AgentConfig | null {
  const db = getLocalDb();
  const row = db.prepare("SELECT * FROM agents WHERE id = ?").get(id) as AgentRow | undefined;
  if (!row) return null;
  return rowToAgent(row);
}

export function saveAgent(cfg: AgentConfig): AgentConfig {
  const db = getLocalDb();

  // Check for existing to preserve createdAt
  const existing = db.prepare("SELECT created_at FROM agents WHERE id = ?").get(cfg.id) as { created_at: string } | undefined;
  const params = agentToParams(cfg, existing?.created_at);

  db.prepare(`
    INSERT OR REPLACE INTO agents
      (id, name, type, role, system_prompt, joinable, apps_json, skills_json,
       builtin_tools_json, mcp_servers_json, guardrails_json, remote_json, config_json,
       avatar_url, bio, created_at, updated_at)
    VALUES
      (@id, @name, @type, @role, @system_prompt, @joinable, @apps_json, @skills_json,
       @builtin_tools_json, @mcp_servers_json, @guardrails_json, @remote_json, @config_json,
       @avatar_url, @bio, @created_at, @updated_at)
  `).run(params);

  // Return the saved state (re-read to ensure consistency)
  return getAgent(cfg.id)!;
}

export function removeAgent(id: string): boolean {
  const db = getLocalDb();
  const result = db.prepare("DELETE FROM agents WHERE id = ?").run(id);
  return result.changes > 0;
}

/**
 * Returns true if the slug is available (not already in use).
 */
export function idAvailable(id: string): boolean {
  if (!/^[a-z0-9][a-z0-9_-]*$/i.test(id)) return false;
  const db = getLocalDb();
  const row = db.prepare("SELECT 1 FROM agents WHERE id = ?").get(id);
  return !row;
}

// ── Server sync (yo-server /api/agents) ─────────────────────
//
// The SQLite table above is the local cache; identity round-trips through the
// server's saved_agents.config JSONB blob (full fidelity — migration 070), so
// agents sync cross-device and appear on the platform Agents page. Sync is
// ADDITIVE — a server list is merged into the cache, never used to prune local
// agents (a locally-created agent may not have synced yet); deletions propagate
// only through removeAgentSynced().

interface ServerAgent {
  id: string;
  name: string;
  role: string | null;
  systemPrompt: string | null;
  modelProvider: string | null;
  modelName: string | null;
  mode: "full" | "readonly";
  maxTurns: number | null;
  maxTokensPerSession: number | null;
  autoStopIdleSeconds: number | null;
  config: AgentConfig | null;
}

const serverIds = new Map<string, string>();   // agent slug → server UUID

function slugifyName(name: string): string {
  const s = String(name).toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48);
  return /^[a-z0-9]/.test(s) ? s : `a-${s || "agent"}`;
}

/** Reconstruct a client AgentConfig from a server row — the config blob when
 *  present (client-authored), else the flat subset (platform-authored). */
function serverToConfig(a: ServerAgent): AgentConfig {
  if (a.config && typeof a.config === "object") {
    const c = { ...a.config } as AgentConfig;
    if (!c.id) c.id = slugifyName(a.name);
    return c;
  }
  return {
    id: slugifyName(a.name),
    name: a.name,
    type: "local",
    role: a.role ?? undefined,
    systemPrompt: a.systemPrompt ?? undefined,
    model_provider: a.modelProvider ?? undefined,
    model_name: a.modelName ?? undefined,
    mode: a.mode,
  };
}

/** Map a client config to the server body (flat subset columns + full blob). */
function configToBody(cfg: AgentConfig): Record<string, unknown> {
  return {
    name: cfg.name,
    role: cfg.role ?? null,
    systemPrompt: cfg.systemPrompt ?? null,
    modelProvider: cfg.model_provider ?? null,
    modelName: cfg.model_name ?? null,
    mode: cfg.mode ?? "full",
    maxTurns: cfg.guardrails?.max_turns ?? null,
    maxTokensPerSession: cfg.guardrails?.max_tokens_per_session ?? null,
    autoStopIdleSeconds: cfg.guardrails?.auto_stop_idle_seconds ?? null,
    config: cfg,
  };
}

/** Push one agent to the server (create or update, keyed by slug→UUID). */
export async function pushAgentToServer(cfg: AgentConfig): Promise<void> {
  const body = configToBody(cfg);
  const id = serverIds.get(cfg.id);
  const saved = id
    ? await serverPatchAuthed<ServerAgent>(`/api/agents/${id}`, body)
    : await serverPostAuthed<ServerAgent>("/api/agents", body);
  serverIds.set(cfg.id, saved.id);
}

/** Pull agents from the server into the local cache (additive, non-fatal). */
export async function refreshAgentsFromServer(): Promise<void> {
  try {
    const agents = await serverGetAuthed<ServerAgent[]>("/api/agents");
    for (const a of agents) {
      try {
        const cfg = serverToConfig(a);
        serverIds.set(cfg.id, a.id);
        saveAgent(cfg);   // mirror into the SQLite cache
      } catch { /* skip malformed */ }
    }
  } catch { /* offline / pre-auth — local cache stands */ }
}

/** Refresh from the server, then list — used by the agents-list IPC. */
export async function refreshAndListAgents(): Promise<AgentConfig[]> {
  await refreshAgentsFromServer();
  return listAgents();
}

/** Save locally, then push to the server (awaited). Used by the Agents tab IPC. */
export async function saveAgentSynced(cfg: AgentConfig): Promise<AgentConfig> {
  const saved = saveAgent(cfg);
  try { await pushAgentToServer(saved); } catch { /* stays cached; reconciles on next push */ }
  return saved;
}

/** Delete locally and on the server. */
export async function removeAgentSynced(id: string): Promise<boolean> {
  const ok = removeAgent(id);
  const uuid = serverIds.get(id);
  serverIds.delete(id);
  if (uuid) { try { await serverDeleteAuthed(`/api/agents/${uuid}`); } catch { /* best-effort */ } }
  return ok;
}
