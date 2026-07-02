import { app, ipcMain, dialog } from "electron";
import fs from "fs";
import { extractMacAppIcon } from "./app-icon-extract";
import type { AppConnector, AppConfig } from "./app-connector";
import { exportApp, importApp, localBundleDir } from "./yo-app-package";
import { hasMcpAccess, serverGetAuthed, serverPostAuthed, serverPatchAuthed, serverDeleteAuthed } from "./auth";
import { openAppWindow } from "./app-window-manager";
import { launchNativeApp, launchInNativeChrome } from "./native-launch";
import { openLayoutByName } from "./app-resolver";

/** Server-authoritative panel-apps CRUD (Dashboard shell) — the Apps tab's
 *  list is no longer a local object; every read/write goes straight to
 *  yo-server's /api/panel-apps (see saved-app-routes.ts). Errors surface as
 *  { ok: false, error } rather than throwing, so the renderer can show a
 *  message instead of crashing on a network hiccup. */
function registerPanelAppsIpc(): void {
  // 5b Panel Manager: open a server app in its own native OS window.
  ipcMain.handle("app-window-open", (_e, spec: { slug: string; name: string; url: string; forceWeb?: boolean }) => {
    if (!spec?.url || (!spec.url.startsWith("http://") && !spec.url.startsWith("https://"))) {
      return { ok: false, error: "App has no web URL" };
    }
    openAppWindow({ slug: String(spec.slug || spec.url), name: String(spec.name || spec.slug), url: spec.url, forceWeb: !!spec.forceWeb });
    return { ok: true };
  });

  // Launch an app the way its config says to (Browser↔Native model):
  //   - native app (isBrowser=false) → launch its executable + archetype config
  //   - browser app, target "native" → open the URL in the user's real Chrome
  //   - browser app, target "webview" (default) → Glyphh's own webview window
  ipcMain.handle("app-launch", (_e, spec: {
    slug: string; name: string; url?: string | null; forceWeb?: boolean;
    isBrowser?: boolean; browserTarget?: "webview" | "native";
    execPath?: string | null; appArchetype?: string | null;
    launchConfig?: Record<string, unknown> | null;
  }) => {
    if (!spec) return { ok: false, error: "No app given" };
    const isBrowser = spec.isBrowser !== false; // legacy rows default to browser
    if (!isBrowser) {
      return launchNativeApp(spec.execPath ?? "", spec.appArchetype, spec.launchConfig);
    }
    if (spec.browserTarget === "native") {
      return launchInNativeChrome(String(spec.url || ""));
    }
    // webview (default) — Glyphh's own OS window over the shared session.
    const url = String(spec.url || "");
    if (!url.startsWith("http://") && !url.startsWith("https://")) {
      return { ok: false, error: "App has no web URL" };
    }
    openAppWindow({ slug: String(spec.slug || url), name: String(spec.name || spec.slug), url, forceWeb: !!spec.forceWeb });
    return { ok: true };
  });

  // Native-app icon as a data URL (Apps page, Layouts cards, command overlay),
  // session-cached per path and SERIALIZED through a promise chain.
  //
  // macOS deliberately does NOT use app.getFileIcon: it decodes NSImage icon
  // reps on Chromium's worker pool and a malformed rep hard-CHECKs the whole
  // process (SIGTRAP in rust_bmp…Reader::metadata_loaded — crashed twice).
  // Instead the icon is extracted out-of-process (icns → sips → PNG); a bad
  // icon can only fail the sips child, never Electron. Windows keeps
  // getFileIcon (SHGetFileInfo path, not implicated).
  const fileIconCache = new Map<string, string>();
  let fileIconChain: Promise<unknown> = Promise.resolve();
  ipcMain.handle("app-file-icon", (_e, execPath: string) => {
    const p = String(execPath || "").trim();
    if (!p) return "";
    const hit = fileIconCache.get(p);
    if (hit !== undefined) return hit;
    const next = fileIconChain.then(async () => {
      const again = fileIconCache.get(p);
      if (again !== undefined) return again;
      let url = "";
      try {
        if (fs.existsSync(p)) {
          if (process.platform === "darwin") {
            url = await extractMacAppIcon(p);
          } else {
            const icon = await app.getFileIcon(p, { size: "large" });
            url = icon.isEmpty() ? "" : icon.toDataURL();
          }
        }
      } catch { url = ""; }
      fileIconCache.set(p, url);
      return url;
    });
    fileIconChain = next.catch(() => "");
    return next;
  });

  ipcMain.handle("panel-apps-list", async () => {
    try { return await serverGetAuthed<unknown[]>("/api/panel-apps"); }
    catch { return []; }
  });
  // input/patch are forwarded verbatim to the server, which validates and
  // picks the fields it accepts (see saved-app-routes.ts readCreateInput).
  // Typed as Record so the new Browser↔Native fields (isBrowser, browserTarget,
  // execPath, appArchetype, launchConfig) pass straight through untouched.
  ipcMain.handle("panel-apps-create", async (_e, input: Record<string, unknown>) => {
    try { return { ok: true, app: await serverPostAuthed("/api/panel-apps", input) }; }
    catch (err) { return { ok: false, error: err instanceof Error ? err.message : String(err) }; }
  });
  ipcMain.handle("panel-apps-update", async (_e, id: string, patch: Record<string, unknown>) => {
    try { return { ok: true, app: await serverPatchAuthed(`/api/panel-apps/${id}`, patch) }; }
    catch (err) { return { ok: false, error: err instanceof Error ? err.message : String(err) }; }
  });
  ipcMain.handle("panel-apps-delete", async (_e, id: string) => {
    try { await serverDeleteAuthed(`/api/panel-apps/${id}`); return { ok: true }; }
    catch (err) { return { ok: false, error: err instanceof Error ? err.message : String(err) }; }
  });
  ipcMain.handle("panel-apps-set-connection", async (_e, id: string, pipedreamSlug: string) => {
    try { return { ok: true, app: await serverPatchAuthed(`/api/panel-apps/${id}/connection`, { pipedreamSlug }) }; }
    catch (err) { return { ok: false, error: err instanceof Error ? err.message : String(err) }; }
  });
  ipcMain.handle("panel-apps-remove-connection", async (_e, id: string) => {
    try { await serverDeleteAuthed(`/api/panel-apps/${id}/connection`); return { ok: true }; }
    catch (err) { return { ok: false, error: err instanceof Error ? err.message : String(err) }; }
  });
  ipcMain.handle("panel-apps-set-mcp", async (_e, id: string, mcp: Record<string, unknown>) => {
    try { return { ok: true, app: await serverPatchAuthed(`/api/panel-apps/${id}/mcp`, mcp) }; }
    catch (err) { return { ok: false, error: err instanceof Error ? err.message : String(err) }; }
  });
  ipcMain.handle("panel-apps-remove-mcp", async (_e, id: string) => {
    try { await serverDeleteAuthed(`/api/panel-apps/${id}/mcp`); return { ok: true }; }
    catch (err) { return { ok: false, error: err instanceof Error ? err.message : String(err) }; }
  });
  ipcMain.handle("panel-apps-set-command", async (_e, id: string, key: string, mapping: Record<string, unknown>) => {
    try { return { ok: true, app: await serverPatchAuthed(`/api/panel-apps/${id}/commands/${encodeURIComponent(key)}`, mapping) }; }
    catch (err) { return { ok: false, error: err instanceof Error ? err.message : String(err) }; }
  });
  ipcMain.handle("panel-apps-remove-command", async (_e, id: string, key: string) => {
    try { await serverDeleteAuthed(`/api/panel-apps/${id}/commands/${encodeURIComponent(key)}`); return { ok: true }; }
    catch (err) { return { ok: false, error: err instanceof Error ? err.message : String(err) }; }
  });
}

