/**
 * PanelManager — manages webview panels.
 *
 * Each panel is a BrowserView loading a native AI web UI.
 * Panels persist in background when hidden (no reload on switch).
 * dip commands route through here.
 */

import { BrowserWindow, BrowserView, WebContents, Menu, session, shell } from "electron";
import * as path from "path";
import * as os from "os";
import * as http from "http";

// Sites like Slack gate on a minimum Chrome version (137+ as of 2026). Electron's
// bundled Chromium can be older (Electron 35 ≈ Chrome 134), so a panel reporting
// the real version gets the "unsupported browser" page instead of the app.
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

export interface PanelConfig {
  id: string;
  name: string;
  url: string;
  preload?: string;
  /** Suppress "open in desktop app" banners and protocol redirects */
  forceWeb?: boolean;
  /** Enable <webview> tag in this panel (for embedded browser) */
  webviewTag?: boolean;
}

export type PanelCreatedCallback = (id: string, webContents: WebContents) => void;

export type PanelReadyCallback = (id: string, webContents: WebContents) => void;

export class PanelManager {
  /** Loading page shown while a local server starts up */
  private static readonly LOADING_HTML = `<html><head><style>
    body{background:#0a0a0a;color:#888;font-family:-apple-system,system-ui,sans-serif;
      display:flex;flex-direction:column;align-items:center;justify-content:center;
      height:100vh;margin:0;gap:20px}
    .dots{display:flex;gap:6px}
    .dot{width:8px;height:8px;border-radius:50%;background:#fbbf24;
      animation:pulse 1.4s infinite ease-in-out}
    .dot:nth-child(2){animation-delay:.2s}
    .dot:nth-child(3){animation-delay:.4s}
    @keyframes pulse{0%,80%,100%{transform:scale(.3);opacity:.3}40%{transform:scale(1);opacity:1}}
    .status{font-size:14px;letter-spacing:.5px;text-align:center}
    .sub{font-size:12px;color:#555;margin-top:4px}
  </style></head><body>
    <div class="dots"><div class="dot"></div><div class="dot"></div><div class="dot"></div></div>
    <div class="status" id="status">Starting server...</div>
    <div class="sub" id="sub"></div>
    <script>
      var start = Date.now();
      setInterval(function(){
        var s = Math.floor((Date.now()-start)/1000);
        document.getElementById("sub").textContent = s+"s";
      }, 1000);
      window.__setStatus = function(msg){ document.getElementById("status").textContent = msg; };
    </script>
  </body></html>`;

  private static readonly SCROLLBAR_CSS = `
    *::-webkit-scrollbar { width: 6px; height: 6px; }
    *::-webkit-scrollbar-track { background: transparent; }
    *::-webkit-scrollbar-thumb {
      background: rgba(255, 255, 255, 0.1);
      border-radius: 3px;
    }
    *::-webkit-scrollbar-thumb:hover {
      background: rgba(251, 146, 60, 0.45);
    }
    *::-webkit-scrollbar-corner { background: transparent; }
  `;

  private static permissionsConfigured = false;
  private static mainWebContents: WebContents | null = null;

  private panels: Map<string, BrowserView> = new Map();
  private configs: Map<string, PanelConfig> = new Map();
  private activePanel: string | null = null;
  private previousPanel: string | null = null;
  private onCreated: PanelCreatedCallback | null = null;
  private onReady: PanelReadyCallback | null = null;
  private onPanelFocused: ((id: string) => void) | null = null;
  private onWebviewAttach: ((childWc: WebContents, panelId: string) => void) | null = null;
  private guests = new Map<string, WebContents>();
  private onRecordToggle: (() => void) | null = null;
  private zoomFactor = 1.0;
  private _animating = false;
  private onZoomChange: ((factor: number) => void) | null = null;
  private _rightInset = 0;
  private _leftInset = 0;
  private _topInset = 0;
  /** Panels that cover the whole window INCLUDING the 38px titlebar strip —
   *  the Code-primary home surface draws its own chrome (traffic lights,
   *  drag regions, command button live inside the panel). */
  private _fullBleed = new Set<string>();
  private _bottomInset = 0;

  constructor(onPanelCreated?: PanelCreatedCallback) {
    this.onCreated = onPanelCreated ?? null;
    PanelManager.setupPermissions();
  }

