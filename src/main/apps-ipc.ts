import { app, ipcMain, dialog, BrowserWindow, net } from "electron";
import { refreshForceWebSlugs } from "./force-web";
import fs from "fs";
import { extractMacAppIcon } from "./app-icon-extract";
import { hasMcpAccess } from "./auth";
import * as appsStore from "./apps-store";
import { dispatchRelayMethod } from "./relay-client";
import { fetchOrgApps } from "./org-apps";
import { BUILTIN_WORKPANELS, WORKPANEL_REFUSAL } from "./saved-tabs";
import { scanChromeProfiles, importFromChrome } from "./chrome-import";

import { openAppByRef, openLayoutByName } from "./app-resolver";
import { BUILTIN_EFFECT_LIST } from "../shared/drip-effects";
import { getDripManagerInstance } from "./drip-manager";

/** The panel apps (the tab rows, apps-store.ts) as the Apps tab reads them.
 *  Errors surface as { ok: false, error } rather than throwing, so the
 *  renderer can show a message instead of crashing. */
function registerPanelAppsIpc(getMainWindow: () => BrowserWindow | null): void {
  // Launch an app — every path opens a workbench panel beside the agent
  // (openAppByRef sends wb:app-cmd). OS windows and real-browser launches
  // are retired; a raw web URL not in the library still opens as a panel.
  ipcMain.handle("app-launch", async (_e, spec: {
    slug: string; name: string; url?: string | null;
    isBrowser?: boolean;
    execPath?: string | null; appArchetype?: string | null;
    launchConfig?: Record<string, unknown> | null;
  }) => {
    if (!spec) return { ok: false, error: "No app given" };
    try {
      await openAppByRef(spec.slug || spec.name);
      return { ok: true };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[app-launch] "${spec.slug || spec.name}" failed:`, msg);
      return { ok: false, error: msg };
    }
  });

  // Renderer diagnostic bridge — surfaces the main-window renderer's [wb] logs
  // in the terminal (its own console lives in the window's DevTools).
  ipcMain.on("wb-log", (_e, msg: unknown) => console.log(String(msg)));

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

  // Web icon (favicon) as a data URL — Echo's WebGL wall can't upload
  // cross-origin <img> pixels into a texture (canvas taint), so the byte
  // fetch rides the main process where CORS doesn't apply. https-only,
  // image/* only, small, session-cached.
  const webIconCache = new Map<string, string>();
  ipcMain.handle("web-icon-fetch", async (_e, rawUrl: string) => {
    const u = String(rawUrl || "").trim();
    // https, or http to LOOPBACK only (the dev control plane at
    // localhost:3001 serves /api/icons — the https-only guard was returning
    // "" for every tile, which is why the whole wall fell back to letters).
    if (!/^https:\/\//i.test(u) && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?\//i.test(u)) return "";
    const hit = webIconCache.get(u);
    if (hit !== undefined) return hit;
    let out = "";
    try {
      const res = await net.fetch(u);
      const type = (res.headers.get("content-type") || "").split(";")[0].trim();
      if (res.ok && type.startsWith("image/")) {
        const buf = Buffer.from(await res.arrayBuffer());
        if (buf.length > 0 && buf.length <= 512 * 1024) out = `data:${type};base64,${buf.toString("base64")}`;
      }
    } catch { out = ""; }
    webIconCache.set(u, out);
    return out;
  });

  ipcMain.handle("panel-apps-list", async () => {
    try { return await fetchOrgApps(); }
    catch { return []; }
  });

  // No house defaults on the wall: the Marketplace tile is gone (his order,
  // 2026-09-16) — Skills and Plugins live in Settings → Build.

}

import { desktopLayouts, toLayoutRow, type GridCell, type LayoutManager } from "./layout-manager";

interface AppsIpcDeps {
  layoutManager: LayoutManager;
  canSaveLayout: (count: number) => { allowed: boolean; reason?: string };
  getMainWindow: () => import("electron").BrowserWindow | null;
}

export function registerAppsIpc(deps: AppsIpcDeps): void {
  const {
    layoutManager,
    canSaveLayout,
    getMainWindow,
  } = deps;

  registerPanelAppsIpc(getMainWindow);

  // Open a saved layout: every cell becomes a workbench PANEL inside Glyphh.
  // (Layouts used to be able to target the desktop and tile real OS windows —
  // that is gone; Glyphh does not arrange other apps' windows.)
  ipcMain.handle("layouts-open", async (_e, name: string) => {
    try { return { ok: true, ...(await openLayoutByName(String(name))) }; }
    catch (err) { return { ok: false, error: err instanceof Error ? err.message : String(err) }; }
  });

  // IPC: layouts CRUD — the files under ~/.glyphh/workspaces are the truth;
  // every list re-scans them. The row is layout-manager's ONE projection,
  // shared with the attach socket's layouts.list. The list is THIS SURFACE'S
  // (his order, 2026-10-06): only the workspaces made on a desktop — a
  // web-made one stays in the folder and the library, listed on the web.
  ipcMain.handle("layouts-list", async () => desktopLayouts(await layoutManager.refreshAndList()).map(toLayoutRow));
  ipcMain.handle("layouts-save", async (_e, name: string, panelIds: string[]) => {
    const existing = layoutManager.listLayouts().find(l => l.name === name);
    if (!existing) {
      const gate = canSaveLayout(layoutManager.listLayouts().length);
      if (!gate.allowed) return { error: gate.reason };
    }
    const count = panelIds.length;
    await layoutManager.saveLayout({
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
  ipcMain.handle("layouts-save-grid", async (_e, grid: { name: string; cols: number; rows: number; colWidths: number[]; rowHeights: number[]; cells: GridCell[]; folderMode?: "single" | "multi"; target?: "glyphh" | "desktop"; loop?: string | null; view?: "glyphh" | "cli" | null; modelSelections?: Record<string, string>; sessionMode?: "keep" | "new" | "last"; type?: "work" | "code" | null; gateway?: "on" | "off" | null; folder?: string | null; space?: "chat" | "cowork" | "code" | null }) => {
    const existing = layoutManager.listLayouts().find(l => l.name === grid.name);
    if (!existing) {
      const gate = canSaveLayout(layoutManager.listLayouts().length);
      if (!gate.allowed) return { error: gate.reason };
    }
    const { loop, view, modelSelections, sessionMode, type, gateway, folder, space, ...rest } = grid;
    await layoutManager.saveLayout({
      ...rest,
      version: 2,
      folderMode: grid.folderMode ?? "single",
      target: grid.target ?? "glyphh",
      ...(loop ? { loop } : {}),
      // The face its agents open with (chat or terminal); absent leaves the app default.
      ...(view === "glyphh" || view === "cli" ? { view } : {}),
      ...(type === "work" || type === "code" ? { type } : {}),
      ...(gateway === "on" || gateway === "off" ? { gateway } : {}),
      ...(modelSelections && Object.keys(modelSelections).length ? { modelSelections } : {}),
      ...(sessionMode && sessionMode !== "keep" ? { sessionMode } : {}),
      ...(folder ? { folder } : {}),
      ...(space === "chat" || space === "cowork" || space === "code" ? { space } : {}),
    });
    return true;
  });
  // Folder-only picker for the layout editor's working-folder field. Pick
  // only — never touches the actual working directory.
  ipcMain.handle("layouts-pick-folder", async () => {
    const win = getMainWindow();
    if (!win || win.isDestroyed()) return null;
    const picked = await dialog.showOpenDialog(win, {
      title: "Choose the layout's working folder",
      properties: ["openDirectory", "createDirectory"],
    });
    return picked.canceled ? null : (picked.filePaths[0] ?? null);
  });

  ipcMain.handle("layouts-delete", async (_e, name: string) => layoutManager.deleteLayout(name));

  // IPC: Drips CRUD — LOCAL presets (drips table, user-state.sqlite).
  ipcMain.handle("drips-list", async () => (await getDripManagerInstance()?.refreshAndList()) ?? []);
  ipcMain.handle("drips-save", async (_e, name: string, recipe: string) => (await getDripManagerInstance()?.saveCustomAsync(name, recipe)) ?? "");
  ipcMain.handle("drips-delete", async (_e, name: string) => (await getDripManagerInstance()?.deleteCustomAsync(name)) ?? "");
  ipcMain.handle("drips-builtin-effects", () => BUILTIN_EFFECT_LIST);
  // A PREVIEW is windowed + time-bounded — never a full-screen forever overlay.
  ipcMain.handle("drips-preview", async (_e, recipe: string) => {
    const mgr = getDripManagerInstance();
    if (!mgr) return "drip manager not ready";
    return mgr.execute(recipe.split(/\s+/), { preview: true });
  });
  ipcMain.handle("drips-stop", async () => {
    const mgr = getDripManagerInstance();
    if (!mgr) return "drip manager not ready";
    mgr.stopAll();
    return "stopped";
  });
  ipcMain.handle("drips-running", async () => (getDripManagerInstance()?.running() ?? []));

  ipcMain.handle("has-mcp-access", () => hasMcpAccess());


  const entryKind = (o: Record<string, unknown>): "web" | "native" | "glyphh" => {
    if (String(o.appArchetype ?? "") === "glyphh-app") return "glyphh";
    return o.isBrowser === false || o.execPath ? "native" : "web";
  };

  const entryFields = (o: Record<string, unknown>) => ({
    ...(o.name !== undefined ? { name: String(o.name) } : {}),
    ...(o.url !== undefined && o.url !== null ? { url: String(o.url) } : {}),
    ...(o.execPath !== undefined && o.execPath !== null ? { nativeRef: String(o.execPath) } : {}),
    ...(o.description !== undefined ? { description: String(o.description) } : {}),
    ...(o.launchConfig !== undefined ? { config: (o.launchConfig ?? {}) as Record<string, unknown> } : {}),
    ...(o.access !== undefined ? { access: o.access as "public" | "members" } : {}),
  });

  const appSlug = async (id: string): Promise<string> => {
    const apps = await fetchOrgApps();
    return apps.find((a) => a.id === id)?.slug ?? id;
  };

  ipcMain.handle("panel-apps-create", async (_e, input: Record<string, unknown>) => {
    setTimeout(() => { void refreshForceWebSlugs(); }, 500);   // guard set follows app edits
    try {
      const slug = String(input.slug || input.name || "").toLowerCase().trim()
        .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
      if (!slug) return { ok: false, error: "A name is required." };
      if (BUILTIN_WORKPANELS.has(slug)) return { ok: false, error: WORKPANEL_REFUSAL };
      const app = await appsStore.createEntry({
        kind: entryKind(input),
        slug,
        name: String(input.name || slug),
        ...entryFields(input),
      });
      return { ok: true, app };
    }
    catch (err) { return { ok: false, error: err instanceof Error ? err.message : String(err) }; }
  });
  ipcMain.handle("panel-apps-update", async (_e, id: string, patch: Record<string, unknown>) => {
    setTimeout(() => { void refreshForceWebSlugs(); }, 500);   // guard set follows app edits
    try {
      // A retype only travels when the renderer asserts a LAUNCHER shape
      // (`isBrowser`). Without this the type dropdown appeared to save and the
      // row kept its old kind; with it on a built app, the server would refuse
      // the whole patch — a glyphh app's kind comes from its bundle.
      const kind = patch.isBrowser !== undefined ? entryKind(patch) : undefined;
      const slug = await appSlug(id);
      if (BUILTIN_WORKPANELS.has(slug) || BUILTIN_WORKPANELS.has(String(patch.slug ?? ""))) {
        return { ok: false, error: WORKPANEL_REFUSAL };
      }
      // RPA ON A TAB (2026-10-07): the General form rebuilds launchConfig from
      // its own fields, so a save there carries the mapping forward unless the
      // caller sets `rpa` itself.
      const fields = entryFields(patch);
      if (fields.config && !("rpa" in fields.config)) {
        const rpa = appsStore.readRow(slug)?.config?.rpa;
        if (rpa) fields.config = { ...fields.config, rpa };
      }
      const app = await appsStore.updateEntry(slug, {
        ...fields,
        ...(kind === "web" || kind === "native" ? { kind } : {}),
      });
      return { ok: true, app };
    }
    catch (err) { return { ok: false, error: err instanceof Error ? err.message : String(err) }; }
  });
  // RPA ON A TAB (2026-10-07): the Tabs page's RPA tab, through the registry
  // doors the agent's rpa_* tools use. One door, the method named.
  const RPA_TAB_METHODS = new Set(["commands", "pick", "map", "unmap", "run", "sequenceSave", "sequenceRemove", "sequenceRun"]);
  ipcMain.handle("rpa-tab", async (_e, method: string, params: Record<string, unknown>) => {
    if (!RPA_TAB_METHODS.has(String(method))) return { ok: false, error: `no such RPA door: ${String(method)}` };
    try { return { ok: true, result: await dispatchRelayMethod(`rpa.${method}`, params ?? {}) }; }
    catch (err) { return { ok: false, error: err instanceof Error ? err.message : String(err) }; }
  });
  ipcMain.handle("panel-apps-delete", async (_e, id: string) => {
    try {
      const slug = await appSlug(id);
      if (BUILTIN_WORKPANELS.has(slug)) return { ok: false, error: WORKPANEL_REFUSAL };
      await appsStore.removeEntry(slug);
      return { ok: true };
    }
    catch (err) { return { ok: false, error: err instanceof Error ? err.message : String(err) }; }
  });
  // IMPORT FROM GOOGLE (his order, 2026-09-23). The scan is what the dialog
  // reads out (profile names + counts, nothing secret); the import is what the
  // user then confirmed.
  ipcMain.handle("chrome-import-scan", async () => {
    try { return await scanChromeProfiles(); }
    catch (err) { return { ok: false, installed: false, cookiesSupported: false, profiles: [], error: err instanceof Error ? err.message : String(err) }; }
  });
  ipcMain.handle("chrome-import-run", async (_e, opts: { profile?: string; cookies?: boolean }) => {
    try { return await importFromChrome(opts ?? {}); }
    catch (err) { return { ok: false, tabsAdded: 0, tabsSkipped: 0, cookiesImported: 0, cookiesFailed: 0, error: err instanceof Error ? err.message : String(err) }; }
  });
}
