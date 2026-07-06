/**
 * home-ipc — IPC for the Settings / home panel: the usage dashboard, the
 * MCP server manager, app connectors, exposed-MCP tokens, and the prompt log.
 *
 * (Formerly bundled into drop-ipc; the Drop is gone, these handlers are not.)
 */

import { ipcMain } from "electron";
import path from "path";
import os from "os";
import fs from "fs";
import type { McpManager } from "./mcp-manager";
import type { ConnectorManager } from "./connectors";
import { reconnectRelay, getRelayStatus } from "./relay-client";
import {
  syncLocalMcpServer,
  stopLocalMcpServer,
  localMcpStatus,
  localMcpGenToken,
  localMcpListTokens,
  localMcpRevokeToken,
} from "./local-mcp-server";
import { setPreference } from "./preferences";
import { serverGetAuthed, serverPostAuthed, serverDeleteAuthed, AUTH_SERVER, getAccountInfo, getAuthStatus } from "./auth";

interface HomeIpcDeps {
  mcpManager: McpManager | null;
  connectorManager: ConnectorManager | null;
  canUseMcp: () => { allowed: boolean; reason?: string };
}

export function registerHomeIpc(deps: HomeIpcDeps): void {
  const { mcpManager, connectorManager, canUseMcp } = deps;

  // ── Home dashboard ──────────────────────────────────────────────────────
  // Credits, month spend, apps deployed, and a per-day usage series (credits
  // + calls). LLM tokens are deliberately NOT a client concept — the client
  // never meters models; usage here is compute. Mirrors the platform's
  // billing/usage endpoints; each call degrades to null so one failure
  // doesn't blank the whole card set. Credit amounts arrive in micro-credits
  // (1 credit = 1e6) → /1e6.
  ipcMain.handle("dashboard-data", async () => {
    const MICRO = 1_000_000;
    const WINDOW = 14;
    const ymd = (d: Date) =>
      `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    const now = new Date();
    const windowStart = new Date(now); windowStart.setDate(now.getDate() - (WINDOW - 1));
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";

    interface CreditsResp { balance?: number; allowance?: number }
    interface UsageResp { totals?: { credits?: number; requests?: number } }
    interface DailyDay { day: string; credits?: number; requests?: number }
    interface DailyResp { days?: DailyDay[] }
    interface PanelApp { system?: boolean; url?: string | null; isBrowser?: boolean }

    const [credits, usage, daily, apps] = await Promise.all([
      serverGetAuthed<CreditsResp>("/api/billing/credits").catch(() => null),
      serverGetAuthed<UsageResp>(`/api/usage?from=${encodeURIComponent(monthStart.toISOString())}&to=${encodeURIComponent(now.toISOString())}`).catch(() => null),
      serverGetAuthed<DailyResp>(`/api/usage/daily?from=${ymd(windowStart)}&to=${ymd(now)}&tz=${encodeURIComponent(tz)}`).catch(() => null),
      serverGetAuthed<PanelApp[]>("/api/panel-apps").catch(() => null),
    ]);

    // Per-day credits/calls (the server combines LLM + compute usage). Fill
    // the series so gaps render as zero bars (the API omits empty days).
    const byDay = new Map<string, { credits: number; calls: number }>();
    for (const d of daily?.days ?? []) {
      byDay.set(d.day, { credits: (d.credits || 0) / MICRO, calls: d.requests || 0 });
    }
    const days: Array<{ day: string; credits: number; calls: number }> = [];
    for (let i = WINDOW - 1; i >= 0; i--) {
      const d = new Date(now); d.setDate(now.getDate() - i);
      const key = ymd(d);
      const v = byDay.get(key);
      days.push({ day: key, credits: v?.credits || 0, calls: v?.calls || 0 });
    }

    const acct = getAccountInfo();
    return {
      name: (acct?.firstName || "").trim(),
      plan: getAuthStatus().tier || "",
      credits: Math.floor((credits?.balance || 0) / MICRO),
      allowance: Math.floor((credits?.allowance || 0) / MICRO),
      spendCredits: Math.floor((usage?.totals?.credits || 0) / MICRO),
      requests: usage?.totals?.requests || 0,
      // Count visible apps only, exactly like the Apps tab: the seeded Glyphh
      // system app (system:true — hidden + undeletable) is not a deployed app.
      appsCount: Array.isArray(apps) ? apps.filter((a) => !a.system && (a.url || a.isBrowser === false)).length : 0,
      windowCredits: days.reduce((s, d) => s + d.credits, 0),
      windowCalls: days.reduce((s, d) => s + d.calls, 0),
      days,
    };
  });

  // Relay: bouncing the WS after the user flips the toggle, and proxying
  // token CRUD to yo-server (the JWT authenticates these calls — same one
  // the WS uses, so signed-in org admins can manage their own server tokens
  // without ever opening the platform).
  ipcMain.handle("relay-reconnect", () => { reconnectRelay(); });
  ipcMain.handle("relay-status", () => getRelayStatus());
  ipcMain.handle("relay-tokens-list", async () => {
    try { return await serverGetAuthed<unknown[]>("/api/mcp/tokens?type=EXTERNAL"); }
    catch (err) { return { error: err instanceof Error ? err.message : String(err) }; }
  });
  ipcMain.handle("relay-tokens-create", async (_e, label: string) => {
    try {
      return await serverPostAuthed<{ ok: boolean; id: string; token: string; expiresAt: string }>(
        "/api/mcp/tokens",
        { label: label || "default", type: "EXTERNAL" },
      );
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) };
    }
  });
  ipcMain.handle("relay-tokens-revoke", async (_e, id: string) => {
    try { return await serverDeleteAuthed<{ ok: boolean }>(`/api/mcp/tokens/${encodeURIComponent(id)}`); }
    catch (err) { return { error: err instanceof Error ? err.message : String(err) }; }
  });

  // Install the relay into the user's ~/.claude.json so Claude code picks it
  // up without hand-editing. Idempotent: only touches the "yo-relay" entry
  // under mcpServers; everything else (other servers, projects, settings)
  // round-trips untouched. Returns the resolved path on success.
  ipcMain.handle("relay-install-claude", async (_e, token: string) => {
    if (!token || typeof token !== "string") return { error: "token is required" };
    const cfgPath = path.join(os.homedir(), ".claude.json");
    let existing: Record<string, unknown> = {};
    try {
      if (fs.existsSync(cfgPath)) {
        const raw = fs.readFileSync(cfgPath, "utf8");
        if (raw.trim()) existing = JSON.parse(raw) as Record<string, unknown>;
      }
    } catch (err) {
      return { error: `Could not read ${cfgPath}: ${err instanceof Error ? err.message : String(err)}` };
    }
    const mcpServers = (existing.mcpServers && typeof existing.mcpServers === "object")
      ? existing.mcpServers as Record<string, unknown>
      : {};
    mcpServers["yo-relay"] = {
      type: "http",
      url: `${AUTH_SERVER}/mcp`,
      headers: { Authorization: `Bearer ${token}` },
    };
    existing.mcpServers = mcpServers;
    try {
      fs.writeFileSync(cfgPath, JSON.stringify(existing, null, 2) + "\n", { mode: 0o600 });
      return { ok: true, path: cfgPath };
    } catch (err) {
      return { error: `Could not write ${cfgPath}: ${err instanceof Error ? err.message : String(err)}` };
    }
  });

  // ── Local MCP server (127.0.0.1) — the no-cloud alternative to the relay ──
  ipcMain.handle("local-mcp-set-enabled", async (_e, enabled: boolean) => {
    setPreference("localMcpEnabled", !!enabled);
    return await syncLocalMcpServer();
  });
  ipcMain.handle("local-mcp-status", () => localMcpStatus());
  ipcMain.handle("local-mcp-set-port", async (_e, port: number) => {
    const p = Number(port);
    if (!Number.isInteger(p) || p < 1024 || p > 65535) return { ok: false, error: "Port must be 1024–65535." };
    setPreference("localMcpPort", p);
    // Bounce the server so the new port takes effect if it's running.
    stopLocalMcpServer();
    return await syncLocalMcpServer();
  });
  ipcMain.handle("local-mcp-tokens-list", () => localMcpListTokens());
  ipcMain.handle("local-mcp-tokens-create", (_e, label: string) => localMcpGenToken(label));
  ipcMain.handle("local-mcp-tokens-revoke", (_e, id: string) => { localMcpRevokeToken(id); return { ok: true }; });

  ipcMain.handle("mcp-get-servers", () => {
    if (!mcpManager) return [];
    return mcpManager.getServerStates().map((s) => ({
      config: s.config,
      status: s.status,
      error: s.error,
      tools: s.tools.map((t) => ({ name: t.name, description: t.description })),
    }));
  });
  ipcMain.handle("mcp-add-server", (_e, config: Record<string, unknown>) => {
    const gate = canUseMcp();
    if (!gate.allowed) throw new Error((gate as any).reason);
    mcpManager!.addServer(config as any);
  });
  ipcMain.handle("mcp-update-server", (_e, id: string, updates: Record<string, unknown>) => {
    mcpManager!.updateServer(id, updates as any);
  });
  ipcMain.handle("mcp-remove-server", (_e, id: string) => {
    mcpManager!.removeServer(id);
  });
  ipcMain.handle("mcp-connect-server", async (_e, id: string) => {
    const gate = canUseMcp();
    if (!gate.allowed) return { ok: false, error: (gate as any).reason };
    const state = mcpManager!.getServerState(id);
    if (!state) return { ok: false, error: "Server not found" };
    try {
      await mcpManager!.connectServer(state.config);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });
  ipcMain.handle("mcp-disconnect-server", async (_e, id: string) => {
    await mcpManager!.disconnectServer(id);
  });
  ipcMain.handle("mcp-get-tool-override", (_e, serverId: string, toolName: string) => {
    return mcpManager!.getToolOverride(serverId, toolName);
  });
  ipcMain.on("mcp-set-tool-override", (_e, serverId: string, toolName: string, override: string) => {
    mcpManager!.setToolOverride(serverId, toolName, override as any);
  });
  ipcMain.on("mcp-set-server-override", (_e, serverId: string, override: string) => {
    mcpManager!.setServerOverride(serverId, override as any);
  });

  ipcMain.handle("connectors-get-apps", async (_e, search?: string, offset?: number) => {
    if (!connectorManager) return { apps: [], hasMore: false };
    return connectorManager.getApps(search, offset);
  });
  ipcMain.handle("connectors-get-accounts", async () => {
    if (!connectorManager) return [];
    return connectorManager.getAccounts();
  });
  ipcMain.handle("connectors-connect", async (_e, appSlug: string) => {
    if (!connectorManager) return { ok: false, error: "Not initialized" };
    return connectorManager.connectApp(appSlug);
  });
  ipcMain.handle("connectors-disconnect", async (_e, accountId: string) => {
    if (!connectorManager) return false;
    return connectorManager.disconnectAccount(accountId);
  });
  ipcMain.handle("connectors-refresh-mcp", async () => {
    if (!connectorManager) return { ok: false, error: "Not initialized", toolCount: 0 };
    return connectorManager.refreshMcp();
  });
  ipcMain.handle("connectors-list-tools", async () => {
    if (!connectorManager) return [];
    return connectorManager.listTools();
  });

}
