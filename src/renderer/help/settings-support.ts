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

import { escapeHtml } from "./shared.js";

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

function renderTickets(): void {
  const list = $("support-tickets");
  const empty = $("support-empty");
  if (!list) return;
  empty?.classList.toggle("hidden", tickets.length > 0);
  list.innerHTML = "";
  for (const t of tickets) {
    const row = document.createElement("button");
    row.type = "button";
    row.className = "set-list-row";
    const last = t.lastMessage?.body ? ` · ${escapeHtml(t.lastMessage.body)}` : "";
    row.innerHTML = `<span class="set-list-main"><span class="set-list-name">${escapeHtml(t.subject)}${t.unread ? ` <span class="set-dot"></span>` : ""}</span><span class="set-list-sub">${escapeHtml(t.status)}${last}</span></span>`;
    row.addEventListener("click", () => void openThread(t.id));
    list.appendChild(row);
  }
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
  const t = transport();
  if (!t) { tickets = []; renderTickets(); setError(NO_TRANSPORT); return; }
  await refresh();
}

export function initSupportPanel(): void {
  if (wired) return;
  wired = true;
  $("support-new-btn")?.addEventListener("click", () => { setError(""); show("new"); });
  $("support-new-back")?.addEventListener("click", () => { setError(""); show("list"); });
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
