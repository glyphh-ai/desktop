/**
 * resources/connections.ts — the org's connectors (Pipedream accounts + custom MCP
 * servers). Install/remove are org_admin (server-enforced); MCP headers are
 * write-only. The Pipedream connect-link needs the server's Pipedream config.
 */

import type { AuthedHttp } from "../core/authed-http.js";
import type {
  Connection, CustomMcpInput, ConnectLink, ConnectorApp, ConnectorTool,
  OrgMcpConnection, OrgMcpInput, OrgMcpPatch, OrgMcpCreateResult, OrgPipedreamConnection,
  ResolvedConnection, McpOAuthStart, PersonalConnection, PersonalConnectSession, RunToolResult, FetchFileResult, ProxySendResult,
} from "../contract/connections.js";

export class ConnectionsClient {
  constructor(private readonly http: AuthedHttp) {}

  list(): Promise<Connection[]> {
    return this.http.get<Connection[]>("/api/connections");
  }

  /**
   * Search the connector catalog for connectable apps (the "Add Connection"
   * picker). Best-effort server-side: an unconfigured or slow catalog yields an
   * empty list rather than an error. `limit` defaults to 24 (server-clamped 1..100).
   */
  apps(input: { search?: string; limit?: number; after?: string; category?: string } = {}): Promise<{ apps: ConnectorApp[]; next?: string; total?: number }> {
    const params = new URLSearchParams();
    if (input.search?.trim()) params.set("search", input.search.trim());
    if (input.limit != null) params.set("limit", String(input.limit));
    if (input.after) params.set("after", input.after);
    if (input.category) params.set("category", input.category);
    const qs = params.toString();
    return this.http.get<{ apps: ConnectorApp[]; next?: string; total?: number }>(`/api/connectors/apps${qs ? `?${qs}` : ""}`);
  }

  /** The most connected apps across the server, by install count. */
  popular(limit = 6): Promise<{ apps: Array<ConnectorApp & { installs: number }> }> {
    return this.http.get<{ apps: Array<ConnectorApp & { installs: number }> }>(`/api/connectors/popular?limit=${limit}`);
  }

  /** The directory by category: name, count, and a few featured apps each. */
  categories(): Promise<{ categories: Array<{ name: string; count: number; apps: ConnectorApp[] }> }> {
    return this.http.get<{ categories: Array<{ name: string; count: number; apps: ConnectorApp[] }> }>("/api/connectors/categories");
  }

  /** Install a custom MCP server (org_admin). `headers` are sent once, then encrypted. */
  installCustomMcp(input: CustomMcpInput): Promise<Connection> {
    return this.http.post<Connection>("/api/connections/mcp", input);
  }

  removeCustomMcp(slug: string): Promise<void> {
    return this.http.del<void>(`/api/connections/mcp/${encodeURIComponent(slug)}`);
  }

  /** Get a Pipedream connect-link URL to OAuth an account (needs Pipedream config). */
  pipedreamConnectLink(): Promise<ConnectLink> {
    return this.http.post<ConnectLink>("/api/connections/pipedream/connect");
  }

  /** The tools/actions a connector app exposes (best-effort; empty when unconfigured). */
  appTools(slug: string): Promise<{ tools: ConnectorTool[] }> {
    return this.http.get<{ tools: ConnectorTool[] }>(`/api/connectors/apps/${encodeURIComponent(slug)}/tools`);
  }

  /**
   * One org custom-MCP connection's advertised tool NAMES (org_admin). Probes the
   * stored endpoint with its decrypted auth; best-effort — an unreachable endpoint
   * degrades to `[]`. 404s a slug the org doesn't own.
   */
  async mcpTools(slug: string): Promise<ConnectorTool[]> {
    const { tools } = await this.http.get<{ tools: ConnectorTool[] }>(`/api/org/mcp-connections/${encodeURIComponent(slug)}/tools`);
    return tools;
  }

  /**
   * The caller's RESOLVED per-connection tools — every enabled connection their
   * workspace may reach, each with its tools narrowed by the workspace tool grant.
   * Best-effort per connection (an unreachable endpoint yields an empty tool list).
   */
  resolvedTools(): Promise<{ connections: ResolvedConnection[] }> {
    return this.http.get<{ connections: ResolvedConnection[] }>("/api/connections/tools");
  }

  /**
   * Start an OAuth 2.1 authorization for a custom-MCP connection (org_admin); runs
   * discovery + dynamic client registration as needed and returns the authorize URL
   * to open. Tokens land later at the browser callback (no SDK method).
   */
  startMcpOAuth(slug: string): Promise<McpOAuthStart> {
    return this.http.post<McpOAuthStart>(`/api/org/mcp-connections/${encodeURIComponent(slug)}/oauth/start`);
  }

  // ── Settings → MCP: the RICH org custom-MCP catalog (org_admin) ──────────────

