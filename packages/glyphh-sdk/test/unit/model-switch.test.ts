/**
 * model-switch.test.ts — `sessions.recordModelSwitch` targets the session-AGNOSTIC
 * `POST /api/models/switch` (not the retired `/api/sessions/:id/model`). Uses an
 * injected fake fetch so it's deterministic and asserts the URL + that the free-form
 * `sessionId` travels in the BODY — so a LOCAL run's ephemeral id (e.g. `cli-…`)
 * audits without a provisioned session.
 */

import { describe, it, expect } from "vitest";
import { createClient } from "../../src/index.js";
import type { FetchLike } from "../../src/core/http.js";

describe("sessions.recordModelSwitch", () => {
  it("POSTs to /api/models/switch with the free-form sessionId in the body", async () => {
    let url = "";
    let method = "";
    let body: Record<string, unknown> = {};
    const fetchImpl: FetchLike = async (u, init) => {
      url = String(u);
      method = init?.method ?? "GET";
      body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
      return new Response(
        JSON.stringify({ data: { sessionId: body.sessionId, from: body.from ?? null, to: body.to, surface: body.surface } }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };

    const client = createClient({ url: "http://cp.test", apiKey: "gy_ak_test", fetch: fetchImpl });
    const res = await client.sessions.recordModelSwitch({
      sessionId: "cli-1700000000-4242", // an ephemeral LOCAL id, not a provisioned UUID
      rotorSlug: "base",
      role: "assistant",
      from: "anthropic::claude-opus-4-8",
      to: "anthropic::claude-haiku-4-5-20251001",
      surface: "cli",
    });

    expect(method).toBe("POST");
    expect(url).toBe("http://cp.test/api/models/switch"); // the new endpoint, not /api/sessions/:id/model
    expect(url).not.toContain("/api/sessions/");
    expect(body.sessionId).toBe("cli-1700000000-4242"); // free-form id rides in the body
    expect(body.to).toBe("anthropic::claude-haiku-4-5-20251001");
    expect(res).toMatchObject({ sessionId: "cli-1700000000-4242", surface: "cli" });
  });
});
