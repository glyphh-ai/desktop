/**
 * contract/connections.ts — connectors the runtime calls. Two kinds: Pipedream
 * OAuth accounts and custom MCP servers (a remote URL + auth headers). Credentials
 * (headers / OAuth tokens) are server-held, encrypted, write-only — never returned.
 * Workspaces filter which connections members may use (`allowedConnections`).
 */

export type ConnectionKind = "pipedream" | "custom_mcp";

export interface Connection {
  slug: string;
  name: string;
  kind: ConnectionKind;
  scope: "org" | "user";
  enabled: boolean;
  /** True when server-side credentials are set (the values are never returned). */
  hasCredentials: boolean;
}

/** org_admin installs a custom MCP server. `headers` are write-only (encrypted at rest). */
export interface CustomMcpInput {
  slug: string;
  name: string;
  url: string;
  headers?: Record<string, string>;
}

/** A Pipedream connect-link URL to open (OAuth an account). */
export interface ConnectLink {
  url: string;
}

/** One connectable app from the connector catalog (the "Add Connection" picker). */
export interface ConnectorApp {
  id: string;
  name: string;
  icon: string | null;
  /** Pipedream's blurb for the app (empty under governance, where the org's list carries none). */
  description?: string;
  /** Pipedream's categories for the app. */
  categories?: string[];
}

/** One tool/action a connector app exposes. */
export interface ConnectorTool {
  /** The invocation identity passed to `runTool` — the Pipedream component key
   *  (e.g. `gmail-send-email`) or, for custom MCP, the tool name. */
  key: string;
  name: string;
  description: string | null;
  /** JSON Schema for the tool's inputs (component definition / MCP tools/list).
   *  Null/absent = the source carried none; the model shapes args from prose. */
  inputSchema?: Record<string, unknown> | null;
}

/** The result of running a connection tool (`ret` is the action's return value). */
export interface RunToolResult {
  result: { ret: unknown; exports?: unknown; os?: unknown };
}

/** A file fetched from a connected account via the server's Connect-proxy
 *  bridge — the way FILE BYTES reach the caller (connector actions execute in
 *  a remote sandbox; their "downloads" never leave it). */
export interface FetchFileResult {
  contentType: string | null;
  bytes: number;
  dataBase64: string;
}

/** The provider's response to a proxy send (outbound bytes: uploads, sends
 *  with attachments). */
export interface ProxySendResult {
  status: number;
  contentType: string | null;
  dataBase64: string;
}

/**
 * One enabled connection the caller may reach, with its advertised tools already
 * narrowed by the caller's workspace tool grant. Both connection kinds share this
 * shape; custom-MCP tools come from a live probe, Pipedream tools from the catalog.
 */
export interface ResolvedConnection {
  slug: string;
  name: string;
  kind: ConnectionKind;
  /** `"org"` = the org-shared connector; `"personal"` = the caller's own (per-user
   *  Pipedream). The runtime picks the external id (`org_<id>` vs `user_<id>`) from this. */
  scope: "org" | "personal";
  /** What the RUNTIME may call: advertised ∩ org ∩ workspace ∩ the member's own cap. */
  tools: ConnectorTool[];
  /** What the MEMBER may choose from: everything the layers ABOVE them allow, before
   *  their own cap. A tool-limiting UI must use THIS as the universe — using `tools`
   *  would make an earlier self-restriction permanent, since a tool they had unchecked
   *  would no longer be listed to re-check. */
  availableTools: ConnectorTool[];
}

/** A member's OWN (personal) Pipedream connection — connected with their own auth,
 *  private to them, governed by their workspace's personal-connection allow-list. */
export interface PersonalConnection {
  id: string;
  appSlug: string;
  appName: string;
  name: string;
  label: string | null;
  healthy: boolean;
  /** The governed on/off switch (healthy mirrors it for older clients). */
  enabled: boolean;
  /** True once an account is authorized (a shared org connection is always connected). */
  connected?: boolean;
  /** An org connection (admin-added) rather than the member's own record. */
  org?: boolean;
  /** A shared org account every member rides; nothing for the member to connect. */
  shared?: boolean;
}

/** The result of starting a personal Pipedream connect session (`url` === `connectUrl`). */
export interface PersonalConnectSession {
  token: string;
  connectUrl: string;
  url: string;
}

/** The authorize URL to open to start a custom-MCP OAuth 2.1 authorization. */
export interface McpOAuthStart {
  authorizeUrl: string;
}

/**
 * The RICH custom-MCP connection the org admin catalog (Settings → MCP) manages:
 * endpoint url, logo hash, enabled toggle, the NAMES of the write-only headers
 * (never values), and the tool count from the last successful probe.
 */
export interface OrgMcpConnection {
  slug: string;
  name: string;
  iconSha: string | null;
  url: string;
  enabled: boolean;
  headerKeys: string[];
  toolCount: number;
}

/** Publish (create) a custom MCP connection. `headers` are write-only (encrypted). */
export interface OrgMcpInput {
  slug: string;
  name: string;
  url: string;
  headers?: Record<string, string>;
}

/** Partial edit of a custom MCP connection. Omitting `headers` keeps the saved secret. */
export interface OrgMcpPatch {
  name?: string;
  url?: string;
  headers?: Record<string, string>;
  enabled?: boolean;
}

/** The publish result: whether the endpoint was reachable + its advertised tool count. */
export interface OrgMcpCreateResult {
  ok: boolean;
  connection: OrgMcpConnection;
  toolCount: number;
  /** The probe failure message when `ok` is false (the connection is still saved). */
  error?: string;
}

/**
 * The RICH org-shared Pipedream connection card (Configure → Connections): identified
 * by row id, with the app it authorizes, health, and when it was connected.
 */
export interface OrgPipedreamConnection {
  id: string;
  appSlug: string;
  appName: string;
  name: string;
  icon: string | null;
  healthy: boolean;
  /** The governed on/off switch (healthy mirrors it for older clients). */
  enabled: boolean;
  createdAt: string;
}
