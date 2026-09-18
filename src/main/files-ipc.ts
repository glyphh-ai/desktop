/**
 * files-ipc.ts — the renderer's transport to the ARTIFACTS store.
 *
 * His ruling, 2026-09-18: artifacts are LOCAL files. These used to call the
 * control plane's `files` resource, which the fork never implemented, so every
 * read came back "ApiError: HTTP 404" and the gallery could only ever be empty.
 * They read and write `app-data/artifacts/files/` now (artifacts-local.ts).
 *
 * Reads propagate rejections so the renderer paints an honest error rather than
 * a fake-empty gallery. Writes return an `{ ok, … , error }` envelope, because
 * a refused name is an expected outcome the form explains, not an exception to
 * decode.
 */

import { ipcMain } from "electron";
import * as artifacts from "./artifacts-local.js";

function fail(err: unknown): { ok: false; error: string } {
  return { ok: false, error: err instanceof Error ? err.message : String(err) };
}

export function registerFilesIpc(): void {
  ipcMain.handle("files-list", () => artifacts.list());
  ipcMain.handle("files-get", (_e, id: string) => artifacts.get(String(id || "")));
  /** The grid's preview tile: the opening bytes of a text artifact. */
  ipcMain.handle("files-peek", (_e, id: string) => artifacts.peek(String(id || "")));

  ipcMain.handle("files-create", (_e, input: { name?: string; content?: string }) => {
    try { return { ok: true as const, file: artifacts.create(String(input?.name || ""), String(input?.content ?? "")) }; }
    catch (err) { return fail(err); }
  });

  ipcMain.handle("files-content", (_e, id: string) => {
    try { return { ok: true as const, content: artifacts.readText(String(id || "")) }; }
    catch (err) { return fail(err); }
  });

  ipcMain.handle("files-save", (_e, id: string, content: string) => {
    try { return { ok: true as const, file: artifacts.save(String(id || ""), String(content ?? "")) }; }
    catch (err) { return fail(err); }
  });

  ipcMain.handle("files-rename", (_e, id: string, name: string) => {
    try { return { ok: true as const, file: artifacts.rename(String(id || ""), String(name || "")) }; }
    catch (err) { return fail(err); }
  });

  ipcMain.handle("files-delete", (_e, id: string) => {
    try { artifacts.remove(String(id || "")); return { ok: true as const }; }
    catch (err) { return fail(err); }
  });
}
