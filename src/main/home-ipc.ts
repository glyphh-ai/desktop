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
import { serverGetAuthed, serverPostAuthed, serverDeleteAuthed, AUTH_SERVER, hasMcpAccess } from "./auth";

interface HomeIpcDeps {
  mcpManager: McpManager | null;
  connectorManager: ConnectorManager | null;
  canUseMcp: () => { allowed: boolean; reason?: string };
}

export function registerHomeIpc(deps: HomeIpcDeps): void {
  const { mcpManager, connectorManager, canUseMcp } = deps;

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
    if (!hasMcpAccess()) return { ok: false, error: "MCP relay tokens require a Pro plan." };
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
    if (!hasMcpAccess()) return { error: "MCP requires a Pro plan." };
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
