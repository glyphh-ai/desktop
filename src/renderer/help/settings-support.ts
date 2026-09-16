/**
 * settings-support.ts — Settings › Support.
 *
 * The stored, threaded ticketing system: the caller's tickets, a thread, a new
 * request, replies, mark-read. Ported from mobile.tsx HelpTray. Three views
 * (list / new / thread) toggle inside one panel.
 *
 * Transport — web → window.glyphhSdk.support (checked first); desktop →
 * window.glyphh.support* IPC (support-ipc.ts → getClient().support). Neither →
 * an honest "not available" message.
 */

import { escapeHtml, paginate, renderPaginationBar } from "./shared.js";

interface SupportMsg { id: string; authorKind: "user" | "admin"; body: string; createdAt: string }
interface SupportTicket { id: string; subject: string; status: string; updatedAt: string; lastMessage?: SupportMsg | null; unread?: boolean }
interface SupportThread extends SupportTicket { messages: SupportMsg[] }

interface SdkSupport {
  tickets?: () => Promise<SupportTicket[]>;
  thread?: (id: string) => Promise<SupportThread>;
  createTicket?: (input: { subject: string; message: string }) => Promise<SupportThread>;
  reply?: (id: string, body: string) => Promise<SupportThread>;
  markTicketRead?: (id: string) => Promise<{ ok: boolean }>;
}
interface DesktopSupportIpc {
  supportTickets?: () => Promise<SupportTicket[]>;
  supportThread?: (id: string) => Promise<SupportThread>;
  supportCreateTicket?: (input: { subject: string; message: string }) => Promise<{ ok: boolean; thread?: SupportThread; error?: string }>;
  supportReply?: (id: string, body: string) => Promise<{ ok: boolean; thread?: SupportThread; error?: string }>;
  supportMarkRead?: (id: string) => Promise<{ ok: boolean; error?: string }>;
}

interface SupportTransport {
  tickets(): Promise<SupportTicket[]>;
  thread(id: string): Promise<SupportThread>;
  createTicket(subject: string, message: string): Promise<SupportThread>;
  reply(id: string, body: string): Promise<SupportThread>;
  markRead(id: string): Promise<void>;
}

const NO_TRANSPORT = "Support isn't available on this build.";
const isWeb = (): boolean => !!(window as unknown as { __GLYPHH_WEB__?: boolean }).__GLYPHH_WEB__;

function transport(): SupportTransport | null {
  if (isWeb()) {
    const s = (window as unknown as { glyphhSdk?: { support?: SdkSupport } }).glyphhSdk?.support;
    if (!s?.tickets || !s.thread || !s.createTicket || !s.reply || !s.markTicketRead) return null;
    return {
      tickets: () => s.tickets!(),
      thread: (id) => s.thread!(id),
      createTicket: (subject, message) => s.createTicket!({ subject, message }),
      reply: (id, body) => s.reply!(id, body),
      markRead: async (id) => { await s.markTicketRead!(id); },
    };
  }
  const g = (window as unknown as { glyphh?: DesktopSupportIpc }).glyphh;
  if (!g?.supportTickets || !g.supportThread || !g.supportCreateTicket || !g.supportReply || !g.supportMarkRead) return null;
  const unwrap = async (p: Promise<{ ok: boolean; thread?: SupportThread; error?: string }>): Promise<SupportThread> => {
    const r = await p;
    if (!r?.ok || !r.thread) throw new Error(r?.error || "Request failed.");
    return r.thread;
  };
  return {
    tickets: () => g.supportTickets!(),
    thread: (id) => g.supportThread!(id),
    createTicket: (subject, message) => unwrap(g.supportCreateTicket!({ subject, message })),
    reply: (id, body) => unwrap(g.supportReply!(id, body)),
    markRead: async (id) => { await g.supportMarkRead!(id); },
  };
}

const $ = (id: string) => document.getElementById(id);
let tickets: SupportTicket[] = [];
let thread: SupportThread | null = null;
let wired = false;

function setError(msg: string): void {
  const el = $("support-error");
  if (!el) return;
  el.textContent = msg;
  el.classList.toggle("hidden", !msg);
}

function show(view: "list" | "new" | "thread"): void {
  $("support-list-view")?.classList.toggle("hidden", view !== "list");
  $("support-new-view")?.classList.toggle("hidden", view !== "new");
  $("support-thread-view")?.classList.toggle("hidden", view !== "thread");
}

/** The standard list-page grammar (Skills/Loops): a lib-table with the row
 *  anatomy subject / last-message / status badge / updated + crud-empty and
 *  pagination. Row click opens the thread. */
let ticketsPage = 0;

