/**
 * home-ipc — IPC for the Settings / home panel: section steering and the
 * loopback MCP server (its switch, port and tokens).
 */

import { ipcMain } from "electron";
import {
  syncLocalMcpServer,
  stopLocalMcpServer,
  localMcpStatus,
  localMcpGenToken,
  localMcpListTokens,
  localMcpRevokeToken,
} from "./local-mcp-server";
import { sendToHomeShell } from "./broadcast";
import { setPreference } from "./stores/preferences-db";

export function registerHomeIpc(): void {
  // The SHELL (boot gate / tutorial) steering the home panel's section —
  // e.g. "land on Home after the first-run walkthrough".
  ipcMain.handle("home-goto-section", (_e, section: string) => {
    sendToHomeShell("home:goto-section", String(section));
    return { ok: true };
  });

  // ── Local MCP server (127.0.0.1) — the loopback MCP surface ──
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
}
