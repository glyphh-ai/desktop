/**
 * office-docs.ts — Glyphh Office · DOCS, the desktop transport.
 *
 * Markdown documents in the ORG library (R2 behind yo-server via
 * client.officeDocs) with the review-and-approve suggestion flow and the
 * code-defined template catalog. Same doctrine as Slides: nothing local,
 * the panel reads/writes through these handlers, the agent through tools.
 */

import { ipcMain } from "electron";
import { getClient } from "./glyphh-client";

/** Doc refs are bare names — same containment rule as the server (.md). */
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
      const docs = (await getClient().officeDocs.list()).map((d) => ({
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
      const doc = await getClient().officeDocs.get(gdocFileName(name));
      return { ok: true, markdown: doc.markdown, title: doc.title };
    } catch (err) {
      return { ok: false, error: errText(err) };
    }
  });
  ipcMain.handle("gdoc-write", async (_e, name: unknown, markdown: unknown) => {
    try {
      const meta = await getClient().officeDocs.put(gdocFileName(name), String(markdown ?? ""));
      return { ok: true, file: meta.file, title: meta.title };
    } catch (err) {
      return { ok: false, error: errText(err) };
    }
  });
  ipcMain.handle("gdoc-delete", async (_e, name: unknown) => {
    try {
      await getClient().officeDocs.delete(gdocFileName(name));
      return { ok: true };
    } catch (err) {
      return { ok: false, error: errText(err) };
    }
  });
  ipcMain.handle("gdoc-suggestions", async (_e, name: unknown, status: unknown) => {
    try {
      const rows = await getClient().officeDocs.suggestions(gdocFileName(name), status ? String(status) : undefined);
      return { ok: true, suggestions: rows };
    } catch (err) {
      return { ok: false, error: errText(err), suggestions: [] };
    }
  });
  ipcMain.handle("gdoc-resolve", async (_e, id: unknown, approve: unknown) => {
    try {
      const row = await getClient().officeDocs.resolveSuggestion(String(id ?? ""), !!approve);
      return { ok: true, suggestion: row };
    } catch (err) {
      return { ok: false, error: errText(err) };
    }
  });
  ipcMain.handle("gdrive-list", async (_e, q: unknown) => {
    try {
      const listing = await getClient().officeDrive.list(q ? String(q) : undefined);
      return { ok: true, ...listing };
    } catch (err) {
      return { ok: false, error: errText(err), folders: [], files: [] };
    }
  });
  ipcMain.handle("gdrive-mkdir", async (_e, name: unknown, parentId: unknown) => {
    try {
      return { ok: true, folder: await getClient().officeDrive.createFolder(String(name ?? ""), parentId ? String(parentId) : null) };
    } catch (err) {
      return { ok: false, error: errText(err) };
    }
  });
  ipcMain.handle("gdrive-move", async (_e, kind: unknown, file: unknown, folderId: unknown) => {
    try {
      const k = String(kind ?? "");
      if (k !== "slides" && k !== "docs") throw new Error("kind must be slides or docs");
      await getClient().officeDrive.move(k, String(file ?? ""), folderId ? String(folderId) : null);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: errText(err) };
    }
  });
  ipcMain.handle("gdrive-folder-rename", async (_e, id: unknown, name: unknown) => {
    try {
      return { ok: true, folder: await getClient().officeDrive.updateFolder(String(id ?? ""), { name: String(name ?? "") }) };
    } catch (err) {
      return { ok: false, error: errText(err) };
    }
  });
  ipcMain.handle("gdrive-folder-delete", async (_e, id: unknown) => {
    try {
      await getClient().officeDrive.deleteFolder(String(id ?? ""));
      return { ok: true };
    } catch (err) {
      return { ok: false, error: errText(err) };
    }
  });
  ipcMain.handle("gdoc-templates", async () => {
    try {
      return { ok: true, templates: await getClient().officeDocs.templates() };
    } catch (err) {
      return { ok: false, error: errText(err), templates: [] };
    }
  });
}