function renderTickets(): void {
  const list = $("support-tickets");
  const empty = $("support-empty");
  if (!list) return;
  const q = (($("support-search") as HTMLInputElement | null)?.value || "").trim().toLowerCase();
  const rows = q
    ? tickets.filter((t) => `${t.subject} ${t.status} ${t.lastMessage?.body || ""}`.toLowerCase().includes(q))
    : tickets;
  empty?.classList.toggle("hidden", tickets.length > 0);
  list.innerHTML = "";
  if (!tickets.length) return;
  if (!rows.length) {
    list.innerHTML = `<div class="crud-empty">No requests matching "${escapeHtml(q)}"</div>`;
    return;
  }
  const { items, state } = paginate(rows, ticketsPage);
  ticketsPage = state.page;
  const table = document.createElement("table");
  table.className = "lib-table";
  table.innerHTML = `<thead><tr><th>Subject</th><th>Last message</th><th>Status</th><th>Updated</th></tr></thead>`;
  const tbody = document.createElement("tbody");
  for (const t of items) {
    const tr = document.createElement("tr");
    const updated = t.updatedAt ? new Date(t.updatedAt) : null;
    tr.innerHTML = `
      <td class="lib-table-name"></td>
      <td class="lib-table-desc"></td>
      <td><span class="lib-badge"></span></td>
      <td class="lib-table-dim">${updated && !Number.isNaN(updated.getTime()) ? escapeHtml(updated.toLocaleDateString()) : ""}</td>`;
    const subject = tr.querySelector(".lib-table-name");
    if (subject) {
      subject.textContent = t.subject;
      if (t.unread) {
        // The house badge — the old .set-dot class had no styles anywhere.
        const badge = document.createElement("span");
        badge.className = "lib-badge";
        badge.textContent = "New";
        subject.append(" ", badge);
      }
    }
    const last = tr.querySelector(".lib-table-desc");
    if (last) last.textContent = t.lastMessage?.body || "";
    const status = tr.querySelector(".lib-badge");
    if (status) status.textContent = t.status;
    tr.addEventListener("click", () => void openThread(t.id));
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  list.appendChild(table);
  if (state.totalPages > 1) list.appendChild(renderPaginationBar(state, (p) => { ticketsPage = p; renderTickets(); }));
}

function renderThread(): void {
  const subj = $("support-thread-subject");
  const status = $("support-thread-status");
  const msgs = $("support-thread-msgs");
  if (subj) subj.textContent = thread?.subject || "—";
  if (status) status.textContent = thread?.status || "—";
  if (!msgs) return;
  msgs.innerHTML = "";
  for (const m of thread?.messages || []) {
    const div = document.createElement("div");
    div.className = `set-msg ${m.authorKind === "user" ? "set-msg-user" : "set-msg-admin"}`;
    div.textContent = m.body;
    msgs.appendChild(div);
  }
  msgs.scrollTop = msgs.scrollHeight;
}

async function openThread(id: string): Promise<void> {
  setError("");
  thread = null;
  renderThread();
  show("thread");
  const t = transport();
  if (!t) { setError(NO_TRANSPORT); return; }
  try {
    thread = await t.thread(id);
    renderThread();
    void t.markRead(id).then(() => void refresh()).catch(() => {});
  } catch (e) { setError(`Couldn't load this request — ${(e as Error).message}`); }
}

async function refresh(): Promise<void> {
  const t = transport();
  if (!t) { tickets = []; renderTickets(); return; }
  try { tickets = await t.tickets(); renderTickets(); }
  catch { tickets = []; renderTickets(); }
}

export async function loadSupportPanel(): Promise<void> {
  initSupportPanel();
  setError("");
  show("list");
  // TICKETS ARE PRO+ (his rule, 2026-09-13): below Pro the surface locks in
  // place — visible, inert — and the gate note carries the community Discord
  // (the same invite the homepage + dashboard link).
  void (async () => {
    const host = document.querySelector<HTMLElement>('.settings-panel[data-sub="support"]');
    if (!host) return;
    const { gateSurface } = await import("./plan-gate.js");
    const allowed = await gateSurface(host, "governance", "Support tickets");
    if (allowed) return;
    const note = host.querySelector<HTMLElement>(":scope > .plan-locked-note span");
    if (note) {
      const invite = (window.glyphh as unknown as { discordInvite?: string }).discordInvite || "https://discord.gg/P3yynv4v9";
      const a = document.createElement("a");
      a.href = "#";
      a.textContent = "Join our Discord for help.";
      a.addEventListener("click", (e) => { e.preventDefault(); window.open(invite, "_blank", "noopener"); });
      note.append(" ", a);
    }
  })();
  const t = transport();
  if (!t) { tickets = []; renderTickets(); setError(NO_TRANSPORT); return; }
  await refresh();
}

export function initSupportPanel(): void {
  if (wired) return;
  wired = true;
  $("support-search")?.addEventListener("input", () => { ticketsPage = 0; renderTickets(); });
  $("support-new-btn")?.addEventListener("click", () => { setError(""); show("new"); });
  $("support-new-back")?.addEventListener("click", () => { setError(""); show("list"); });
  // Cancel in the form's bottom .settings-actions — same exit as the breadcrumb.
  $("support-new-cancel")?.addEventListener("click", () => { setError(""); show("list"); });
  $("support-thread-back")?.addEventListener("click", () => { setError(""); thread = null; show("list"); void refresh(); });

  $("support-submit-btn")?.addEventListener("click", async () => {
    const subject = ($("support-subject") as HTMLInputElement | null)?.value.trim() || "";
    const message = ($("support-message") as HTMLTextAreaElement | null)?.value.trim() || "";
    if (!subject || !message) return;
    const t = transport();
    if (!t) { setError(NO_TRANSPORT); return; }
    setError("");
    try {
      thread = await t.createTicket(subject, message);
      const s = $("support-subject") as HTMLInputElement | null; if (s) s.value = "";
      const m = $("support-message") as HTMLTextAreaElement | null; if (m) m.value = "";
      await refresh();
      renderThread();
      show("thread");
    } catch (e) { setError(`Couldn't submit — ${(e as Error).message}`); }
  });

  const sendReply = async (): Promise<void> => {
    if (!thread) return;
    const input = $("support-reply") as HTMLInputElement | null;
    const body = (input?.value || "").trim();
    if (!body) return;
    const t = transport();
    if (!t) { setError(NO_TRANSPORT); return; }
    setError("");
    try { thread = await t.reply(thread.id, body); if (input) input.value = ""; renderThread(); }
    catch (e) { setError(`Couldn't send — ${(e as Error).message}`); }
  };
  $("support-reply-btn")?.addEventListener("click", () => void sendReply());
  $("support-reply")?.addEventListener("keydown", (e) => { if ((e as KeyboardEvent).key === "Enter") void sendReply(); });
}
