/**
 * media-panel.ts — GLYPHH IMAGE / VIDEO / SOUNDS, the desktop transport.
 * Thin IPC over the house store (shared/house-store.ts): the libraries live
 * in the member library, their bytes on R2 (his order, 2026-10-06: cloud is
 * the one home). The desktop's own part is the two dialogs — Upload picks a
 * file off this disk, Download writes one to it — and the bearer never
 * reaches the renderer: a panel plays a presigned URL the store mints.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { basename } from "node:path";
import { dialog, ipcMain } from "electron";
import { houseStore } from "./house-store.js";
import { mediaMimeOf, type MediaKind } from "../shared/house-store.js";

const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** Upload a file from this disk into its library. */
export async function uploadMediaFile(path: string, opts: { title?: string; kind?: string } = {}): Promise<{ id: string; kind: MediaKind; title: string }> {
  const mime = mediaMimeOf(path);
  if (!mime) throw new Error(`unsupported file type "${path.slice(path.lastIndexOf("."))}"`);
  const r = await houseStore().mediaAdd(opts.kind, opts.title ? `${opts.title}${path.slice(path.lastIndexOf("."))}` : basename(path), new Uint8Array(readFileSync(path)), mime);
  if (!r.ok) throw new Error(r.error);
  return { id: r.id, kind: r.kind, title: r.title };
}

export function registerMediaPanelIpc(): void {
  const store = () => houseStore();
  ipcMain.handle("media-list", (_e, kind?: unknown, q?: unknown) => store().mediaList(kind, q));
  ipcMain.handle("media-url", (_e, id: unknown) => store().mediaUrl(id));
  // First-frame capture support: the raw bytes fetched HERE — Node has no
  // CORS. The renderer wraps them in a same-origin Blob and captures cleanly.
  ipcMain.handle("media-thumb-bytes", (_e, id: unknown) => store().mediaThumbBytes(id));
  ipcMain.handle("media-delete", (_e, id: unknown) => store().mediaDelete(id));
  // GLYPHH MAKES NO MODEL CALLS (his ruling, 2026-09-18, and the same rule
  // that retired llm.complete and agent.run in the app runtime): the driving
  // agent generates, and files what it made with the app's own save tool.
  // There is no server job to start and none to poll.
  ipcMain.handle("media-generate", () => ({
    ok: false,
    error: "Ask the agent to make it — it generates and saves into this app's library. Glyphh itself makes no model calls.",
  }));
  ipcMain.handle("media-job", () => ({
    ok: false,
    error: "Generation runs in the agent, not on a server, so there is no job to poll.",
  }));
  ipcMain.handle("media-save", async (_e, id: unknown) => {
    try {
      const r = await store().mediaBytes(id);
      if (!r.ok) return r;
      const picked = await dialog.showSaveDialog({ defaultPath: r.name });
      if (picked.canceled || !picked.filePath) return { ok: false, error: "cancelled" };
      writeFileSync(picked.filePath, r.bytes);
      return { ok: true, path: picked.filePath, bytes: r.bytes.byteLength };
    } catch (err) {
      return { ok: false, error: errText(err) };
    }
  });
  ipcMain.handle("media-upload-pick", async () => {
    try {
      const picked = await dialog.showOpenDialog({
        properties: ["openFile"],
        filters: [
          { name: "Media", extensions: ["png", "jpg", "jpeg", "webp", "gif", "mp4", "webm", "mov", "mp3", "m4a", "wav", "ogg"] },
        ],
      });
      const path = picked.filePaths[0];
      if (picked.canceled || !path) return { ok: false, error: "cancelled" };
      return { ok: true, ...(await uploadMediaFile(path)) };
    } catch (err) {
      return { ok: false, error: errText(err) };
    }
  });
  ipcMain.handle("media-upload-file", async (_e, path: unknown, opts: unknown) => {
    try {
      return { ok: true, ...(await uploadMediaFile(String(path), (opts ?? {}) as { title?: string; kind?: string })) };
    } catch (err) {
      return { ok: false, error: errText(err) };
    }
  });
}
