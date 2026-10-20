/**
 * Usage ↔ live control plane. A new user has zero usage, and the rollups return the
 * uniform summary shape. (Ingest is service-gated + exercised server-side.) Needs :3001.
 */

import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { createClient, type Client } from "../src/index.js";

const url = process.env.GLYPHH_SERVER_URL ?? "http://127.0.0.1:3001";

async function signIn(): Promise<Client> {
  const client = createClient({ url });
  const start = await client.auth.startEmailLink(`use-${randomUUID()}@example.com`);
  await client.auth.verifyEmailLink(start.devToken!);
  return client;
}

describe("@glyphh/sdk — usage", () => {
  it("a new user's usage rolls up to zero with the summary shape", async () => {
    const mine = await (await signIn()).usage.mine();
    expect(mine.usd).toBe(0);
    expect(mine.bySource.pipedream).toBe(0);
    expect(mine.bySource).toEqual({ fly: 0, pipedream: 0, provider: 0 });
    expect(mine.events).toBe(0);
  });

  it("the org rollup is available to the org_admin", async () => {
    const org = await (await signIn()).usage.org();
    expect(org.usd).toBe(0);
    expect(typeof org.events).toBe("number");
  });
});
