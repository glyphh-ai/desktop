import { ipcMain } from "electron";

interface MarketplaceIpcDeps {
  serverGetAuthed: <T = unknown>(path: string) => Promise<T>;
  serverPostAuthed: <T = unknown>(path: string, body: Record<string, unknown>) => Promise<T>;
  setOfferEnabled: (enabled: boolean) => Promise<unknown>;
  getCapabilitiesStatus: () => Promise<{ enabled?: boolean } | null>;
}

export function registerMarketplaceIpc(deps: MarketplaceIpcDeps): void {
  const {
    serverGetAuthed, serverPostAuthed,
    setOfferEnabled, getCapabilitiesStatus,
  } = deps;

  ipcMain.handle("capabilities-set-enabled", async (_e, enabled: boolean) => {
    return setOfferEnabled(!!enabled);
  });
  ipcMain.handle("capabilities-get-status", async () => {
    return getCapabilitiesStatus();
  });

  ipcMain.handle("yos-balance", async () => ({ user_id: "", balance: 0 }));
  ipcMain.handle("yos-rate-cards", async () => ({ cards: [] }));
  ipcMain.handle("models-list", async () => {
    try { return await serverGetAuthed<{ models: Array<{ provider: string; model: string; display_name: string; yos_per_1k_input: number; yos_per_1k_output: number }> }>("/api/models"); }
    catch (err) { return { error: err instanceof Error ? err.message : "fetch failed" }; }
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
