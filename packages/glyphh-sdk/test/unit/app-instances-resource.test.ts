/**
 * AppInstancesClient path mapping (the app platform contract, 2026-10-06):
 * every method hits the exact verb + path the server mounts under
 * /api/app-instances, keys URL-encoded, bodies verbatim. Deterministic with
 * recording stubs.
 */

import { describe, it, expect } from "vitest";
import { AppInstancesClient } from "../../src/resources/app-instances.js";
import { createClient } from "../../src/index.js";
import type { AuthedHttp } from "../../src/core/authed-http.js";

interface Call { method: string; path: string; body?: unknown }

function recorder(getReturn: unknown = {}) {
  const calls: Call[] = [];
  const stub = {
    get: async (path: string) => { calls.push({ method: "GET", path }); return getReturn as unknown; },
    post: async (path: string, body?: unknown) => { calls.push({ method: "POST", path, body }); return {} as unknown; },
    patch: async (path: string, body?: unknown) => { calls.push({ method: "PATCH", path, body }); return {} as unknown; },
    del: async (path: string) => { calls.push({ method: "DELETE", path }); return {} as unknown; },
  };
  return { calls, client: new AppInstancesClient(stub as unknown as AuthedHttp) };
}

describe("AppInstancesClient — the installed apps", () => {
  it("lists, installs a built bundle (create → ready), installs from the hub", async () => {
    const rows = [{ key: "notes~u1", slug: "notes", kind: "personal", release: 2 }];
    const { calls, client } = recorder(rows);
    expect(await client.list()).toEqual(rows);
    await client.create({ slug: "notes", kind: "personal", bundle: { sha256: "ab".repeat(32), sizeBytes: 1234 }, manifest: { name: "Notes" } });
    await client.ready("notes~u1");
    await client.ready("notes~u1", { note: "first" });
    await client.fromHub("11111111-1111-4111-8111-111111111111");
    expect(calls).toEqual([
      { method: "GET", path: "/api/app-instances" },
      { method: "POST", path: "/api/app-instances", body: { slug: "notes", kind: "personal", bundle: { sha256: "ab".repeat(32), sizeBytes: 1234 }, manifest: { name: "Notes" } } },
      { method: "POST", path: "/api/app-instances/notes~u1/ready", body: {} },
      { method: "POST", path: "/api/app-instances/notes~u1/ready", body: { note: "first" } },
      { method: "POST", path: "/api/app-instances/from-hub", body: { itemId: "11111111-1111-4111-8111-111111111111" } },
    ]);
  });

  it("releases + pin (rollback), builds from source (builds → run), invoke", async () => {
    const { calls, client } = recorder([]);
    await client.releases("notes");
    await client.pin("notes", 1);
    await client.builds("notes");
    await client.runBuild("notes", 3);
    await client.runBuild("notes", 3, { note: "fix the cron" });
    await client.invoke("notes", "add_note", { text: "hi" });
    await client.invoke("notes", "list_notes");
    expect(calls).toEqual([
      { method: "GET", path: "/api/app-instances/notes/releases" },
      { method: "POST", path: "/api/app-instances/notes/pin", body: { n: 1 } },
      { method: "POST", path: "/api/app-instances/notes/builds", body: {} },
      { method: "POST", path: "/api/app-instances/notes/builds/3/run", body: {} },
      { method: "POST", path: "/api/app-instances/notes/builds/3/run", body: { note: "fix the cron" } },
      { method: "POST", path: "/api/app-instances/notes/invoke", body: { tool: "add_note", args: { text: "hi" } } },
      { method: "POST", path: "/api/app-instances/notes/invoke", body: { tool: "list_notes", args: {} } },
    ]);
  });

  it("patches (access, members, public, connection, secrets, embed model) and removes; keys are encoded", async () => {
    const { calls, client } = recorder();
    await client.patch("we ird/key", { access: "restricted", members: ["u1"], public: false, orgConnectionId: null });
    await client.patch("notes", { secrets: { API_KEY: "k", OLD: null }, embedModel: "text-embedding-3-large" });
    await client.remove("notes~u1");
    expect(calls).toEqual([
      { method: "PATCH", path: "/api/app-instances/we%20ird%2Fkey", body: { access: "restricted", members: ["u1"], public: false, orgConnectionId: null } },
      { method: "PATCH", path: "/api/app-instances/notes", body: { secrets: { API_KEY: "k", OLD: null }, embedModel: "text-embedding-3-large" } },
      { method: "DELETE", path: "/api/app-instances/notes~u1" },
    ]);
  });

  it("hangs off the Client as appInstances; apps / hosting / appServers are gone", () => {
    const client = createClient({ url: "http://127.0.0.1:3001" }) as unknown as Record<string, unknown>;
    expect(client.appInstances).toBeInstanceOf(AppInstancesClient);
    expect(client.apps).toBeUndefined();
    expect(client.hosting).toBeUndefined();
    expect(client.appServers).toBeUndefined();
  });
});
