/**
 * apikeys-ipc.ts — the desktop renderer's transport to the caller's API KEYS
 * (`gy_ak_…` headless-auth keys, user-scoped).
 *
 * The renderer has no SDK handle (preload boundary), so these thin IPC methods
 * call the MAIN-process @glyphh/sdk client — the same authed client every other
 * control-plane call uses (getClient()). Same shape as files-ipc.ts.
 *
 * The read (list) propagates rejection so the panel can paint an honest error.
 * The writes (create/revoke) return an `{ ok, … , error }` envelope, because a
 * quota/permission refusal is an expected outcome the form must explain.
 */

import { ipcMain } from "electron";
import type { ApiKeyInput } from "@glyphh/sdk";
import { getClient } from "./glyphh-client";

function fail(err: unknown): { ok: false; error: string } {
  return { ok: false, error: err instanceof Error ? err.message : String(err) };
}

export function registerApiKeysIpc(): void {
  ipcMain.handle("apikeys-list", () => getClient().apiKeys.list());
  ipcMain.handle("apikeys-create", async (_e, input: ApiKeyInput) => {
    try { return { ok: true as const, created: await getClient().apiKeys.create(input) }; }
    catch (err) { return fail(err); }
  });
  ipcMain.handle("apikeys-revoke", async (_e, id: string) => {
    try { await getClient().apiKeys.revoke(String(id || "")); return { ok: true as const }; }
    catch (err) { return fail(err); }
  });
}
