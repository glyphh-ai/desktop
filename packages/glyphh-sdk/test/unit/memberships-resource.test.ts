/**
 * MembershipsClient path mapping — orgs() reads the /api/me/orgs switcher list and
 * setActiveOrg() POSTs the scope change to /api/session/active-org with { orgId }.
 * Deterministic recording stub.
 */

import { describe, it, expect } from "vitest";
import { MembershipsClient } from "../../src/resources/memberships.js";
import type { AuthedHttp } from "../../src/core/authed-http.js";

interface Call { method: string; path: string; body?: unknown }

function recorder() {
  const calls: Call[] = [];
  const stub = {
    get: async (path: string) => { calls.push({ method: "GET", path }); return {} as unknown; },
    post: async (path: string, body?: unknown) => { calls.push({ method: "POST", path, body }); return {} as unknown; },
  };
  return { calls, client: new MembershipsClient(stub as unknown as AuthedHttp) };
}

describe("MembershipsClient", () => {
  it("orgs() GETs /api/me/orgs", async () => {
    const { calls, client } = recorder();
    await client.orgs();
    expect(calls).toEqual([{ method: "GET", path: "/api/me/orgs" }]);
  });

  it("setActiveOrg() POSTs { orgId } to /api/session/active-org", async () => {
    const { calls, client } = recorder();
    await client.setActiveOrg("org-1");
    expect(calls).toEqual([{ method: "POST", path: "/api/session/active-org", body: { orgId: "org-1" } }]);
  });
});
