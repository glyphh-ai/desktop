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
import { getClient } from "./glyphh-client";
import type { MediaKind } from "@glyphh/sdk";

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

