/**
 * Preload for the command overlay window (command-center.html). Exposes a
 * small `window.yo` surface — the same method names the main renderer uses —
 * so the shared app-icon module (panelAppsList / connectorsGetApps) works
 * unchanged, plus the command-open IPCs that render apps/layouts at OS level.
 */

import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("yo", {
  // Data (same global ipcMain.handle channels the main window uses).
  panelAppsList: () => ipcRenderer.invoke("panel-apps-list"),
  layoutsList: () => ipcRenderer.invoke("layouts-list"),
  connectorsGetApps: (search?: string, offset?: number) =>
    ipcRenderer.invoke("connectors-get-apps", search, offset),
  appFileIcon: (execPath: string) => ipcRenderer.invoke("app-file-icon", execPath),

  // Actions — open at the OS level via app-window-manager (see command-window).
  commandOpenApp: (ref: string) => ipcRenderer.invoke("command:open-app", ref),
  commandOpenLayout: (name: string) => ipcRenderer.invoke("command:open-layout", name),
  commandExec: (text: string) => ipcRenderer.invoke("command:exec", text),
  commandClose: () => ipcRenderer.send("command:close"),

  // Main tells the overlay to rebuild its list (with the active theme) each
  // time it's shown.
  onCommandRefresh: (cb: (theme: string) => void) =>
    ipcRenderer.on("command:refresh", (_e, theme: string) => cb(theme)),
});
