/**
 * Device login ↔ live control plane. The headless flow: a fresh client starts a device
 * grant and polls; a separate signed-in "browser" approves the user code; the polling
 * client then adopts the session and is authenticated. Needs the server on :3001.
 */

import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { createClient, type Client, type DevicePrompt } from "../src/index.js";

const url = process.env.GLYPHH_SERVER_URL ?? "http://127.0.0.1:3001";

async function signIn(): Promise<Client> {
  const client = createClient({ url });
  const start = await client.auth.startEmailLink(`dev-${randomUUID()}@example.com`);
  await client.auth.verifyEmailLink(start.devToken!);
  return client;
}

describe("@glyphh/sdk — device login", () => {
  it("start → approve out-of-band → the SDK adopts the session", async () => {
    const approver = await signIn();
    const approverId = (await approver.me()).userId;

    const cli = createClient({ url });
    let resolvePrompt!: (p: DevicePrompt) => void;
    const promptSeen = new Promise<DevicePrompt>((r) => (resolvePrompt = r));
    const login = cli.auth.deviceLogin({ onPrompt: (p) => resolvePrompt(p) });

    const prompt = await promptSeen;
    expect(prompt.userCode).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
    expect(prompt.verificationUri).toContain("/device");

    // The signed-in browser approves the code.
    const res = await fetch(`${url}/api/auth/device/approve`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${await approver.token()}` },
      body: JSON.stringify({ userCode: prompt.userCode }),
    });
    expect(res.ok).toBe(true);

    const session = await login;
    expect(session.accessToken).toMatch(/^gy_at_/);
    expect((await cli.me()).userId).toBe(approverId);
  }, 20_000);
});