/** Strip the MCP OAuth client secret before any app config crosses IPC to the
 *  renderer. The secret stays in the main process / encrypted on disk; the UI
 *  sends a blank secret on save and the main process preserves the stored one. */
function redactSecrets(apps: AppConfig[]): AppConfig[] {
  return apps.map((a) =>
    a.mcp?.oauth?.clientSecret
      ? { ...a, mcp: { ...a.mcp, oauth: { ...a.mcp.oauth, clientSecret: "" } } }
      : a,
  );
}
import type { LayoutManager } from "./layout-manager";
import type { DripManager } from "./drip-manager";
import type { PanelManager } from "./panel-manager";

interface AppsIpcDeps {
  appConnector: AppConnector;
  layoutManager: LayoutManager;
  dripManager: DripManager | null;
  panelManager: PanelManager;
  canAddApp: (count: number) => { allowed: boolean; reason?: string };
  canSaveLayout: (count: number) => { allowed: boolean; reason?: string };
  getMainWindow: () => import("electron").BrowserWindow | null;
  PICKER_SCRIPT: string;
}

/** Hide system-kind apps from the Layouts cell picker.
 *  They're still mountable via the `+` picker and `.dip`, just not in layouts. */
function isUserKindApp(a: { kind?: "user" | "system" }): boolean {
  return (a.kind ?? "user") !== "system";
}

