/**
 * artifacts-local.ts — Artifacts, on this machine.
 *
 * His ruling, 2026-09-18: artifacts are local files, like every other library
 * the app shows. They used to be R2 objects reached through the SDK's `files`
 * resource, which the fork never implemented, so the page opened on
 * "Couldn't load artifacts: ApiError: HTTP 404".
 *
 * Same shape as media-local.ts, and for the same reason: an artifact is an app's
 * file, so they live in `app-data/artifacts/files/` under the signed-in user,
 * and THE DIRECTORY IS THE INDEX. A file dropped in by hand is an artifact; a
 * file deleted is gone; there is no manifest to reconcile. The id is the
 * filename, so nothing has to be looked up to open one.
 *
 * An artifact's comments (artifact-comments.ts) sit beside `files/`, keyed by
 * that id: a rename here moves them, a delete drops them, and a new artifact
 * never inherits the threads of one deleted by hand under the same name.
 */

import fs from "fs";
import path from "path";
import { pathToFileURL } from "url";
import { appDataDir } from "./glyphh-app-services.js";
import { dropComments, moveComments } from "./artifact-comments.js";

export type ArtifactKind = "code" | "text" | "markdown" | "image" | "pdf" | "other";

export interface LocalArtifact {
  id: string;
  name: string;
  mime: string;
  kind: ArtifactKind;
  sessionId: string | null;
  sizeBytes: number;
  createdAt: string;
  /** Where it actually is, so the workbench can open it without a round trip. */
  path: string;
  /** file:// for an image or a PDF the viewer renders directly. */
  downloadUrl: string;
}

const MIME: Record<string, string> = {
  ".md": "text/markdown", ".markdown": "text/markdown",
  ".txt": "text/plain", ".log": "text/plain", ".csv": "text/csv",
  ".json": "application/json", ".yaml": "text/yaml", ".yml": "text/yaml",
  ".js": "text/javascript", ".mjs": "text/javascript", ".ts": "text/typescript",
  ".tsx": "text/typescript", ".jsx": "text/javascript", ".py": "text/x-python",
  ".rb": "text/x-ruby", ".go": "text/x-go", ".rs": "text/x-rust", ".java": "text/x-java",
  ".c": "text/x-c", ".h": "text/x-c", ".cpp": "text/x-c++", ".cs": "text/x-csharp",
  ".sh": "text/x-sh", ".sql": "text/x-sql", ".html": "text/html", ".css": "text/css",
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif",
  ".webp": "image/webp", ".svg": "image/svg+xml", ".avif": "image/avif",
  ".pdf": "application/pdf", ".zip": "application/zip",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".mp4": "video/mp4", ".mp3": "audio/mpeg", ".wav": "audio/wav",
};

const CODE_EXT = new Set([
  ".js", ".mjs", ".ts", ".tsx", ".jsx", ".py", ".rb", ".go", ".rs", ".java", ".c", ".h",
  ".cpp", ".cs", ".sh", ".sql", ".html", ".css", ".json", ".yaml", ".yml",
]);

export function mimeForName(name: string): string {
  return MIME[path.extname(name).toLowerCase()] || "text/plain";
}

export function kindOf(name: string, mime: string): ArtifactKind {
  const ext = path.extname(name).toLowerCase();
  if (mime.startsWith("image/")) return "image";
  if (mime === "application/pdf") return "pdf";
  if (mime === "text/markdown") return "markdown";
  if (CODE_EXT.has(ext)) return "code";
  if (mime.startsWith("text/")) return "text";
  return "other";
}

/** Where artifacts live. Created on demand, so a fresh machine opens on an
 *  empty gallery rather than an error. */
