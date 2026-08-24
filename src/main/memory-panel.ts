/**
 * memory-panel.ts — GLYPHH MEMORY, the desktop transport. The panel is a
 * window onto the org's stator (one memory plane): raw browse, semantic
 * search with scores, the 3D graph payload, and the two curation writes
 * (forget/amend). Thin IPC over client.stator — auth, region routing and
 * tenant scoping all live server-side.
 */

import { ipcMain } from "electron";
import { getClient } from "./glyphh-client";

const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

export function registerMemoryPanelIpc(): void {
  ipcMain.handle("memory-browse", async (_e, threadId?: unknown) => {
    try {
      const r = await getClient().stator.browse(threadId ? String(threadId) : undefined);
      return { ok: true, ...r };
    } catch (err) {
      return { ok: false, error: errText(err), facts: [], turns: [], window: [] };
    }
  });
  ipcMain.handle("memory-graph", async (_e, opts: unknown) => {
    try {
      const o = (opts ?? {}) as { max?: number; semMin?: number; neuralMin?: number; neuralMax?: number };
      const r = await getClient().stator.graph(o);
      return { ok: true, ...r };
    } catch (err) {
      return { ok: false, error: errText(err), nodes: [], coords: [], edges: [] };
    }
  });
  ipcMain.handle("memory-search", async (_e, query: unknown, topK?: unknown) => {
    try {
      const r = await getClient().stator.recall({
        query: String(query ?? ""),
        topK: Math.max(1, Math.min(50, Number(topK) || 12)),
        threshold: 0.05,
      });
      return { ok: true, recalled: r.recalled, directives: r.directives };
    } catch (err) {
      return { ok: false, error: errText(err), recalled: [], directives: [] };
    }
  });
  ipcMain.handle("memory-forget", async (_e, input: unknown) => {
    try {
      const r = await getClient().stator.forget(input as Parameters<ReturnType<typeof getClient>["stator"]["forget"]>[0]);
      return { ok: true, deleted: r.deleted };
    } catch (err) {
      return { ok: false, error: errText(err) };
    }
  });
  ipcMain.handle("memory-amend", async (_e, input: unknown) => {
    try {
      const r = await getClient().stator.amend(input as Parameters<ReturnType<typeof getClient>["stator"]["amend"]>[0]);
      return { ok: true, written: r.written };
    } catch (err) {
      return { ok: false, error: errText(err) };
    }
  });
}
