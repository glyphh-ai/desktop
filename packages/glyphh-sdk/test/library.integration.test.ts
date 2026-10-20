/**
 * Library ↔ live control plane. Personal + org CRUD over the uniform library surface,
 * exercised through two kinds (rotors, skills). A fresh user is org_admin of their
 * personal org, so can save org-scoped items too. Needs the server on :3001.
 */

import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { createClient, type Client } from "../src/index.js";

const url = process.env.GLYPHH_SERVER_URL ?? "http://127.0.0.1:3001";

async function signIn(): Promise<Client> {
  const client = createClient({ url });
  const start = await client.auth.startEmailLink(`lib-${randomUUID()}@example.com`);
  await client.auth.verifyEmailLink(start.devToken!);
  return client;
}

describe("@glyphh/sdk — library", () => {
  it("personal rotor: save → list → get → update → delete", async () => {
    const client = await signIn();

    const saved = await client.rotors.save({ name: "my-loop", data: { steps: 3 } });
    expect(saved.scope).toBe("personal");
    expect(saved.ownerUserId).toBeTruthy();
    expect(saved.kind).toBe("rotor");

    expect((await client.rotors.list()).some((r) => r.id === saved.id)).toBe(true);
    expect((await client.rotors.get(saved.id)).name).toBe("my-loop");

    const updated = await client.rotors.save({ id: saved.id, name: "my-loop", data: { steps: 5 } });
    expect(updated.id).toBe(saved.id);
    expect((updated.data as { steps: number }).steps).toBe(5);

    await client.rotors.delete(saved.id);
    expect((await client.rotors.list()).some((r) => r.id === saved.id)).toBe(false);
  });

  it("org-scoped item is shared (author is org_admin)", async () => {
    const client = await signIn();
    const item = await client.drips.save({ name: "shared-agent", data: {}, scope: "org" });
    expect(item.scope).toBe("org");
    expect(item.ownerUserId).toBeNull();
    expect((await client.drips.list()).some((s) => s.id === item.id)).toBe(true);
  });

  it("a duplicate name within a kind is a conflict", async () => {
    const client = await signIn();
    await client.drips.save({ name: "dup", data: {} });
    await expect(client.drips.save({ name: "dup", data: {} })).rejects.toMatchObject({ code: "E_CONFLICT" });
    // The same name under a different kind is fine.
    const ok = await client.layouts.save({ name: "dup", data: {} });
    expect(ok.name).toBe("dup");
  });
});
