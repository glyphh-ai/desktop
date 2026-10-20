/**
 * artifacts-ipc.ts — THE ARTIFACTS PANEL's desktop transport (his order,
 * 2026-10-05: "on the web and desktop i want there to also be an artifacts
 * web panel… We should allow the comment… feature").
 *
 * LOCAL ONLY (2026-10-18): there is no server. The panel's artifacts are the
 * files in artifacts-local.ts's folder and their comments are
 * artifact-comments.ts's, both under the local user; sharing is gone with the
 * server (one user, nobody to share with). The channels:
 *
 *   artifacts-list                 every artifact, newest first
 *   artifacts-get        (id)      one row
 *   artifacts-content    (id)      the bytes, base64, with their mime
 *   artifacts-update     (id, { name })   a rename — the id is the filename,
 *                                         so the answer carries the new id
 *   artifacts-delete     (id)      the file and its comments
 *   artifacts-comments   (id)      the threads, replies under each
 *   artifacts-comment-add    (id, { text, region?, parentId?, agent? })
 *   artifacts-comment-patch  (id, cid, { resolved })
 *   artifacts-comment-delete (id, cid)
 *
 * Every answer is an `{ ok, data | error }` envelope (never a throw across
 * the bridge). The web's counterpart is web/src/web-contract.js's artifacts*
 * shims — same names, same envelopes — so help/artifacts-panel.ts paints one
 * way.
 */

import fs from "fs";
import { ipcMain } from "electron";
import * as local from "./artifacts-local.js";
import * as comments from "./artifact-comments.js";
import { getAccountInfo, LOCAL_USER_ID } from "./auth.js";

type Env<T> = { ok: true; data: T } | { ok: false; error: string };

/** The panel's row (renderer/help/artifact-rules.ts ArtifactMeta). */
export interface ArtifactRow {
  id: string;
  name: string;
  mime: string;
  sizeBytes: number;
  sessionId: string | null;
  createdAt: string;
  updatedAt: string;
}

/** A local file as the panel's row. The folder keeps one clock, the file's
 *  mtime, so it is both the creation and the last edit. */
export function rowOf(a: local.LocalArtifact): ArtifactRow {
  return { id: a.id, name: a.name, mime: a.mime, sizeBytes: a.sizeBytes, sessionId: a.sessionId, createdAt: a.createdAt, updatedAt: a.createdAt };
}

/** The comment author: the one local user. */
function author(): comments.CommentAuthor {
  const a = getAccountInfo();
  const name = [a?.firstName, a?.lastName].filter(Boolean).join(" ").trim() || "You";
  return { id: LOCAL_USER_ID, name, avatarUrl: a?.avatarUrl || null };
}

function run<T>(work: () => T): Env<T> {
  try { return { ok: true, data: work() }; }
  catch (err) { return { ok: false, error: err instanceof Error ? err.message : String(err) }; }
}

/** The artifact must still be there before its comments are read or written. */
const known = (id: string): string => local.get(String(id || "")).id;

export function registerArtifactsIpc(): void {
  ipcMain.handle("artifacts-list", () => run(() => local.list().map(rowOf)));
  ipcMain.handle("artifacts-get", (_e, id: string) => run(() => rowOf(local.get(String(id || "")))));
  // The bytes: main reads the file and hands it over base64 with its mime;
  // the renderer frames a blob URL in a sandboxed iframe.
  ipcMain.handle("artifacts-content", (_e, id: string) => run(() => {
    const a = local.get(String(id || ""));
    return { base64: fs.readFileSync(a.path).toString("base64"), mime: a.mime || "application/octet-stream" };
  }));
  ipcMain.handle("artifacts-update", (_e, id: string, patch: { name?: string }) => run(() => {
    const a = local.get(String(id || ""));
    if (typeof patch?.name !== "string") return rowOf(a);
    return rowOf(local.rename(a.id, local.renameTarget(a.name, patch.name)));
  }));
  ipcMain.handle("artifacts-delete", (_e, id: string) => run(() => { local.remove(known(id)); return {}; }));
  ipcMain.handle("artifacts-comments", (_e, id: string) => run(() => comments.listThreads(known(id))));
  ipcMain.handle("artifacts-comment-add", (_e, id: string, input: comments.NewComment) =>
    run(() => comments.addComment(known(id), input ?? { text: "" }, author())));
  ipcMain.handle("artifacts-comment-patch", (_e, id: string, cid: string, patch: { resolved: boolean }) =>
    run(() => comments.patchComment(known(id), String(cid || ""), { resolved: !!patch?.resolved })));
  ipcMain.handle("artifacts-comment-delete", (_e, id: string, cid: string) =>
    run(() => { comments.deleteComment(known(id), String(cid || "")); return {}; }));
}
