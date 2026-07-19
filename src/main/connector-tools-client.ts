/**
 * connector-tools-client — yo-client's view of the server-side connector
 * tool layer.
 *
 * The server owns connector auth. Instead of yo-client running its own MCP
 * client per connected app (which then has to call back to the server for
 * tokens anyway), we go through client.connections.resolvedTools()/runTool().
 * Single source of truth — the relay's connector_* tools and yo-client both
 * ride this same path.
 *
 * Trade-off: one extra hop (yo-server → Pipedream) vs. direct from the
 * desktop app. ~50–100 ms; acceptable since Pipedream's own call cost
 * dominates and the catalog is cached for 5 min on the server.
 */

import { getClient } from "./glyphh-client.js";

/** One invocable connection tool, flattened for the agent surfaces: `slug` is
 *  the CONNECTION, `name` the tool key runTool wants. The resolved catalog
 *  carries no input schema — schema-less tools prompt the model to shape args
 *  from the description. */
export interface ConnectorTool {
  slug: string;
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

let cached: ConnectorTool[] = [];
let slugs = new Set<string>();
let lastRefresh = 0;

/** Pull the freshest resolved tool set from the server and cache it in-process. */
export async function refreshConnectorCatalog(): Promise<ConnectorTool[]> {
  try {
    const { connections } = await getClient().connections.resolvedTools();
    cached = connections.flatMap((conn) =>
      conn.tools.map((t) => ({
        slug: conn.slug,
        name: t.key,
        description: t.description ?? t.name,
        inputSchema: {},
      })),
    );
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

/** Invoke a connection tool via the server. Returns the coerced text result. */
export async function callConnectorTool(
  slug: string,
  name: string,
  args: Record<string, unknown>,
): Promise<string> {
  const { result } = await getClient().connections.runTool({ slug, tool: name, props: args });
  if (result.ret === undefined || result.ret === null) return "";
  return typeof result.ret === "string" ? result.ret : JSON.stringify(result.ret);
}
