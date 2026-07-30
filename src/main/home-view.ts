/**
 * HomeView — the ONE persistent BrowserView hosting home.html.
 *
 * The legacy PanelManager (BrowserView registry, tabs, grid layouts) is gone;
 * the home surface is the only main-owned view left. It covers the whole
 * window (full-bleed — home.html draws its own chrome), and detaches while an
 * HTML overlay in the shell must be visible (splash, onboarding, lockout,
 * update handoff). Workspace apps render as renderer-owned <webview> panels
 * INSIDE home's workbench, so this module also carries the session setup those
 * guests rely on (persist:yo user agent, permission allowlist, downloads).
 */

import { BrowserView, BrowserWindow, Menu, WebContents, session, webContents } from "electron";
import * as path from "path";
import * as os from "os";
import { wireForceWebGuest } from "./force-web";

// Sites like Slack gate on a minimum Chrome version. Electron's bundled
// Chromium can be older, so a guest reporting the real version gets the
// "unsupported browser" page instead of the app.
const MIN_CHROME_MAJOR = 137;
const SPOOF_CHROME = "140.0.0.0";

/** Strip Electron/app identifiers and bump an outdated Chrome version above the gate. */
function cleanUserAgent(ua: string): string {
  let out = ua
    .replace(/Electron\/\S+\s*/g, "")
    .replace(/\S+-client\/\S+\s*/g, "")
    .replace(/\s+/g, " ")
    .trim();
  const m = /Chrome\/(\d+)/.exec(out);
  if (m && parseInt(m[1], 10) < MIN_CHROME_MAJOR) {
    out = out.replace(/Chrome\/[\d.]+/, `Chrome/${SPOOF_CHROME}`);
  }
  return out;
}

const SCROLLBAR_CSS = `
  *::-webkit-scrollbar { width: 6px; height: 6px; }
  *::-webkit-scrollbar-track { background: transparent; }
  *::-webkit-scrollbar-thumb {
    background: rgba(255, 255, 255, 0.1);
    border-radius: 3px;
  }
  *::-webkit-scrollbar-thumb:hover {
    background: rgba(168, 85, 247, 0.45);
  }
  *::-webkit-scrollbar-corner { background: transparent; }
`;

/**
 * Auto-dismiss JS dialogs (alert/confirm/prompt) via the Chrome DevTools
 * Protocol — intercepts at the Chromium IPC level, before the renderer blocks.
 */
function attachDialogHandler(wc: WebContents): void {
  try {
    wc.debugger.attach("1.3");
  } catch {
    return; // already attached or destroyed
  }
  wc.debugger.sendCommand("Page.enable").catch(() => {});
  wc.debugger.on("message", (_event, method, params) => {
    if (method === "Page.javascriptDialogOpening") {
      const accept = params.type !== "beforeunload";
      wc.debugger.sendCommand("Page.handleJavaScriptDialog", {
        accept,
        promptText: params.defaultPrompt || "",
      }).catch(() => {});
    }
  });
  wc.on("destroyed", () => {
    try { wc.debugger.detach(); } catch { /* already detached */ }
  });
}

/** Right-click context menu with edit actions + Inspect Element. */
function attachContextMenu(wc: WebContents): void {
  wc.on("context-menu", (_event, params) => {
    const items: Electron.MenuItemConstructorOptions[] = [];
    if (params.isEditable) {
      items.push(
        { label: "Cut", role: "cut" },
        { label: "Copy", role: "copy" },
        { label: "Paste", role: "paste" },
        { type: "separator" },
      );
    } else if (params.selectionText) {
      items.push(
        { label: "Copy", role: "copy" },
        { type: "separator" },
      );
    }
    if (params.linkURL) {
      items.push(
        { label: "Copy Link", click: () => { const { clipboard } = require("electron"); clipboard.writeText(params.linkURL); } },
        { type: "separator" },
      );
    }
    items.push({ label: "Inspect Element", click: () => { wc.inspectElement(params.x, params.y); } });
    Menu.buildFromTemplate(items).popup();
  });
}

