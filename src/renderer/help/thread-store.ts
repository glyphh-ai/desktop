/**
 * thread-store.ts — THE SESSION STORE: main's chat file (the local user's
 * agent-sessions.json, main/agent-ipc.ts) through the glyphhSessionsLoad /
 * glyphhSessionsSave doors.
 *
 * Every save stamps `updatedAt` on a thread whose content changed: main
 * merges the file by chat id and the newer stamp wins, so several agent
 * panels can write it at once. A delete is SAID, not implied — the deleted
 * ids ride every save, because the shared file keeps the chats this window
 * does not carry (his report, 2026-09-21: a deleted chat came back after a
 * restart). Another writer's save reaches code.ts as glyphh-sessions-updated
 * and it re-reads the file itself.
 */

import { healSource } from "./thread-locus.js";

/** The store's structural view of a chat — code.ts's CodeChat satisfies it.
 *  `updatedAt` is the merge clock. */
export interface ThreadChat {
  id: string;
  title: string;
  createdAt: number;
  messages: unknown[];
  mode?: "work" | "code" | /** legacy stamps (help/code.ts modeOf folds them to Work) */ "chat" | "cowork";
  source?: unknown;
  updatedAt?: number;
}

let chatsRef: ThreadChat[] = [];
let currentIdRef = "";
/** id → the content last saved; a differing projection is a real edit (stamp). */
const snapshot = new Map<string, string>();
/** Ids deleted in this window, said on every save until the file drops them. */
const deleted = new Set<string>();
let hydrated: Promise<{ chats: ThreadChat[]; currentId: string }> | null = null;

const modeOf = (c: ThreadChat): string => c.mode ?? ((c as { chat?: boolean }).chat ? "chat" : "code");
/** The content that stamps — title/mode/source/messages (view-only fields excluded). */
const projection = (c: ThreadChat): string =>
  JSON.stringify({ t: c.title, m: modeOf(c), s: c.source ?? null, msgs: c.messages });

async function fileSave(): Promise<void> {
  try { await window.glyphh.glyphhSessionsSave?.(chatsRef, currentIdRef, [...deleted]); }
  catch { /* a failed save loses nothing but this write — the next one carries it */ }
}

/** Load the file once and return the live { chats, currentId } — code.ts
 *  keeps mutating that same array; persist() writes it back. */
export function hydrate(): Promise<{ chats: ThreadChat[]; currentId: string }> {
  if (!hydrated) {
    hydrated = (async () => {
      try {
        const s = await window.glyphh.glyphhSessionsLoad?.();
        chatsRef = ((s?.chats as ThreadChat[]) || []).filter((c) => !deleted.has(c.id));
        currentIdRef = String(s?.currentId || "");
      } catch { chatsRef = []; currentIdRef = ""; }
      // A record written by an older build may carry a flipped source: heal it
      // once on load, so every reader sees the session's real locus.
      for (const c of chatsRef) {
        const healed = healSource(c.source);
        if (healed !== c.source) c.source = healed;
        snapshot.set(c.id, projection(c));
      }
      return { chats: chatsRef, currentId: currentIdRef };
    })();
  }
  return hydrated;
}

/** Persist chats+currentId to the file, stamping every thread whose content
 *  actually changed since the last save. */
export function persist(chats: ThreadChat[], currentId: string): Promise<void> {
  chatsRef = chats;
  currentIdRef = currentId;
  for (const c of chats) {
    const proj = projection(c);
    if (snapshot.get(c.id) === proj) continue;
    c.updatedAt = Date.now();
    snapshot.set(c.id, proj);
    deleted.delete(c.id);   // a re-created id is not deleted any more
  }
  return fileSave();
}

/** Mark a thread deleted. The caller removes it from `chats` and persists as
 *  usual; the id rides that save so the shared file drops it too. */
export function remove(id: string): void {
  snapshot.delete(id);
  deleted.add(id);
}
