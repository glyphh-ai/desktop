/**
 * Memberships ↔ live control plane. A new user has exactly one (personal) org they
 * own; orgs() lists it flagged active, and setActiveOrg() to it round-trips the
 * effective scope. Switching to an org you don't belong to is a ForbiddenError (403)
 * — that path is impersonation's, not the switcher's. Needs the server on :3001.
 */

import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { createClient, ForbiddenError, type Client } from "../src/index.js";

const url = process.env.GLYPHH_SERVER_URL ?? "http://127.0.0.1:3001";

async function signIn(): Promise<Client> {
  const client = createClient({ url });
  const start = await client.auth.startEmailLink(`memb-${randomUUID()}@example.com`);
  await client.auth.verifyEmailLink(start.devToken!);
  return client;
}

describe("@glyphh/sdk — memberships", () => {
  it("orgs() lists the caller's personal org, flagged active (org_admin)", async () => {
    const client = await signIn();
    const me = await client.me();
    const orgs = await client.memberships.orgs();
    expect(orgs).toHaveLength(1);
    expect(orgs[0]).toMatchObject({ orgId: me.orgId, role: "org_admin", active: true });
    expect(typeof orgs[0]!.orgName).toBe("string");
  });

  it("setActiveOrg() to your own org returns the effective scope", async () => {
    const client = await signIn();
    const me = await client.me();
    const ctx = await client.memberships.setActiveOrg(me.orgId!);
    expect(ctx).toMatchObject({ orgId: me.orgId, isPlatformAdmin: false, impersonating: null });
    expect(typeof ctx.role).toBe("string");
  });

  it("setActiveOrg() to an org you don't belong to is forbidden", async () => {
    const client = await signIn();
    await expect(client.memberships.setActiveOrg(randomUUID())).rejects.toBeInstanceOf(ForbiddenError);
  });
});
