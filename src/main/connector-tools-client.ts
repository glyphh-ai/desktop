/**
 * connector-tools-client — yo-client's view of the server-side connector
 * tool layer.
 *
 * yo-server owns Pipedream auth. Instead of yo-client running its own MCP
 * client per connected app (which then has to call back to yo-server for
 * tokens anyway), we go through /api/connectors/tools{,/call} with the
 * regular JWT. Single source of truth — the relay's connector_* tools and
 * yo-client both ride this same path.
 *
 * Trade-off: one extra hop (yo-server → Pipedream) vs. direct from the
 * desktop app. ~50–100 ms; acceptable since Pipedream's own call cost
 * dominates and the catalog is cached for 5 min on the server.
 */

import { serverGetAuthed, serverPostAuthed } from "./auth.js";

export interface ConnectorTool {
  slug: string;
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

let cached: ConnectorTool[] = [];
let slugs = new Set<string>();
let lastRefresh = 0;

/** Pull the freshest catalog from yo-server and cache it in-process. */
export async function refreshConnectorCatalog(): Promise<ConnectorTool[]> {
  try {
    const res = await serverGetAuthed<{ ok: boolean; tools: ConnectorTool[]; error?: string }>(
      "/api/connectors/tools",
    );
    if (!res.ok) {
      console.warn(`[connector-tools] refresh failed: ${res.error}`);
      cached = [];
      slugs = new Set();
      return [];
    }
    cached = res.tools || [];
    slugs = new Set(cached.map((t) => t.slug));
    lastRefresh = Date.now();
    return cached;
  } catch (err) {
    console.warn(`[connector-tools] refresh threw: ${err instanceof Error ? err.message : String(err)}`);
    return cached;                              // keep stale catalog on transient errors
  }
}

export function getConnectorCatalog(): ConnectorTool[] { return cached; }
export function isConnectorSlug(slug: string): boolean { return slugs.has(slug); }
export function getCatalogAge(): number { return lastRefresh ? Date.now() - lastRefresh : Infinity; }

/** Drop the in-process catalog — called when the signed-in user changes so
 *  one account's tool list can never bleed into the next. */
export function clearConnectorCatalog(): void {
  cached = [];
  slugs = new Set();
  lastRefresh = 0;
}

/** Invoke a connector tool via yo-server. Returns the coerced text result. */
export async function callConnectorTool(
  slug: string,
  name: string,
  args: Record<string, unknown>,
): Promise<string> {
  const res = await serverPostAuthed<{ ok: boolean; result?: string; error?: string }>(
    "/api/connectors/tools/call",
    { slug, name, args },
  );
  if (!res.ok) throw new Error(res.error || "tool call failed");
  return res.result || "";
}
