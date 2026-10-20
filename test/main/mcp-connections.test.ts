/**
 * mcp-connections.test.ts — the connections every loop's tools come from
 * (main/mcp-connections.ts): a connected Pipedream app is dialed at
 * Pipedream's MCP endpoint with the x-pd headers and a fresh bearer,
 * re-dialed when that token rotates or a call comes back 401; tool
 * permissions drop Never tools and refuse Never calls; a custom server's
 * typed OAuth client reaches the dial. The MCP SDK and Pipedream are fakes.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const home = mkdtempSync(join(tmpdir(), "glyphh-conns-"));
vi.mock("../../src/main/app-paths.js", () => ({ userScopedPath: (...p: string[]) => join(home, ...p) }));
vi.mock("electron", () => ({ ipcMain: { handle: vi.fn() }, shell: { openExternal: vi.fn() } }));

let modes: Record<string, Record<string, string>> = {};
vi.mock("../../src/main/stores/preferences-db.js", () => ({ preferencesByPrefix: () => modes }));

const pdState = { token: "tok-1", apps: [{ app: "gmail", name: "Gmail" }] as Array<{ app: string; name: string }>, invalidated: 0 };
vi.mock("../../src/main/pipedream.js", () => ({
  pdToolApps: () => pdState.apps,
  currentPdToken: () => pdState.token,
  invalidatePdToken: () => { pdState.invalidated++; pdState.token = `tok-${pdState.invalidated + 1}`; },
  pdMcpAuth: async (app: string) => ({
    url: "https://remote.mcp.pipedream.net/v3",
    token: pdState.token,
    headers: { Authorization: `Bearer ${pdState.token}`, "x-pd-project-id": "proj_abc", "x-pd-environment": "development", "x-pd-external-user-id": "glyphh-local", "x-pd-app-slug": app },
  }),
}));

/** Every transport made, with what it was made with. */
const dials: Array<{ url: string; opts: { requestInit?: { headers?: Record<string, string> }; authProvider?: { clientInformation(): { client_id: string; client_secret?: string } | undefined } } }> = [];
let callBehaviour: (name: string) => unknown = (name) => ({ content: [{ type: "text", text: `ran ${name}` }] });
const tools = [
  { name: "gmail-list-labels", description: "List labels", inputSchema: { type: "object" } },
  { name: "gmail-send-email", description: "Send an email", inputSchema: { type: "object" } },
  { name: "gmail-delete-email", description: "Delete an email", inputSchema: { type: "object" } },
];
vi.mock("@modelcontextprotocol/sdk/client/streamableHttp.js", () => ({
  StreamableHTTPClientTransport: class { constructor(url: URL, opts: never) { dials.push({ url: url.toString(), opts }); } },
}));
vi.mock("@modelcontextprotocol/sdk/client/sse.js", () => ({ SSEClientTransport: class {} }));
vi.mock("@modelcontextprotocol/sdk/client/stdio.js", () => ({ StdioClientTransport: class {} }));
vi.mock("@modelcontextprotocol/sdk/client/index.js", () => ({
  Client: class {
    async connect(): Promise<void> {}
    async listTools() { return { tools }; }
    async callTool({ name }: { name: string }) { return callBehaviour(name); }
    async close(): Promise<void> {}
  },
}));

const C = await import("../../src/main/mcp-connections.js");

beforeEach(async () => {
  C.closeMcpConnections();
  await new Promise((r) => setTimeout(r, 0));
  rmSync(home, { recursive: true, force: true });
  mkdirSync(home, { recursive: true });
  dials.length = 0;
  modes = {};
  pdState.token = "tok-1";
  pdState.apps = [{ app: "gmail", name: "Gmail" }];
  pdState.invalidated = 0;
  callBehaviour = (name) => ({ content: [{ type: "text", text: `ran ${name}` }] });
});

