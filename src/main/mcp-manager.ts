/**
 * MCP Manager — manages MCP server connections and tool discovery.
 *
 * Server configs live on AppConnector (each app's mcp tab).
 * Legacy configs in preferences are migrated on first init.
 */

import { McpClient, McpTool, McpToolResult } from "./mcp-client";
import { getPreference, setPreference } from "./preferences";
import { EventEmitter } from "events";
import type { AppConnector, McpConfig, McpOAuth } from "./app-connector";
import { callConnectorTool, type ConnectorTool } from "./connector-tools-client";

export interface McpServerConfig {
  id: string;
  name: string;
  transport: "stdio" | "sse" | "streamable-http";
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  oauth?: McpOAuth;
  enabled: boolean;
}

export interface McpServerState {
  config: McpServerConfig;
  status: "disconnected" | "connecting" | "connected" | "error";
  error?: string;
  tools: McpTool[];
}

export type McpToolOverride = "default" | "auto" | "ask";

export class McpManager extends EventEmitter {
  private servers = new Map<string, { client: McpClient; state: McpServerState }>();
  // Tools from the user's Pipedream-connected apps. These are NOT local MCP
  // servers — they're served by yo-server via /api/connectors/tools{,/call}.
  // Surfaced through getAllTools alongside local server tools so consumers
  // (skills, agent, relay) don't need to special-case them.
  private connectorCatalog: ConnectorTool[] = [];
  private appConnector: AppConnector | null = null;
  private ephemeralIds = new Set<string>();

  setAppConnector(ac: AppConnector): void { this.appConnector = ac; }

  async init(): Promise<void> {
    this.migrateLegacyConfigs();
    this.cleanupPipedreamApps();
    const configs = this.getConfigs();
    for (const config of configs) {
      if (config.enabled) {
        this.connectServer(config).catch(() => {});
      } else {
        this.servers.set(config.id, {
          client: new McpClient({ transport: config.transport }),
          state: { config, status: "disconnected", tools: [] },
        });
      }
    }
  }

  private cleanupPipedreamApps(): void {
    if (!this.appConnector) return;
    for (const app of this.appConnector.list()) {
      if (app.id.startsWith("pipedream-connect-") || app.id === "pipedream-connect") {
        this.appConnector.removeMcp(app.id);
        if (!app.url && !app.connection && Object.keys(app.commands).length === 0) {
          this.appConnector.remove(app.id);
        }
      }
    }
  }

  /** Migrate legacy mcpServers preference into AppConnector apps */
  private migrateLegacyConfigs(): void {
    if (!this.appConnector) return;
    const legacy = getPreference<McpServerConfig[]>("mcpServers", []);
    if (legacy.length === 0) return;

    for (const cfg of legacy) {
      let app = this.appConnector.get(cfg.id);
      if (!app) {
        app = this.appConnector.add(cfg.id, cfg.name);
      }
      if (!app.mcp) {
        this.appConnector.setMcp(cfg.id, {
          transport: cfg.transport,
          command: cfg.command,
          args: cfg.args,
          env: cfg.env,
          url: cfg.url,
          headers: cfg.headers,
          oauth: cfg.oauth,
          enabled: cfg.enabled,
        });
      }
    }
    setPreference("mcpServers", []);
    console.log(`[mcp] migrated ${legacy.length} legacy server configs into apps`);
  }

  getConfigs(): McpServerConfig[] {
    if (this.appConnector) {
      return this.appConnector.getMcpConfigs().map((c) => ({
        id: c.id,
        name: c.name,
        transport: c.transport,
        command: c.command,
        args: c.args,
        env: c.env,
        url: c.url,
        headers: c.headers,
        oauth: c.oauth,
        enabled: c.enabled,
      }));
    }
    return getPreference<McpServerConfig[]>("mcpServers", []);
  }

  addServer(config: McpServerConfig): void {
    if (this.appConnector) {
      let app = this.appConnector.get(config.id);
      if (!app) {
        app = this.appConnector.add(config.id, config.name);
      }
      this.appConnector.setMcp(config.id, {
        transport: config.transport,
        command: config.command,
        args: config.args,
        env: config.env,
        url: config.url,
        headers: config.headers,
        oauth: config.oauth,
        enabled: config.enabled,
      });
    } else {
      const configs = getPreference<McpServerConfig[]>("mcpServers", []);
      const existing = configs.findIndex((c) => c.id === config.id);
      if (existing >= 0) configs[existing] = config;
      else configs.push(config);
      setPreference("mcpServers", configs);
    }
    this.servers.set(config.id, {
      client: new McpClient({ transport: config.transport }),
      state: { config, status: "disconnected", tools: [] },
    });
    this.emit("changed");
  }

