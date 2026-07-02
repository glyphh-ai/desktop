/**
 * AgentSync — syncs local agent public metadata to yo-server for
 * discoverability and cross-device pull.
 *
 * Replaces agent-publisher.ts with a cleaner API:
 *   - pushAgentProfile(agent) — upsert single agent
 *   - deleteAgentProfile(id) — remove from server
 *   - pullAgentProfiles()    — pull all from server (new device)
 *   - syncAllAgents(agents)  — bulk push all joinable agents
 *
 * All operations are fire-and-forget — failures are logged, not surfaced
 * to the renderer. The local registry remains source of truth.
 */

import { net } from "electron";
import { isAuthenticated, getAuthToken } from "./auth";
import type { AgentConfig } from "./stores/agent-store-db";

const AUTH_SERVER =
  process.env.YO_AUTH_SERVER || "https://api.glyphh.ai";

// ── Types ───────────────────────────────────────────────────

export interface AgentProfileRemote {
  id: string;
  user_id: string;
  local_agent_id: string;
  name: string;
  role: string | null;
  type: string;
  description: string | null;
  apps: string[] | null;
  skills: string[] | null;
  model_provider: string | null;
  model_name: string | null;
  joinable: boolean;
  online: boolean;
  last_seen_at: string | null;
  version: number;
  created_at: string;
  updated_at: string;
}

interface ProfilePayload {
  name: string;
  role?: string | null;
  type: string;
  description?: string | null;
  apps?: string[];
  skills?: string[];
  model_provider?: string | null;
  model_name?: string | null;
  joinable: boolean;
  online: boolean;
}

// ── Internal HTTP helpers ───────────────────────────────────

function serverRequest<T>(method: string, endpoint: string, body?: unknown): Promise<T> {
  const token = getAuthToken();
  if (!token) return Promise.reject(new Error("Not authenticated"));

  return new Promise((resolve, reject) => {
    const url = `${AUTH_SERVER}${endpoint}`;
    const request = net.request({ url, method });
    request.setHeader("Authorization", `Bearer ${token}`);
    if (body !== undefined) {
      request.setHeader("Content-Type", "application/json");
    }
    const timer = setTimeout(() => { request.abort(); reject(new Error("Request timeout")); }, 15_000);

    let responseBody = "";
    request.on("response", (response) => {
      const status = response.statusCode ?? 500;
      clearTimeout(timer);
      response.on("data", (chunk: Buffer) => { responseBody += chunk.toString(); });
      response.on("end", () => {
        if (status < 200 || status >= 300) {
          reject(new Error(`HTTP ${status}: ${responseBody.slice(0, 200)}`));
          return;
        }
        try {
          resolve(JSON.parse(responseBody) as T);
        } catch {
          reject(new Error("Invalid server response"));
        }
      });
    });
    request.on("error", reject);
    if (body !== undefined) {
      request.write(JSON.stringify(body));
    }
    request.end();
  });
}

// ── Public API ──────────────────────────────────────────────

/**
 * Push a single agent's public profile to the server.
 * Extracts only public fields — no system prompt, no API keys, no guardrails.
 */
export async function pushAgentProfile(agent: AgentConfig): Promise<void> {
  if (!isAuthenticated()) return;

  const payload: ProfilePayload = {
    name: agent.name,
    role: agent.role ?? null,
    type: agent.type,
    description: agent.meta?.description ?? null,
    apps: agent.apps ?? [],
    skills: agent.skills ?? [],
    model_provider: agent.model_provider ?? null,
    model_name: agent.model_name ?? null,
    joinable: agent.joinable !== false,
    online: true,
  };

  try {
    await serverRequest<{ ok: boolean; profile: AgentProfileRemote }>(
      "PUT",
      `/api/agents/profiles/${encodeURIComponent(agent.id)}`,
      payload,
    );
  } catch (err) {
    console.error("[agent-sync] push failed:", err instanceof Error ? err.message : err);
  }
}

/** Remove an agent's profile from the server. */
export async function deleteAgentProfile(agentId: string): Promise<void> {
  if (!isAuthenticated()) return;

  try {
    await serverRequest<{ ok: boolean }>(
      "DELETE",
      `/api/agents/profiles/${encodeURIComponent(agentId)}`,
    );
  } catch (err) {
    console.error("[agent-sync] delete failed:", err instanceof Error ? err.message : err);
  }
}

/** Pull all agent profiles from the server (for new device or recovery). */
export async function pullAgentProfiles(): Promise<AgentProfileRemote[]> {
  if (!isAuthenticated()) return [];

  try {
    const res = await serverRequest<{ ok: boolean; profiles: AgentProfileRemote[] }>(
      "GET",
      "/api/agents/profiles/pull",
    );
    return res.profiles ?? [];
  } catch (err) {
    console.error("[agent-sync] pull failed:", err instanceof Error ? err.message : err);
    return [];
  }
}

/**
 * Bulk push all joinable local agents to the server.
 * Called on app boot after auth is confirmed.
 */
export async function syncAllAgents(localAgents: AgentConfig[]): Promise<void> {
  if (!isAuthenticated()) return;

  const joinable = localAgents.filter((a) => a.joinable !== false);
  if (joinable.length === 0) return;

  const profiles = joinable.map((agent) => ({
    local_agent_id: agent.id,
    name: agent.name,
    role: agent.role ?? null,
    type: agent.type,
    description: agent.meta?.description ?? null,
    apps: agent.apps ?? [],
    skills: agent.skills ?? [],
    model_provider: agent.model_provider ?? null,
    model_name: agent.model_name ?? null,
    joinable: true,
    online: true,
  }));

  try {
    await serverRequest<{ ok: boolean; profiles: AgentProfileRemote[] }>(
      "POST",
      "/api/agents/profiles/sync",
      { profiles },
    );
  } catch (err) {
    console.error("[agent-sync] bulk sync failed:", err instanceof Error ? err.message : err);
  }
}
