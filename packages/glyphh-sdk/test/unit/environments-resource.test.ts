/**
 * EnvironmentsClient path mapping (his direction, 2026-10-05: personal environments):
 * the lane hits the exact method + path the server mounts, ids URL-encoded, the
 * input bodies passed verbatim; and client.run carries `environmentId` in the
 * harness body for a CLOUD turn only. Deterministic with recording stubs.
 */

import { describe, it, expect } from "vitest";
import { EnvironmentsClient } from "../../src/resources/environments.js";
import { DEFAULT_ENVIRONMENT_ID, ENVIRONMENT_NETWORKS, ENVIRONMENT_NETWORK_LABELS } from "../../src/contract/environments.js";
import { createClient } from "../../src/index.js";
import type { AuthedHttp } from "../../src/core/authed-http.js";

interface Call { method: string; path: string; body?: unknown }

function recorder(getReturn: unknown = {}) {
  const calls: Call[] = [];
  const stub = {
    get: async (path: string) => { calls.push({ method: "GET", path }); return getReturn as unknown; },
    post: async (path: string, body?: unknown) => { calls.push({ method: "POST", path, body }); return {} as unknown; },
    put: async (path: string, body?: unknown) => { calls.push({ method: "PUT", path, body }); return {} as unknown; },
    del: async (path: string) => { calls.push({ method: "DELETE", path }); return {} as unknown; },
  };
  return { calls, client: new EnvironmentsClient(stub as unknown as AuthedHttp) };
}

describe("EnvironmentsClient — the member's named environments", () => {
  it("lists and gets, the id URL-encoded, Default by its reserved id", async () => {
    const rows = [{ id: "e1", name: "Staging", network: "trusted", varCount: 2, createdAt: "2026-10-05T09:00:00Z", updatedAt: "2026-10-05T09:00:00Z" }];
    const { calls, client } = recorder(rows);
    expect(await client.list()).toEqual(rows);
    await client.get("e1");
    await client.get(DEFAULT_ENVIRONMENT_ID);
    await client.get("we ird/../x");
    expect(calls).toEqual([
      { method: "GET", path: "/api/environments" },
      { method: "GET", path: "/api/environments/e1" },
      { method: "GET", path: "/api/environments/default" },
      { method: "GET", path: "/api/environments/we%20ird%2F..%2Fx" },
    ]);
  });

  it("creates and updates with the input verbatim (vars is the .env text), deletes by id", async () => {
    const { calls, client } = recorder();
    await client.create({ name: "Staging", network: "none", vars: "API_KEY=hunter2\n" });
    await client.create({ name: "Bare" });
    await client.update("e1", { vars: "" });
    await client.update("e1", { name: "Prod", network: "full" });
    await client.delete("e1");
    expect(calls).toEqual([
      { method: "POST", path: "/api/environments", body: { name: "Staging", network: "none", vars: "API_KEY=hunter2\n" } },
      { method: "POST", path: "/api/environments", body: { name: "Bare" } },
      { method: "PUT", path: "/api/environments/e1", body: { vars: "" } },
      { method: "PUT", path: "/api/environments/e1", body: { name: "Prod", network: "full" } },
      { method: "DELETE", path: "/api/environments/e1" },
    ]);
  });

  it("names the three network policies and their labels, Default being the absent pick", () => {
    expect(ENVIRONMENT_NETWORKS).toEqual(["none", "trusted", "full"]);
    expect(ENVIRONMENT_NETWORK_LABELS).toEqual({ none: "No network access", trusted: "Trusted network access", full: "Full network access" });
    expect(DEFAULT_ENVIRONMENT_ID).toBe("default");
  });
});

describe("client.run — environmentId rides the harness body for a cloud turn", () => {
  function frontDoor() {
    const bodies: Array<{ path: string; body: unknown }> = [];
    const ac = new AbortController();
    const fetchImpl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const url = String(input);
      const path = new URL(url).pathname;
      if (path.endsWith("/api/harness/run")) {
        bodies.push({ path, body: JSON.parse(String(init?.body)) });
        ac.abort();
        return new Response(JSON.stringify({ runId: "r1", sessionId: "s1", wire: "glyphh.harness/v1" }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response(JSON.stringify({ frames: [] }), { status: 200, headers: { "content-type": "application/json" } });
    };
    const client = createClient({ url: "https://cp.test", apiKey: "sk-test", fetch: fetchImpl as unknown as typeof fetch });
    return { bodies, ac, client };
  }

  it("carries environmentId beside repo and branch, and leaves it out when absent", async () => {
    const a = frontDoor();
    const run = a.client.run({ target: "cloud", prompt: "hi", threadId: "t1", repo: "glyphh-ai/sdk", branch: "main", environmentId: "e1", signal: a.ac.signal });
    await run.done.catch(() => undefined);
    expect(a.bodies).toHaveLength(1);
    expect(a.bodies[0]!.body).toMatchObject({ prompt: "hi", threadId: "t1", repo: "glyphh-ai/sdk", branch: "main", environmentId: "e1" });

    const b = frontDoor();
    const bare = b.client.run({ target: "cloud", prompt: "hi", threadId: "t1", signal: b.ac.signal });
    await bare.done.catch(() => undefined);
    expect(b.bodies[0]!.body).not.toHaveProperty("environmentId");
    expect(b.bodies[0]!.body).not.toHaveProperty("env");
    expect(b.bodies[0]!.body).not.toHaveProperty("network");
  });
});
