/**
 * Preload for installed Glyphh apps (glyphh-app-host). The ENTIRE surface an
 * app gets is `glyphh.call(method, args)` — the main process enforces the
 * manifest's capability list per-window, so an app can only reach what it
 * declared at install time (e.g. "contacts.search", "messages.send").
 */

import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("glyphh", {
  call: (method: string, args?: unknown) =>
    ipcRenderer.invoke("glyphh-app:call", method, args) as Promise<
      { ok: true; result: unknown } | { ok: false; error: string }
    >,
});
