/**
 * Global hotkey — Cmd+Y (Mac) / Ctrl+Y (Windows).
 *
 * Summons/dismisses the app as a desktop overlay.
 */

import { BrowserWindow, globalShortcut } from "electron";

export function registerHotkey(window: BrowserWindow): void {
  const accelerator =
    process.platform === "darwin" ? "CommandOrControl+Y" : "Ctrl+Y";

  globalShortcut.register(accelerator, () => {
    if (window.isVisible()) {
      window.hide();
    } else {
      window.show();
      window.focus();
    }
  });
}
