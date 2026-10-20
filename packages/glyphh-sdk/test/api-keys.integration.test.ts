/**
 * API keys ↔ live control plane. A minted `gy_ak_` token is shown once, then
 * authenticates the SDK headlessly (as `apiKey`) with no interactive session, and
 * revocation takes effect. Needs the server on :3001.
 */

import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { createClient, type Client } from "../src/index.js";

const url = process.env.GLYPHH_SERVER_URL ?? "http://127.0.0.1:3001";

async function signIn(): Promise<Client> {
  const client = createClient({ url });
  const start = await client.auth.startEmailLink(`key-${randomUUID()}@example.com`);
  await client.auth.verifyEmailLink(start.devToken!);
  return client;
}

describe("@glyphh/sdk — api keys", () => {
  it("mints a gy_ak_ token once, never re-exposing it", async () => {
    const client = await signIn();
    const created = await client.apiKeys.create({ label: "ci" });
    expect(created.token).toMatch(/^gy_ak_/);
    expect(created.key.prefix).toMatch(/^gy_ak_/);
    expect(created.key.prefix).not.toBe(created.token);

    const listed = await client.apiKeys.list();
    const mine = listed.find((k) => k.id === created.key.id)!;
    expect(mine.label).toBe("ci");
    // The list is metadata only — the raw token is nowhere in it.
    expect(JSON.stringify(listed)).not.toContain(created.token);
  });

  it("the key authenticates the SDK headlessly, and revocation ends that", async () => {
    const owner = await signIn();
    const me = await owner.me();
    const { token, key } = await owner.apiKeys.create({ label: "headless" });

    // A fresh client with NO session — only the api key.
    const headless = createClient({ url, apiKey: token });
    const who = await headless.me();
    expect(who.userId).toBe(me.userId);

    await owner.apiKeys.revoke(key.id);
    await expect(headless.me()).rejects.toThrow();
  });
});