export function artifactsDir(): string {
  const dir = path.join(appDataDir("artifacts"), "files");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** The file behind an id, or null when the id reaches outside the folder. */
export function pathOf(id: string): string | null {
  const name = String(id || "");
  if (!name || name.includes("..") || name.includes("/") || name.includes("\\") || path.isAbsolute(name)) return null;
  const dir = artifactsDir();
  const full = path.join(dir, name);
  return full.startsWith(dir + path.sep) ? full : null;
}

function rowOf(name: string): LocalArtifact | null {
  const full = path.join(artifactsDir(), name);
  let st: fs.Stats;
  try { st = fs.statSync(full); } catch { return null; }
  if (!st.isFile() || name.startsWith(".")) return null;
  const mime = mimeForName(name);
  return {
    id: name,
    name,
    mime,
    kind: kindOf(name, mime),
    sessionId: null,
    sizeBytes: st.size,
    createdAt: new Date(st.mtimeMs).toISOString(),
    path: full,
    downloadUrl: pathToFileURL(full).href,
  };
}

export function list(): LocalArtifact[] {
  let names: string[] = [];
  try { names = fs.readdirSync(artifactsDir()); } catch { names = []; }
  return names
    .map(rowOf)
    .filter((a): a is LocalArtifact => a !== null)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function get(id: string): LocalArtifact {
  const full = pathOf(id);
  const row = full ? rowOf(path.basename(full)) : null;
  if (!row) throw new Error("that artifact is no longer here");
  return row;
}

/** The text an editor opens. Binary kinds are read through their file:// URL. */
export function readText(id: string): string {
  const full = pathOf(id);
  if (!full) throw new Error("that artifact is no longer here");
  const st = fs.statSync(full);
  if (st.size > 2 * 1024 * 1024) throw new Error("that artifact is over the 2MB editor cap");
  return fs.readFileSync(full, "utf8");
}

/** The first lines of a text artifact, for the grid's preview tile. */
export function peek(id: string, maxBytes = 2048): string {
  const full = pathOf(id);
  if (!full) return "";
  try {
    const fd = fs.openSync(full, "r");
    const buf = Buffer.alloc(maxBytes);
    const read = fs.readSync(fd, buf, 0, maxBytes, 0);
    fs.closeSync(fd);
    return buf.subarray(0, read).toString("utf8");
  } catch {
    return "";
  }
}

function uniqueName(name: string): string {
  const dir = artifactsDir();
  const ext = path.extname(name) || ".md";
  const base = path.basename(name, ext).replace(/[/\\:*?"<>|]+/g, "-").slice(0, 120) || "untitled";
  let candidate = `${base}${ext}`;
  for (let i = 2; fs.existsSync(path.join(dir, candidate)); i++) candidate = `${base} ${i}${ext}`;
  return candidate;
}

export function create(name: string, content = ""): LocalArtifact {
  const chosen = uniqueName(name || "untitled.md");
  dropComments(chosen);
  fs.writeFileSync(path.join(artifactsDir(), chosen), content, "utf8");
  return get(chosen);
}

/** Save an artifact the agent or a panel produced, bytes and all. */
export function write(name: string, data: Buffer): LocalArtifact {
  const chosen = uniqueName(name);
  dropComments(chosen);
  fs.writeFileSync(path.join(artifactsDir(), chosen), data);
  return get(chosen);
}

/** Replace an artifact's content in place: text from an editor, or bytes. */
export function save(id: string, content: string | Buffer): LocalArtifact {
  const full = pathOf(id);
  if (!full) throw new Error("that artifact is no longer here");
  if (typeof content === "string") fs.writeFileSync(full, content, "utf8");
  else fs.writeFileSync(full, content);
  return get(id);
}

/** A rename that drops the extension keeps the old one: the type is the extension. */
export function renameTarget(current: string, wanted: string): string {
  const name = String(wanted || "").replace(/\s+/g, " ").trim();
  if (!name) throw new Error("a name is required");
  return path.extname(name) ? name : `${name}${path.extname(current)}`;
}

export function rename(id: string, name: string): LocalArtifact {
  const full = pathOf(id);
  if (!full || !fs.existsSync(full)) throw new Error("that artifact is no longer here");
  if (name === path.basename(full)) return get(id);
  const chosen = uniqueName(name);
  fs.renameSync(full, path.join(artifactsDir(), chosen));
  moveComments(path.basename(full), chosen);
  return get(chosen);
}

export function remove(id: string): void {
  const full = pathOf(id);
  if (!full) return;
  fs.rmSync(full, { force: true });
  dropComments(path.basename(full));
}
