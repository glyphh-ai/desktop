/**
 * Git ↔ live control plane. A fresh user is unconnected; `connect` hands back a real
 * GitHub authorize URL to open. (The OAuth callback can't be completed headlessly, so
 * repo-listing of a connected account is covered by the server's unit tests with an
 * injected GitHub client.) Needs the server on :3001 with GH_* configured.
 */

import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { createClient, type Client } from "../src/index.js";

const url = process.env.GLYPHH_SERVER_URL ?? "http://127.0.0.1:3001";

async function signIn(): Promise<Client> {
  const client = createClient({ url });
  const start = await client.auth.startEmailLink(`git-${randomUUID()}@example.com`);
  await client.auth.verifyEmailLink(start.devToken!);
  return client;
}

describe("@glyphh/sdk — git", () => {
  it("a fresh user is unconnected and connect returns a GitHub authorize URL", async () => {
    const client = await signIn();

    const status = await client.git.status();
    expect(status.connected).toBe(false);

    const { url: authorizeUrl, state } = await client.git.connect();
    expect(authorizeUrl).toMatch(/^https:\/\/github\.com\/login\/oauth\/authorize/);
    expect(state).toBeTruthy();
  });
});