  /** The org's published custom-MCP connections (rich rows). */
  async orgMcpList(): Promise<OrgMcpConnection[]> {
    const { connections } = await this.http.get<{ connections: OrgMcpConnection[] }>("/api/org/mcp-connections");
    return connections;
  }

  /** Publish a custom-MCP connection; the server probes it for reachability + tool count. */
  orgMcpCreate(input: OrgMcpInput): Promise<OrgMcpCreateResult> {
    return this.http.post<OrgMcpCreateResult>("/api/org/mcp-connections", input);
  }

  /** Edit a custom-MCP connection (omit `headers` to keep the saved secret). */
  orgMcpUpdate(slug: string, patch: OrgMcpPatch): Promise<{ ok: boolean; connection: OrgMcpConnection }> {
    return this.http.patch<{ ok: boolean; connection: OrgMcpConnection }>(`/api/org/mcp-connections/${encodeURIComponent(slug)}`, patch);
  }

  /** Delete a custom-MCP connection (removes every member's install of it). */
  orgMcpRemove(slug: string): Promise<{ ok: boolean }> {
    return this.http.del<{ ok: boolean }>(`/api/org/mcp-connections/${encodeURIComponent(slug)}`);
  }

  /** Set a custom-MCP connection's logo from a data-URL. */
  orgMcpSetIcon(slug: string, dataUrl: string): Promise<{ ok: boolean; iconSha: string }> {
    return this.http.put<{ ok: boolean; iconSha: string }>(`/api/org/mcp-connections/${encodeURIComponent(slug)}/icon`, { dataUrl });
  }

  // ── Configure → Connections: the RICH org-shared Pipedream cards (org_admin) ──

  /** The org's shared Pipedream OAuth connections (rich cards). */
  async pipedreamList(): Promise<OrgPipedreamConnection[]> {
    const { connections } = await this.http.get<{ connections: OrgPipedreamConnection[] }>("/api/org/connections");
    return connections;
  }

  /**
   * Start an org-level Pipedream Connect session for one app. Returns the
   * short-lived Connect `token` (authorizes the browser SDK's inline connect
   * dialog for this app) plus the hosted `connectUrl` fallback.
   */
  async pipedreamConnect(appSlug: string): Promise<{ token: string; connectUrl: string }> {
    return this.http.post<{ token: string; connectUrl: string }>("/api/org/connections/connect", { appSlug });
  }

  /** Disconnect an org Pipedream account by id (audited server-side). */
  pipedreamDisconnect(id: string): Promise<{ ok: boolean }> {
    return this.http.del<{ ok: boolean }>(`/api/org/connections/${encodeURIComponent(id)}`);
  }

  /** The org-level tool caps per connection — `{ slug: allowedTools[] }`. A slug
   *  absent ⇒ all its tools are org-allowed; workspaces further restrict from this. */
  orgConnectionTools(): Promise<Record<string, string[]>> {
    return this.http.get<Record<string, string[]>>("/api/org/connections/tools");
  }

  /** Set the org-level allowed tools for a connection (the org cap; audited). */
  setOrgConnectionTools(slug: string, tools: string[]): Promise<{ ok: boolean; slug: string; tools: string[] }> {
    return this.http.put<{ ok: boolean; slug: string; tools: string[] }>(`/api/org/connections/${encodeURIComponent(slug)}/tools`, { tools });
  }

  /** Rename an org Pipedream connection (sets its display label). */
  async renameOrgConnection(id: string, label: string): Promise<OrgPipedreamConnection> {
    const { connection } = await this.http.patch<{ ok: boolean; connection: OrgPipedreamConnection }>(`/api/org/connections/${encodeURIComponent(id)}`, { label });
    return connection;
  }

  /** Enable/disable ANY connection in the org — org-shared or a member's own
   *  (the org admin governs both; disabled rows leave every tool set). */
  async setOrgConnectionEnabled(id: string, enabled: boolean): Promise<OrgPipedreamConnection> {
    const { connection } = await this.http.patch<{ ok: boolean; connection: OrgPipedreamConnection }>(`/api/org/connections/${encodeURIComponent(id)}`, { enabled });
    return connection;
  }

  /** Move a connection between ORG scope (everyone) and PERSONAL scope (the
   *  caller's). Org-admin only. */
  async setOrgConnectionScope(id: string, scope: "org" | "personal"): Promise<OrgPipedreamConnection> {
    const { connection } = await this.http.patch<{ ok: boolean; connection: OrgPipedreamConnection }>(`/api/org/connections/${encodeURIComponent(id)}`, { scope });
    return connection;
  }

  // ── Personal (member-made) connections — the member's OWN Pipedream auth ──────

  /** The caller's personal Pipedream connections (best-effort synced from Pipedream). */
  async personalList(): Promise<PersonalConnection[]> {
    const { connections } = await this.http.get<{ connections: PersonalConnection[] }>("/api/connections/personal");
    return connections;
  }

