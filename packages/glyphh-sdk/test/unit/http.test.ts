/**
 * HttpClient unit tests — deterministic with an injected fake fetch. Covers the
 * envelope unwrap, error-envelope → typed SdkError mapping, bearer injection,
 * timeout → ConnectError, and a network throw → ConnectError.
 */

import { describe, it, expect } from "vitest";
import { HttpClient, type FetchLike } from "../../src/core/http.js";
import { AuthError, ForbiddenError, ValidationError, NotFoundError, ApiError, ConnectError } from "../../src/core/errors.js";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(body === undefined ? "" : JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("HttpClient", () => {
  it("unwraps the { data } success envelope", async () => {
    const fetchImpl: FetchLike = async () => jsonResponse(200, { data: { hello: "world" } });
    const http = new HttpClient({ baseUrl: "http://x", fetchImpl });
    expect(await http.get("/p")).toEqual({ hello: "world" });
  });

  it("injects the bearer header when provided", async () => {
    let seen: string | null = null;
    const fetchImpl: FetchLike = async (_url, init) => {
      seen = new Headers(init?.headers).get("authorization");
      return jsonResponse(200, { data: true });
    };
    const http = new HttpClient({ baseUrl: "http://x", fetchImpl });
    await http.post("/p", { a: 1 }, { bearer: "tok123" });
    expect(seen).toBe("Bearer tok123");
  });

  it("maps error envelopes to the right SdkError subclass", async () => {
    const cases: [number, string, typeof ApiError][] = [
      [401, "E_UNAUTHENTICATED", AuthError],
      [403, "E_FORBIDDEN", ForbiddenError],
      [400, "E_VALIDATION", ValidationError],
      [404, "E_NOT_FOUND", NotFoundError],
      [500, "E_INTERNAL", ApiError],
    ];
    for (const [status, code, Cls] of cases) {
      const fetchImpl: FetchLike = async () => jsonResponse(status, { error: { code, message: "x", remediation: "do y", requestId: "req_1" } });
      const http = new HttpClient({ baseUrl: "http://x", fetchImpl });
      const err = (await http.post("/p").catch((e) => e)) as ApiError;
      expect(err).toBeInstanceOf(Cls);
      expect(err.code).toBe(code);
      expect(err.httpStatus).toBe(status);
      expect(err.requestId).toBe("req_1");
    }
  });

  it("wraps a network throw as ConnectError", async () => {
    const fetchImpl: FetchLike = async () => {
      throw new TypeError("failed to fetch");
    };
    const http = new HttpClient({ baseUrl: "http://x", fetchImpl });
    await expect(http.get("/p")).rejects.toBeInstanceOf(ConnectError);
  });

  it("aborts and raises ConnectError after the timeout", async () => {
    const fetchImpl: FetchLike = (_url, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      });
    const http = new HttpClient({ baseUrl: "http://x", fetchImpl, timeoutMs: 20 });
    await expect(http.get("/slow")).rejects.toBeInstanceOf(ConnectError);
  });

  it("returns undefined for a 204/no-body response", async () => {
    const fetchImpl: FetchLike = async () => new Response(null, { status: 204 });
    const http = new HttpClient({ baseUrl: "http://x", fetchImpl });
    expect(await http.post("/p")).toBeUndefined();
  });

  it("decodes the flat { error, detail } envelope (harness + member-library routes)", async () => {
    const fetchImpl: FetchLike = async () => jsonResponse(404, { error: "not-found", detail: "no thread c1" });
    const http = new HttpClient({ baseUrl: "http://x", fetchImpl });
    const err = (await http.get("/p").catch((e) => e)) as ApiError;
    expect(err).toBeInstanceOf(NotFoundError);
    expect(err.code).toBe("not-found");
    expect(err.message).toBe("no thread c1");
    expect(err.httpStatus).toBe(404);
  });

  it("DELETE carries a JSON body when one is given, none otherwise", async () => {
    const seen: { body: unknown; type: string | null }[] = [];
    const fetchImpl: FetchLike = async (_url, init) => {
      seen.push({ body: init?.body ?? null, type: new Headers(init?.headers).get("content-type") });
      return new Response(null, { status: 204 });
    };
    const http = new HttpClient({ baseUrl: "http://x", fetchImpl });
    expect(await http.del("/p", { updatedAt: 5 })).toBeUndefined();
    expect(await http.del("/p")).toBeUndefined();
    expect(seen).toEqual([
      { body: JSON.stringify({ updatedAt: 5 }), type: "application/json" },
      { body: null, type: null },
    ]);
  });
});
