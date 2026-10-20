/**
 * ArtifactsClient path mapping (his direction, 2026-10-05: artifacts like
 * Claude's): every method hits the exact verb + path the server mounts, ids
 * URL-encoded, bodies verbatim, the bytes read raw; and the comments lane under
 * it. Deterministic with recording stubs.
 */

import { describe, it, expect } from "vitest";
import { ArtifactsClient } from "../../src/resources/artifacts.js";
import { ARTIFACT_ACCESSES, ARTIFACT_SIZE_CAP } from "../../src/contract/artifacts.js";
import { createClient } from "../../src/index.js";
import type { AuthedHttp } from "../../src/core/authed-http.js";

interface Call { method: string; path: string; body?: unknown }

function recorder(getReturn: unknown = {}) {
  const calls: Call[] = [];
  const bytes = new TextEncoder().encode("<h1>hi</h1>").buffer;
  const stub = {
    get: async (path: string) => { calls.push({ method: "GET", path }); return getReturn as unknown; },
    getBytes: async (path: string) => { calls.push({ method: "GET bytes", path }); return bytes; },
    post: async (path: string, body?: unknown) => { calls.push({ method: "POST", path, body }); return {} as unknown; },
    put: async (path: string, body?: unknown) => { calls.push({ method: "PUT", path, body }); return {} as unknown; },
    patch: async (path: string, body?: unknown) => { calls.push({ method: "PATCH", path, body }); return {} as unknown; },
    del: async (path: string) => { calls.push({ method: "DELETE", path }); return {} as unknown; },
  };
  return { calls, bytes, client: new ArtifactsClient(stub as unknown as AuthedHttp) };
}

describe("ArtifactsClient — the member's artifacts", () => {
  it("lists by scope (all by default), gets by id, reads the bytes raw", async () => {
    const rows = [{ id: "a1", name: "report.html", mime: "text/html", access: "private", mine: true, viewUrl: "https://app.test/a/a1" }];
    const { calls, bytes, client } = recorder(rows);
    expect(await client.list()).toEqual(rows);
    await client.list("shared");
    await client.get("we ird/../x");
    expect(await client.content("a1")).toBe(bytes);
    expect(calls).toEqual([
      { method: "GET", path: "/api/artifacts?scope=all" },
      { method: "GET", path: "/api/artifacts?scope=shared" },
      { method: "GET", path: "/api/artifacts/we%20ird%2F..%2Fx" },
      { method: "GET bytes", path: "/api/artifacts/a1/content" },
    ]);
  });

  it("publishes, renames, replaces the content in place, shares and deletes with the bodies verbatim", async () => {
    const { calls, client } = recorder();
    await client.create({ name: "report.html", text: "<h1>hi</h1>", sessionId: "t1" });
    await client.create({ name: "pic.png", mime: "image/png", content: "iVBORw0=" });
    await client.update("a1", { name: "Final.html" });
    await client.update("a1", { access: "public" });
    await client.update("a1", { text: "<h1>v2</h1>" });
    await client.update("a1", { content: "iVBORw0=", mime: "image/png", name: "chart.png" });
    await client.share("a1", "org");
    await client.remove("a1");
    expect(calls).toEqual([
      { method: "POST", path: "/api/artifacts", body: { name: "report.html", text: "<h1>hi</h1>", sessionId: "t1" } },
      { method: "POST", path: "/api/artifacts", body: { name: "pic.png", mime: "image/png", content: "iVBORw0=" } },
      { method: "PUT", path: "/api/artifacts/a1", body: { name: "Final.html" } },
      { method: "PUT", path: "/api/artifacts/a1", body: { access: "public" } },
      { method: "PUT", path: "/api/artifacts/a1", body: { text: "<h1>v2</h1>" } },
      { method: "PUT", path: "/api/artifacts/a1", body: { content: "iVBORw0=", mime: "image/png", name: "chart.png" } },
      { method: "POST", path: "/api/artifacts/a1/share", body: { access: "org" } },
      { method: "DELETE", path: "/api/artifacts/a1" },
    ]);
  });

  it("comments: list the threads, add one with a region or as a reply, resolve, remove", async () => {
    const { calls, client } = recorder([]);
    await client.comments.list("a1");
    await client.comments.add("a1", { text: "Look here", region: { x: 0.1, y: 0.2, w: 0.5, h: 0.1 } });
    await client.comments.add("a1", { text: "Fixed", parentId: "c1" });
    await client.comments.resolve("a1", "c1");
    await client.comments.resolve("a1", "c1", false);
    await client.comments.remove("a1", "c/2");
    expect(calls).toEqual([
      { method: "GET", path: "/api/artifacts/a1/comments" },
      { method: "POST", path: "/api/artifacts/a1/comments", body: { text: "Look here", region: { x: 0.1, y: 0.2, w: 0.5, h: 0.1 } } },
      { method: "POST", path: "/api/artifacts/a1/comments", body: { text: "Fixed", parentId: "c1" } },
      { method: "PATCH", path: "/api/artifacts/a1/comments/c1", body: { resolved: true } },
      { method: "PATCH", path: "/api/artifacts/a1/comments/c1", body: { resolved: false } },
      { method: "DELETE", path: "/api/artifacts/a1/comments/c%2F2" },
    ]);
  });

  it("names the three access levels and the size cap, and rides on the client", () => {
    expect(ARTIFACT_ACCESSES).toEqual(["private", "org", "public"]);
    expect(ARTIFACT_SIZE_CAP).toBe(25 * 1024 * 1024);
    const client = createClient({ url: "https://cp.test", apiKey: "sk-test" });
    expect(client.artifacts).toBeInstanceOf(ArtifactsClient);
    expect(typeof client.artifacts.comments.add).toBe("function");
  });
});
