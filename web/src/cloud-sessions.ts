/**
 * cloud-sessions.ts — the phone's CLOUD threads, on the server's thread store.
 *
 * A session born in the cloud has no desktop to keep its chat (desktop-
 * sessions.ts is the attach-socket store for desktop-born threads). It lives
 * where the web's cloud sessions live: the control plane's threads at
 * `/api/harness/threads` (SDK `sessions.threads/thread/pushThread/
 * deleteThread`, contract/threads.ts — database as truth, LWW on `updatedAt`).
 * Same origin, same session token as the desktop-width web bundle, so a
 * session started on app.glyphh.ai on a phone is the very thread the
 * desktop-width web lists (his direction, 2026-10-05).
 *
 * Only CLOUD threads are read from here (mobile-cloud.ts mergeThreads) — a
 * desktop thread syncs to the server too and would list twice otherwise.
 */
import { glyphh } from './glyphh-web.js';
import { isCloudKind, type ListedThread } from './mobile-cloud';

interface StoredMessage { role: string; text?: string; [k: string]: unknown }
interface ThreadsDoor {
  threads(): Promise<ListedThread[]>;
  thread(id: string): Promise<ListedThread & { messages?: StoredMessage[] }>;
  pushThread(id: string, body: { title?: string; mode?: string; source?: unknown; messages?: StoredMessage[]; updatedAt: number }): Promise<unknown>;
  deleteThread(id: string): Promise<void>;
}
const door = (): ThreadsDoor => (glyphh() as unknown as { sessions: ThreadsDoor }).sessions;

export const cloudSessions = {
  /** The member's cloud threads, newest-updated first. A failed read is an
   *  empty list — the desktop list still stands. */
  async threads(): Promise<ListedThread[]> {
    try {
      const all = await door().threads();
      return (Array.isArray(all) ? all : []).filter((t) => isCloudKind((t.source as { kind?: string } | null)?.kind));
    } catch { return []; }
  },

  async thread(id: string): Promise<{ messages: StoredMessage[]; source?: ListedThread['source'] }> {
    const t = await door().thread(id);
    return { messages: t?.messages ?? [], source: t?.source ?? null };
  },

  /** LWW upsert at the phone's clock: title/source on birth, the transcript
   *  after each turn (the worker does not write the thread itself). */
  async pushThread(id: string, t: { title?: string; mode?: string; source?: unknown; messages?: StoredMessage[] }): Promise<void> {
    await door().pushThread(id, {
      ...(t.title ? { title: t.title } : {}),
      ...(t.mode ? { mode: t.mode } : {}),
      ...(t.source !== undefined ? { source: t.source } : {}),
      ...(t.messages ? { messages: t.messages } : {}),
      updatedAt: Date.now(),
    });
  },

  async deleteThread(id: string): Promise<void> {
    await door().deleteThread(id);
  },
};
