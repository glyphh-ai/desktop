/**
 * office-docs.ts — Glyphh Office · DOCS, the desktop transport.
 *
 * Markdown documents in the LOCAL library (~/.glyphh/office via office-store,
 * THE PURGE 2026-09-10) with the review-and-approve suggestion flow and the
 * vendored template catalog. The panel reads/writes through these handlers,
 * the agent through tools — the store is the one seam.
 */

import { ipcMain } from "electron";
import * as store from "./office-store";
import { DOC_TEMPLATES } from "./office-doc-templates";

/** Doc refs are bare names — same containment rule as ever (.md). */
export function gdocFileName(name: unknown): string {
  const base = String(name ?? "").trim().split(/[\\/]/).pop() ?? "";
  const stem = base.replace(/\.(md|markdown)$/i, "").replace(/[^\w\s.-]/g, "").trim().replace(/\s+/g, "-").toLowerCase();
  if (!stem) throw new Error("a document needs a name");
  return `${stem}.md`;
}

const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

export function registerOfficeDocsIpc(): void {
  ipcMain.handle("gdoc-list", async () => {
    try {
      const docs = (await store.listDocs()).map((d) => ({
        file: d.file, title: d.title, size: d.sizeBytes, folderId: d.folderId,
        mtime: Date.parse(d.updatedAt) || 0,
      }));
      return { ok: true, docs };
    } catch (err) {
      return { ok: false, error: errText(err), docs: [] };
    }
  });
  ipcMain.handle("gdoc-read", async (_e, name: unknown) => {
    try {
      const doc = await store.readDoc(gdocFileName(name));
      return { ok: true, markdown: doc.markdown, title: doc.title };
    } catch (err) {
      return { ok: false, error: errText(err) };
    }
  });
  ipcMain.handle("gdoc-write", async (_e, name: unknown, markdown: unknown, folderId?: unknown) => {
    try {
      const meta = await store.writeDoc(gdocFileName(name), String(markdown ?? ""), folderId === undefined ? undefined : (folderId as string | null));
      return { ok: true, file: meta.file, title: meta.title };
    } catch (err) {
      return { ok: false, error: errText(err) };
    }
  });
  ipcMain.handle("gdoc-delete", async (_e, name: unknown) => {
    try {
      await store.deleteDoc(gdocFileName(name));
      return { ok: true };
    } catch (err) {
      return { ok: false, error: errText(err) };
    }
  });
  ipcMain.handle("gdoc-suggest", async (_e, name: unknown, input: unknown) => {
    try {
      const i = input as { section?: string; beforeMd?: string; afterMd: string; note?: string; authorKind?: "agent" | "user" };
      const row = await store.createDocSuggestion(gdocFileName(name), i);
      return { ok: true, suggestion: row };
    } catch (err) {
      return { ok: false, error: errText(err) };
    }
  });
  ipcMain.handle("gdoc-suggestions", async (_e, name: unknown, status: unknown) => {
    try {
      const rows = await store.listDocSuggestions(gdocFileName(name), status ? String(status) : undefined);
      return { ok: true, suggestions: rows };
    } catch (err) {
      return { ok: false, error: errText(err), suggestions: [] };
    }
  });
  ipcMain.handle("gdoc-resolve", async (_e, id: unknown, approve: unknown) => {
    try {
      const row = await store.resolveDocSuggestion(String(id ?? ""), !!approve);
      return { ok: true, suggestion: row };
    } catch (err) {
      return { ok: false, error: errText(err) };
    }
  });
  ipcMain.handle("gdoc-templates", async () => {
    try {
      return { ok: true, templates: DOC_TEMPLATES };
    } catch (err) {
      return { ok: false, error: errText(err), templates: [] };
    }
  });
}
