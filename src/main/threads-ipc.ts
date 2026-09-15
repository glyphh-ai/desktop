/**
 * threads-ipc.ts — MESSAGE THREADS LIVE ON THIS MACHINE (his ruling, 2026-09-15):
 * `~/.glyphh/<user_id>/messages/<thread id>.json`, one file per thread, the
 * only store. Same four IPC lanes the renderer's thread-store has always used
 * (list / get / push / delete), so nothing above changes; the server thread
 * store is gone.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ipcMain } from "electron";
import { userScopedPath } from "./app-paths";

const THREAD_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

interface ThreadMessage { role: string; [k: string]: unknown }
interface ThreadBody {
  title?: string;
  mode?: string;
  source?: unknown;
  messages?: ThreadMessage[];
  updatedAt: number;
}
interface StoredThread extends ThreadBody {
  id: string;
  createdAt: number;
  messages: ThreadMessage[];
}

function dir(): string {
  const d = userScopedPath("messages");
  if (!existsSync(d)) mkdirSync(d, { recursive: true });
  return d;
}

function pathOf(id: string): string {
  if (!THREAD_ID_RE.test(id)) throw new Error(`bad thread id "${id}"`);
  return join(dir(), `${id}.json`);
}

function read(id: string): StoredThread | null {
  const p = pathOf(id);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf8")) as StoredThread;
  } catch (err) {
    console.warn(`[threads] unreadable thread ${id}:`, err instanceof Error ? err.message : String(err));
    return null;
  }
}

export function listThreads(): Array<Omit<StoredThread, "messages"> & { messageCount: number }> {
  const out = [];
  for (const f of readdirSync(dir())) {
    if (!f.endsWith(".json")) continue;
    const t = read(f.slice(0, -5));
    if (!t) continue;
    const { messages, ...rest } = t;
    out.push({ ...rest, messageCount: messages.length });
  }
  return out.sort((a, b) => b.updatedAt - a.updatedAt);
}

export function pushThread(id: string, body: ThreadBody): StoredThread {
  const existing = read(id);
  if (existing && existing.updatedAt > body.updatedAt) return existing;
  const next: StoredThread = {
    id,
    createdAt: existing?.createdAt ?? Date.now(),
    title: body.title ?? existing?.title,
    mode: body.mode ?? existing?.mode,
    source: body.source ?? existing?.source,
    messages: body.messages ?? existing?.messages ?? [],
    updatedAt: body.updatedAt,
  };
  writeFileSync(pathOf(id), JSON.stringify(next));
  return next;
}

export function deleteThread(id: string): void {
  const p = pathOf(id);
  if (existsSync(p)) unlinkSync(p);
}

export function registerThreadsIpc(): void {
  ipcMain.handle("glyphh-threads-list", () => listThreads());
  ipcMain.handle("glyphh-threads-get", (_e, id: string) => read(String(id || "")));
  ipcMain.handle("glyphh-threads-push", (_e, p: { id: string; body: ThreadBody }) => {
    const id = String(p?.id || "");
    if (!id || !p?.body || typeof p.body.updatedAt !== "number") throw new Error("threadsPush requires { id, body.updatedAt }");
    return pushThread(id, p.body);
  });
  ipcMain.handle("glyphh-threads-delete", (_e, id: string) => deleteThread(String(id || "")));
}
