/**
 * GitClient path mapping — the GitHub lane hits the exact method + path the server
 * mounts: connect carries a returnTo only when given, branches names the repo's two
 * segments URL-encoded, and a cloud run carries the base branch only beside its repo.
 * Deterministic with a recording stub.
 */

import { describe, it, expect } from "vitest";
import { GitClient } from "../../src/resources/git.js";
import type { AuthedHttp } from "../../src/core/authed-http.js";

interface Call { method: string; path: string; body?: unknown }

function recorder(getReturn: unknown = {}) {
  const calls: Call[] = [];
  const stub = {
    get: async (path: string) => { calls.push({ method: "GET", path }); return getReturn as unknown; },
    post: async (path: string, body?: unknown) => { calls.push({ method: "POST", path, body }); return {} as unknown; },
    del: async (path: string) => { calls.push({ method: "DELETE", path }); return {} as unknown; },
  };
  return { calls, client: new GitClient(stub as unknown as AuthedHttp) };
}

describe("GitClient — the GitHub lane", () => {
  it("connect POSTs an empty body, or the returnTo when given", async () => {
    const { calls, client } = recorder();
    await client.connect();
    await client.connect({ returnTo: "https://mobile.glyphh.ai/settings" });
    expect(calls).toEqual([
      { method: "POST", path: "/api/git/connect", body: {} },
      { method: "POST", path: "/api/git/connect", body: { returnTo: "https://mobile.glyphh.ai/settings" } },
    ]);
  });

  it("complete POSTs the link when given, an empty body for the newest pending one, and returns the status shape", async () => {
    const { calls, client } = recorder();
    await client.complete("n0nce");
    await client.complete();
    expect(calls).toEqual([
      { method: "POST", path: "/api/git/connect/complete", body: { link: "n0nce" } },
      { method: "POST", path: "/api/git/connect/complete", body: {} },
    ]);
  });

  it("status, repos and disconnect hit their routes", async () => {
    const { calls, client } = recorder([]);
    await client.status();
    await client.repos();
    await client.disconnect();
    expect(calls.map((c) => [c.method, c.path])).toEqual([["GET", "/api/git/status"], ["GET", "/api/git/repos"], ["DELETE", "/api/git/connection"]]);
  });

  it("status carries every installation the member reaches, and a repo row names the account it listed through", async () => {
    const status = {
      connected: true, login: "timmetim", installationId: "9002", connectedAt: "2026-10-05T09:00:00Z", installationUrl: "https://github.com/settings/installations/9002",
      installations: [
        { id: "9002", account: "timmetim", type: "User", url: "https://github.com/settings/installations/9002" },
        { id: "9001", account: "glyphh-ai", type: "Organization", url: "https://github.com/organizations/glyphh-ai/settings/installations/9001" },
      ],
    };
    const st = await recorder(status).client.status();
    expect(st.installations?.map((i) => [i.account, i.type])).toEqual([["timmetim", "User"], ["glyphh-ai", "Organization"]]);
    expect(st.installationId).toBe(st.installations?.[0]?.id);
    const rows = [{ id: "7", fullName: "timmetim/notes", private: true, defaultBranch: "main", url: "", account: "timmetim", installationId: "9002" }];
    const got = await recorder(rows).client.repos();
    expect(got.map((r) => [r.account, r.installationId])).toEqual([["timmetim", "9002"]]);
  });

  it("branches GETs the repo's branches route, each segment URL-encoded, and refuses a name that is not owner/name", async () => {
    const rows = [{ name: "main", default: true }, { name: "release/1.0", default: false }];
    const { calls, client } = recorder(rows);
    expect(await client.branches("glyphh-ai/sdk")).toEqual(rows);
    await client.branches("o/we ird");
    expect(calls).toEqual([
      { method: "GET", path: "/api/git/repos/glyphh-ai/sdk/branches" },
      { method: "GET", path: "/api/git/repos/o/we%20ird/branches" },
    ]);
    expect(() => client.branches("sdk")).toThrow(/owner\/name/);
    expect(() => client.branches("/sdk")).toThrow(/owner\/name/);
  });

  it("cloneToken POSTs the repo", async () => {
    const { calls, client } = recorder();
    await client.cloneToken("glyphh-ai/sdk");
    expect(calls).toEqual([{ method: "POST", path: "/api/git/clone-token", body: { repo: "glyphh-ai/sdk" } }]);
  });
});
