import { ipcMain } from "electron";
import type { AgentConfig as AgentRegistryConfig } from "./stores/agent-store-db";
import { refreshAndListAgents, saveAgentSynced, removeAgentSynced } from "./stores/agent-store-db";

interface MarketplaceIpcDeps {
  serverGetAuthed: <T = unknown>(path: string) => Promise<T>;
  serverPostAuthed: <T = unknown>(path: string, body: Record<string, unknown>) => Promise<T>;
  listAgents: () => AgentRegistryConfig[];
  getAgent: (id: string) => AgentRegistryConfig | null;
  saveAgent: (cfg: AgentRegistryConfig) => AgentRegistryConfig;
  removeAgent: (id: string) => boolean;
  idAvailable: (id: string) => boolean;
  pushAgentProfile: (cfg: AgentRegistryConfig) => Promise<void>;
  deleteAgentProfile: (id: string) => Promise<void>;
  setOfferEnabled: (enabled: boolean) => Promise<unknown>;
  getCapabilitiesStatus: () => Promise<{ enabled?: boolean } | null>;
}

export function registerMarketplaceIpc(deps: MarketplaceIpcDeps): void {
  const {
    serverGetAuthed, serverPostAuthed,
    listAgents, getAgent, saveAgent, removeAgent, idAvailable,
    pushAgentProfile, deleteAgentProfile,
    setOfferEnabled, getCapabilitiesStatus,
  } = deps;

  async function reconcileOfferEnabled(): Promise<void> {
    const anyJoinable = listAgents().some((a) => (a as any).joinable === true);
    const status = await getCapabilitiesStatus().catch(() => null);
    const currentlyEnabled = !!status?.enabled;
    if (anyJoinable && !currentlyEnabled) {
      await setOfferEnabled(true).catch(() => {});
    } else if (!anyJoinable && currentlyEnabled) {
      await setOfferEnabled(false).catch(() => {});
    }
  }

  ipcMain.handle("capabilities-set-enabled", async (_e, enabled: boolean) => {
    return setOfferEnabled(!!enabled);
  });
  ipcMain.handle("capabilities-get-status", async () => {
    return getCapabilitiesStatus();
  });

  // agents-list/save/remove sync the org-shared library (yo-server saved_agents,
  // the same the platform Agents page reads). The joinable-profile push
  // (pushAgentProfile/deleteAgentProfile) is a SEPARATE surface — published
  // agents discoverable for cyphers — and stays wired alongside it.
  ipcMain.handle("agents-list", async () => refreshAndListAgents());
  ipcMain.handle("agents-get", async (_e, id: string) => getAgent(id));
  ipcMain.handle("agents-save", async (_e, cfg: AgentRegistryConfig) => {
    const saved = await saveAgentSynced(cfg);
    void (saved.joinable
      ? pushAgentProfile(saved)
      : deleteAgentProfile(saved.id));
    void reconcileOfferEnabled();
    return saved;
  });
  ipcMain.handle("agents-remove", async (_e, id: string) => {
    const ok = await removeAgentSynced(id);
    if (ok) void deleteAgentProfile(id);
    void reconcileOfferEnabled();
    return ok;
  });
  ipcMain.handle("agents-id-available", async (_e, id: string) => idAvailable(id));

  ipcMain.handle("yos-balance", async () => ({ user_id: "", balance: 0 }));
  ipcMain.handle("yos-rate-cards", async () => ({ cards: [] }));
  ipcMain.handle("models-list", async () => {
    try { return await serverGetAuthed<{ models: Array<{ provider: string; model: string; display_name: string; yos_per_1k_input: number; yos_per_1k_output: number }> }>("/api/models"); }
    catch (err) { return { error: err instanceof Error ? err.message : "fetch failed" }; }
  });
  // Admin-curated model catalog (active rows only) — the Agents form intersects
  // this with configured BYOK providers, and gates the full agent loop on
  // agentLoopCapable. Same source the platform Agents form uses.
  ipcMain.handle("model-catalog", async () => {
    try { return await serverGetAuthed<Array<{ provider: string; model: string; displayName: string; agentLoopCapable: boolean; maxContextTokens?: number; maxOutputTokens?: number }>>("/api/model-catalog"); }
    catch { return []; }
  });
  ipcMain.handle("yos-buy-url", () => {
    const base = process.env.YO_PLATFORM_URL || "https://platform.glyphh.ai";
    return { url: `${base}/dashboard/billing#yos` };
  });
  ipcMain.handle("agents-leaderboard", async (_e, opts?: { skills?: string; days?: number; limit?: number }) => {
    const params = new URLSearchParams();
    if (opts?.skills) params.set("skills", opts.skills);
    if (opts?.days) params.set("days", String(opts.days));
    if (opts?.limit) params.set("limit", String(opts.limit));
    const qs = params.toString();
    try {
      return await serverGetAuthed<{ entries: unknown[]; count: number }>(
        `/api/agents/leaderboard${qs ? "?" + qs : ""}`,
      );
    } catch (err) {
      return { error: err instanceof Error ? err.message : "fetch failed" };
    }
  });
  ipcMain.handle("leaderboard-top-cyphers", async (_e, limit?: number) => {
    try {
      return await serverGetAuthed<unknown>(`/api/cyphers/leaderboard/tokens?limit=${limit || 10}`);
    } catch (err) {
      return { error: err instanceof Error ? err.message : "fetch failed" };
    }
  });
  ipcMain.handle("leaderboard-top-jammers", async (_e, limit?: number) => {
    try {
      return await serverGetAuthed<unknown>(`/api/jammers/leaderboard/tokens?limit=${limit || 10}`);
    } catch (err) {
      return { error: err instanceof Error ? err.message : "fetch failed" };
    }
  });
  ipcMain.handle("marketplace-available", async (_e, opts?: { tier?: string; provider?: string; limit?: number }) => {
    const params = new URLSearchParams();
    if (opts?.tier) params.set("tier", opts.tier);
    if (opts?.provider) params.set("provider", opts.provider);
    if (opts?.limit) params.set("limit", String(opts.limit));
    const qs = params.toString();
    try {
      return await serverGetAuthed<{ entries: unknown[]; count: number; ts: string }>(
        `/api/marketplace/available${qs ? "?" + qs : ""}`,
      );
    } catch (err) {
      return { error: err instanceof Error ? err.message : "fetch failed" };
    }
  });
  ipcMain.handle("reservation-create", async (_e, body: { provider_handle: string; idle_minutes: number; guardrails?: unknown }) => {
    try { return await serverPostAuthed("/api/marketplace/reservations", body as Record<string, unknown>); }
    catch (err) { return { ok: false, error: err instanceof Error ? err.message : "reservation failed" }; }
  });
  ipcMain.handle("reservation-release", async (_e, id: string, reason?: string) => {
    try { return await serverPostAuthed(`/api/marketplace/reservations/${encodeURIComponent(id)}/release`, { reason }); }
    catch (err) { return { ok: false, error: err instanceof Error ? err.message : "release failed" }; }
  });
  ipcMain.handle("reservation-list", async (_e, opts?: { status?: string }) => {
    const params = new URLSearchParams();
    if (opts?.status) params.set("status", opts.status);
    const qs = params.toString();
    try { return await serverGetAuthed(`/api/marketplace/reservations/mine${qs ? "?" + qs : ""}`); }
    catch (err) { return { error: err instanceof Error ? err.message : "fetch failed" }; }
  });
}
