/**
 * Connections ↔ live control plane. Custom MCP install/list/remove (write-only
 * headers) + the Pipedream-unconfigured path. Needs the server on :3001.
 */

import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { createClient, type Client } from "../src/index.js";

const url = process.env.GLYPHH_SERVER_URL ?? "http://127.0.0.1:3001";

async function signIn(): Promise<Client> {
  const client = createClient({ url });
  const start = await client.auth.startEmailLink(`conn-${randomUUID()}@example.com`);
  await client.auth.verifyEmailLink(start.devToken!);
  return client;
}

describe("@glyphh/sdk — connections", () => {
  it("install a custom MCP (write-only headers) → list → remove", async () => {
    const client = await signIn();
    expect(await client.connections.list()).toEqual([]);

    const conn = await client.connections.installCustomMcp({
      slug: "sfdc",
      name: "Salesforce",
      url: "https://mcp.example.com",
      headers: { Authorization: "Bearer super-secret-token" },
    });
    expect(conn.slug).toBe("mcp-sfdc"); // auto-prefixed
    expect(conn.kind).toBe("custom_mcp");
    expect(conn.hasCredentials).toBe(true);
    expect(JSON.stringify(conn)).not.toContain("super-secret");

    const list = await client.connections.list();
    expect(list.some((c) => c.slug === "mcp-sfdc")).toBe(true);

    await client.connections.removeCustomMcp("mcp-sfdc");
    expect(await client.connections.list()).toEqual([]);
  });

  it("Pipedream connect returns a hosted connect link (live-configured)", async () => {
    const { url } = await (await signIn()).connections.pipedreamConnectLink();
    expect(url).toMatch(/^https:\/\/pipedream\.com\//);
  });

  it("apps() searches the connector catalog and returns typed { apps } (degrades to [] when unconfigured)", async () => {
    const client = await signIn();
    const { apps } = await client.connections.apps({ search: "slack", limit: 5 });
    expect(Array.isArray(apps)).toBe(true);
    // Whether Pipedream is live-configured or not, every row matches ConnectorApp.
    for (const a of apps) {
      expect(typeof a.id).toBe("string");
      expect(typeof a.name).toBe("string");
      expect(a.icon === null || typeof a.icon === "string").toBe(true);
    }
  });

  it("org custom-MCP catalog + appTools + org-shared Pipedream (rich surfaces)", async () => {
    const client = await signIn(); // a personal-org org_admin
    expect(await client.connections.orgMcpList()).toEqual([]);

    const created = await client.connections.orgMcpCreate({
      slug: "billing",
      name: "Internal Billing",
      url: "https://mcp.example.invalid/billing",
      headers: { Authorization: "Bearer sk-secret-value" },
    });
    // Reachability is best-effort (the endpoint is unreachable here), but it is saved
    // with the rich shape and the header VALUE never leaks — only the key name.
    expect(typeof created.ok).toBe("boolean");
    expect(created.connection.slug).toBe("mcp-billing");
    expect(created.connection.headerKeys).toEqual(["Authorization"]);
    expect(JSON.stringify(created)).not.toContain("sk-secret");

    expect((await client.connections.orgMcpList()).some((c) => c.slug === "mcp-billing")).toBe(true);

    const updated = await client.connections.orgMcpUpdate("mcp-billing", { name: "Billing v2", enabled: false });
    expect(updated.connection).toMatchObject({ name: "Billing v2", enabled: false });

    expect((await client.connections.orgMcpRemove("mcp-billing")).ok).toBe(true);
    expect(await client.connections.orgMcpList()).toEqual([]);

    // appTools — typed { tools } list.
    const { tools } = await client.connections.appTools("slack");
    expect(Array.isArray(tools)).toBe(true);

    // org-shared Pipedream — empty for a fresh org; disconnect 404s an unknown id.
    expect(await client.connections.pipedreamList()).toEqual([]);
    await expect(client.connections.pipedreamDisconnect(randomUUID())).rejects.toMatchObject({ httpStatus: 404 });
  });

  it("mcpTools (org_admin): degrades to [] for an unreachable connection; 404s an unknown slug", async () => {
    const client = await signIn(); // a personal-org org_admin
    await client.connections.orgMcpCreate({
      slug: "tools-probe",
      name: "Tools Probe",
      url: "https://mcp.example.invalid/probe",
      headers: { Authorization: "Bearer sk-secret-value" },
    });
    try {
      // The endpoint is unreachable here, so the best-effort probe degrades to an empty list.
      expect(await client.connections.mcpTools("mcp-tools-probe")).toEqual([]);
      await expect(client.connections.mcpTools("mcp-does-not-exist")).rejects.toMatchObject({ httpStatus: 404 });
    } finally {
      await client.connections.orgMcpRemove("mcp-tools-probe");
    }
  });

  it("resolvedTools returns the { connections } shape (empty for a fresh org)", async () => {
    const client = await signIn();
    const resolved = await client.connections.resolvedTools();
    expect(Array.isArray(resolved.connections)).toBe(true);
    expect(resolved.connections).toEqual([]);
  });

  it("startMcpOAuth (org_admin) 404s a connection the org doesn't own", async () => {
    const client = await signIn();
    await expect(client.connections.startMcpOAuth("mcp-nope")).rejects.toMatchObject({ httpStatus: 404 });
  });

  it("proxySend gates like runTool: an unreachable slug 404s, a bad url 400s", async () => {
    const client = await signIn();
    await expect(
      client.connections.proxySend({ slug: "gmail", url: "https://gmail.googleapis.com/upload/x", bodyBase64: "aGk=" }),
    ).rejects.toMatchObject({ httpStatus: 404 });
    await expect(
      client.connections.proxySend({ slug: "gmail", url: "http://gmail.googleapis.com/x", bodyBase64: "aGk=" }),
    ).rejects.toMatchObject({ httpStatus: 400 });
  });

  it("fetchFile gates like runTool: an unreachable slug 404s, a bad url 400s", async () => {
    const client = await signIn();
    // connection gate first — a slug the caller can't reach 404s
    await expect(
      client.connections.fetchFile({ slug: "google_drive", url: "https://www.googleapis.com/drive/v3/files/x?alt=media" }),
    ).rejects.toMatchObject({ httpStatus: 404 });
    // schema gate — an unparseable body 400s before any resolution
    await expect(
      client.connections.fetchFile({ slug: "", url: "https://x.example/f" }),
    ).rejects.toMatchObject({ httpStatus: 400 });
  });
});
