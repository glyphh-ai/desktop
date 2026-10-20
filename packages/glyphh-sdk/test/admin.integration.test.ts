/**
 * Admin ↔ live control plane. The console is super_admin-only; a normal user's
 * createOrg surfaces as a ForbiddenError (403) — proving the typed method + the
 * server's role gate are wired. The super_admin happy path is covered server-side.
 * Needs the server on :3001.
 */

import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { createClient, ForbiddenError } from "../src/index.js";

const url = process.env.GLYPHH_SERVER_URL ?? "http://127.0.0.1:3001";

async function signIn() {
  const client = createClient({ url });
  const start = await client.auth.startEmailLink(`admin-${randomUUID()}@example.com`);
  await client.auth.verifyEmailLink(start.devToken!);
  return client;
}

describe("@glyphh/sdk — admin.createOrg", () => {
  it("is forbidden for a non-super_admin", async () => {
    const client = await signIn();
    await expect(client.admin.createOrg({ name: "Globex" })).rejects.toBeInstanceOf(ForbiddenError);
  });
});

describe("@glyphh/sdk — admin impersonation gate", () => {
  it("impersonate is forbidden for a non-platform-admin", async () => {
    const client = await signIn();
    await expect(client.admin.impersonate(randomUUID())).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("stopImpersonate is auth-only — a normal user gets their own (non-impersonating) scope", async () => {
    const client = await signIn();
    const me = await client.me();
    const ctx = await client.admin.stopImpersonate();
    expect(ctx).toMatchObject({ orgId: me.orgId, isPlatformAdmin: false, impersonating: null });
  });
});

describe("@glyphh/sdk — admin org-plan gate (super_admin)", () => {
  it("setOrgPlan is forbidden for a non-platform-admin", async () => {
    const client = await signIn();
    await expect(
      client.admin.setOrgPlan(randomUUID(), { maxSeats: 10, monthlyUsdCents: 5000, displayName: "Bespoke" }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("updateOrgPlan is forbidden for a non-platform-admin", async () => {
    const client = await signIn();
    await expect(client.admin.updateOrgPlan(randomUUID(), { maxSeats: 20 })).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("removeOrgPlan is forbidden for a non-platform-admin", async () => {
    const client = await signIn();
    await expect(client.admin.removeOrgPlan(randomUUID())).rejects.toBeInstanceOf(ForbiddenError);
  });
});

describe("@glyphh/sdk — admin plan-price gate (super_admin)", () => {
  it("planPrices read is forbidden for a non-platform-admin", async () => {
    const client = await signIn();
    await expect(client.admin.planPrices("pro")).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("addPlanPrice is forbidden for a non-platform-admin", async () => {
    const client = await signIn();
    await expect(client.admin.addPlanPrice("pro", "price_x")).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("activatePlanPrice is forbidden for a non-platform-admin", async () => {
    const client = await signIn();
    await expect(client.admin.activatePlanPrice(randomUUID())).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("removePlanPrice is forbidden for a non-platform-admin", async () => {
    const client = await signIn();
    await expect(client.admin.removePlanPrice(randomUUID())).rejects.toBeInstanceOf(ForbiddenError);
  });
});
