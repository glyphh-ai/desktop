/**
 * MCP Manager — the client-side view of the user's tool surface.
 *
 * All MCP execution is SERVER-SIDE now: Pipedream-connected apps and the
 * user's custom MCP connections both ride yo-server's governed connector
 * catalog (/api/connectors/tools{,/call}) — the client never dials an MCP
 * endpoint itself. This class holds the refreshed catalog and routes tool
 * calls through the server; local stdio/localhost servers are gone
 * (custom MCP connections are remote URLs, managed on the Connections page).
 */

import { EventEmitter } from "events";
import { callConnectorTool, type ConnectorTool } from "./connector-tools-client";

export class McpManager extends EventEmitter {
  // Tools from the user's connections (Pipedream apps + custom MCP servers),
  // served by yo-server. Surfaced through getAllTools so consumers (skills,
  // agent, relay) don't need to special-case where a tool executes.
  private connectorCatalog: ConnectorTool[] = [];

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
    return this.connectorCatalog.map((t) => ({
      serverId: t.slug,
      serverName: t.slug,
      name: t.name,
      qualifiedName: `mcp__${t.slug}__${t.name}`,
      description: t.description,
      inputSchema: t.inputSchema,
    }));
  }

  async callTool(qualifiedName: string, args: Record<string, unknown> = {}): Promise<string> {
    const match = qualifiedName.match(/^mcp__(.+?)__(.+)$/);
    if (!match) return `Invalid MCP tool name: ${qualifiedName}`;
    const [, serverId, toolName] = match;
    if (!this.connectorCatalog.some((t) => t.slug === serverId)) {
      return `MCP server "${serverId}" not found.`;
    }
    try { return await callConnectorTool(serverId, toolName, args); }
    catch (err) { return `MCP tool error: ${err instanceof Error ? err.message : err}`; }
  }

  async callToolDirect(serverId: string, toolName: string, args: Record<string, unknown> = {}): Promise<string> {
    return this.callTool(`mcp__${serverId}__${toolName}`, args);
  }
}
