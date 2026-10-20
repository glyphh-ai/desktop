/**
 * Stored support ticketing ↔ live control plane. Exercises the caller's own threaded
 * flow end-to-end (open → list → thread → reply → mark-read → unread) and the admin
 * console's role gate (a normal user is Forbidden from every /admin/support route).
 *
 * The admin HAPPY path is covered server-side — here we only need the SDK method +
 * envelope + gate to be wired, mirroring admin.integration.test.ts.
 *
 * Throwaway tickets created by this suite are torn down in afterAll via a direct
 * Postgres connection (there is no delete endpoint); deleting a ticket cascades its
 * messages. Needs the server on :3001 and the dev Postgres (migration 032).
 */

import { describe, it, expect, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { Client as PgClient } from "pg";
import { createClient, ForbiddenError, type Client } from "../src/index.js";

const url = process.env.GLYPHH_SERVER_URL ?? "http://127.0.0.1:3001";
const databaseUrl = process.env.DATABASE_URL ?? "postgres://glyphh:glyphh@127.0.0.1:5432/glyphh";

/** Tickets opened by this suite; deleted (with their messages) in afterAll. */
const createdTicketIds: string[] = [];

async function signIn(): Promise<Client> {
  const client = createClient({ url });
  const start = await client.auth.startEmailLink(`support-tix-${randomUUID()}@example.com`);
  await client.auth.verifyEmailLink(start.devToken!);
  return client;
}

afterAll(async () => {
  if (createdTicketIds.length === 0) return;
  const pg = new PgClient({ connectionString: databaseUrl });
  try {
    await pg.connect();
    await pg.query(`DELETE FROM support_tickets WHERE id = ANY($1::uuid[])`, [createdTicketIds]);
  } catch (e) {
    // Best-effort: never fail the suite on cleanup (e.g. no DB in CI).
    console.warn("support-tickets cleanup skipped:", (e as Error).message);
  } finally {
    await pg.end().catch(() => {});
  }
});

describe("@glyphh/sdk — support tickets (user flow)", () => {
  it("opens, lists, reads, replies to, marks-read, and counts a ticket", async () => {
    const client = await signIn();

    // open
    const created = await client.support.createTicket({ subject: "Cannot reach runtime", message: "It 500s on connect." });
    createdTicketIds.push(created.id);
    expect(created.id).toBeTruthy();
    expect(created.subject).toBe("Cannot reach runtime");
    expect(created.status).toBe("open");
    expect(created.messages).toHaveLength(1);
    expect(created.messages[0]).toMatchObject({ authorKind: "user", body: "It 500s on connect." });

    // list — the new ticket is present with its last message + unread flag
    const list = await client.support.tickets();
    const listed = list.find((t) => t.id === created.id);
    expect(listed).toBeDefined();
    expect(listed!.lastMessage?.body).toBe("It 500s on connect.");
    expect(listed!.unread).toBe(false); // no admin reply yet

    // thread — the full detail round-trips
    const thread = await client.support.thread(created.id);
    expect(thread.id).toBe(created.id);
    expect(thread.messages).toHaveLength(1);

    // reply — appends a second user message, returns the updated thread
    const replied = await client.support.reply(created.id, "Still failing after a retry.");
    expect(replied.messages).toHaveLength(2);
    expect(replied.messages[1]).toMatchObject({ authorKind: "user", body: "Still failing after a retry." });

    // mark read — idempotent ack
    const read = await client.support.markTicketRead(created.id);
    expect(read.ok).toBe(true);

    // unread — the caller has no unread ADMIN responses
    const unread = await client.support.unreadCount();
    expect(typeof unread.count).toBe("number");
    expect(unread.count).toBe(0);
  });

  it("a ticket the caller does not own is Not Found (never leaks another org's ticket)", async () => {
    const client = await signIn();
    await expect(client.support.thread(randomUUID())).rejects.toMatchObject({ code: "E_NOT_FOUND" });
  });
});

describe("@glyphh/sdk — admin support console (role gate)", () => {
  it("supportTickets is forbidden for a non-platform-admin", async () => {
    const client = await signIn();
    await expect(client.admin.supportTickets()).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("supportTicket is forbidden for a non-platform-admin", async () => {
    const client = await signIn();
    await expect(client.admin.supportTicket(randomUUID())).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("supportReply is forbidden for a non-platform-admin", async () => {
    const client = await signIn();
    await expect(client.admin.supportReply(randomUUID(), "we're on it")).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("setSupportStatus is forbidden for a non-platform-admin", async () => {
    const client = await signIn();
    await expect(client.admin.setSupportStatus(randomUUID(), "resolved")).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("markSupportRead is forbidden for a non-platform-admin", async () => {
    const client = await signIn();
    await expect(client.admin.markSupportRead(randomUUID())).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("supportUnreadCount is forbidden for a non-platform-admin", async () => {
    const client = await signIn();
    await expect(client.admin.supportUnreadCount()).rejects.toBeInstanceOf(ForbiddenError);
  });
});
