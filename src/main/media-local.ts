/**
 * media-local.ts — the Images, Audio and Video libraries, on this machine.
 *
 * His ruling, 2026-09-18: these panels are APPS, so their files live where
 * every other app's data lives — `app-data/<slug>/files/` under the signed-in
 * user — and nothing about them is fetched from a server. The library used to
 * ask the old server for `/api/media`, a route the fork never implemented, so
 * every panel opened on "Couldn't load the library. HTTP 404".
 *
 * THE DIRECTORY IS THE INDEX. No manifest to write, corrupt or reconcile: a
 * file that is there is in the library, a file that is gone is not, and a file
 * the user drops in by hand shows up. Id is the filename, which is also what
 * makes a URL, so nothing has to be looked up to play something.
 */

import fs from "fs";
import path from "path";
import { appDataDir } from "./glyphh-app-services.js";

export type MediaKind = "image" | "audio" | "video";

/** Each panel is its own app, and owns its own files. */
export const APP_OF: Record<MediaKind, string> = { image: "images", audio: "audio", video: "video" };

const MIME: Record<string, string> = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif",
  ".webp": "image/webp", ".svg": "image/svg+xml", ".avif": "image/avif", ".bmp": "image/bmp",
  ".mp3": "audio/mpeg", ".wav": "audio/wav", ".m4a": "audio/mp4", ".ogg": "audio/ogg", ".flac": "audio/flac",
  ".mp4": "video/mp4", ".mov": "video/quicktime", ".webm": "video/webm", ".mkv": "video/x-matroska",
};

const KIND_OF_MIME = (mime: string): MediaKind | null =>
  mime.startsWith("image/") ? "image" : mime.startsWith("audio/") ? "audio" : mime.startsWith("video/") ? "video" : null;

export interface LocalAsset {
  id: string;
  kind: MediaKind;
  title: string;
  mime: string;
  sizeBytes: number;
  width: number | null;
  height: number | null;
  durationMs: number | null;
  status: "ready";
  meta: Record<string, unknown>;
  updatedAt: string;
}

/** Where one kind's files live. Created on demand, so a fresh machine opens
 *  on an empty library rather than an error. */
export function mediaDir(kind: MediaKind): string {
  const dir = path.join(appDataDir(APP_OF[kind]), "files");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** `<kind>/<filename>` — enough to find the file again with no index. */
const idOf = (kind: MediaKind, name: string): string => `${kind}/${name}`;

/** The file behind an id, or null when the id reaches outside its library. */
export function pathOf(id: string): string | null {
  const [kind, ...rest] = String(id || "").split("/");
  const name = rest.join("/");
  if (!name || !(kind in APP_OF) || name.includes("..") || path.isAbsolute(name)) return null;
  const dir = mediaDir(kind as MediaKind);
  const full = path.join(dir, name);
  // Never follow a name back out of the library, whatever it contains.
  return full.startsWith(dir + path.sep) ? full : null;
}

function assetOf(kind: MediaKind, name: string): LocalAsset | null {
  const full = path.join(mediaDir(kind), name);
  let st: fs.Stats;
  try { st = fs.statSync(full); } catch { return null; }
  if (!st.isFile()) return null;
  const mime = MIME[path.extname(name).toLowerCase()] ?? "";
  if (KIND_OF_MIME(mime) !== kind) return null;
  return {
    id: idOf(kind, name), kind, title: path.basename(name, path.extname(name)),
    mime, sizeBytes: st.size, width: null, height: null, durationMs: null,
    status: "ready", meta: {}, updatedAt: new Date(st.mtimeMs).toISOString(),
  };
}

export function list(kind?: MediaKind, q?: string): LocalAsset[] {
  const kinds: MediaKind[] = kind ? [kind] : (Object.keys(APP_OF) as MediaKind[]);
  const needle = (q || "").trim().toLowerCase();
  const out: LocalAsset[] = [];
  for (const k of kinds) {
    let names: string[] = [];
    try { names = fs.readdirSync(mediaDir(k)); } catch { names = []; }
    for (const n of names) {
      const a = assetOf(k, n);
      if (a && (!needle || a.title.toLowerCase().includes(needle))) out.push(a);
    }
  }
  return out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export function get(id: string): LocalAsset {
  const full = pathOf(id);
  const kind = String(id).split("/")[0] as MediaKind;
  const a = full ? assetOf(kind, path.basename(full)) : null;
  if (!a) throw new Error("that file is no longer in your library");
  return a;
}

export function bytes(id: string): Buffer {
  const full = pathOf(id);
  if (!full) throw new Error("that file is no longer in your library");
  return fs.readFileSync(full);
}

/** Write a file into its library, without overwriting one already there. */
export function save(kind: MediaKind, name: string, data: Buffer): LocalAsset {
  const dir = mediaDir(kind);
  const ext = path.extname(name) || ".bin";
  const base = path.basename(name, ext).replace(/[/\\:*?"<>|]+/g, "-").slice(0, 120) || "untitled";
  let candidate = `${base}${ext}`;
  for (let i = 2; fs.existsSync(path.join(dir, candidate)); i++) candidate = `${base} ${i}${ext}`;
  fs.writeFileSync(path.join(dir, candidate), data);
  const a = assetOf(kind, candidate);
  if (!a) throw new Error(`${ext} isn't a file this library can hold`);
  return a;
}

export function remove(id: string): void {
  const full = pathOf(id);
  if (full) fs.rmSync(full, { force: true });
}

/** What the panel plays: the file itself, straight off the disk. */
export function fileUrl(id: string): string {
  const full = pathOf(id);
  if (!full) throw new Error("that file is no longer in your library");
  return `file://${full}`;
}
