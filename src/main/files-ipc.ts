/**
 * files-ipc.ts — the desktop renderer's transport to the FILES artifact store
 * (the user's saved code/text/markdown/image/pdf artifacts, R2-backed).
 *
 * The renderer has no SDK handle (preload boundary), so these thin IPC methods
 * call the MAIN-process @glyphh/sdk client — the same authed client every other
 * control-plane call uses (getClient(), the token harnessRun rides). Same shape
 * as account-ipc.ts / threads-ipc.ts.
 *
 * Reads (list/get) propagate rejections so the renderer can paint an honest
 * error state rather than a fake-empty gallery. The write (create) returns an
 * `{ ok, file, error }` envelope, because a quota/permission refusal is an
 * EXPECTED outcome the form must explain, not an exception to decode.
 */

import { ipcMain } from "electron";
import type { CreateFileInput } from "@glyphh/sdk";
import { getClient } from "./glyphh-client";

/** Shape a write failure the way the Files form renders it. */
function fail(err: unknown): { ok: false; error: string } {
  return { ok: false, error: err instanceof Error ? err.message : String(err) };
}

export function registerFilesIpc(): void {
  // Reads — the caller's artifacts (newest first) and one artifact by id (the
  // get carries a short-lived downloadUrl the renderer's viewer reads directly).
  ipcMain.handle("files-list", () => getClient().files.list());
  ipcMain.handle("files-get", (_e, id: string) => getClient().files.get(String(id || "")));

  // Write — save an artifact on the caller's behalf (bytes arrive base64).
  ipcMain.handle("files-create", async (_e, input: CreateFileInput) => {
    try { return { ok: true as const, file: await getClient().files.create(input) }; }
    catch (err) { return fail(err); }
  });
}
