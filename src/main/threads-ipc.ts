/**
 * threads-ipc.ts — the desktop renderer's transport to the SERVER THREADS
 * SURFACE. The renderer has no SDK handle (preload boundary); these four thin
 * IPC methods call the MAIN-process @glyphh/sdk client (glyphh-client.ts) —
 * the SDK in main IS the desktop's client, per the architecture law.
 *
 * Errors propagate to the renderer as rejections: thread-store.ts treats any
 * failure as "server unreachable" and stays in cache-only mode, so no shaping
 * happens here.
 */

import { ipcMain } from "electron";
import { getClient } from "./glyphh-client";

interface ThreadPushBody {
  title?: string;
  mode?: string;
  source?: unknown;
  messages?: Array<{ role: string; [k: string]: unknown }>;
  updatedAt: number;
}

export function registerThreadsIpc(): void {
  ipcMain.handle("glyphh-threads-list", () => getClient().sessions.threads());
  ipcMain.handle("glyphh-threads-get", (_e, id: string) => getClient().sessions.thread(String(id || "")));
  ipcMain.handle("glyphh-threads-push", (_e, p: { id: string; body: ThreadPushBody }) => {
    const id = String(p?.id || "");
    if (!id || !p?.body || typeof p.body.updatedAt !== "number") throw new Error("threadsPush requires { id, body.updatedAt }");
    return getClient().sessions.pushThread(id, p.body);
  });
  ipcMain.handle("glyphh-threads-delete", (_e, id: string) => getClient().sessions.deleteThread(String(id || "")));
}
