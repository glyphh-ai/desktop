/**
 * artifact-comments.ts — THE ARTIFACTS PANEL'S COMMENTS, on this machine.
 *
 * Local only (2026-10-18): the comments that used to live on the server's
 * /api/artifacts/{id}/comments are one JSON file per artifact in
 * `app-data/artifacts/comments/`, a sibling of the `files/` folder that IS
 * the artifact index (artifacts-local.ts), so a comment file can never show
 * up as an artifact. The artifact's id is its filename, so the comment file
 * is `<id>.json`; a rename moves it (moveComments) and a delete drops it
 * (dropComments) — artifacts-local.ts calls both, so the Files gallery, the
 * panel and the agent all keep an artifact's threads with it.
 *
 * Stored flat (every comment with its parentId), answered as threads: a root
 * comment with its replies under it, oldest first. A reply to a reply joins
 * the root's thread — the panel shows one level. Writes go through a temp
 * file and a rename, so a crash mid-write leaves the old file whole.
 */

import fs from "fs";
import path from "path";
import { randomUUID } from "crypto";
import { appDataDir } from "./glyphh-app-services.js";

export interface CommentRegion { x: number; y: number; w: number; h: number }
export interface CommentAuthor { id: string; name: string; avatarUrl: string | null }

/** One comment as the panel reads it (artifact-rules.ts ArtifactComment). */
export interface ArtifactCommentThread {
  id: string;
  author: CommentAuthor;
  region: CommentRegion | null;
  text: string;
  resolved: boolean;
  createdAt: string;
  replies: ArtifactCommentThread[];
  /** Glyphh's own reply in the thread. */
  agent?: boolean;
}

export interface NewComment { text: string; region?: unknown; parentId?: string; agent?: boolean }

/** What the file holds: every comment, flat. */
interface StoredComment {
  id: string;
  parentId: string | null;
  author: CommentAuthor;
  region: CommentRegion | null;
  text: string;
  resolved: boolean;
  createdAt: string;
  agent?: boolean;
}

/** Glyphh's replies are signed as Glyphh, not as the local user. */
export const GLYPHH_AUTHOR: Readonly<CommentAuthor> = Object.freeze({ id: "glyphh", name: "Glyphh", avatarUrl: null });
export const COMMENT_TEXT_MAX = 10_000;

export function commentsDir(): string {
  const dir = path.join(appDataDir("artifacts"), "comments");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** The comment file behind an artifact id, or null when the id reaches outside. */
function fileOf(id: string): string | null {
  const name = String(id || "");
  if (!name || name.includes("..") || name.includes("/") || name.includes("\\") || path.isAbsolute(name)) return null;
  return path.join(commentsDir(), `${name}.json`);
}

function readAll(id: string): StoredComment[] {
  const file = fileOf(id);
  if (!file) return [];
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
    return Array.isArray(parsed) ? (parsed as StoredComment[]).filter((c) => c && typeof c.id === "string") : [];
  } catch {
    return [];
  }
}

function writeAll(id: string, rows: StoredComment[]): void {
  const file = fileOf(id);
  if (!file) throw new Error("that artifact is no longer here");
  if (!rows.length) { fs.rmSync(file, { force: true }); return; }
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(rows, null, 2), "utf8");
  fs.renameSync(tmp, file);
}

const stamp = (iso: string): number => { const t = Date.parse(iso); return Number.isFinite(t) ? t : 0; };
const byTime = (a: StoredComment, b: StoredComment): number => stamp(a.createdAt) - stamp(b.createdAt);

function threadOf(root: StoredComment, all: StoredComment[]): ArtifactCommentThread {
  const replies = all.filter((c) => c.parentId === root.id).sort(byTime).map((c) => threadOf(c, []));
  return {
    id: root.id,
    author: root.author,
    region: root.region,
    text: root.text,
    resolved: root.resolved,
    createdAt: root.createdAt,
    replies,
    ...(root.agent ? { agent: true } : {}),
  };
}

/** A drawn region is four fractions of the frame; anything else is no region. */
export function regionOf(raw: unknown): CommentRegion | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const n = (k: string): number | null => (typeof r[k] === "number" && Number.isFinite(r[k]) && (r[k] as number) >= 0 && (r[k] as number) <= 1 ? (r[k] as number) : null);
  const x = n("x"), y = n("y"), w = n("w"), h = n("h");
  return x === null || y === null || w === null || h === null ? null : { x, y, w, h };
}

/** Every thread on the artifact, oldest first (the panel orders open before resolved). */
export function listThreads(id: string): ArtifactCommentThread[] {
  const all = readAll(id);
  return all.filter((c) => !c.parentId).sort(byTime).map((c) => threadOf(c, all));
}

/** A new thread, or a reply when `parentId` names one (a reply to a reply joins its root). */
export function addComment(id: string, input: NewComment, author: CommentAuthor): ArtifactCommentThread {
  const text = String(input?.text ?? "").trim();
  if (!text) throw new Error("a comment needs text");
  if (text.length > COMMENT_TEXT_MAX) throw new Error(`a comment is ${COMMENT_TEXT_MAX} characters at most`);
  const all = readAll(id);
  let parentId: string | null = null;
  if (input?.parentId) {
    const parent = all.find((c) => c.id === String(input.parentId));
    if (!parent) throw new Error("that comment is no longer here");
    parentId = parent.parentId ?? parent.id;
  }
  const row: StoredComment = {
    id: `c_${randomUUID().replace(/-/g, "").slice(0, 16)}`,
    parentId,
    author: input?.agent === true ? { ...GLYPHH_AUTHOR } : { id: author.id, name: author.name, avatarUrl: author.avatarUrl ?? null },
    // A reply rides its thread's region; only a thread's opening line draws one.
    region: parentId ? null : regionOf(input?.region),
    text,
    resolved: false,
    createdAt: new Date().toISOString(),
    ...(input?.agent === true ? { agent: true } : {}),
  };
  all.push(row);
  writeAll(id, all);
  return threadOf(row, all);
}

/** Resolve or reopen a thread; answers the whole thread, replies and all. */
export function patchComment(id: string, cid: string, patch: { resolved: boolean }): ArtifactCommentThread {
  const all = readAll(id);
  const row = all.find((c) => c.id === String(cid || ""));
  if (!row) throw new Error("that comment is no longer here");
  row.resolved = !!patch?.resolved;
  writeAll(id, all);
  return threadOf(row, all);
}

/** Delete a comment; a thread's opening line takes its replies with it. */
export function deleteComment(id: string, cid: string): void {
  const all = readAll(id);
  const target = String(cid || "");
  if (!all.some((c) => c.id === target)) throw new Error("that comment is no longer here");
  writeAll(id, all.filter((c) => c.id !== target && c.parentId !== target));
}

/** A rename changed the artifact's id: its threads go with it. */
export function moveComments(fromId: string, toId: string): void {
  const from = fileOf(fromId), to = fileOf(toId);
  if (!from || !to || from === to || !fs.existsSync(from)) return;
  fs.renameSync(from, to);
}

/** The artifact is gone: so are its threads. */
export function dropComments(id: string): void {
  const file = fileOf(id);
  if (file) fs.rmSync(file, { force: true });
}