  /** Start a personal Pipedream Connect session for one app — refused (403) when the
   *  caller's workspace does not permit personally connecting it. */
  personalConnect(app: string): Promise<PersonalConnectSession> {
    return this.http.post<PersonalConnectSession>("/api/connections/personal/pipedream/connect", { app });
  }

  /** Label one of the caller's OWN connections (e.g. "My work Gmail"). */
  async renamePersonalConnection(id: string, label: string): Promise<PersonalConnection> {
    const { connection } = await this.http.patch<{ ok: boolean; connection: PersonalConnection }>(`/api/connections/personal/${encodeURIComponent(id)}`, { label });
    return connection;
  }

  /** Enable/disable one of the caller's OWN connections. */
  async setPersonalConnectionEnabled(id: string, enabled: boolean): Promise<PersonalConnection> {
    const { connection } = await this.http.patch<{ ok: boolean; connection: PersonalConnection }>(`/api/connections/personal/${encodeURIComponent(id)}`, { enabled });
    return connection;
  }

  /** Disconnect one of the caller's OWN personal connections by id. */
  personalDisconnect(id: string): Promise<{ ok: boolean }> {
    return this.http.del<{ ok: boolean }>(`/api/connections/personal/${encodeURIComponent(id)}`);
  }

  // ── the member's OWN custom-MCP endpoints (workspace-gated) ──────────────────

  /** The caller's own custom-MCP endpoints (never the org-shared catalog). */
  async personalMcpList(): Promise<OrgMcpConnection[]> {
    const { connections } = await this.http.get<{ connections: OrgMcpConnection[] }>("/api/connections/personal/mcp");
    return connections;
  }

  /** Register a custom-MCP endpoint of the caller's own; the server probes it for
   *  reachability. Refused (403) unless their workspace allows custom MCP. */
  personalMcpCreate(input: OrgMcpInput): Promise<OrgMcpCreateResult> {
    return this.http.post<OrgMcpCreateResult>("/api/connections/personal/mcp", input);
  }

  /** Edit one of the caller's own endpoints (omit `headers` to keep the saved secret). */
  personalMcpUpdate(slug: string, patch: OrgMcpPatch): Promise<{ ok: boolean; connection: OrgMcpConnection }> {
    return this.http.patch<{ ok: boolean; connection: OrgMcpConnection }>(`/api/connections/personal/mcp/${encodeURIComponent(slug)}`, patch);
  }

  /** Delete one of the caller's own endpoints. */
  personalMcpRemove(slug: string): Promise<{ ok: boolean }> {
    return this.http.del<{ ok: boolean }>(`/api/connections/personal/mcp/${encodeURIComponent(slug)}`);
  }

  /** The caller's OWN per-connection tool caps — `{ slug: allowedTools[] }`. The last
   *  narrowing layer under the org cap and the workspace grant; an absent slug ⇒ no cap. */
  personalConnectionTools(): Promise<Record<string, string[]>> {
    return this.http.get<Record<string, string[]>>("/api/connections/personal/tools");
  }

  /** Narrow which of a connection's tools the caller's own agents may call. */
  setPersonalConnectionTools(slug: string, tools: string[]): Promise<{ ok: boolean; slug: string; tools: string[] }> {
    return this.http.put<{ ok: boolean; slug: string; tools: string[] }>(`/api/connections/personal/${encodeURIComponent(slug)}/tools`, { tools });
  }

  /**
   * Run one governed connection tool. `slug` names a connection from the caller's resolved
   * set; `tool` is the tool key or name; `props` are the action inputs. Scope is derived
   * server-side from the resolved connection — a PERSONAL connection runs under the member's
   * own external id (`user_<userId>`), an org-shared one under `org_<orgId>`.
   */
  runTool(input: { slug: string; tool: string; props?: Record<string, unknown>; scope?: "org" | "personal" }): Promise<RunToolResult> {
    return this.http.post<RunToolResult>("/api/connections/run", input);
  }

  /** Fetch a file's bytes from a connected account (provider API url, e.g.
   *  Drive `files/<id>?alt=media`) through the server's Connect-proxy bridge.
   *  Same gates as runTool; capped server-side (~15MB default, 25MB max). */
  fetchFile(input: { slug: string; url: string; scope?: "org" | "personal"; maxBytes?: number }): Promise<FetchFileResult> {
    return this.http.post<FetchFileResult>("/api/connections/fetch-file", input);
  }

  /** Push bytes TO a connected account's provider API (uploads, sends with
   *  real attachments) through the server's Connect-proxy bridge. bodyBase64
   *  must decode text-safe (MIME with base64-encoded parts is). Same gates as
   *  runTool; 25MB body cap server-side. */
  proxySend(input: { slug: string; url: string; bodyBase64: string; method?: "POST" | "PUT"; contentType?: string; scope?: "org" | "personal" }): Promise<ProxySendResult> {
    return this.http.post<ProxySendResult>("/api/connections/proxy-send", input);
  }
}
