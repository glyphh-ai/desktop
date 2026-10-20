/**
 * SDK auth ↔ control plane integration — drives @glyphh/sdk against a REAL
 * running server (docker: http://127.0.0.1:3001, or $GLYPHH_SERVER_URL), per the
 * SDK spec's "test against a real server" mandate. Proves the end-to-end magic-link
 * sign-in, the bearer supplier, proactive single-use rotation, and sign-out — the
 * exact loop mobile/desktop/CLI will run.
 */

import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { createClient, AuthError } from "../src/index.js";

const url = process.env.GLYPHH_SERVER_URL ?? "http://127.0.0.1:3001";
const email = () => `sdk-${randomUUID()}@example.com`;

/** Sign in via magic link (dev returns the token), return the client + session. */
async function signIn(overrides = {}) {
  const client = createClient({ url, ...overrides });
  const start = await client.auth.startEmailLink(email());
  // Dev/test hands back the token directly instead of dispatching a real email.
  expect(start.sent).toBe(false);
  const token = start.devToken;
  expect(token).toMatch(/^gy_ml_/);
  const session = await client.auth.verifyEmailLink(token!);
  return { client, session };
}

describe("@glyphh/sdk — auth", () => {
  it("magic-link sign-in yields a session and a live bearer", async () => {
    const { client, session } = await signIn();
    expect(session.accessToken).toMatch(/^gy_at_/);
    expect(session.expiresAt).toBeGreaterThan(Date.now());
    expect(await client.token()).toBe(session.accessToken);
  });

  it("proactively refreshes and rotates the session (single-use)", async () => {
    // A huge margin forces every accessToken() to refresh, exercising rotation.
    const { client, session } = await signIn({ refreshMarginMs: 10_000_000 });
    const t1 = await client.token();
    expect(t1).not.toBe(session.accessToken); // rotated
    const t2 = await client.token();
    expect(t2).not.toBe(t1); // rotated again — the prior refresh was single-use
  });

  it("surfaces an invalid magic token as an AuthError (401)", async () => {
    const client = createClient({ url });
    await expect(client.auth.verifyEmailLink("gy_ml_this-token-does-not-exist")).rejects.toBeInstanceOf(AuthError);
  });

  it("sign-out clears the session; the bearer supplier then refuses", async () => {
    const { client } = await signIn();
    await client.auth.signOut();
    await expect(client.token()).rejects.toThrow(/not authenticated/);
  });

  it("me() returns the authenticated identity (org_admin of a personal org)", async () => {
    const { client } = await signIn();
    const id = await client.me();
    expect(id.email).toMatch(/@example\.com$/);
    expect(id.role).toBe("org_admin"); // personal-org-on-signup
    expect(id.orgId).toBeTruthy();
    expect(id.userId).toBeTruthy();
  });

  it("a static API key is returned as-is without a session", async () => {
    const client = createClient({ url, apiKey: "gy_ak_example_key" });
    expect(await client.token()).toBe("gy_ak_example_key");
  });
});
