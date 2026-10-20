/**
 * chat-store-repair.ts — collapse a thread whose transcript was appended to
 * itself (his report, 2026-10-04: the desktop crashed and crawled; the chat
 * store had grown to 164 MB — 55,058 messages in 10 threads, 227 of them
 * real). Two writers (main's publisher and the renderer's thread-store) and
 * one puller that replaced the local transcript with the server's copy
 * doubled every thread on every pass. The writers are one now; this repairs
 * what the loop left behind, on load, before anything crosses IPC.
 *
 * A duplicate is a message identical to an earlier one in the same thread by
 * role, text, timestamp and attachments. Two real messages that say the same
 * words carry different timestamps; the loop's copies carry the same one.
 * Pure — no Electron, tested in test/main/chat-store-repair.test.ts.
 */
export interface RepairResult<C> { chats: C[]; /** id → the message count before the repair, for threads that shrank. */ repaired: Record<string, number> }

/** No thread holds more than this many messages on this machine: the tail is
 *  kept. A loop can still misbehave, but it can no longer take the app down. */
export const MAX_THREAD_MESSAGES = 2000;

function keyOf(m: unknown): string {
  const r = (m ?? {}) as Record<string, unknown>;
  const extra = r.attachments ?? r.images ?? r.tool ?? null;
  return JSON.stringify([r.role ?? "", r.text ?? r.content ?? "", r.at ?? r.ts ?? null, extra === null ? null : JSON.stringify(extra)]);
}

/** The real messages of a list: copies dropped, then the tail within the cap. */
export function boundMessages<M>(messages: M[]): M[] {
  const seen = new Set<string>();
  const kept = messages.filter((m) => { const k = keyOf(m); if (seen.has(k)) return false; seen.add(k); return true; });
  return kept.length > MAX_THREAD_MESSAGES ? kept.slice(-MAX_THREAD_MESSAGES) : kept;
}

export function repairChatStore<C extends { id?: unknown; messages?: unknown }>(chats: C[]): RepairResult<C> {
  const repaired: Record<string, number> = {};
  const out = chats.map((c) => {
    if (!c || !Array.isArray(c.messages) || c.messages.length < 2) return c;
    const kept = boundMessages(c.messages as unknown[]);
    if (kept.length === c.messages.length) return c;
    if (typeof c.id === "string") repaired[c.id] = c.messages.length;
    return { ...c, messages: kept };
  });
  return { chats: out, repaired };
}

/** THE BOTS PANEL IS GONE (2026-10-19). The threads it wrote (`bots/<slug>`)
 *  stay in the file untouched — no conversation is deleted — but no surface
 *  lists or opens them: the store hands out the rest. A save merges over the
 *  file (mergeChats), so a hidden thread survives every write. */
export function withoutRetiredThreads<C extends { id?: unknown }>(chats: C[]): C[] {
  return chats.filter((c) => !(c && typeof c.id === "string" && c.id.startsWith("bots/")));
}

/** Merge a saver's chats over the stored ones by id: the newer `updatedAt`
 *  wins, EXCEPT that a row carrying no messages never erases stored
 *  messages — a renderer that lists a thread without having opened it saves
 *  a stub, and a stub is metadata, not an empty transcript (2026-10-04: the
 *  stubs wiped six local threads, which were then re-read from the server's
 *  polluted copies). Every kept transcript is bounded. */
export function mergeChats<C extends { id?: unknown; updatedAt?: unknown; messages?: unknown }>(have: C[], incoming: C[], gone: ReadonlySet<string> = new Set()): C[] {
  const byId = new Map<string, C>();
  for (const c of have) if (c && typeof c.id === "string") byId.set(c.id, c);
  for (const c of incoming) {
    if (!c || typeof c.id !== "string") continue;
    const cur = byId.get(c.id);
    if (cur && (Number(c.updatedAt) || 0) < (Number(cur.updatedAt) || 0)) continue;
    const curMsgs = cur && Array.isArray(cur.messages) ? (cur.messages as unknown[]) : [];
    const newMsgs = Array.isArray(c.messages) ? (c.messages as unknown[]) : [];
    byId.set(c.id, newMsgs.length === 0 && curMsgs.length > 0 ? { ...c, messages: curMsgs } : c);
  }
  const order = [...incoming, ...have].map((c) => (c && typeof c.id === "string" ? c.id : "")).filter(Boolean);
  const seen = new Set<string>();
  return order
    .filter((id) => (gone.has(id) ? false : seen.has(id) ? false : (seen.add(id), true)))
    .map((id) => { const c = byId.get(id)!; return Array.isArray(c.messages) ? { ...c, messages: boundMessages(c.messages as unknown[]) } : c; });
}
