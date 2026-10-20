/**
 * MemberLibraryClient over a mocked fetch — the exact method, path, query and
 * body the v2 routes expect, the `{ data }` envelope unwrapped, a `{ error,
 * detail }` 404 as NotFoundError, the tombstone's clock riding the DELETE body,
 * and a 204 resolving to void.
 */

import { describe, it, expect } from "vitest";
import { HttpClient, type FetchLike } from "../../src/core/http.js";
import { AuthedHttp } from "../../src/core/authed-http.js";
import { NotFoundError } from "../../src/core/errors.js";
import { MemberLibraryClient } from "../../src/resources/member-library.js";
import type { MemberLibraryItem } from "../../src/contract/member-library.js";

interface Seen { method: string; url: string; bearer: string | null; body: unknown }

function harness(answer: (seen: Seen) => Response) {
  const calls: Seen[] = [];
  const fetchImpl: FetchLike = async (url, init) => {
    const seen: Seen = {
      method: init?.method ?? "GET",
      url: String(url),
      bearer: new Headers(init?.headers).get("authorization"),
      body: typeof init?.body === "string" ? JSON.parse(init.body) : null,
    };
    calls.push(seen);
    return answer(seen);
  };
  const http = new AuthedHttp(new HttpClient({ baseUrl: "http://x", fetchImpl }), async () => "tok");
  return { calls, client: new MemberLibraryClient(http) };
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const item: MemberLibraryItem<{ name: string }> = {
  kind: "skill", id: "s1", updatedAt: 10, deletedAt: null, createdAt: "2026-10-04T00:00:00.000Z",
  data: { name: "triage" }, files: [{ path: "SKILL.md", size: 12, mtime: 9, sha256: "ab" }],
};

describe("MemberLibraryClient", () => {
  it("list GETs /api/library/v2/<kind> with the bearer, no query without since", async () => {
    const rows = [{ kind: "skill", id: "s1", updatedAt: 10, deletedAt: null, data: { name: "triage" } }];
    const { calls, client } = harness(() => json(200, { data: rows }));
    expect(await client.list("skill")).toEqual(rows);
    expect(calls).toEqual([{ method: "GET", url: "http://x/api/library/v2/skill", bearer: "Bearer tok", body: null }]);
  });

  it("list carries since= and returns tombstones alongside live rows", async () => {
    const rows = [
      { kind: "tab", id: "t1", updatedAt: 20, deletedAt: null, data: {} },
      { kind: "tab", id: "t2", updatedAt: 21, deletedAt: "2026-10-04T00:00:00.000Z" },
    ];
    const { calls, client } = harness(() => json(200, { data: rows }));
    expect(await client.list("tab", { since: 15 })).toEqual(rows);
    expect(calls[0]!.url).toBe("http://x/api/library/v2/tab?since=15");
  });

  it("get GETs the item (id url-encoded) and unwraps the envelope", async () => {
    const { calls, client } = harness(() => json(200, { data: item }));
    expect(await client.get("skill", "a/b c")).toEqual(item);
    expect(calls[0]).toMatchObject({ method: "GET", url: "http://x/api/library/v2/skill/a%2Fb%20c" });
  });

  it("get maps a { error, detail } 404 to NotFoundError", async () => {
    const { client } = harness(() => json(404, { error: "not-found", detail: "no skill s9" }));
    const err = await client.get("skill", "s9").catch((e) => e);
    expect(err).toBeInstanceOf(NotFoundError);
    expect(err.code).toBe("not-found");
    expect(err.message).toBe("no skill s9");
  });

  it("put PUTs { data, files, updatedAt } and returns the verdict", async () => {
    const { calls, client } = harness(() => json(200, { data: { applied: true, item } }));
    const input = { data: { name: "triage" }, files: item.files, updatedAt: 10 };
    expect(await client.put("skill", "s1", input)).toEqual({ applied: true, item });
    expect(calls).toEqual([{ method: "PUT", url: "http://x/api/library/v2/skill/s1", bearer: "Bearer tok", body: input }]);
  });

  it("put passes a stale verdict through: applied:false with the stored item", async () => {
    const { client } = harness(() => json(200, { data: { applied: false, item } }));
    const out = await client.put("skill", "s1", { data: { name: "older" }, updatedAt: 5 });
    expect(out.applied).toBe(false);
    expect(out.item).toEqual(item);
  });

  it("remove DELETEs with the clock in the body and resolves void on 204", async () => {
    const { calls, client } = harness(() => new Response(null, { status: 204 }));
    expect(await client.remove("agent", "a1", { updatedAt: 42 })).toBeUndefined();
    expect(calls).toEqual([{ method: "DELETE", url: "http://x/api/library/v2/agent/a1", bearer: "Bearer tok", body: { updatedAt: 42 } }]);
  });

  it("remove without a clock sends an empty body (the server stamps now)", async () => {
    const { calls, client } = harness(() => new Response(null, { status: 204 }));
    await client.remove("workspace", "w1");
    expect(calls[0]!.body).toEqual({});
  });

  it("files POSTs the paths and returns the presigned put/get maps", async () => {
    const urls = { put: { "SKILL.md": "https://r2/put" }, get: { "SKILL.md": "https://r2/get" } };
    const { calls, client } = harness(() => json(200, { data: urls }));
    expect(await client.files("task", "k1", ["SKILL.md"])).toEqual(urls);
    expect(calls).toEqual([{ method: "POST", url: "http://x/api/library/v2/task/k1/files", bearer: "Bearer tok", body: { paths: ["SKILL.md"] } }]);
  });
});
