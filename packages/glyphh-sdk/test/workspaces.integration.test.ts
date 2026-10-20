/**
 * Workspaces (governance) ↔ live control plane. Base workspace on signup, CRUD, and
 * the admin's effective grants (= all). Needs the server on :3001.
 */

import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { createClient, type Client } from "../src/index.js";

const url = process.env.GLYPHH_SERVER_URL ?? "http://127.0.0.1:3001";

async function signIn(): Promise<Client> {
  const client = createClient({ url });
  const start = await client.auth.startEmailLink(`ws-${randomUUID()}@example.com`);
  await client.auth.verifyEmailLink(start.devToken!);
  return client;
}

describe("@glyphh/sdk — workspaces", () => {
  it("signup creates one base workspace", async () => {
    const client = await signIn();
    const list = await client.workspaces.list();
    expect(list).toHaveLength(1);
    expect(list[0]!.isBase).toBe(true);
  });

  it("create → update → delete a non-base workspace", async () => {
    const client = await signIn();
    const created = await client.workspaces.create({ name: "Sales", limitModels: true, allowedModels: ["anthropic::opus"] });
    expect(created.name).toBe("Sales");
    expect(created.limitModels).toBe(true);
    expect(created.allowedModels).toEqual(["anthropic::opus"]);
    expect(created.isBase).toBe(false);

    const updated = await client.workspaces.update(created.id, { allowCustomMcp: false, budgetUsd: 50 });
    expect(updated.allowCustomMcp).toBe(false);
    expect(updated.budgetUsd).toBe(50);

    await client.workspaces.delete(created.id);
    expect((await client.workspaces.list()).some((w) => w.id === created.id)).toBe(false);
  });

  it("the base workspace cannot be deleted", async () => {
    const client = await signIn();
    const base = (await client.workspaces.list()).find((w) => w.isBase)!;
    await expect(client.workspaces.delete(base.id)).rejects.toMatchObject({ httpStatus: 409 });
  });

  it("allowedConnectionTools round-trips through create + update (defaults to {})", async () => {
    const client = await signIn();
    const base = (await client.workspaces.list()).find((w) => w.isBase)!;
    expect(base.allowedConnectionTools).toEqual({});

    const created = await client.workspaces.create({
      name: "Scoped",
      limitConnections: true,
      allowedConnections: ["mcp-billing"],
      allowedConnectionTools: { "mcp-billing": ["read_invoice"] },
    });
    try {
      expect(created.allowedConnectionTools).toEqual({ "mcp-billing": ["read_invoice"] });

      const updated = await client.workspaces.update(created.id, {
        allowedConnectionTools: { "mcp-billing": [] },
      });
      expect(updated.allowedConnectionTools).toEqual({ "mcp-billing": [] });
    } finally {
      await client.workspaces.delete(created.id);
    }
  });

  it("an org_admin's effective grants are unlimited (all)", async () => {
    const client = await signIn();
    const grants = await client.workspaces.grants();
    expect(grants.models).toBe("all");
    expect(grants.connections).toBe("all");
    expect(grants.apps).toBe("all");
  });
});
