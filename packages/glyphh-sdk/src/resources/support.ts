/**
 * resources/support.ts — the caller's own SUPPORT surface. Two flows share this client:
 *
 *   • `ticket()` — the legacy fire-and-forget flare: a subject + description relayed to
 *     the configured Discord sink, returning an ack. When support is unconfigured
 *     server-side the call surfaces as NotFoundError. This flow is preserved verbatim.
 *   • the STORED, THREADED ticketing system (migration 032): open a ticket, list your
 *     tickets, read a thread, reply, mark it read, and poll the unread badge. Every call
 *     is scoped server-side to the authenticated principal — you only ever see your own.
 *
 * The server wraps each body in `{ data }`; `AuthedHttp` unwraps it, so these methods
 * return the payload directly. List/badge routes wrap once more (`{ tickets }`,
 * `{ count }`) — that inner envelope is unwrapped here.
 */

import type { AuthedHttp } from "../core/authed-http.js";
import type {
  SupportTicketInput, SupportTicketAck,
  SupportTicket, SupportThread, SupportTicketCreate, SupportUnread,
} from "../contract/support.js";

export class SupportClient {
  constructor(private readonly http: AuthedHttp) {}

  /** Legacy flare: relay a subject + description to the Discord sink. */
  ticket(input: SupportTicketInput): Promise<SupportTicketAck> {
    return this.http.post<SupportTicketAck>("/api/support/ticket", input);
  }

  /** Open a stored ticket with its first message; returns the ticket + its thread. */
  createTicket(input: SupportTicketCreate): Promise<SupportThread> {
    return this.http.post<SupportThread>("/api/support/tickets", input);
  }

  /** The caller's tickets, newest activity first (each with its last message + unread flag). */
  async tickets(): Promise<SupportTicket[]> {
    const { tickets } = await this.http.get<{ tickets: SupportTicket[] }>("/api/support/tickets");
    return tickets;
  }

  /** One of the caller's tickets, with its full message thread. */
  thread(id: string): Promise<SupportThread> {
    return this.http.get<SupportThread>(`/api/support/tickets/${encodeURIComponent(id)}`);
  }

  /** Append a reply to the caller's ticket; returns the updated thread. */
  reply(id: string, body: string): Promise<SupportThread> {
    return this.http.post<SupportThread>(`/api/support/tickets/${encodeURIComponent(id)}/messages`, { body });
  }

  /** Mark a ticket read by the user (clears its unread flag; never reorders the list). */
  markTicketRead(id: string): Promise<{ ok: boolean }> {
    return this.http.post<{ ok: boolean }>(`/api/support/tickets/${encodeURIComponent(id)}/read`);
  }

  /** Count of the caller's tickets carrying an unread admin response (the sidebar badge). */
  unreadCount(): Promise<SupportUnread> {
    return this.http.get<SupportUnread>("/api/support/unread");
  }
}
