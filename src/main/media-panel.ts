/**
 * media-panel.ts — GLYPHH IMAGE / VIDEO / SOUNDS, the desktop transport.
 * Thin IPC over client.media, plus the one desktop-only concern: PLAYBACK.
 * The store presigns a direct URL when it can; when it can't (local dev),
 * the main process downloads the bytes once into a tmp cache and hands the
 * renderer a file:// path — the bearer never reaches the renderer either way.
 */

import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, basename, extname } from "node:path";
import { dialog, ipcMain } from "electron";
import { getClient } from "./glyphh-client";
import * as local from "./media-local.js";
import type { MediaKind } from "@glyphh/sdk";

const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

const MIMES: Record<string, string> = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif",
  ".mp4": "video/mp4", ".webm": "video/webm", ".mov": "video/quicktime",
  ".mp3": "audio/mpeg", ".m4a": "audio/mp4", ".wav": "audio/wav", ".ogg": "audio/ogg",
  ".txt": "text/plain", ".md": "text/markdown",
};
const EXT_BY_MIME: Record<string, string> = Object.fromEntries(Object.entries(MIMES).map(([e, m]) => [m, e]));

export function kindForMime(mime: string): MediaKind {
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("video/")) return "video";
  if (mime.startsWith("audio/")) return "audio";
  return "script";
}

/** Upload a local file into the org library — presigned when possible. */
export async function uploadMediaFile(path: string, opts: { title?: string; kind?: MediaKind } = {}): Promise<{ id: string; kind: MediaKind; title: string }> {
  const mime = MIMES[extname(path).toLowerCase()];
  if (!mime) throw new Error(`unsupported file type "${extname(path)}"`);
  const bytes = readFileSync(path);
  const kind = opts.kind ?? kindForMime(mime);
  if (kind === "script") throw new Error(`unsupported file type "${extname(path)}"`);
  const done = local.save(kind as local.MediaKind, opts.title ?? basename(path), bytes);
  return { id: done.id, kind: done.kind as MediaKind, title: done.title };
}

/** A URL the renderer can play directly: presigned when the store can, else a
 *  tmp-cached file:// (cache-keyed by asset id + mime — assets are immutable). */
export async function mediaFileUrl(id: string): Promise<string> {
  const media = getClient().media;
  const { url } = await media.playbackUrl(id);
  if (url) return url;
  const asset = await media.get(id);
  const dir = join(tmpdir(), "glyphh-media-cache");
  mkdirSync(dir, { recursive: true });
  const name = `${createHash("sha1").update(id).digest("hex").slice(0, 16)}${EXT_BY_MIME[asset.mime] ?? ".bin"}`;
  const dest = join(dir, name);
  if (!existsSync(dest)) {
    const bytes = await media.bytes(id);
    writeFileSync(dest, Buffer.from(bytes));
  }
  return `file://${dest}`;
}

export function registerMediaPanelIpc(): void {
  // THE LIBRARY IS ON THIS MACHINE (his ruling, 2026-09-18). These panels are
  // apps, so their files sit in app-data/<slug>/files like every other app's
  // data. The old lane asked the server for /api/media, which the fork never
  // implemented, so every panel opened on "Couldn't load the library".
  ipcMain.handle("media-list", (_e, kind?: unknown, q?: unknown) => {
    try {
      const k = kind ? String(kind) : "";
      const only = k === "image" || k === "audio" || k === "video" ? (k as local.MediaKind) : undefined;
      return { ok: true, assets: local.list(only, q ? String(q) : undefined) };
    } catch (err) {
      return { ok: false, error: errText(err), assets: [] };
    }
  });
  ipcMain.handle("media-url", (_e, id: unknown) => {
    try {
      return { ok: true, url: local.fileUrl(String(id)) };
    } catch (err) {
      return { ok: false, error: errText(err) };
    }
  });
  // First-frame capture support: the raw bytes fetched HERE — Node has no
  // CORS. The store's presigned URLs carry no CORS headers, so the renderer's
  // crossOrigin <video> load simply errored and every video card sat on its
  // placeholder instead of a still (his report, 2026-09-08). The renderer
  // wraps these bytes in a same-origin Blob and captures cleanly.
  ipcMain.handle("media-thumb-bytes", (_e, id: unknown) => {
    const THUMB_BYTES_CAP = 64 * 1024 * 1024; // a thumbnail is not worth a 500MB read
    try {
      const asset = local.get(String(id));
      if (asset.sizeBytes > THUMB_BYTES_CAP) return { ok: false, error: "too large for capture" };
      return { ok: true, bytes: new Uint8Array(local.bytes(String(id))), mime: asset.mime };
    } catch (err) {
      return { ok: false, error: errText(err) };
    }
  });
  ipcMain.handle("media-delete", (_e, id: unknown) => {
    try {
      local.remove(String(id));
      return { ok: true };
    } catch (err) {
      return { ok: false, error: errText(err) };
    }
  });
  ipcMain.handle("media-generate", async (_e, input: unknown) => {
    try {
      const started = await getClient().media.generate(input as Parameters<ReturnType<typeof getClient>["media"]["generate"]>[0]);
      return { ok: true, job: started.job, outputKind: started.outputKind };
    } catch (err) {
      return { ok: false, error: errText(err) };
    }
  });
  ipcMain.handle("media-job", async (_e, id: unknown) => {
    try {
      return { ok: true, job: await getClient().media.job(String(id)) };
    } catch (err) {
      return { ok: false, error: errText(err) };
    }
  });
  ipcMain.handle("media-save", async (_e, id: unknown) => {
    try {
      const asset = local.get(String(id));
      const ext = EXT_BY_MIME[asset.mime] ?? ".bin";
      const stem = asset.title.replace(/[^\w\s.-]/g, "").trim().replace(/\s+/g, "-").toLowerCase() || "media";
      const picked = await dialog.showSaveDialog({ defaultPath: `${stem}${ext}` });
      if (picked.canceled || !picked.filePath) return { ok: false, error: "cancelled" };
      const bytes = local.bytes(String(id));
      writeFileSync(picked.filePath, Buffer.from(bytes));
      return { ok: true, path: picked.filePath, bytes: bytes.byteLength };
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
      const r = await uploadMediaFile(path);
      return { ok: true, ...r };
    } catch (err) {
      return { ok: false, error: errText(err) };
    }
  });
  ipcMain.handle("media-upload-file", async (_e, path: unknown, opts: unknown) => {
    try {
      const r = await uploadMediaFile(String(path), (opts ?? {}) as { title?: string; kind?: MediaKind });
      return { ok: true, ...r };
    } catch (err) {
      return { ok: false, error: errText(err) };
    }
  });
}
