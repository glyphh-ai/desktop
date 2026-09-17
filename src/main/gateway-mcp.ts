/**
 * gateway-mcp.ts — ONE way to run a connected account's tool.
 *
 * His report, 2026-09-17: an agent asked to read his mail got a 404. The SDK's
 * `connections.runTool` posts to `/api/connections/run`, a route the old
 * server had and THIS server never implemented, so every call through it has
 * always failed — the local MCP server's `connector_call`, and the semantic
 * lane's connection ingestion with it.
 *
 * The path that does work is the gateway's own MCP endpoint: the org's
 * connections are registered there, the member's gateway key authenticates
 * the call, and account binding and metering happen server-side. The task
 * runner has been using it all along. This is that, in one place, for every
 * caller — a second client with its own reconnect logic is how one of them
 * ends up broken.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { mcpCreds } from "./gateway-token.js";
import { pickToolName, toolsOfApp } from "./gateway-tool-name.js";

let client: Client | null = null;

async function connect(): Promise<Client> {
  if (client) return client;
  const creds = await mcpCreds();
  if (!creds) throw new Error("no gateway credential: sign in to reach the org's connections");
  const c = new Client({ name: "glyphh-desktop", version: "1.0.0" });
  await c.connect(new StreamableHTTPClientTransport(
    new URL(`${creds.baseUrl.replace(/\/$/, "")}/mcp`),
    { requestInit: { headers: { Authorization: `Bearer ${creds.token}` } } },
  ));
  client = c;
  return c;
}

/** Drop the connection so the next call redials (token rotated, server moved). */
export function resetGatewayMcp(): void {
  const c = client;
  client = null;
  toolNames = null;
  if (c) void c.close().catch(() => {});
}

/**
 * THE GATEWAY NAMES ITS OWN TOOLS (his report, 2026-09-17: every connector
 * call came back "User not allowed to call this tool", which reads as a
 * governance refusal).
 *
 * A tool there is prefixed with the SERVER's registered name, and a
 * connection's server is named for the org and the account —
 * `pd_<org>_google_drive_u_<user>` — not for the app slug. We asked for
 * `google_drive-list_files`, which resolves to no server at all, and the
 * permission check then refuses a server it could not identify. The CLI
 * never hit this because it lists the tools and calls them by the names it
 * was given.
 *
 * So do that: ask the gateway what it has, and match the app and the tool
 * against real names. The answer is cached per connection and refreshed when
 * a name misses, since a connection added today must not need a restart.
 */
let toolNames: string[] | null = null;

async function knownToolNames(force = false): Promise<string[]> {
  if (toolNames && !force) return toolNames;
  try {
    const c = await connect();
    const listed = await c.listTools();
    toolNames = (listed?.tools ?? []).map((t) => String(t.name));
  } catch { toolNames = toolNames ?? []; }
  return toolNames;
}

/** The gateway's own name for one app's tool, or null when it has no such
 *  tool. The matching itself is pure and tested (gateway-tool-name.ts); this
 *  only decides when to re-read the list. */
async function resolveToolName(appSlug: string, tool: string, force = false): Promise<string | null> {
  const hit = pickToolName(await knownToolNames(force), appSlug, tool);
  if (hit) return hit;
  return force ? null : resolveToolName(appSlug, tool, true);
}

/**
 * Call one connected app's tool through the gateway. An error RESULT is raised
 * as an error: the gateway answers a refusal with `isError` and ordinary
 * content, which a caller that only checks for throws would read as data.
 */
export async function callGatewayTool(appSlug: string, tool: string, args: Record<string, unknown> = {}): Promise<unknown> {
  const resolved = await resolveToolName(appSlug, tool);
  if (!resolved) {
    const names = toolsOfApp(await knownToolNames(), appSlug).slice(0, 12);
    throw new Error(names.length
      ? `"${tool}" is not a tool on ${appSlug}. It has: ${names.join(", ")}`
      : `${appSlug} has no tools on the gateway — connect it, or ask your admin to authorize the shared account`);
  }
  const name = resolved;
  let res: unknown;
  try {
    const c = await connect();
    res = await c.callTool({ name, arguments: args });
  } catch (err) {
    resetGatewayMcp();
    throw err;
  }
  const r = res as { isError?: boolean; content?: Array<{ type?: string; text?: string }> };
  if (r?.isError) {
    const said = (r.content ?? []).map((x) => x?.text).filter(Boolean).join(" ").trim();
    throw new Error(said || `"${tool}" on ${appSlug} was refused by the gateway`);
  }
  return res;
}

/** The text a tool answered with, which is what an agent wants back. */
export async function callGatewayToolText(appSlug: string, tool: string, args: Record<string, unknown> = {}): Promise<string> {
  const res = await callGatewayTool(appSlug, tool, args) as { content?: Array<{ type?: string; text?: string }> };
  const said = (res?.content ?? []).map((c) => c?.text).filter(Boolean).join("\n").trim();
  return said || JSON.stringify(res ?? null);
}