describe("Pipedream apps are connections", () => {
  it("are dialed at Pipedream's MCP endpoint with the x-pd headers and the bearer", async () => {
    const list = await C.listConnectionTools();
    expect(dials).toHaveLength(1);
    expect(dials[0]!.url).toBe("https://remote.mcp.pipedream.net/v3");
    expect(dials[0]!.opts.requestInit?.headers).toEqual({
      Authorization: "Bearer tok-1",
      "x-pd-project-id": "proj_abc",
      "x-pd-environment": "development",
      "x-pd-external-user-id": "glyphh-local",
      "x-pd-app-slug": "gmail",
    });
    expect(list.map((t) => [t.connection, t.label, t.name, t.mode])).toEqual([
      ["pd:gmail", "Gmail", "gmail-list-labels", "allow"],
      ["pd:gmail", "Gmail", "gmail-send-email", "ask"],
      ["pd:gmail", "Gmail", "gmail-delete-email", "ask"],
    ]);
  });

  it("the live client is reused while the token holds, and re-dialed when it rotates", async () => {
    await C.listConnectionTools();
    await C.callConnectionTool("pd:gmail", "gmail-list-labels", {});
    expect(dials).toHaveLength(1);
    pdState.token = "tok-rotated";
    await C.callConnectionTool("pd:gmail", "gmail-list-labels", {});
    expect(dials).toHaveLength(2);
    expect(dials[1]!.opts.requestInit?.headers?.Authorization).toBe("Bearer tok-rotated");
  });

  it("a 401 mints a new token, re-dials, and retries once", async () => {
    let first = true;
    callBehaviour = (name) => {
      if (first) { first = false; throw Object.assign(new Error("Streamable HTTP error: 401"), { code: 401 }); }
      return { content: [{ type: "text", text: `ran ${name}` }] };
    };
    const r = await C.callConnectionTool("pd:gmail", "gmail-send-email", { to: "sam@x.co" }) as { content: Array<{ text: string }> };
    expect(r.content[0]!.text).toBe("ran gmail-send-email");
    expect(pdState.invalidated).toBe(1);
    expect(dials.map((d) => d.opts.requestInit?.headers?.Authorization)).toEqual(["Bearer tok-1", "Bearer tok-2"]);
  });

  it("an app with no connected account is refused before any dial", async () => {
    await expect(C.callConnectionTool("pd:slack", "slack-send", {})).rejects.toThrow(/no connected Pipedream account for "slack"/);
    expect(dials).toHaveLength(0);
  });

  it("there is something to lend once an app is connected, and nothing without", () => {
    expect(C.hasConnections()).toBe(true);
    pdState.apps = [];
    expect(C.hasConnections()).toBe(false);
  });
});

describe("tool permissions (conn-tool-modes)", () => {
  it("a Never tool is not listed and a call to it is refused; an explicit Always allow wins over the default", async () => {
    modes = { "pd:gmail": { "gmail-delete-email": "never", "gmail-send-email": "allow" } };
    const list = await C.listConnectionTools();
    expect(list.map((t) => [t.name, t.mode])).toEqual([["gmail-list-labels", "allow"], ["gmail-send-email", "allow"]]);
    await expect(C.callConnectionTool("pd:gmail", "gmail-delete-email", {})).rejects.toThrow(/set to Never/);
  });
});

describe("custom servers", () => {
  const row = (slug: string, over: Record<string, unknown> = {}) => ({
    slug, name: slug.toUpperCase(), url: `https://${slug}.example.com/mcp`, headerKeys: [], enabled: true, hiddenTools: [], createdAt: "2026-10-19", kind: "personal", iconUrl: null, ...over,
  });
  const save = (slug: string, r: unknown, secrets: unknown = {}): void => {
    mkdirSync(join(home, "connections"), { recursive: true });
    writeFileSync(join(home, "connections", `${slug}.json`), JSON.stringify(r));
    writeFileSync(join(home, "connections", `${slug}.secrets.json`), JSON.stringify(secrets));
  };

  it("dial with the OAuth client the user typed in", async () => {
    pdState.apps = [];
    save("crm", row("crm"), { oauth: { clientId: "typed-id", clientSecret: "typed-secret" } });
    await C.listConnectionTools();
    const info = dials[0]!.opts.authProvider!.clientInformation();
    expect(info?.client_id).toBe("typed-id");
    expect(info?.client_secret).toBe("typed-secret");
  });

  it("a row saved with the typed client as clientInformation (no redirect URIs) still dials with it", async () => {
    pdState.apps = [];
    save("old", row("old"), { clientInformation: { client_id: "legacy-id", redirect_uris: [] } });
    await C.listConnectionTools();
    expect(dials[0]!.opts.authProvider!.clientInformation()?.client_id).toBe("legacy-id");
  });

  it("are listed beside the Pipedream apps, keyed mcp:<slug> for their modes, hidden tools left out", async () => {
    save("crm", row("crm", { hiddenTools: ["gmail-list-labels"] }));
    save("off", row("off", { enabled: false }));
    modes = { "mcp:crm": { "gmail-send-email": "never" } };
    const list = await C.listConnectionTools();
    expect(list.filter((t) => t.connection === "crm").map((t) => t.name)).toEqual(["gmail-delete-email"]);
    expect(list.some((t) => t.connection === "off")).toBe(false);
    expect(list.filter((t) => t.connection === "pd:gmail")).toHaveLength(3);
    expect(C.connectionSources().map((s) => s.connection)).toEqual(["crm", "pd:gmail"]);
    expect(C.connModeKey("crm")).toBe("mcp:crm");
    expect(C.connModeKey("pd:gmail")).toBe("pd:gmail");
  });
});