export function registerAppsIpc(deps: AppsIpcDeps): void {
  const {
    appConnector,
    layoutManager,
    dripManager,
    panelManager,
    canAddApp,
    canSaveLayout,
    getMainWindow,
    PICKER_SCRIPT,
  } = deps;

  registerPanelAppsIpc();

  // Open a saved layout at the OS level — real windows tiled across the display
  // (nothing renders inside the Glyphh client). This is the hand-off the Layouts
  // tab's "Open" button uses instead of the legacy in-window layout manager.
  ipcMain.handle("layouts-open", async (_e, name: string) => {
    try { return { ok: true, ...(await openLayoutByName(String(name), "screen")) }; }
    catch (err) { return { ok: false, error: err instanceof Error ? err.message : String(err) }; }
  });

  // IPC: layouts CRUD
  // Server-authoritative (yo-server /api/layouts) — refresh the local cache
  // from the server before listing so the Layouts tab shows server truth.
  ipcMain.handle("layouts-list", async () =>
    (await layoutManager.refreshAndList()).map((l) => ({
      name: l.name,
      cols: l.cols,
      rows: l.rows,
      colWidths: l.colWidths,
      rowHeights: l.rowHeights,
      splits: l.cells.map((c) => ({ panelId: c.panelId, col: c.col, row: c.row, colSpan: c.colSpan, rowSpan: c.rowSpan })),
    }))
  );
  ipcMain.handle("layouts-save", (_e, name: string, panelIds: string[]) => {
    const existing = layoutManager.listLayouts().find(l => l.name === name);
    if (!existing) {
      const gate = canSaveLayout(layoutManager.listLayouts().length);
      if (!gate.allowed) return { error: gate.reason };
    }
    const count = panelIds.length;
    layoutManager.saveLayout({
      name,
      version: 2,
      cols: count,
      rows: 1,
      colWidths: Array(count).fill(1 / count),
      rowHeights: [1],
      cells: panelIds.map((id, i) => ({
        panelId: id,
        col: i,
        row: 0,
        colSpan: 1,
        rowSpan: 1,
      })),
    });
    return true;
  });
  ipcMain.handle("layouts-save-grid", (_e, grid: { name: string; cols: number; rows: number; colWidths: number[]; rowHeights: number[]; cells: Array<{ panelId: string; col: number; row: number; colSpan: number; rowSpan: number }>; folderMode?: "single" | "multi" }) => {
    const existing = layoutManager.listLayouts().find(l => l.name === grid.name);
    if (!existing) {
      const gate = canSaveLayout(layoutManager.listLayouts().length);
      if (!gate.allowed) return { error: gate.reason };
    }
    layoutManager.saveLayout({ ...grid, version: 2, folderMode: grid.folderMode ?? "single" });
    return true;
  });
  /** True if any app in the layout declares requiresFolder. The UI uses
   *  this to show the folder-mode toggle + the layout-level folder picker. */
  ipcMain.handle("layouts-folder-required", (_e, name: string) => {
    const layout = layoutManager.listLayouts().find(l => l.name === name);
    if (!layout) return false;
    const apps = appConnector.list();
    return layout.cells.some(c => apps.find(a => a.id === c.panelId)?.requiresFolder);
  });
  ipcMain.handle("layouts-delete", (_e, name: string) => layoutManager.deleteLayout(name));

  // IPC: Drips CRUD
  // Server-authoritative (yo-server /api/drips) — list refreshes from the
  // server; save/delete await the write so a subsequent list is consistent.
  ipcMain.handle("drips-list", async () => (await dripManager?.refreshAndList()) ?? []);
  ipcMain.handle("drips-save", async (_e, name: string, recipe: string) => (await dripManager?.saveCustomAsync(name, recipe)) ?? "");
  ipcMain.handle("drips-delete", async (_e, name: string) => (await dripManager?.deleteCustomAsync(name)) ?? "");
  ipcMain.handle("drips-builtin-effects", () => {
    const { BUILTIN_EFFECTS } = require("./drip-manager");
    return BUILTIN_EFFECTS as string[];
  });
  ipcMain.handle("drips-preview", async (_e, recipe: string) => {
    if (!dripManager) return "drip manager not ready";
    return dripManager.execute(recipe.split(/\s+/));
  });

  // IPC: apps CRUD (panel apps).
  // Apps registry shows ONLY user-owned apps — internal apps that ship
  // with .Yo (Agent, Vibe, Spec, Council, Terminal, plus the system rail
  // surfaces) are uneditable and hidden here. They're still openable from
  // the `+` picker, `.dip`, and (where allowed) Layouts.
  // Renderer-side tier check (same gate the connect IPCs enforce) so the UI
  // can lock the MCP / Connection tabs for Free users instead of showing a
  // form that silently fails to save.
  ipcMain.handle("has-mcp-access", () => hasMcpAccess());
  ipcMain.handle("apps-list", () =>
    redactSecrets(appConnector.list().filter((a) => !a.internal)),
  );
  // All apps including system. Used by the panel `+` picker so users can
  // mount Dashboard/Apps/Agents/etc. as standalone panels.
  ipcMain.handle("apps-list-all", () => redactSecrets(appConnector.list()));
  // Mountable in Layouts: user apps + non-system internal apps (Agent,
  // Vibe, Spec, Council, Terminal, Browser). System rail surfaces stay
  // out per the design.
  ipcMain.handle("apps-list-mountable", () =>
    redactSecrets(appConnector.list().filter(isUserKindApp)),
  );
  // "apps-add" stays for the still-local INTERNAL_APPS registry (system nav
  // apps, .dip-openable panels) — NOT the Apps tab's user-facing library,
  // which is server-authoritative via panel-apps-* above (see apps.ts).
  ipcMain.handle("apps-add", (_e, id: string, name: string, url?: string) => {
    const userApps = appConnector.list().filter(a => a.url && !a.url.startsWith("yo://")).length;
    const gate = canAddApp(userApps);
    if (!gate.allowed) return { error: gate.reason };
    const app = appConnector.add(id, name, url);
    if (url) panelManager.addPanel(id, url);
    return app;
  });
  // Defense in depth — internal apps are ALL uneditable/undeletable via IPC.
  // The Apps registry UI already filters them out (see apps-list), but a
  // direct IPC call would otherwise still mutate them.
  const refuseIfInternal = (id: string) => appConnector.isInternal(id);
  ipcMain.handle("apps-remove", (_e, id: string) => refuseIfInternal(id) ? false : appConnector.remove(id));
  // Connections are available to all tiers — no pay gate. (MCP server config
  // below stays gated.) refuseIfInternal still blocks editing built-in apps.
  ipcMain.handle("apps-set-connection", (_e, id: string, pipedreamSlug: string) =>
    refuseIfInternal(id) ? false : appConnector.setConnection(id, { pipedreamSlug }));
  ipcMain.handle("apps-remove-connection", (_e, id: string) =>
    refuseIfInternal(id) ? false : appConnector.removeConnection(id));
  ipcMain.handle("apps-set-mcp", (_e, id: string, mcp: any) =>
    refuseIfInternal(id) ? false : appConnector.setMcp(id, mcp));
  ipcMain.handle("apps-remove-mcp", (_e, id: string) =>
    refuseIfInternal(id) ? false : appConnector.removeMcp(id));
  ipcMain.handle("apps-update-id", (_e, oldId: string, newId: string) => {
    if (refuseIfInternal(oldId)) return false;
    const ok = appConnector.updateId(oldId, newId);
    if (ok) layoutManager.renamePanelId(oldId, newId);
    return ok;
  });
  ipcMain.handle("apps-update-name", (_e, id: string, name: string) =>
    refuseIfInternal(id) ? false : appConnector.updateName(id, name));
  ipcMain.handle("apps-update-url", (_e, id: string, url: string) =>
    refuseIfInternal(id) ? false : appConnector.updateUrl(id, url));
  ipcMain.handle("apps-update-force-web", (_e, id: string, forceWeb: boolean) =>
    refuseIfInternal(id) ? false : appConnector.updateForceWeb(id, forceWeb));
  ipcMain.handle("apps-set-connected-slug", () => false);

  // ── yo app package (import / export) ──────────────────────
  // Export an app to a .yoapp bundle. Web apps are manifest-only; bundled apps
  // carry their code/ assets. (Static-build bundling for vibe output is a TODO;
  // exportApp already supports a bundledCodeDir arg for when that lands.)
  ipcMain.handle("app-export", async (_e, appId: string) => {
    const app = appConnector.get(appId);
    if (!app) return { ok: false, error: `App "${appId}" not found` };
    const win = getMainWindow();
    if (!win || win.isDestroyed()) return { ok: false, error: "No window" };
    const safeName = (app.name || app.id).replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || app.id;
    const result = await dialog.showSaveDialog(win, {
      title: "Export app",
      defaultPath: `${safeName}.yoapp`,
      filters: [{ name: "yo app", extensions: ["yoapp"] }],
    });
    if (result.canceled || !result.filePath) return { ok: false, error: "Canceled" };
    const dest = result.filePath.endsWith(".yoapp") ? result.filePath : `${result.filePath}.yoapp`;
    // Multi-file / local apps (file:// url) export WITH their code folder; remote
    // web apps (http/yo://) are manifest-only.
    const codeDir = localBundleDir(app.url);
    return exportApp(appConnector, appId, dest, codeDir);
  });

  // Import a .yoapp bundle → register it (deduping the id) → return the appId.
  ipcMain.handle("app-import", async () => {
    const win = getMainWindow();
    if (!win || win.isDestroyed()) return { ok: false, error: "No window" };
    const result = await dialog.showOpenDialog(win, {
      title: "Import app",
      properties: ["openFile"],
      filters: [{ name: "yo app", extensions: ["yoapp"] }],
    });
    if (result.canceled || result.filePaths.length === 0) return { ok: false, error: "Canceled" };
    const res = importApp(appConnector, result.filePaths[0]);
    if (res.ok && res.appId) {
      const app = appConnector.get(res.appId);
      if (app?.url) panelManager.addPanel(res.appId, app.url);
    }
    return res;
  });

  // IPC: app command mapping (DOM picker)
  ipcMain.handle("apps-set-command", (_e, id: string, key: string, mapping: { selector: string; action: string; description: string }) => {
    return appConnector.setCommand(id, key, mapping as any);
  });
  ipcMain.handle("apps-remove-command", (_e, id: string, key: string) => {
    return appConnector.removeCommand(id, key);
  });
  // Dashboard shell (5a): commands now live server-side (saved_apps.commands),
  // so the renderer passes the mapping it already has in hand rather than
  // asking main to look it up by (id, key) in the local appConnector — that
  // registry no longer holds user-added panel apps' command data.
  ipcMain.handle("apps-test-command", async (_e, mapping: import("./app-connector").CommandMapping | null, wcId?: number) => {
    if (!mapping) return "Command not found";
    let wc: import("electron").WebContents | null = null;
    if (wcId) {
      const { webContents } = require("electron") as typeof import("electron");
      wc = webContents.fromId(wcId) ?? null;
    }
    if (!wc || wc.isDestroyed()) return "Panel not open";
    const { executeCommand: execCmd } = await import("./dom-bridge");
    return execCmd(wc, mapping);
  });

  ipcMain.on("start-picker", (e, wcId: number) => {
    const { webContents } = require("electron") as typeof import("electron");
    const wc = webContents.fromId(wcId);
    if (!wc || wc.isDestroyed()) return;
    // Reply to the renderer that asked — the Apps section runs inside the
    // Home panel's own BrowserView, not the main window.
    const sender = e.sender;
    // PICKER_SCRIPT resolves a Promise with the pick (or null on cancel);
    // executeJavaScript hands us that value directly — no console-message bridge.
    wc.executeJavaScript(PICKER_SCRIPT, true)
      .then((result) => {
        if (!sender.isDestroyed()) sender.send("picker-result", result ?? null);
      })
      .catch(() => {
        if (!sender.isDestroyed()) sender.send("picker-result", null);
      });
  });
}
