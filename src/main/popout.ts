/**
 * popout.ts — pop a workbench panel OFF the app into a standalone OS window
 * (macOS traffic lights, hiddenInset title bar).
 *
 *   kind "url"    — any web panel: a plain window on the panel's URL, riding
 *                   the same persist:yo session partition as in-app webviews
 *                   so logins carry over.
 *   kind "slides" — the Slides panel: loads popout-slides.html (the same
 *                   wb-gpoint module standalone) with the app preload, so the
 *                   org deck library IPC works; presenting there goes real
 *                   fullscreen.
 */

import { join } from "node:path";
import { BrowserWindow, ipcMain } from "electron";

export function registerPopoutIpc(): void {
  ipcMain.handle("panel-popout", (_e, req: { kind?: string; url?: string; file?: string; title?: string } | undefined) => {
    try {
      const kind = req?.kind === "slides" ? "slides" : "url";
      const title = String(req?.title || (kind === "slides" ? "Slides" : "Glyphh"));
      if (kind === "slides") {
        const win = new BrowserWindow({
          width: 1160, height: 740, title,
          titleBarStyle: "hiddenInset",
          webPreferences: {
            preload: join(__dirname, "..", "renderer", "preload.js"),
            contextIsolation: true,
            nodeIntegration: false,
          },
        });
        void win.loadFile(
          join(__dirname, "..", "renderer", "popout-slides.html"),
          req?.file ? { search: `?file=${encodeURIComponent(String(req.file))}` } : undefined,
        );
        return { ok: true };
      }
      const url = String(req?.url ?? "");
      if (!/^https?:\/\//i.test(url)) throw new Error("popout needs an http(s) url");
      const win = new BrowserWindow({
        width: 1160, height: 740, title,
        titleBarStyle: "hiddenInset",
        webPreferences: {
          partition: "persist:yo",
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
        },
      });
      void win.loadURL(url);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });
}