let sessionsConfigured = false;

/**
 * One-time session setup for the workbench's <webview> guests:
 * - persist:yo gets a clean Chrome-like user agent (version-gated sites load)
 * - a permission allowlist (only what web apps actually need)
 * - downloads on BOTH sessions auto-save to ~/Downloads
 */
export function setupPanelSessions(): void {
  if (sessionsConfigured) return;
  sessionsConfigured = true;

  const ses = session.fromPartition("persist:yo");
  ses.setUserAgent(cleanUserAgent(ses.getUserAgent()));

  const ALLOWED_PERMISSIONS = new Set([
    "clipboard-read",
    "clipboard-sanitized-write",
    "notifications",
    "fullscreen",
    "pointerLock",
    "media",            // camera/mic — only when user explicitly grants
  ]);
  ses.setPermissionRequestHandler((_wc, permission, callback) => {
    callback(ALLOWED_PERMISSIONS.has(permission));
  });
  ses.setPermissionCheckHandler((_wc, permission) => ALLOWED_PERMISSIONS.has(permission));

  const downloadsDir = path.join(os.homedir(), "Downloads");
  const wireDownloads = (target: Electron.Session): void => {
    target.on("will-download", (_event, item) => {
      const filename = item.getFilename() || "download";
      item.setSavePath(path.join(downloadsDir, filename));
    });
  };
  wireDownloads(ses);
  wireDownloads(session.defaultSession);
}

export class HomeView {
  private view: BrowserView | null = null;
  private win: BrowserWindow | null = null;
  private hidden = false;
  private locked = false;
  private zoomFactor = 1.0;
  private onZoomChange: ((factor: number) => void) | null = null;

  setOnZoomChange(cb: (factor: number) => void): void {
    this.onZoomChange = cb;
  }

  /** The home page's webContents (null until created). */
  get webContents(): WebContents | null {
    const wc = this.view?.webContents;
    return wc && !wc.isDestroyed() ? wc : null;
  }

  get isHidden(): boolean { return this.hidden; }
  get isLocked(): boolean { return this.locked; }

  /** Account lockout: while locked, the view refuses to attach so nothing can
   *  paint over the lockout overlay (BrowserViews render above shell HTML). */
  setLocked(locked: boolean): void {
    this.locked = locked;
    if (locked && this.win) this.hide(this.win);
  }

  /** Create the view (if needed) and start loading home.html. Does NOT attach —
   *  the shell reveals it via show() once the splash/onboarding dismisses. */
  ensureCreated(win: BrowserWindow): void {
    this.win = win;
    if (this.view && this.view.webContents && !this.view.webContents.isDestroyed()) return;
    setupPanelSessions();

    const view = new BrowserView({
      webPreferences: {
        preload: path.join(__dirname, "..", "renderer", "preload.js"),
        contextIsolation: true,
        nodeIntegration: false,
        webviewTag: true,
      },
    });
    this.view = view;
    const wc = view.webContents;

    // Popups from the home surface itself: web protocols only.
    wc.setWindowOpenHandler(({ url }) => {
      if (!url.startsWith("http://") && !url.startsWith("https://") && !url.startsWith("about:")) {
        return { action: "deny" };
      }
      return {
        action: "allow",
        overrideBrowserWindowOptions: {
          webPreferences: { contextIsolation: true, nodeIntegration: false, partition: "persist:yo" },
        },
      };
    });

    // Workbench <webview> guests: the glyphh-app bridge preload must be set at
    // will-attach time (later is ignored). Inert for ordinary web apps —
    // glyphh-app:call rejects any webContents without a capability grant.
    (wc as any).on("will-attach-webview", (_event: unknown, webPreferences: Electron.WebPreferences) => {
      webPreferences.preload = path.join(__dirname, "glyphh-app-preload.js");
    });

    (wc as any).on("did-attach-webview", (_event: unknown, guest: WebContents) => {
      // Stay in the panel when a page bounces to a native client (slack:// etc.)
      wireForceWebGuest(guest);
      attachDialogHandler(guest);
      attachContextMenu(guest);
      guest.setWindowOpenHandler(({ url }) => {
        if (!url.startsWith("http://") && !url.startsWith("https://") && !url.startsWith("about:")) {
          return { action: "deny" };
        }
        return {
          action: "allow",
          overrideBrowserWindowOptions: {
            webPreferences: { contextIsolation: true, nodeIntegration: false, partition: "persist:yo" },
          },
        };
      });
      guest.on("did-finish-load", () => {
        if (!guest.isDestroyed()) {
          guest.setZoomFactor(this.zoomFactor);
          guest.insertCSS(SCROLLBAR_CSS).catch(() => {});
        }
      });
      this.wireShortcuts(guest);
    });

    wc.on("did-finish-load", () => {
      if (wc.isDestroyed()) return;
      wc.setZoomFactor(this.zoomFactor);
    });
    this.wireShortcuts(wc);

    void wc.loadFile(path.join(__dirname, "..", "renderer", "home.html"));
  }