  /** Register an in-memory server without persisting to AppConnector.
   *  Used by ConnectorManager for Pipedream endpoints with ephemeral tokens. */
  addEphemeralServer(config: McpServerConfig): void {
    this.ephemeralIds.add(config.id);
    this.servers.set(config.id, {
      client: new McpClient({ transport: config.transport }),
      state: { config, status: "disconnected", tools: [] },
    });
    this.emit("changed");
  }

  removeEphemeralServer(id: string): void {
    const entry = this.servers.get(id);
    if (entry?.client.isConnected()) {
      entry.client.disconnect().catch(() => {});
    }
    this.servers.delete(id);
    this.ephemeralIds.delete(id);
    this.emit("changed");
  }

  removeServer(id: string): void {
    const entry = this.servers.get(id);
    if (entry?.client.isConnected()) {
      entry.client.disconnect().catch(() => {});
    }
    this.servers.delete(id);

    if (this.appConnector) {
      this.appConnector.removeMcp(id);
    } else {
      const configs = getPreference<McpServerConfig[]>("mcpServers", []).filter((c) => c.id !== id);
      setPreference("mcpServers", configs);
    }

    const overrides = this.getToolOverrides();
    const cleaned: Record<string, McpToolOverride> = {};
    for (const [key, val] of Object.entries(overrides)) {
      if (!key.startsWith(`${id}:`)) cleaned[key] = val;
    }
    setPreference("mcpToolOverrides", cleaned);

    this.emit("changed");
  }

  updateServer(id: string, updates: Partial<McpServerConfig>): void {
    if (this.appConnector) {
      const mcpUpdates: Partial<McpConfig> = {};
      if (updates.transport !== undefined) mcpUpdates.transport = updates.transport;
      if (updates.command !== undefined) mcpUpdates.command = updates.command;
      if (updates.args !== undefined) mcpUpdates.args = updates.args;
      if (updates.env !== undefined) mcpUpdates.env = updates.env;
      if (updates.url !== undefined) mcpUpdates.url = updates.url;
      if (updates.headers !== undefined) mcpUpdates.headers = updates.headers;
      if (updates.oauth !== undefined) mcpUpdates.oauth = updates.oauth;
      if (updates.enabled !== undefined) mcpUpdates.enabled = updates.enabled;
      this.appConnector.updateMcp(id, mcpUpdates);
      if (updates.name) this.appConnector.updateName(id, updates.name);
    } else {
      const configs = getPreference<McpServerConfig[]>("mcpServers", []);
      const idx = configs.findIndex((c) => c.id === id);
      if (idx < 0) return;
      configs[idx] = { ...configs[idx], ...updates };
      setPreference("mcpServers", configs);
    }

    const entry = this.servers.get(id);
    if (entry) {
      entry.state.config = { ...entry.state.config, ...updates };
    }

    this.emit("changed");
  }

  async connectServer(config: McpServerConfig): Promise<void> {
    const existing = this.servers.get(config.id);
    if (existing?.client.isConnected()) {
      await existing.client.disconnect();
    }

    const state: McpServerState = { config, status: "connecting", tools: [] };
    const client = new McpClient({
      transport: config.transport,
      command: config.command,
      args: config.args,
      env: config.env,
      url: config.url,
      headers: config.headers,
      oauth: config.oauth,
    });

    this.servers.set(config.id, { client, state });
    this.emit("changed");

    try {
      await client.connect();
      state.status = "connected";

      const tools = await client.listTools();
      state.tools = tools;
      state.error = undefined;

      if (!config.enabled) {
        this.updateServer(config.id, { enabled: true });
        config.enabled = true;
      }

      client.on("disconnected", () => {
        state.status = "disconnected";
        state.tools = [];
        this.emit("changed");
      });

      client.on("error", (err: Error) => {
        state.status = "error";
        state.error = err.message;
        this.emit("changed");
      });

      this.emit("changed");
    } catch (err) {
      state.status = "error";
      state.error = err instanceof Error ? err.message : String(err);
      this.emit("changed");
      throw err;
    }
  }

  async disconnectServer(id: string): Promise<void> {
    const entry = this.servers.get(id);
    if (!entry) return;
    this.updateServer(id, { enabled: false });
    await entry.client.disconnect();
    entry.state.status = "disconnected";
    entry.state.tools = [];
    this.emit("changed");
  }

  getServerStates(): McpServerState[] {
    return Array.from(this.servers.values()).map((e) => e.state);
  }

  getServerState(id: string): McpServerState | null {
    return this.servers.get(id)?.state ?? null;
  }

  /** Replace the connector tool catalog (called by ConnectorManager.refreshMcp). */
  setConnectorCatalog(tools: ConnectorTool[]): void {
    this.connectorCatalog = tools;
    this.emit("changed");
  }

