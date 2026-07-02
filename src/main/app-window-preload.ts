/**
 * Preload for per-app windows and layout windows (5b Panel Manager).
 * One job: report each <webview>'s WebContents id to the main process,
 * keyed by app slug, so the MCP relay's RPA tools can target apps by name.
 */

import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("glyphhWin", {
  reportWebview: (slug: string, wcId: number) =>
    ipcRenderer.send("app-window-webview-attached", slug, wcId),
});
