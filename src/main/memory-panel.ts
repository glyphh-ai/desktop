/**
 * memory-panel.ts — GLYPHH MEMORY, the desktop transport. The panel is a
 * window onto the org's memory plane — the FACT SUBSTRATE (glyph ledger):
 * raw browse, cosine search with scores, the 3D fact-space payload, and the
 * curation writes (forget/amend). Thin IPC over client.stator — auth, region
 * routing and tenant scoping all live server-side.
 */

import { ipcMain } from "electron";
import { getClient } from "./glyphh-client";

const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

export function registerMemoryPanelIpc(): void {
  ipcMain.handle("memory-browse", async (_e, limit?: unknown) => {
    try {
      const r = await getClient().stator.browse({ limit: Math.max(1, Math.min(2000, Number(limit) || 500)) });
      return { ok: true, facts: r.facts };
    } catch (err) {
      return { ok: false, error: errText(err), facts: [] };
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
        topK: Math.max(1, Math.min(24, Number(topK) || 12)),
      });
      return { ok: true, facts: r.facts };
    } catch (err) {
      return { ok: false, error: errText(err), facts: [] };
    }
  });
  ipcMain.handle("memory-forget", async (_e, id: unknown) => {
    try {
      const r = await getClient().stator.forget({ id: String(id ?? "") });
      return { ok: true, forgotten: r.forgotten };
    } catch (err) {
      return { ok: false, error: errText(err) };
    }
  });
  ipcMain.handle("memory-amend", async (_e, input: unknown) => {
    try {
      const i = (input ?? {}) as { id?: string; name?: string; facts?: Record<string, Record<string, string>>; confidence?: number };
      const r = await getClient().stator.amend({
        id: String(i.id ?? ""),
        ...(i.name ? { name: i.name } : {}),
        ...(i.facts ? { facts: i.facts } : {}),
        ...(typeof i.confidence === "number" ? { confidence: i.confidence } : {}),
      });
      return { ok: true, id: r.id, supersedes: r.supersedes };
    } catch (err) {
      return { ok: false, error: errText(err) };
    }
  });
}
