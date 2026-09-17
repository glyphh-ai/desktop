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
  if (c) void c.close().catch(() => {});
}

/**
 * Call one connected app's tool through the gateway. The gateway prefixes each
 * tool with its server's name, so a bare tool name is qualified with the app.
 * An error RESULT is raised as an error: the gateway answers a refusal with
 * `isError` and ordinary content, which a caller that only checks for throws
 * would read as data.
 */
export async function callGatewayTool(appSlug: string, tool: string, args: Record<string, unknown> = {}): Promise<unknown> {
  const name = tool.startsWith(`${appSlug}-`) ? tool : `${appSlug}-${tool}`;
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