  /** Zoom / reload / DevTools shortcuts — the view (or its guests) hold focus,
   *  so the shell's keydown handlers never see these. */
  private wireShortcuts(wc: WebContents): void {
    wc.on("before-input-event", (e, input) => {
      if (wc.isDestroyed()) return;
      if (!input.meta && !input.control) return;
      if (input.type !== "keyDown") return;
      if (input.key === "=" || input.key === "+") {
        e.preventDefault();
        this.setZoom(this.zoomFactor + 0.1);
      } else if (input.key === "-") {
        e.preventDefault();
        this.setZoom(this.zoomFactor - 0.1);
      } else if (input.key === "0") {
        e.preventDefault();
        this.setZoom(1.0);
      } else if (input.key === "r") {
        e.preventDefault();
        this.reload();
      } else if (input.key === "i" && (input.alt || input.shift)) {
        e.preventDefault();
        this.toggleDevTools();
      }
    });
  }

  /** Attach the view full-bleed (home owns the chrome, titlebar included).
   *  No-op while locked — the lockout overlay must stay visible. */
  show(win: BrowserWindow): void {
    if (win.isDestroyed() || this.locked) return;
    this.hidden = false;
    this.ensureCreated(win);
    const view = this.view!;
    win.setBrowserView(view);
    const [w, h] = win.getContentSize();
    view.setBounds({ x: 0, y: 0, width: w, height: h });
    view.setAutoResize({ width: true, height: true });
    view.webContents.focus();
  }

  /** Detach so a shell HTML overlay (splash/onboarding/lockout/update) shows. */
  hide(win: BrowserWindow): void {
    this.hidden = true;
    if (win.isDestroyed()) return;
    for (const bv of win.getBrowserViews()) {
      try { win.removeBrowserView(bv); } catch { /* already destroyed */ }
    }
  }

  reload(): void {
    this.webContents?.reload();
  }

  toggleDevTools(): void {
    const wc = this.webContents;
    if (!wc) return;
    if (wc.isDevToolsOpened()) wc.closeDevTools();
    else wc.openDevTools({ mode: "detach" });
  }

  /** Zoom applies to home AND every workbench guest webview. */
  setZoom(factor: number): void {
    this.zoomFactor = Math.max(0.5, Math.min(2.0, factor));
    const wcs = [this.webContents, ...webContents.getAllWebContents().filter((g) => {
      try { return !g.isDestroyed() && g.hostWebContents === this.view?.webContents; } catch { return false; }
    })];
    for (const wc of wcs) {
      try { wc?.setZoomFactor(this.zoomFactor); } catch { /* destroyed */ }
    }
    this.onZoomChange?.(this.zoomFactor);
  }

  getZoom(): number {
    return this.zoomFactor;
  }
}
