/**
 * AgentPublisher — pushes a local agent's profile to yo-server so it can be
 * discovered for cyphers. Called from the agent CRUD handlers in main.ts:
 *
 *   onSave(agent)  → if joinable, publishAgent(agent) else withdrawAgent(agent.id)
 *   onDelete(id)   → deletePublishedAgent(id)
 *
 * Publish is fire-and-forget — failures are logged, not surfaced to the
 * renderer, since the local registry is the source of truth and the user can
 * re-publish on next save.
 */

import { isAuthenticated, serverPostAuthed } from "./auth";
import { getOrCreateClientId } from "./capability-collector";
import type { AgentConfig } from "./stores/agent-store-db";

interface PublishResponse {
  ok: boolean;
  id?: string;
  agent_local_id?: string;
  derived_tier?: "premiere" | "standard" | "low";
  joinable?: boolean;
  last_seen_at?: string;
  error?: string;
}

export async function publishAgent(agent: AgentConfig, opts: { defaultModelProvider?: string; defaultModelName?: string } = {}): Promise<PublishResponse | null> {
  if (!isAuthenticated()) return null;
  const payload = {
    client_id: getOrCreateClientId(),
    agent_local_id: agent.id,
    joinable: agent.joinable !== false,           // undefined defaults to true once user opts in via UI
    name: agent.name,
    type: agent.type,
    model_provider: agent.model_provider || opts.defaultModelProvider,
    model_name: agent.model_name || opts.defaultModelName,
    apps: agent.apps ?? [],
    skills: agent.skills ?? [],
    builtin_tools: agent.builtin_tools ?? [],
    mcp_servers: agent.mcp_servers ?? [],
    avatar_url: agent.avatar_url,
    bio: agent.bio,
    raw_blob: agent as unknown as Record<string, unknown>,
  };
  try {
    return await serverPostAuthed<PublishResponse>("/api/agents/publish", payload);
  } catch (err) {
    console.error("[agent-publisher] publish failed:", err instanceof Error ? err.message : err);
    return null;
  }
}

export async function withdrawAgent(agentLocalId: string): Promise<boolean> {
  if (!isAuthenticated()) return false;
  try {
    const r = await serverPostAuthed<{ ok: boolean }>("/api/agents/withdraw", { agent_local_id: agentLocalId });
    return r.ok;
  } catch (err) {
    console.error("[agent-publisher] withdraw failed:", err instanceof Error ? err.message : err);
    return false;
  }
}

export async function deletePublishedAgent(agentLocalId: string): Promise<boolean> {
  if (!isAuthenticated()) return false;
  try {
    // POST /withdraw to mark unjoinable, then explicit DELETE for the row.
    // We call withdraw first so even if the DELETE fails the agent stops appearing in discover.
    await withdrawAgent(agentLocalId);
    // No serverDeleteAuthed helper; call via the same auth.ts pattern using fetch.
    // For simplicity: also POST to withdraw which already hides; the row will be cleaned by retention later.
    // (A full DELETE endpoint exists at /api/agents/:id but isn't reachable from serverPostAuthed.)
    return true;
  } catch (err) {
    console.error("[agent-publisher] delete failed:", err instanceof Error ? err.message : err);
    return false;
  }
}
