/**
 * contract/support.ts — the SUPPORT wire shapes. Two surfaces share this domain:
 *
 *   • the legacy fire-and-forget FLARE (`SupportTicketInput`/`SupportTicketAck`) —
 *     a subject + description relayed to a Discord sink, returning an ack; and
 *   • the STORED, THREADED ticketing system (migration 032): a ticket carries a
 *     subject + status + a message thread the reporter and a platform admin trade.
 *
 * As on the server, the two audiences keep two conventions: the USER-facing ticket
 * shapes are camelCase (mirroring billing/catalog); the ADMIN-console shapes are
 * snake_case (mirroring the rest of the /admin surface). These interfaces mirror the
 * server's `serialize.ts` exactly — do not diverge from the wire.
 */

// ── legacy Discord flare ─────────────────────────────────────────────────────
export interface SupportTicketInput {
  subject: string;
  description: string;
}

export interface SupportTicketAck {
  ok: boolean;
}

// ── stored ticketing — status + shared pieces ────────────────────────────────
export type SupportTicketStatus = "open" | "pending" | "resolved" | "closed";

/** The unread/pending badge count, shared by the user + admin `/unread` routes. */
export interface SupportUnread {
  count: number;
}

// ── user-facing (camelCase) ──────────────────────────────────────────────────
export interface SupportMessage {
  id: string;
  authorKind: "user" | "admin";
  authorUserId: string | null;
  body: string;
  createdAt: string;
}

/** A row in the caller's own ticket list: summary + last message + unread flag. */
export interface SupportTicket {
  id: string;
  subject: string;
  status: SupportTicketStatus;
  createdAt: string;
  updatedAt: string;
  /** The most recent message (list rows only); absent on a freshly-created detail. */
  lastMessage?: SupportMessage | null;
  /** True when an admin message landed after the user last read the thread. */
  unread?: boolean;
}

/** A ticket the caller opened, with its full message thread. */
export interface SupportThread extends SupportTicket {
  messages: SupportMessage[];
}

/** Open a new ticket: a subject + the first message body. */
export interface SupportTicketCreate {
  subject: string;
  message: string;
}

// ── admin-console (snake_case; mirrors the /admin wire) ──────────────────────
export interface AdminSupportMessage {
  id: string;
  author_kind: "user" | "admin";
  author_user_id: string | null;
  body: string;
  created_at: string;
}

/** A row in the admin ticket list: joined with org name + reporter email. */
export interface AdminSupportTicket {
  id: string;
  subject: string;
  status: SupportTicketStatus;
  created_at: string;
  updated_at: string;
  org_id: string;
  org_name: string;
  user_id: string;
  user_email: string;
  /** True when a user message landed after the admin last read the thread. */
  unread_for_admin: boolean;
}

export interface AdminSupportThread extends AdminSupportTicket {
  messages: AdminSupportMessage[];
}

/** A page of the admin ticket browser. */
export interface AdminSupportPage {
  tickets: AdminSupportTicket[];
  total: number;
}

/** Query for the admin ticket browser (search + status filter + pagination). */
export interface AdminSupportQuery {
  q?: string | undefined;
  status?: string | undefined;
  page?: number | undefined;
  limit?: number | undefined;
}
