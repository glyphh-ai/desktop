/**
 * Relay ↔ live control plane. A fresh org is OPEN by default; the user (org_admin of
 * their personal org) opts a device in, sees it, revokes it, then closes the org policy
 * and confirms opt-in is refused. Needs the server on :3001.
 */

import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { createClient, type Client } from "../src/index.js";

const url = process.env.GLYPHH_SERVER_URL ?? "http://127.0.0.1:3001";

async function signIn(): Promise<Client> {
  const client = createClient({ url });
  const start = await client.auth.startEmailLink(`relay-${randomUUID()}@example.com`);
  await client.auth.verifyEmailLink(start.devToken!);
  return client;
}

describe("@glyphh/sdk — relay", () => {
  it("open by default → opt-in a device → revoke", async () => {
    const client = await signIn();

    const status0 = await client.relay.status();
    expect(status0.orgEnabled).toBe(true); // default-open
    expect(status0.devices).toEqual([]);

    const device = await client.relay.enable("work-laptop");
    expect(device.label).toBe("work-laptop");
    expect(device.status).toBe("active");

    const status1 = await client.relay.status();
    expect(status1.devices.some((d) => d.id === device.id)).toBe(true);

    await client.relay.disable(device.id);
    const status2 = await client.relay.status();
    const still = status2.devices.find((d) => d.id === device.id);
    expect(still?.status ?? "revoked").not.toBe("active");
  });

  it("closing the org policy refuses new opt-ins", async () => {
    const client = await signIn();

    const closed = await client.relay.setPolicy(false);
    expect(closed.orgEnabled).toBe(false);
    await expect(client.relay.enable("blocked")).rejects.toMatchObject({ code: "E_FAILED_PRECONDITION" });

    // Re-open and it works again.
    await client.relay.setPolicy(true);
    const device = await client.relay.enable("reopened");
    expect(device.status).toBe("active");
  });
});