  getAllTools(): Array<{
    serverId: string;
    serverName: string;
    name: string;
    qualifiedName: string;
    description: string;
    inputSchema: Record<string, unknown>;
  }> {
    const tools: ReturnType<McpManager["getAllTools"]> = [];
    // Local MCP servers — talk directly via the client per connection.
    for (const entry of this.servers.values()) {
      if (entry.state.status !== "connected") continue;
      for (const tool of entry.state.tools) {
        tools.push({
          serverId: entry.state.config.id,
          serverName: entry.state.config.name,
          name: tool.name,
          qualifiedName: `mcp__${entry.state.config.id}__${tool.name}`,
          description: tool.description || "",
          inputSchema: tool.inputSchema,
        });
      }
    }
    // Pipedream-connected apps — served through yo-server. Use the slug as
    // the serverId so existing call sites (skills, agent) keep working.
    for (const t of this.connectorCatalog) {
      tools.push({
        serverId: t.slug,
        serverName: t.slug,
        name: t.name,
        qualifiedName: `mcp__${t.slug}__${t.name}`,
        description: t.description,
        inputSchema: t.inputSchema,
      });
    }
    return tools;
  }

  /** Tools from LOCAL MCP servers only — used by the relay's local_mcp_* path. */
  getLocalTools(): Array<{
    serverId: string;
    serverName: string;
    name: string;
    qualifiedName: string;
    description: string;
    inputSchema: Record<string, unknown>;
  }> {
    const tools: ReturnType<McpManager["getLocalTools"]> = [];
    for (const entry of this.servers.values()) {
      if (entry.state.status !== "connected") continue;
      for (const tool of entry.state.tools) {
        tools.push({
          serverId: entry.state.config.id,
          serverName: entry.state.config.name,
          name: tool.name,
          qualifiedName: `mcp__${entry.state.config.id}__${tool.name}`,
          description: tool.description || "",
          inputSchema: tool.inputSchema,
        });
      }
    }
    return tools;
  }

  /** True when `serverId` is a Pipedream-connected app (route via yo-server). */
  private isConnectorServerId(serverId: string): boolean {
    return this.connectorCatalog.some((t) => t.slug === serverId);
  }

  async callTool(qualifiedName: string, args: Record<string, unknown> = {}): Promise<string> {
    const match = qualifiedName.match(/^mcp__(.+?)__(.+)$/);
    if (!match) return `Invalid MCP tool name: ${qualifiedName}`;

    const [, serverId, toolName] = match;

    // Connector tools: route through yo-server. No local MCP client per app.
    if (this.isConnectorServerId(serverId)) {
      try { return await callConnectorTool(serverId, toolName, args); }
      catch (err) { return `MCP tool error: ${err instanceof Error ? err.message : err}`; }
    }

    const entry = this.servers.get(serverId);
    if (!entry) return `MCP server "${serverId}" not found.`;
    if (entry.state.status !== "connected") return `MCP server "${serverId}" is not connected.`;

    try {
      const result = await entry.client.callTool(toolName, args);
      return result.content
        .map((block) => {
          if (block.type === "text" && block.text) return block.text;
          if (block.type === "image" && block.data) return `[image: ${block.mimeType || "image/png"}]`;
          return `[${block.type}]`;
        })
        .join("\n") || (result.isError ? "[tool returned error with no content]" : "[no output]");
    } catch (err) {
      return `MCP tool error: ${err instanceof Error ? err.message : err}`;
    }
  }

  async callToolDirect(serverId: string, toolName: string, args: Record<string, unknown> = {}): Promise<string> {
    return this.callTool(`mcp__${serverId}__${toolName}`, args);
  }

  getToolOverrides(): Record<string, McpToolOverride> {
    return getPreference<Record<string, McpToolOverride>>("mcpToolOverrides", {});
  }

  getToolOverride(serverId: string, toolName: string): McpToolOverride {
    const overrides = this.getToolOverrides();
    return overrides[`${serverId}:${toolName}`] || "default";
  }

  setToolOverride(serverId: string, toolName: string, override: McpToolOverride): void {
    const overrides = this.getToolOverrides();
    const key = `${serverId}:${toolName}`;
    if (override === "default") {
      delete overrides[key];
    } else {
      overrides[key] = override;
    }
    setPreference("mcpToolOverrides", overrides);
  }

  setServerOverride(serverId: string, override: McpToolOverride): void {
    const overrides = this.getToolOverrides();
    const entry = this.servers.get(serverId);
    if (!entry) return;
    for (const tool of entry.state.tools) {
      const key = `${serverId}:${tool.name}`;
      if (override === "default") {
        delete overrides[key];
      } else {
        overrides[key] = override;
      }
    }
    setPreference("mcpToolOverrides", overrides);
  }

  async disconnectAll(): Promise<void> {
    for (const entry of this.servers.values()) {
      if (entry.client.isConnected()) {
        await entry.client.disconnect().catch(() => {});
      }
    }
    this.servers.clear();
  }
}