  /**
   * Attach a CDP (Chrome DevTools Protocol) handler to auto-dismiss JS dialogs.
   * This intercepts alert/confirm/prompt at the Chromium IPC level — before the
   * renderer process blocks — so pages with inline dialogs can still load.
   */
  static attachDialogHandler(wc: WebContents): void {
    try {
      wc.debugger.attach("1.3");
    } catch {
      return; // already attached or destroyed
    }
    wc.debugger.sendCommand("Page.enable").catch(() => {});
    wc.debugger.on("message", (_event, method, params) => {
      if (method === "Page.javascriptDialogOpening") {
        const accept = params.type !== "beforeunload"; // accept alert/confirm/prompt, dismiss beforeunload
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

  /** Attach a right-click context menu with Inspect Element + View Source. */
  static attachContextMenu(wc: WebContents): void {
    wc.on("context-menu", (_event, params) => {
      const items: Electron.MenuItemConstructorOptions[] = [];

      // Standard edit actions when right-clicking editable fields
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

      // Link actions
      if (params.linkURL) {
        items.push(
          { label: "Copy Link", click: () => { const { clipboard } = require("electron"); clipboard.writeText(params.linkURL); } },
          { type: "separator" },
        );
      }

      items.push(
        { label: "View Page Source", click: () => {
          wc.executeJavaScript("document.documentElement.outerHTML").then((html: string) => {
            const sourceWin = new BrowserWindow({ width: 800, height: 600, title: `Source: ${wc.getURL()}` });
            sourceWin.loadURL(`data:text/plain;charset=utf-8,${encodeURIComponent(html)}`);
          }).catch(() => {});
        }},
        { label: "Inspect Element", click: () => {
          wc.inspectElement(params.x, params.y);
        }},
      );

      Menu.buildFromTemplate(items).popup();
    });
  }

  /** JS injected into forceWeb panels to suppress desktop-app redirects.
   *  Public: app-window-manager injects the same script into per-app windows. */
  static readonly FORCE_WEB_JS = `
    (function() {
      if (window.__yoForceWeb) return;
      window.__yoForceWeb = true;

      // Block location assignments to native app protocols (slack://, zoommtg://, etc.)
      const origAssign = location.assign.bind(location);
      const origReplace = location.replace.bind(location);
      const blockNative = (fn, url) => {
        if (typeof url === 'string' && !/^https?:\\/\\/|^about:|^\\//.test(url)) {
          console.log('[yo:forceWeb] blocked redirect:', url);
          return;
        }
        return fn(url);
      };
      location.assign = (url) => blockNative(origAssign, url);
      location.replace = (url) => blockNative(origReplace, url);

      // Hide "open in desktop app" banners via a MutationObserver
      const BANNER_PATTERNS = [
        /open\\s+(in|with)\\s+(the\\s+)?(desktop|native|app)/i,
        /download\\s+(the\\s+)?app/i,
        /use\\s+(the\\s+)?(desktop|native)\\s+app/i,
        /switch\\s+to\\s+(the\\s+)?(desktop|app)/i,
        /get\\s+(the\\s+)?(desktop|native)\\s+app/i,
        /continue\\s+in\\s+(the\\s+)?app/i,
      ];

      function hideBanners(root) {
        const candidates = root.querySelectorAll
          ? root.querySelectorAll('a, button, [role="dialog"], [role="banner"], [class*="banner"], [class*="modal"], [class*="download"], [class*="desktop"]')
          : [];
        for (const el of candidates) {
          const text = (el.textContent || '').trim();
          if (text.length > 200) continue;
          for (const pat of BANNER_PATTERNS) {
            if (pat.test(text)) {
              // Walk up to find the container (banner/modal wrapper)
              let target = el;
              for (let i = 0; i < 5 && target.parentElement; i++) {
                const p = target.parentElement;
                const tag = p.tagName.toLowerCase();
                if (tag === 'body' || tag === 'main' || tag === 'html') break;
                if (p.getAttribute('role') === 'dialog' || p.getAttribute('role') === 'banner'
                    || /banner|modal|overlay|download|desktop/i.test(p.className || '')) {
                  target = p;
                }
              }
              target.style.display = 'none';
              console.log('[yo:forceWeb] hid banner:', text.slice(0, 60));
              break;
            }
          }
        }
      }

      // Run on current DOM + watch for dynamic banners
      hideBanners(document);
      new MutationObserver((mutations) => {
        for (const m of mutations) {
          for (const node of m.addedNodes) {
            if (node.nodeType === 1) hideBanners(node);
          }
        }
      }).observe(document.body || document.documentElement, { childList: true, subtree: true });
    })();
  `;


  /**
   * Map a native protocol URL to the corresponding web client URL.
   * Returns null if no mapping exists (caller should just close the popup).
   */
  static nativeToWebUrl(nativeUrl: string, parentUrl: string): string | null {
    try {
      const parsed = new URL(nativeUrl);
      const proto = parsed.protocol; // e.g. "slack:", "discord:", "msteams:"

      if (proto === "slack:") {
        const team = parsed.searchParams.get("team") || "";
        return team
          ? `https://app.slack.com/client/${team}`
          : "https://app.slack.com/client";
      }

      if (proto === "discord:") {
        // discord://- or discord://channels/... → discord.com/app
        return "https://discord.com/app";
      }

      if (proto === "msteams:") {
        // msteams://... → teams.microsoft.com
        return "https://teams.microsoft.com";
      }

      if (proto === "zoommtg:" || proto === "zoomus:") {
        // zoommtg://zoom.us/join?confno=... → app.zoom.us web client
        const confno = parsed.searchParams.get("confno") || "";
        return confno
          ? `https://app.zoom.us/wc/${confno}/join`
          : "https://app.zoom.us";
      }

      if (proto === "notion:") {
        return "https://notion.so";
      }
    } catch { /* malformed URL */ }

    // Unknown protocol — fall back to reloading the parent page
    try {
      return new URL(parentUrl).origin;
    } catch {
      return null;
    }
  }

  /** Configure permission handlers on the persist:yo session (once) */
  private static setupPermissions(): void {
    if (PanelManager.permissionsConfigured) return;
    PanelManager.permissionsConfigured = true;

    const ses = session.fromPartition("persist:yo");

    // Strip Electron/app identifiers from the session user agent so webview
    // guests (e.g., browser panel) inherit a clean Chrome-like UA string, and
    // bump an outdated Chrome version so version-gated sites (Slack) still load.
    ses.setUserAgent(cleanUserAgent(ses.getUserAgent()));

    // Allowlist specific permissions — only grant what web apps actually need
    const ALLOWED_PERMISSIONS = new Set([
      "clipboard-read",
      "clipboard-sanitized-write",
      "notifications",
      "fullscreen",
      "pointerLock",
      "media",            // camera/mic — only when user explicitly grants via panel
    ]);
    ses.setPermissionRequestHandler((_wc, permission, callback) => {
      callback(ALLOWED_PERMISSIONS.has(permission));
    });

    ses.setPermissionCheckHandler((_wc, permission) => ALLOWED_PERMISSIONS.has(permission));

    // Handle file downloads — auto-save to ~/Downloads with progress UI.
    // Wired on BOTH sessions: persist:yo (app panels) and the default session
    // (the workbench Browser panel's webview lives there, for glyphh-preview).
    const downloadsDir = path.join(os.homedir(), "Downloads");
    const wireDownloads = (target: Electron.Session): void => {
      target.on("will-download", (_event, item) => {
        const filename = item.getFilename() || "download";
        const savePath = path.join(downloadsDir, filename);
        item.setSavePath(savePath);

        const wc = PanelManager.mainWebContents;
        const totalBytes = item.getTotalBytes();

        wc?.send("download:start", { filename, totalBytes, savePath });

        item.on("updated", (_e, state) => {
          if (state === "progressing" && !item.isPaused()) {
            wc?.send("download:progress", {
              filename,
              receivedBytes: item.getReceivedBytes(),
              totalBytes,
            });
          }
        });

        item.once("done", (_e, state) => {
          wc?.send("download:done", {
            filename,
            savePath,
            state, // "completed", "cancelled", or "interrupted"
          });
        });
      });
    };
    wireDownloads(ses);
    wireDownloads(session.defaultSession);
  }

  /**
   * Handle OAuth localhost callback failures.
   * When a popup navigates to localhost:PORT/callback?code=... and fails (no server),
   * spin up a temp HTTP server on that port and reload so the callback succeeds.
   */
  private static handleOAuthCallback(childWindow: BrowserWindow, failUrl: string): void {
    try {
      const url = new URL(failUrl);
      if (url.hostname !== "localhost" || !url.searchParams.has("code")) return;
      const port = parseInt(url.port);
      if (isNaN(port) || port < 1024) return;

      const server = http.createServer((_req, res) => {
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(`<html><body style="background:#1e1e1e;color:#ccc;font-family:system-ui;
          display:flex;align-items:center;justify-content:center;height:100vh;margin:0">
          <div style="text-align:center"><p>Authenticated — closing…</p></div>
          <script>setTimeout(()=>window.close(),1500)</script>
        </body></html>`);
        setTimeout(() => { try { server.close(); } catch {} }, 10000);
      });

      server.listen(port, () => {
        console.log(`[oauth] temp server on :${port}, reloading callback`);
        if (!childWindow.isDestroyed()) childWindow.loadURL(failUrl);
        else server.close();
      });
      server.on("error", (err) => console.log("[oauth] server error:", err.message));
    } catch (e) {
      console.log("[oauth] intercept error:", e);
    }
  }

  /** Register callback for when a panel becomes active (after switch or page load). */
  setOnPanelReady(cb: PanelReadyCallback): void {
    this.onReady = cb;
  }

  /** Register callback for when zoom changes (to persist preference). */
  setOnZoomChange(cb: (factor: number) => void): void {
    this.onZoomChange = cb;
  }

  setOnPanelFocused(cb: (id: string) => void): void {
    this.onPanelFocused = cb;
  }

  setOnWebviewAttach(cb: (childWc: WebContents, panelId: string) => void): void {
    this.onWebviewAttach = cb;
  }

  setOnRecordToggle(cb: () => void): void {
    this.onRecordToggle = cb;
  }

  /** Whether a slide animation is in progress */
  get isAnimating(): boolean { return this._animating; }

  /** Register a custom panel (dip add <url>) */
  addPanel(id: string, url: string, preload?: string, forceWeb?: boolean, webviewTag?: boolean): void {
    this.configs.set(id, { id, name: id, url, preload, forceWeb, webviewTag });
  }

  /** Get or create a panel's BrowserView (public for layout manager) */
  getOrCreateView(id: string, parent: BrowserWindow): BrowserView | null {
    return this.getOrCreate(id, parent);
  }

  /** Get an existing panel's BrowserView without creating it */
  getView(id: string): BrowserView | null {
    const view = this.panels.get(id);
    if (!view || view.webContents.isDestroyed()) return null;
    return view;
  }

  /** Iterate over all live panel webContents (for broadcasting events) */
  getAllWebContents(): WebContents[] {
    const out: WebContents[] = [];
    for (const view of this.panels.values()) {
      if (view.webContents && !view.webContents.isDestroyed()) {
        out.push(view.webContents);
      }
    }
    return out;
  }

  private getOrCreate(id: string, parent: BrowserWindow): BrowserView | null {
    // Store main window ref for download notifications
    if (!PanelManager.mainWebContents && !parent.isDestroyed()) {
      PanelManager.mainWebContents = parent.webContents;
    }

    if (this.panels.has(id)) {
      const existing = this.panels.get(id)!;
      // If the view or its webContents was destroyed, drop it and recreate
      try {
        if (!existing.webContents || existing.webContents.isDestroyed()) {
          console.log(`[getOrCreate] panel="${id}" — existing view destroyed, recreating`);
          this.panels.delete(id);
        } else {
          return existing;
        }
      } catch {
        console.log(`[getOrCreate] panel="${id}" — existing view threw, recreating`);
        this.panels.delete(id);
      }
    } else {
      console.log(`[getOrCreate] panel="${id}" — not in panels map, creating fresh`);
    }

    const config = this.configs.get(id);
    if (!config) return null;

    const isLocal = config.url.startsWith("file://");

    const view = new BrowserView({
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        partition: isLocal ? undefined : "persist:yo",
        ...(config.preload ? { preload: config.preload } : {}),
        ...(config.webviewTag ? { webviewTag: true } : {}),
      },
    });

    if (!isLocal) {
      // Set a modern Chrome user agent so sites don't flag Electron's bundled
      // Chromium as outdated (e.g. Slack gates on Chrome 137+).
      view.webContents.setUserAgent(cleanUserAgent(view.webContents.getUserAgent()));
      // Auto-dismiss JS dialogs (alert/confirm/prompt) via Chrome DevTools Protocol.
      // This intercepts at the Chromium IPC level, before the renderer blocks.
      PanelManager.attachDialogHandler(view.webContents);
      PanelManager.attachContextMenu(view.webContents);
    }

    // Block native app protocol redirects (slack://, zoommtg://, etc.)
    view.webContents.on("will-navigate", (e, url) => {
      if (isLocal && url.startsWith("file://")) return;
      // Internal yo:// links (e.g. yo://open-settings from info pages)
      if (url.startsWith("yo://open-settings")) {
        e.preventDefault();
        PanelManager.mainWebContents?.send("open-settings");
        return;
      }
      if (!url.startsWith("http://") && !url.startsWith("https://") && !url.startsWith("about:")) {
        e.preventDefault();
        return;
      }
      // For forceWeb panels, block redirects to download/get-started pages
      if (config.forceWeb) {
        try {
          const u = new URL(url);
          if (/\/(get-started|download|desktop|install|apps)\b/i.test(u.pathname)) {
            console.log(`[panel:${id}:forceWeb] blocked redirect to:`, url);
            e.preventDefault();
          }
        } catch { /* ignore malformed URLs */ }
      }
    });
    const popupOptions = {
      action: "allow" as const,
      overrideBrowserWindowOptions: {
        webPreferences: {
          contextIsolation: true,
          nodeIntegration: false,
          partition: isLocal ? undefined : "persist:yo",
        },
      },
    };

    // Log webContents errors for debugging (filter out Electron CSP noise)
    view.webContents.on("console-message", (_e, level, message) => {
      if (level >= 2 && !message.includes("Content-Security-Policy")) {
        console.log(`[panel:${id}:console]`, message.slice(0, 200));
      }
    });
    let retrying = false;
    view.webContents.on("did-fail-load", (_e, code, desc, failUrl) => {
      console.log(`[panel:${id}:fail-load]`, code, desc, failUrl);
      // ERR_CONNECTION_REFUSED on localhost → server starting up, show loading + retry
      if (code === -102 && failUrl && /^https?:\/\/(127\.0\.0\.1|localhost)[:/]/.test(failUrl)) {
        if (retrying) return; // already in retry loop, don't restart
        retrying = true;
        const retryUrl = failUrl;
        view.webContents.loadURL(`data:text/html,${encodeURIComponent(PanelManager.LOADING_HTML)}`);
        const retry = (attempt: number) => {
          if (attempt > 30) {
            retrying = false;
            try {
              if (!view.webContents.isDestroyed()) {
                view.webContents.executeJavaScript(
                  `window.__setStatus && window.__setStatus("Server did not respond — check Settings")`
                ).catch(() => {});
              }
            } catch {}
            return;
          }
          setTimeout(() => {
            if (!retrying) return; // page loaded successfully, stop retrying
            try {
              if (!view.webContents.isDestroyed()) {
                console.log(`[panel:${id}] retrying load (attempt ${attempt})...`);
                view.webContents.executeJavaScript(
                  `window.__setStatus && window.__setStatus("Waiting for server... (attempt ${attempt})")`
                ).catch(() => {});
                view.webContents.loadURL(retryUrl);
              }
            } catch {}
            retry(attempt + 1);
          }, 2000);
        };
        retry(1);
      }
    });
    view.webContents.on("did-navigate", (_e, navUrl) => {
      // Only stop retrying when we successfully navigate to the real URL (not the loading page)
      if (navUrl && !navUrl.startsWith("data:")) retrying = false;
    });

    view.webContents.setWindowOpenHandler(({ url, features }) => {
      console.log(`[panel:${id}:popup]`, url.slice(0, 120), features?.slice(0, 80));
      // Block native app protocol redirects (slack://, zoommtg://, etc.)
      if (!url.startsWith("http://") && !url.startsWith("https://") && !url.startsWith("about:")) {
        return { action: "deny" };
      }
      // Allow all popups — grant with shared session
      return popupOptions;
    });

    // Configure popup windows created from this panel
    view.webContents.on("did-create-window", (childWindow, { url }) => {
      console.log(`[panel:${id}:child-created]`, url?.slice(0, 120));
      // Set reasonable defaults for popup windows
      childWindow.setMinimumSize(400, 300);
      // Show immediately — don't wait for ready-to-show which may not fire
      childWindow.show();
      childWindow.focus();
      childWindow.once("ready-to-show", () => {
        childWindow.show();
        childWindow.focus();
      });
      // Share user agent with parent
      if (!isLocal) {
        childWindow.webContents.setUserAgent(view.webContents.getUserAgent());
      }

      // For forceWeb panels, block native protocol redirects in popup windows too
      // (e.g. Slack popup opens https:// then redirects to slack://)
      // When blocked, navigate the parent view to the web client and close the popup.
      if (config.forceWeb) {
        childWindow.webContents.on("will-navigate", (e, navUrl) => {
          if (!navUrl.startsWith("http://") && !navUrl.startsWith("https://") && !navUrl.startsWith("about:")) {
            console.log(`[panel:${id}:child-blocked]`, navUrl.slice(0, 120));
            e.preventDefault();

            // Map native protocol redirects back to their web clients
            const webRedirect = PanelManager.nativeToWebUrl(navUrl, config.url);
            if (webRedirect) {
              console.log(`[panel:${id}:forceWeb] redirecting parent to:`, webRedirect);
              view.webContents.loadURL(webRedirect);
            }

            setTimeout(() => { if (!childWindow.isDestroyed()) childWindow.close(); }, 300);
            return;
          }
        });
        childWindow.webContents.setWindowOpenHandler(({ url: childUrl }) => {
          if (!childUrl.startsWith("http://") && !childUrl.startsWith("https://") && !childUrl.startsWith("about:")) {
            console.log(`[panel:${id}:child-popup-blocked]`, childUrl.slice(0, 120));
            return { action: "deny" };
          }
          return { action: "allow" };
        });
      }

      // Log child window navigation issues + handle OAuth localhost callbacks
      childWindow.webContents.on("did-fail-load", (_e, code, desc, failUrl) => {
        console.log(`[panel:${id}:child-fail]`, code, desc, failUrl?.slice(0, 120));
        // ERR_CONNECTION_REFUSED on localhost callback → OAuth flow needs a temp server
        if (code === -102 && failUrl) {
          PanelManager.handleOAuthCallback(childWindow, failUrl);
        }
      });
      childWindow.webContents.on("did-finish-load", () => {
        console.log(`[panel:${id}:child-loaded]`, childWindow.webContents.getURL().slice(0, 120));
      });
    });

    // Intercept Cmd/Ctrl shortcuts so they work even when a panel has focus
    view.webContents.on("before-input-event", (e, input) => {
      if (view.webContents.isDestroyed() || parent.isDestroyed()) return;
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
        this.refresh(this.activePanel ?? undefined);
      } else if (input.key === "i" && (input.alt || input.shift)) {
        // Cmd+Opt+I (mac) or Ctrl+Shift+I (win/linux) — DevTools for active panel
        e.preventDefault();
        this.toggleDevTools();
      } else if (input.key === "." && !input.shift) {
        // Cmd+. — toggle yo agent panel
        e.preventDefault();
        if (!parent.isDestroyed()) parent.webContents.send("yo-panel-toggle");
      }
    });

    // Forward keyboard shortcuts from webviews nested inside this panel (e.g., browser panel)
    view.webContents.on("did-attach-webview" as any, (_event: unknown, childWc: WebContents) => {
      // Auto-dismiss JS dialogs, context menu, and themed scrollbars in guest webviews
      PanelManager.attachDialogHandler(childWc);
      PanelManager.attachContextMenu(childWc);
      this.guests.set(id, childWc);
      childWc.on("destroyed", () => { if (this.guests.get(id) === childWc) this.guests.delete(id); });
      // Notify listeners so interceptor can activate on the guest webview
      this.onWebviewAttach?.(childWc, id);
      childWc.on("did-finish-load", () => {
        if (!childWc.isDestroyed()) {
          childWc.insertCSS(PanelManager.SCROLLBAR_CSS).catch(() => {});
        }
      });
      childWc.on("before-input-event", (e, input) => {
        if (childWc.isDestroyed() || parent.isDestroyed()) return;
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
          this.refresh(this.activePanel ?? undefined);
        } else if (input.key === "." && !input.shift) {
          e.preventDefault();
          if (!parent.isDestroyed()) parent.webContents.send("yo-panel-toggle");
        }
      });
    });

    view.webContents.loadURL(config.url);
    view.webContents.on("did-finish-load", () => {
      if (view.webContents.isDestroyed()) return;
      view.webContents.setZoomFactor(this.zoomFactor);
      // Inject thin scrollbar styles into all panels
      view.webContents.insertCSS(PanelManager.SCROLLBAR_CSS).catch(() => {});
      // Suppress desktop-app banners and protocol redirects
      if (config.forceWeb) {
        view.webContents.executeJavaScript(PanelManager.FORCE_WEB_JS).catch(() => {});
      }
      this.onReady?.(id, view.webContents);
    });
    this.panels.set(id, view);

    // When a panel's webContents gains focus (user clicked it), track as active
    view.webContents.on("focus", () => {
      if (this.activePanel && this.activePanel !== id) {
        this.previousPanel = this.activePanel;
      }
      this.activePanel = id;
      this.onPanelFocused?.(id);
    });

    this.onCreated?.(id, view.webContents);
    return view;
  }

  /** Switch to a panel with slide animation (dip <id>) */
  // Direction is the on-screen motion of the incoming view. Forward navigation
  // slides left→right ("right"); going back slides right→left ("left").
  switchTo(id: string, parent: BrowserWindow, direction: "left" | "right" = "right"): boolean {
    if (parent.isDestroyed()) return false;
    const view = this.getOrCreate(id, parent);
    if (!view) return false;

    const oldId = this.activePanel;
    if (oldId) this.previousPanel = oldId;
    this.activePanel = id;

    const [w, h] = parent.getContentSize();
    const yTop = this.yTopFor(id);
    const finalBounds = { x: this._leftInset, y: yTop, width: w - this._rightInset - this._leftInset, height: h - yTop - this._bottomInset };

    // While hidden (onboarding/splash overlay) or locked (trial expired/disabled),
    // record the desired active panel but attach NO BrowserView — a BrowserView
    // always paints above the HTML overlay and would cover the gate.
    if (this._hidden || this._locked) {
      return true;
    }

    // No animation if same panel or already animating
    if (oldId === id || this._animating) {
      parent.setBrowserView(view);
      view.setBounds(finalBounds);
      view.setAutoResize({ width: true, height: true });
      view.webContents.focus();
      this.onReady?.(id, view.webContents);
      return true;
    }

    const oldViews = parent.getBrowserViews();
    const oldBounds = oldViews.map((v) => ({ view: v, bounds: { ...v.getBounds() } }));

    // Position new view off-screen
    const offset = direction === "left" ? w : -w;
    view.setBounds({ ...finalBounds, x: offset });
    view.setAutoResize({ width: false, height: false });
    parent.addBrowserView(view);

    this.slideViews(
      parent, oldBounds,
      [{ view, finalBounds }],
      offset,
      220,
      () => {
        // Recompute bounds — rightInset may have changed during animation
        // (e.g. yo panel opened while slide was running)
        const [cw, ch] = parent.getContentSize();
        const cy = this.yTopFor(id);
        view.setBounds({ x: this._leftInset, y: cy, width: cw - this._rightInset - this._leftInset, height: ch - cy - this._bottomInset });
        view.setAutoResize({ width: true, height: true });
        view.webContents.focus();
        this.onReady?.(id, view.webContents);
      },
    );
    return true;
  }

  /** Switch to previous panel — going back slides right→left. */
  switchBack(parent: BrowserWindow): boolean {
    if (!this.previousPanel) return false;
    return this.switchTo(this.previousPanel, parent, "left");
  }

  /** Animate old views out + new views in (carousel slide) */
  slideViews(
    parent: BrowserWindow,
    oldViews: Array<{ view: BrowserView; bounds: Electron.Rectangle }>,
    newViews: Array<{ view: BrowserView; finalBounds: Electron.Rectangle }>,
    offset: number,
    duration = 220,
    onDone?: () => void,
  ) {
    this._animating = true;
    const newSet = new Set(newViews.map((n) => n.view));
    const start = Date.now();

    const tick = () => {
      const elapsed = Date.now() - start;
      const t = Math.min(elapsed / duration, 1);
      // Ease-out cubic
      const ease = 1 - Math.pow(1 - t, 3);

      // Slide old views out — but when the left rail is open, never let a
      // view slide past the rail's right edge, so the sliding panel doesn't
      // sweep across and cover the rail (BrowserViews paint above it).
      for (const { view, bounds } of oldViews) {
        if (newSet.has(view)) continue;
        try {
          let nx = Math.round(bounds.x - offset * ease);
          if (this._leftInset > 0) nx = Math.max(nx, this._leftInset);
          view.setBounds({ ...bounds, x: nx });
        } catch { /* view may have been destroyed */ }
      }

      // Slide new views in
      for (const { view, finalBounds } of newViews) {
        view.setBounds({
          ...finalBounds,
          x: Math.round(finalBounds.x + offset * (1 - ease)),
        });
      }

      if (t < 1) {
        setTimeout(tick, 16);
      } else {
        // Animation done — clean up
        this._animating = false;
        for (const { view } of oldViews) {
          if (!newSet.has(view)) {
            try { parent.removeBrowserView(view); } catch {}
          }
        }
        for (const { view, finalBounds } of newViews) {
          view.setBounds(finalBounds);
          view.setAutoResize({ width: false, height: false });
        }
        onDone?.();
      }
    };
    tick();
  }

  /** Get the active panel's webContents */
  get activeWebContents() {
    if (!this.activePanel) return null;
    return this.panels.get(this.activePanel)?.webContents ?? null;
  }

  /** Seed the active panel ID without triggering a switch.
   *  Used on startup so dip back has a target after the first dip. */
  setInitialActive(id: string): void {
    if (!this.activePanel) this.activePanel = id;
  }

  /** Get active panel ID */
  get activePanelId(): string | null {
    return this.activePanel;
  }

  /** Get the previously active panel ID */
  get previousPanelId(): string | null {
    return this.previousPanel;
  }

  /** Right inset (px) — used by yo panel to narrow BrowserViews */
  get rightInset(): number { return this._rightInset; }

  /** Left inset (px) — used by the files left rail to narrow BrowserViews */
  get leftInset(): number { return this._leftInset; }

  /** Top inset (px) — used by URL bar to push BrowserViews down */
  get topInset(): number { return this._topInset; }

  setFullBleed(id: string, on = true): void {
    if (on) this._fullBleed.add(id);
    else this._fullBleed.delete(id);
  }
  private yTopFor(id: string | null | undefined): number {
    return id && this._fullBleed.has(id) ? 0 : 38 + this._topInset;
  }

  private onInsetChange: (() => void) | null = null;
  setOnInsetChange(cb: () => void): void { this.onInsetChange = cb; }

  setRightInset(px: number): void {
    if (px === this._rightInset) return;
    this._rightInset = px;
    this.onInsetChange?.();
  }

  setLeftInset(px: number): void {
    if (px === this._leftInset) return;
    this._leftInset = px;
    this.onInsetChange?.();
  }

  /** Resize all visible BrowserViews to reflect current insets */
  resizeViews(parent: BrowserWindow): void {
    if (parent.isDestroyed() || this._hidden) return;
    const [w, h] = parent.getContentSize();
    for (const bv of parent.getBrowserViews()) {
      // Per-view yTop — full-bleed panels cover the titlebar strip.
      let id: string | null = null;
      for (const [pid, pv] of this.panels) { if (pv === bv) { id = pid; break; } }
      const yTop = this.yTopFor(id);
      bv.setBounds({ x: this._leftInset, y: yTop, width: w - this._rightInset - this._leftInset, height: h - yTop - this._bottomInset });
      bv.setAutoResize({ width: true, height: true });
    }
  }

  setTopInset(px: number): void {
    if (px === this._topInset) return;
    this._topInset = px;
    this.onInsetChange?.();
  }

  /** Bottom inset (px) — used by the Dock to reserve a strip below the panels. */
  get bottomInset(): number { return this._bottomInset; }
  setBottomInset(px: number): void {
    const next = Math.max(0, Math.round(px));
    if (next === this._bottomInset) return;
    this._bottomInset = next;
    this.onInsetChange?.();
  }

  /** Whether panels are currently hidden for overlay */
  get isHidden(): boolean {
    return this._hidden;
  }
  set hidden(v: boolean) {
    this._hidden = v;
  }
  private _hidden = false;

  // ── Single gate for window-view attachment ───────────────────
  // Panel-manager is the ONLY authority for what BrowserViews are attached to
  // the window. Both the single-panel path (switchTo) and the layout/grid path
  // (layout-manager) route their attaches through `attachView` so the gate is
  // honored everywhere. `_locked` (trial-expired / disabled) and `_hidden`
  // (onboarding / splash overlay) both suppress attachment — without this, a
  // second owner (the grid layout) re-attaches app views over the lockout.
  private _locked = false;
  get isLocked(): boolean { return this._locked; }
  setLocked(v: boolean): void { this._locked = v; }

  /** True when no BrowserView may be attached (overlay/lockout is up). */
  get isAttachSuppressed(): boolean { return this._hidden || this._locked; }

  /** Attach a view to the window — no-op while hidden/locked. */
  attachView(parent: BrowserWindow, view: BrowserView): boolean {
    if (this._hidden || this._locked) return false;
    parent.addBrowserView(view);
    return true;
  }

  /** Detach every BrowserView from the window (always allowed). */
  detachAllViews(parent: BrowserWindow): void {
    for (const bv of parent.getBrowserViews()) {
      try { parent.removeBrowserView(bv); } catch { /* already destroyed */ }
    }
  }

  /** Capture screenshots of all visible BrowserViews (for freeze-frame during hide) */
  async captureScreenshots(parent: BrowserWindow): Promise<Array<{ dataUrl: string; bounds: Electron.Rectangle }>> {
    const results: Array<{ dataUrl: string; bounds: Electron.Rectangle }> = [];
    for (const bv of parent.getBrowserViews()) {
      try {
        const bounds = bv.getBounds();
        const image = await bv.webContents.capturePage();
        if (!image.isEmpty()) {
          results.push({ dataUrl: image.toDataURL(), bounds });
        }
      } catch { /* view may have been destroyed */ }
    }
    return results;
  }

  /** Hide ALL BrowserViews (for overlay support) */
  hideActive(parent: BrowserWindow): void {
    this._hidden = true;
    this.detachAllViews(parent);
  }

  /** Restore the active panel's BrowserView. No-op while locked (trial expired). */
  showActive(parent: BrowserWindow): void {
    if (this._locked) return;
    this._hidden = false;
    if (this.activePanel) {
      this.switchTo(this.activePanel, parent);
    }
  }

  /** Set zoom for all panels */
  setZoom(factor: number): void {
    this.zoomFactor = Math.max(0.5, Math.min(2.0, factor));
    for (const view of this.panels.values()) {
      view.webContents.setZoomFactor(this.zoomFactor);
    }
    this.onZoomChange?.(this.zoomFactor);
  }

  /** Get current zoom factor */
  getZoom(): number {
    return this.zoomFactor;
  }

  /** Toggle DevTools for a panel (or active panel if no id given) */
  toggleDevTools(id?: string): boolean {
    const targetId = id ?? this.activePanel;
    if (!targetId) return false;
    const view = this.panels.get(targetId);
    if (!view) return false;
    if (view.webContents.isDevToolsOpened()) {
      view.webContents.closeDevTools();
    } else {
      view.webContents.openDevTools({ mode: "detach" });
    }
    return true;
  }

  /** Reload a panel (or all visible panels if no id given) */
  refresh(id?: string): boolean {
    if (id) {
      const view = this.panels.get(id);
      if (!view) return false;
      view.webContents.reload();
      return true;
    }
    // Refresh active panel
    if (this.activePanel) {
      return this.refresh(this.activePanel);
    }
    return false;
  }

  /** Get a panel's webContents by ID (null if not yet created) */
  getWebContents(id: string): WebContents | null {
    return this.panels.get(id)?.webContents ?? null;
  }

  /** Get the innermost webContents — guest webview if present, else the panel's own */
  getGuestOrWebContents(id: string): WebContents | null {
    const guest = this.guests.get(id);
    if (guest && !guest.isDestroyed()) return guest;
    return this.panels.get(id)?.webContents ?? null;
  }

  /** List IDs of panels that have loaded webContents. */
  getLoadedPanelIds(): string[] {
    return [...this.panels.keys()];
  }

  /** Check if a panel config exists */
  hasPanel(id: string): boolean {
    return this.configs.has(id);
  }

  /** Close and destroy a panel's BrowserView.
   *  If closing the active panel, switches to fallbackId (if given),
   *  then previousPanel, then any remaining loaded panel. */
  closePanel(id: string, parent: BrowserWindow, fallbackId?: string): void {
    const view = this.panels.get(id);
    if (view) {
      try {
        parent.removeBrowserView(view);
        if (!view.webContents.isDestroyed()) {
          (view.webContents as any).destroy?.();
        }
      } catch { /* already destroyed */ }
      this.panels.delete(id);
    }
    if (this.activePanel === id) {
      const prev = this.previousPanel !== id ? this.previousPanel : null;
      this.previousPanel = null;
      // Pick best fallback: caller hint → previous → any loaded panel
      const next = [fallbackId, prev].find((f) => f && this.panels.has(f))
        ?? (this.panels.size > 0 ? this.panels.keys().next().value ?? null : null);
      this.activePanel = next;
      if (next && !parent.isDestroyed()) {
        this.switchTo(next, parent);
      }
    } else if (this.previousPanel === id) {
      this.previousPanel = null;
    }
  }

  /** Clear cookies/storage/cache for a panel (or active panel) and reload */
  async clearSession(id?: string): Promise<boolean> {
    const targetId = id ?? this.activePanel;
    if (!targetId) return false;
    const view = this.panels.get(targetId);
    if (!view) return false;
    const ses = view.webContents.session;
    await ses.clearStorageData();
    await ses.clearCache();
    view.webContents.reload();
    return true;
  }
}
