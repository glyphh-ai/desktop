/**
 * Connectors — Pipedream Connect integration for managed OAuth connections.
 *
 * Pro-tier feature. Flow:
 *   1. Client calls yo-server to create/get Pipedream external user
 *   2. Client requests a connect token for a specific app
 *   3. Opens OAuth window using the connect token URL
 *   4. After OAuth, refreshes MCP connection to discover new tools
 *   5. Connected accounts stored in Pipedream, queried via yo-server
 *
 * All Pipedream API calls go through yo-server (api.glyphh.ai) to keep
 * project keys server-side. The client only sees connect tokens and account lists.
 */

import { BrowserWindow, shell } from "electron";
import { EventEmitter } from "events";
import { getAccountInfo, getHeartbeatInfo } from "./auth";
import { getClient } from "./glyphh-client";
import { refreshConnectorCatalog, type ConnectorTool } from "./connector-tools-client";

// ── Types ──────────────────────────────────────────────────

export interface ConnectorApp {
  id: string;
  name: string;
  description: string;
  icon?: string;
  categories?: string[];
}

export interface ConnectedAccount {
  id: string;
  appSlug: string;
  appName: string;
  createdAt: string;
  healthy: boolean;
}

// ── ConnectorManager ──────────────────────────────────────

export class ConnectorManager extends EventEmitter {

  private cachedAccounts: ConnectedAccount[] = [];
  private cachedApps: ConnectorApp[] = [];

  // ── Available apps (browse catalog) ───────────────────

  async getApps(search?: string, _offset?: number): Promise<{ apps: ConnectorApp[]; hasMore: boolean }> {
    try {
      const { apps } = await getClient().connections.apps(search ? { search } : {});
      this.cachedApps = apps.map((a) => ({ id: a.id, name: a.name, description: a.description ?? "", icon: a.icon ?? undefined, categories: a.categories ?? [] }));
      return { apps: this.cachedApps, hasMore: false };
    } catch {
      return { apps: this.cachedApps, hasMore: false };
    }
  }

  getCachedApps(): ConnectorApp[] {
    return this.cachedApps;
  }

  // ── Connected accounts ────────────────────────────────

  async getAccounts(): Promise<ConnectedAccount[]> {
    try {
      const personal = await getClient().connections.personalList();
      const accounts: ConnectedAccount[] = personal.map((c) => ({
        id: c.id,
        appSlug: c.appSlug,
        appName: c.appName,
        createdAt: "",
        healthy: c.healthy,
      }));
      this.cachedAccounts = accounts;
      // No server-side app-row sync: an app's connections come from its
      // manifest now, and the server resolves connected/required itself.
      return accounts;
    } catch {
      return this.cachedAccounts;
    }
  }

  getCachedAccounts(): ConnectedAccount[] {
    return this.cachedAccounts;
  }

  /** Identity switch: drop the previous account's cached accounts/catalog so
   *  an error-path fallback can never serve them to the next user. */
  clearUserState(): void {
    this.cachedAccounts = [];
    this.cachedApps = [];
  }

  async disconnectAccount(accountId: string): Promise<boolean> {
    try {
      await getClient().connections.personalDisconnect(accountId);
      this.cachedAccounts = this.cachedAccounts.filter((a) => a.id !== accountId);
      await this.refreshMcp();
      this.emit("changed");
      return true;
    } catch {
      return false;
    }
  }

  // ── OAuth connect flow ────────────────────────────────

  private oauthWindow: BrowserWindow | null = null;

  /**
   * Start the OAuth flow for a Pipedream app.
   * 1. Request a connect token from yo-server
   * 2. Open OAuth URL in Electron BrowserWindow (shared session for existing cookies)
   * 3. Wait for callback / window close
   * 4. Refresh accounts + MCP
   */
  async connectApp(appSlug: string): Promise<{ ok: boolean; error?: string }> {
    // Connections available to all tiers — no pay gate.
    // Start a personal connect session (the server keeps project keys).
    let connectUrl: string;
    try {
      const session = await getClient().connections.personalConnect(appSlug);
      if (!session.connectUrl) {
        return { ok: false, error: "Failed to get connect token" };
      }
      connectUrl = session.connectUrl;
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : "Server error" };
    }

