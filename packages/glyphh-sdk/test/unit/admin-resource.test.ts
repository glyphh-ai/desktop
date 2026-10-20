/**
 * AdminClient path mapping — the super_admin catalog surface (createModel POSTs the
 * catalog wire shape; deleteModel DELETEs the (provider, model) route) hits the
 * exact HTTP method + path the server mounts. Deterministic with a recording stub.
 */

import { describe, it, expect } from "vitest";
import { AdminClient } from "../../src/resources/admin.js";
import type { AuthedHttp } from "../../src/core/authed-http.js";

interface Call { method: string; path: string; body?: unknown }

function recorder() {
  const calls: Call[] = [];
  const stub = {
    get: async (path: string) => { calls.push({ method: "GET", path }); return {} as unknown; },
    post: async (path: string, body?: unknown) => { calls.push({ method: "POST", path, body }); return {} as unknown; },
    patch: async (path: string, body?: unknown) => { calls.push({ method: "PATCH", path, body }); return {} as unknown; },
    put: async (path: string, body?: unknown) => { calls.push({ method: "PUT", path, body }); return {} as unknown; },
    del: async (path: string) => { calls.push({ method: "DELETE", path }); return undefined as unknown; },
  };
  return { calls, client: new AdminClient(stub as unknown as AuthedHttp) };
}

describe("AdminClient catalog mutations", () => {
  it("createModel POSTs the catalog wire shape to /api/admin/models", async () => {
    const { calls, client } = recorder();
    const input = { id: "acme::m1", providerSlug: "acme", name: "M1", kind: "proxied" as const, inputUsdPerMTok: 3, outputUsdPerMTok: 6 };
    await client.createModel(input);
    expect(calls).toEqual([{ method: "POST", path: "/api/admin/models", body: input }]);
  });

  it("deleteModel DELETEs the (provider, model) route, URL-encoded", async () => {
    const { calls, client } = recorder();
    await client.deleteModel("acme", "m/1");
    expect(calls).toEqual([{ method: "DELETE", path: "/api/admin/models/acme/m%2F1" }]);
  });

  it("createOrg POSTs { name, tier } to /api/admin/orgs", async () => {
    const { calls, client } = recorder();
    await client.createOrg({ name: "Globex", tier: "pro" });
    expect(calls).toEqual([{ method: "POST", path: "/api/admin/orgs", body: { name: "Globex", tier: "pro" } }]);
  });
});

describe("AdminClient per-org bespoke plans", () => {
  it("setOrgPlan POSTs the camelCase input to /api/admin/orgs/:orgId/plan", async () => {
    const { calls, client } = recorder();
    const input = { maxSeats: 50, monthlyUsdCents: 9900, displayName: "Globex Enterprise" };
    await client.setOrgPlan("org-9", input);
    expect(calls).toEqual([{ method: "POST", path: "/api/admin/orgs/org-9/plan", body: input }]);
  });

  it("updateOrgPlan PATCHes the org plan route", async () => {
    const { calls, client } = recorder();
    await client.updateOrgPlan("org-9", { maxSeats: 75 });
    expect(calls).toEqual([{ method: "PATCH", path: "/api/admin/orgs/org-9/plan", body: { maxSeats: 75 } }]);
  });

  it("removeOrgPlan DELETEs the org plan route, URL-encoded", async () => {
    const { calls, client } = recorder();
    await client.removeOrgPlan("org/9");
    expect(calls).toEqual([{ method: "DELETE", path: "/api/admin/orgs/org%2F9/plan" }]);
  });
});

describe("AdminClient plan-price history", () => {
  it("planPrices GETs the tier route, URL-encoded", async () => {
    const { calls, client } = recorder();
    await client.planPrices("pro");
    expect(calls).toEqual([{ method: "GET", path: "/api/admin/plans/pro/prices" }]);
  });

  it("addPlanPrice POSTs { stripePriceId } to the tier route", async () => {
    const { calls, client } = recorder();
    await client.addPlanPrice("pro", "price_123");
    expect(calls).toEqual([{ method: "POST", path: "/api/admin/plans/pro/prices", body: { stripePriceId: "price_123" } }]);
  });

  it("activatePlanPrice PATCHes /prices/:id/activate", async () => {
    const { calls, client } = recorder();
    await client.activatePlanPrice("pp1");
    expect(calls).toEqual([{ method: "PATCH", path: "/api/admin/plans/prices/pp1/activate", body: undefined }]);
  });

  it("removePlanPrice DELETEs /prices/:id", async () => {
    const { calls, client } = recorder();
    await client.removePlanPrice("pp1");
    expect(calls).toEqual([{ method: "DELETE", path: "/api/admin/plans/prices/pp1" }]);
  });
});

describe("AdminClient impersonation", () => {
  it("impersonate POSTs { orgId } to /api/admin/impersonate", async () => {
    const { calls, client } = recorder();
    await client.impersonate("org-9");
    expect(calls).toEqual([{ method: "POST", path: "/api/admin/impersonate", body: { orgId: "org-9" } }]);
  });

  it("stopImpersonate DELETEs /api/admin/impersonate", async () => {
    const { calls, client } = recorder();
    await client.stopImpersonate();
    expect(calls).toEqual([{ method: "DELETE", path: "/api/admin/impersonate" }]);
  });
});
