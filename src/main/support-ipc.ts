/**
 * support-ipc.ts — the desktop renderer's transport to the STORED, THREADED
 * support ticketing surface (migration 032): the caller's own tickets, a
 * thread, opening a ticket, replying, and marking read. Every call is scoped
 * server-side to the authenticated principal.
 *
 * The renderer has no SDK handle (preload boundary), so these thin IPC methods
 * call the MAIN-process @glyphh/sdk client — the same authed client every other
 * control-plane call uses (getClient()). Same shape as files-ipc.ts.
 *
 * Reads (tickets/thread) propagate rejection so the panel can paint an honest
 * error; writes (createTicket/reply/markRead) return an `{ ok, … , error }`
 * envelope. (The legacy fire-and-forget `submit-support-ticket` flare stays
 * where it is — this is the separate threaded system.)
 */

import { ipcMain } from "electron";
import type { SupportTicketCreate } from "@glyphh/sdk";
import { getClient } from "./glyphh-client";

function fail(err: unknown): { ok: false; error: string } {
  return { ok: false, error: err instanceof Error ? err.message : String(err) };
}

export function registerSupportIpc(): void {
  // A READ BEFORE SIGN-IN IS NOT A FAULT (his log, 2026-09-17): the panel asks
  // on boot, the client has no token yet, and an unhandled rejection paints
  // "Error occurred in handler for 'support-tickets'" across the log. An
  // unauthenticated read answers with nothing; every other failure still
  // propagates, so a real outage is not disguised as an empty list.
  const unauthed = (err: unknown): boolean => /not authenticated|unauthorized|401/i.test(err instanceof Error ? err.message : String(err));
  ipcMain.handle("support-tickets", async () => {
    try { return await getClient().support.tickets(); }
    catch (err) { if (unauthed(err)) return []; throw err; }
  });
  ipcMain.handle("support-thread", async (_e, id: string) => {
    try { return await getClient().support.thread(String(id || "")); }
    catch (err) { if (unauthed(err)) return null; throw err; }
  });
  ipcMain.handle("support-create-ticket", async (_e, input: SupportTicketCreate) => {
    try { return { ok: true as const, thread: await getClient().support.createTicket(input) }; }
    catch (err) { return fail(err); }
  });
  ipcMain.handle("support-reply", async (_e, id: string, body: string) => {
    try { return { ok: true as const, thread: await getClient().support.reply(String(id || ""), String(body || "")) }; }
    catch (err) { return fail(err); }
  });
  ipcMain.handle("support-mark-read", async (_e, id: string) => {
    try { await getClient().support.markTicketRead(String(id || "")); return { ok: true as const }; }
    catch (err) { return fail(err); }
  });
}