    // Open OAuth in Electron window (no partition — shares default session so
    // existing Google/provider logins are available, avoiding "suspicious" flags)
    return new Promise((resolve) => {
      if (this.oauthWindow && !this.oauthWindow.isDestroyed()) {
        this.oauthWindow.close();
      }

      this.oauthWindow = new BrowserWindow({
        width: 500,
        height: 700,
        title: `Connect ${appSlug}`,
        resizable: true,
        minimizable: false,
        maximizable: false,
        webPreferences: {
          nodeIntegration: false,
          contextIsolation: true,
          partition: "persist:yo",
        },
      });

      this.oauthWindow.setMenuBarVisibility(false);
      // Spoof Chrome UA so Google's fraud detection doesn't flag Electron
      this.oauthWindow.webContents.setUserAgent(
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
      );

      let resolved = false;
      const done = (ok: boolean, error?: string) => {
        // Renderer drops its app-level overlay on this.
        this.emit("connect-progress", { phase: "done", appSlug, ok, error });
        resolve({ ok, error });
      };
      const finish = async (success: boolean, error?: string) => {
        if (resolved) return;
        resolved = true;

        // Outcome is known — close the OAuth window right away and let the
        // app-level overlay narrate the verification (account sync + tool
        // catalog refresh take a few seconds).
        this.emit("connect-progress", { phase: "verifying", appSlug });
        if (this.oauthWindow && !this.oauthWindow.isDestroyed()) {
          this.oauthWindow.close();
        }

        if (success) {
          const accounts = await this.getAccounts();
          console.log(`[connectors] After OAuth, accounts:`, accounts.map(a => `${a.appSlug} (${a.id})`));
          const mcpResult = await this.refreshMcp();
          console.log(`[connectors] After OAuth, refreshMcp:`, mcpResult);
          this.emit("changed");
        }

        done(success, error);
      };

      // Open external links (Google Cloud Console, etc.) in system browser
      this.oauthWindow.webContents.setWindowOpenHandler(({ url }) => {
        if (!url.includes("pipedream")) {
          shell.openExternal(url);
          return { action: "deny" };
        }
        return { action: "allow" };
      });

      // Watch for success callback URL from Pipedream
      this.oauthWindow.webContents.on("will-navigate", (_event, url) => {
        if (url.includes("/connect/callback") || url.includes("success=true")) {
          finish(true);
        }
      });

      this.oauthWindow.webContents.on("will-redirect", (_event, url) => {
        if (url.includes("/connect/callback") || url.includes("success=true")) {
          finish(true);
        }
      });

      // If user closes the window, check if they completed OAuth — the same
      // overlay covers this check so the close never feels like a dead end.
      this.oauthWindow.on("closed", () => {
        this.oauthWindow = null;
        if (!resolved) {
          resolved = true;
          this.emit("connect-progress", { phase: "verifying", appSlug });
          this.getAccounts().then((accounts) => {
            const wasAdded = accounts.some((a) => a.appSlug === appSlug);
            if (wasAdded) {
              this.refreshMcp().then(() => {
                this.emit("changed");
                done(true);
              });
            } else {
              done(false, "Connection cancelled");
            }
          }).catch(() => {
            done(false, "Connection cancelled");
          });
        }
      });

      this.oauthWindow.loadURL(connectUrl);
    });
  }

  // ── MCP bridge ────────────────────────────────────────

  /**
   * Refresh the connector tool catalog from yo-server.
   *
   * Used to open an MCP client per connected app locally (against Pipedream's
   * MCP URL with short-lived tokens). Now we fetch the flattened catalog via
   * /api/connectors/tools — yo-server owns the Pipedream auth and exposes the
   * same surface to both this client and the relay's external callers.
   *
   * The refreshed catalog feeds the LOCAL MCP SERVER's connector lane now —
   * the client-side McpManager died with the built-in agent.
   */
  async refreshMcp(): Promise<{ ok: boolean; error?: string; toolCount: number }> {
    try {
      const tools = await refreshConnectorCatalog();
      return { ok: true, toolCount: tools.length };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error("Connectors catalog refresh error:", msg);
      return { ok: false, error: msg, toolCount: 0 };
    }
  }

  /** Flat connector tool catalog (refreshed) for the Apps → connection tab. */
  async listTools(): Promise<ConnectorTool[]> {
    return refreshConnectorCatalog();
  }

  /** Initialize — load accounts and set up MCP if any exist. */
  async init(): Promise<void> {
    try {
      const accounts = await this.getAccounts();
      console.log(`[connectors] init: ${accounts.length} accounts found`);
      if (accounts.length > 0) {
        const result = await this.refreshMcp();
        console.log(`[connectors] init: ${result.toolCount} MCP tools loaded`);
      }
    } catch (err) {
      console.warn("[connectors] init failed:", err);
    }
  }

  // ── Cleanup ───────────────────────────────────────────

  cleanup(): void {
    if (this.oauthWindow && !this.oauthWindow.isDestroyed()) {
      this.oauthWindow.close();
      this.oauthWindow = null;
    }
  }
}
