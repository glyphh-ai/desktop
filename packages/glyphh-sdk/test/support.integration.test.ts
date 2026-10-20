/**
 * Support ticket ↔ live control plane. The webhook is typically unconfigured in dev,
 * so the call degrades to NotFoundError; when configured it resolves { ok: true }.
 * Either way the typed method + envelope are exercised. Needs the server on :3001.
 */

import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { createClient, type Client } from "../src/index.js";

const url = process.env.GLYPHH_SERVER_URL ?? "http://127.0.0.1:3001";

async function signIn(): Promise<Client> {
  const client = createClient({ url });
  const start = await client.auth.startEmailLink(`support-${randomUUID()}@example.com`);
  await client.auth.verifyEmailLink(start.devToken!);
  return client;
}

describe("@glyphh/sdk — support", () => {
  it("ticket() resolves { ok } or degrades to E_NOT_FOUND when unconfigured", async () => {
    const client = await signIn();
    try {
      const ack = await client.support.ticket({ subject: "Test ticket", description: "From the SDK integration suite." });
      expect(ack.ok).toBe(true);
    } catch (e) {
      expect((e as { code?: string }).code).toBe("E_NOT_FOUND");
    }
  });
});
