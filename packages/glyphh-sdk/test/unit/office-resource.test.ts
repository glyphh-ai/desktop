/**
 * OfficeSlidesClient path mapping — every call hits the exact method + path the
 * server mounts, with the deck name URL-encoded. Deterministic recording stub.
 */

import { describe, it, expect } from "vitest";
import { OfficeSlidesClient } from "../../src/resources/office.js";
import type { AuthedHttp } from "../../src/core/authed-http.js";

interface Call { method: string; path: string; body?: unknown }

function recorder() {
  const calls: Call[] = [];
  const stub = {
    get: async (path: string) => { calls.push({ method: "GET", path }); return {} as unknown; },
    put: async (path: string, body?: unknown) => { calls.push({ method: "PUT", path, body }); return {} as unknown; },
    del: async (path: string) => { calls.push({ method: "DELETE", path }); return undefined as unknown; },
  };
  return { calls, client: new OfficeSlidesClient(stub as unknown as AuthedHttp) };
}

describe("OfficeSlidesClient", () => {
  it("list GETs the library", async () => {
    const { calls, client } = recorder();
    await client.list();
    expect(calls).toEqual([{ method: "GET", path: "/api/office/slides" }]);
  });

  it("get GETs one deck by name, encoded", async () => {
    const { calls, client } = recorder();
    await client.get("q3 review.html");
    expect(calls).toEqual([{ method: "GET", path: "/api/office/slides/q3%20review.html" }]);
  });

  it("put PUTs the deck html by name", async () => {
    const { calls, client } = recorder();
    await client.put("pitch.html", "<html>deck</html>");
    expect(calls).toEqual([{ method: "PUT", path: "/api/office/slides/pitch.html", body: { html: "<html>deck</html>" } }]);
  });

  it("delete DELETEs by name", async () => {
    const { calls, client } = recorder();
    await client.delete("pitch.html");
    expect(calls).toEqual([{ method: "DELETE", path: "/api/office/slides/pitch.html" }]);
  });
});
