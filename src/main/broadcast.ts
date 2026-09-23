import { webContents } from "electron";

/** Send to EVERY renderer — the shell window AND the home BrowserView.
 *
 *  home.html (the Echo wall, the Apps page, Settings, the code panel) is a
 *  BrowserView, whose webContents is NOT a BrowserWindow's. An event sent
 *  with `BrowserWindow.getAllWindows()[i].webContents.send` reaches only the
 *  shell (index.html), where none of the listeners live — so an app installed
 *  from Discover registered its tab, announced it, and nobody heard: the wall
 *  showed it after a restart, when the boot scan re-read the folder (his
 *  report, 2026-09-23). Every cross-renderer announcement goes through here. */
export function broadcast(channel: string, ...args: unknown[]): void {
  for (const wc of webContents.getAllWebContents()) {
    if (wc.isDestroyed()) continue;
    try { wc.send(channel, ...args); } catch { /* renderer mid-teardown */ }
  }
}
