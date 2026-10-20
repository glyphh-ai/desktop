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

const urlOf = (wc: Electron.WebContents): string => {
  try { return wc.isDestroyed() ? "" : wc.getURL(); } catch { return ""; }
};

/**
 * THE WORKBENCH THAT OWNS THE WINDOW — the home.html BrowserView, and never an
 * agent panel (his report, 2026-09-29: the agent opened Gmail twice, "one
 * inside the glyphh agent panel and one in the right place").
 *
 * An agent panel is ALSO a home.html document (`?solo=tool:coding&instance=…`)
 * running the same workbench code, so "send it to every home.html" meant every
 * panel opened the app inside itself as well. A command that steers the UI —
 * open an app, go to a section, front the command center, start a session —
 * belongs to the one workbench the user is looking at.
 */
export function homeShellWebContents(): Electron.WebContents[] {
  return webContents.getAllWebContents().filter((wc) => {
    const url = urlOf(wc);
    return /home\.html/.test(url) && !/[?&]solo=/.test(url);
  });
}

/** Steer the workbench: the shell's home panel, else the shell itself. */
export function sendToHomeShell(channel: string, ...args: unknown[]): void {
  const homes = homeShellWebContents();
  for (const wc of homes) {
    try { wc.send(channel, ...args); } catch { /* renderer mid-teardown */ }
  }
}
