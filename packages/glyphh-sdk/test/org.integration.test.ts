/**
 * Accounts (org/members) ↔ live control plane. Proves the personal-org-on-signup +
 * org read/update + member list flow end-to-end. Needs the server on :3001.
 */

import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { createClient } from "../src/index.js";

const url = process.env.GLYPHH_SERVER_URL ?? "http://127.0.0.1:3001";

async function signIn() {
  const client = createClient({ url });
  const start = await client.auth.startEmailLink(`org-${randomUUID()}@example.com`);
  await client.auth.verifyEmailLink(start.devToken!);
  return client;
}

describe("@glyphh/sdk — accounts", () => {
  it("a new user has a personal org (org_admin, 1 seat used of 1)", async () => {
    const client = await signIn();
    const org = await client.org.get();
    expect(org.name).toBeTruthy();
    expect(org.slug).toBeTruthy();
    expect(org.maxSeats).toBe(1);
    expect(org.seatsUsed).toBe(1);
    const me = await client.me();
    expect(me.role).toBe("org_admin");
    expect(me.orgId).toBe(org.id);
  });

  it("org_admin can update the org name", async () => {
    const client = await signIn();
    const renamed = await client.org.update({ name: "Renamed Org" });
    expect(renamed.name).toBe("Renamed Org");
    expect((await client.org.get()).name).toBe("Renamed Org");
  });

  it("member list returns the owner as org_admin", async () => {
    const client = await signIn();
    const members = await client.members.list();
    expect(members).toHaveLength(1);
    expect(members[0]!.role).toBe("org_admin");
  });

  it("inviting past the seat cap is refused (Free = 1 seat)", async () => {
    const client = await signIn();
    await expect(client.members.invite(`invitee-${randomUUID()}@example.com`)).rejects.toMatchObject({
      httpStatus: 402,
    });
  });

  it("member writes: updateProfile + setRole + assignWorkspace (on self, the sole member)", async () => {
    const client = await signIn();
    const me = await client.me();

    const named = await client.members.updateProfile(me.userId, { firstName: "Grace", lastName: "Hopper" });
    expect(named).toMatchObject({ userId: me.userId, name: "Grace Hopper" });

    const roled = await client.members.setRole(me.userId, "org_admin");
    expect(roled.role).toBe("org_admin");

    // Clear to the base workspace (null) — a no-op on the sole member, but exercises the route.
    const assigned = await client.members.assignWorkspace(me.userId, null);
    expect(assigned.userId).toBe(me.userId);
  });
});
