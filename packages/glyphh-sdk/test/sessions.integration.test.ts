/**
 * Sessions ↔ live control plane. Provision a runtime (LocalProvisioner in dev),
 * receive a one-time `gy_rk_` runtime token + a ready `runtimeUrl`, see it in the
 * list, then deprovision. Needs the server on :3001.
 */

import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { createClient, type Client } from "../src/index.js";

const url = process.env.GLYPHH_SERVER_URL ?? "http://127.0.0.1:3001";

async function signIn(): Promise<Client> {
  const client = createClient({ url });
  const start = await client.auth.startEmailLink(`sess-${randomUUID()}@example.com`);
  await client.auth.verifyEmailLink(start.devToken!);
  return client;
}

describe("@glyphh/sdk — sessions", () => {
  it("provisions a runtime, lists it, and deprovisions", async () => {
    const client = await signIn();

    const { session, runtimeToken } = await client.sessions.create({ rotor: "default" });
    expect(session.status).toBe("ready");
    expect(session.rotor).toBe("default");
    expect(session.runtimeUrl).toBeTruthy();
    expect(runtimeToken).toMatch(/^gy_rk_/);

    const listed = await client.sessions.list();
    expect(listed.some((s) => s.id === session.id)).toBe(true);
    // The token is never echoed back on reads.
    expect(JSON.stringify(listed)).not.toContain(runtimeToken);

    const got = await client.sessions.get(session.id);
    expect(got.id).toBe(session.id);

    await client.sessions.delete(session.id);
    // After deprovision it is gone or stopped — either way not "ready".
    const after = await client.sessions.list();
    const still = after.find((s) => s.id === session.id);
    expect(still?.status ?? "stopped").not.toBe("ready");
  });
});

describe("@glyphh/sdk — session threads (LWW cache sync)", () => {
  it("pushes a client-minted thread, lists metadata, reads messages, rejects stale, tombstones", async () => {
    const client = await signIn();
    // The app's newChat id shape: c<ts36> (not a uuid).
    const id = `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    const t0 = Date.now() - 60_000;
    const t1 = Date.now() - 30_000;

    // Create via push (the pendingPush drain path — unknown id creates). Messages
    // are CodeMsg objects, stored verbatim; clocks are epoch ms.
    const created = await client.sessions.pushThread(id, {
      title: "first", mode: "code", source: { kind: "repo", repo: "glyphh-ai/sdk" }, updatedAt: t1,
      messages: [
        { role: "user", text: "hello", at: t0 },
        { role: "assistant", text: "hi", at: t0 + 1, kind: "answer" },
      ],
    });
    expect(created.applied).toBe(true);
    expect(created.thread).toMatchObject({ id, title: "first", mode: "code", messageCount: 2, updatedAt: t1 });

    // List: metadata only, no message bodies.
    const listed = await client.sessions.threads();
    const meta = listed.find((t) => t.id === id);
    expect(meta?.messageCount).toBe(2);
    expect(JSON.stringify(listed)).not.toContain("hello");

    // Read: full thread, CodeMsg round-trips verbatim, in order.
    const full = await client.sessions.thread(id);
    expect(full.messages).toEqual([
      { role: "user", text: "hello", at: t0 },
      { role: "assistant", text: "hi", at: t0 + 1, kind: "answer" },
    ]);

    // A STALE push (older clock) is rejected and reports the server's state.
    const stale = await client.sessions.pushThread(id, { title: "old-news", updatedAt: t0 });
    expect(stale.applied).toBe(false);
    expect(stale.thread.title).toBe("first");

    // Tombstone: gone from list/read; a stale push cannot resurrect it.
    await client.sessions.deleteThread(id);
    expect((await client.sessions.threads()).some((t) => t.id === id)).toBe(false);
    await expect(client.sessions.thread(id)).rejects.toMatchObject({ code: "E_NOT_FOUND" });
    const zombie = await client.sessions.pushThread(id, { title: "zombie", updatedAt: t1 });
    expect(zombie.applied).toBe(false);
    await expect(client.sessions.thread(id)).rejects.toMatchObject({ code: "E_NOT_FOUND" });
  });
});
