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
  const media = getClient().media;
  const ticket = await media.uploadTicket({
    kind, mime,
    title: opts.title ?? basename(path),
    sizeBytes: bytes.byteLength,
  });
  if (ticket.url) {
    const res = await fetch(ticket.url, { method: "PUT", headers: { "content-type": mime }, body: new Uint8Array(bytes) });
    if (!res.ok) throw new Error(`presigned upload failed: ${res.status}`);
  } else {
    await media.putBytes(ticket.asset.id, new Uint8Array(bytes));
  }
  const done = await media.finalize(ticket.asset.id);
  return { id: done.id, kind: done.kind, title: done.title };
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
  ipcMain.handle("media-list", async (_e, kind?: unknown, q?: unknown) => {
    try {
      const assets = await getClient().media.list(kind ? (String(kind) as MediaKind) : undefined, q ? String(q) : undefined);
      return { ok: true, assets };
    } catch (err) {
      return { ok: false, error: errText(err), assets: [] };
    }
  });
  ipcMain.handle("media-url", async (_e, id: unknown) => {
    try {
      return { ok: true, url: await mediaFileUrl(String(id)) };
    } catch (err) {
      return { ok: false, error: errText(err) };
    }
  });
  ipcMain.handle("media-delete", async (_e, id: unknown) => {
    try {
      await getClient().media.delete(String(id));
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
