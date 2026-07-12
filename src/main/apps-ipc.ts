import { app, ipcMain, dialog } from "electron";
import fs from "fs";
import { extractMacAppIcon } from "./app-icon-extract";
import type { AppConnector, AppConfig } from "./app-connector";
import { exportApp, importApp, localBundleDir } from "./glyphh-app-package";
import { hasMcpAccess, serverGetAuthed, serverPostAuthed, serverPatchAuthed, serverPutAuthed, serverDeleteAuthed, AUTH_SERVER } from "./auth";
import { cachedServerGet, invalidateServerCache } from "./server-cache";
import { listMarketplace, getMarketplaceApp, installMarketplaceApp } from "./marketplace";

import { detectBrowsers } from "./browser-detect";
import { openAppByRef, openLayoutByName } from "./app-resolver";
import { showThinking, hideThinking } from "./thinking-overlay";
import { isGlyphhAppBundle, installGlyphhAppBundle, isGlyphhAppRow } from "./glyphh-app-host";
import { listAppSecrets, setAppSecret, deleteAppSecret } from "./app-secrets";
import { invalidateProxyCache } from "./app-proxy-stream";

/** Server-authoritative panel-apps CRUD (Dashboard shell) — the Apps tab's
 *  list is no longer a local object; every read/write goes straight to
 *  yo-server's /api/panel-apps (see saved-app-routes.ts). Errors surface as
 *  { ok: false, error } rather than throwing, so the renderer can show a
 *  message instead of crashing on a network hiccup. */
function registerPanelAppsIpc(): void {
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
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  // Installed real browsers — feeds the app editor's Browser dropdown.
  ipcMain.handle("browsers-detect", () => detectBrowsers());

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
    try { return await cachedServerGet<unknown[]>("/api/panel-apps"); }
    catch { return []; }
  });

  // ── Marketplace ──────────────────────────────────────────────
  // Shopify-style catalog (public + org-private). Backed by marketplace.ts,
  // which serves a placeholder catalog until the yo-server routes land.
  ipcMain.handle("marketplace-list", async (_e, params: {
    scope?: string; category?: string; q?: string; sort?: string; page?: number;
  }) => {
    const scope = params?.scope === "private" ? "private" : "public";
    try {
      return await listMarketplace({
        scope,
        category: params?.category,
        q: params?.q,
        sort: (params?.sort as "popular" | "rating" | "newest") || "popular",
        page: params?.page,
      });
    } catch {
      return { items: [], total: 0, page: 1, pageSize: 12, categories: [], featured: [], popular: [] };
    }
  });
  ipcMain.handle("marketplace-detail", async (_e, id: string) => {
    try { return await getMarketplaceApp(String(id)); }
    catch { return null; }
  });
  ipcMain.handle("marketplace-install", async (_e, id: string) => installMarketplaceApp(String(id)));
  // input/patch are forwarded verbatim to the server, which validates and
  // picks the fields it accepts (see saved-app-routes.ts readCreateInput).
  // Typed as Record so the new Browser↔Native fields (isBrowser, browserTarget,
  // execPath, appArchetype, launchConfig) pass straight through untouched.
  ipcMain.handle("panel-apps-create", async (_e, input: Record<string, unknown>) => {
    try { const app = await serverPostAuthed("/api/panel-apps", input); invalidateServerCache("/api/panel-apps"); return { ok: true, app }; }
    catch (err) { return { ok: false, error: err instanceof Error ? err.message : String(err) }; }
  });
  ipcMain.handle("panel-apps-update", async (_e, id: string, patch: Record<string, unknown>) => {
    try { const app = await serverPatchAuthed(`/api/panel-apps/${id}`, patch); invalidateServerCache("/api/panel-apps"); return { ok: true, app }; }
    catch (err) { return { ok: false, error: err instanceof Error ? err.message : String(err) }; }
  });
  ipcMain.handle("panel-apps-delete", async (_e, id: string) => {
    try { await serverDeleteAuthed(`/api/panel-apps/${id}`); invalidateServerCache("/api/panel-apps"); return { ok: true }; }
    catch (err) { return { ok: false, error: err instanceof Error ? err.message : String(err) }; }
  });
  // Replace the set of Connections an app uses (first-class Connections model).
  ipcMain.handle("panel-apps-set-connections", async (_e, id: string, connectionIds: string[]) => {
    try { const app = await serverPutAuthed(`/api/panel-apps/${id}/connections`, { connectionIds }); invalidateServerCache("/api/panel-apps"); return { ok: true, app }; }
    catch (err) { return { ok: false, error: err instanceof Error ? err.message : String(err) }; }
  });

  // ── Loops (Build → Loops on the platform; role-scoped) ───────
  // Offline / signed-out falls back to the built-in Default so the composer's
  // loop picker always has something to show.
  ipcMain.handle("loops-list", async () => {
    const fallback = { loops: [{ id: "default", name: "Default", description: "The standard Glyphh agent loop.", builtIn: true }], canBuild: false };
    try {
      const r = await serverGetAuthed<{ loops?: Array<{ id: string; name: string; description: string; builtIn?: boolean }>; canBuild?: boolean }>("/api/loops");
      return { ok: true, loops: r.loops?.length ? r.loops : fallback.loops, canBuild: !!r.canBuild };
    } catch { return { ok: true, ...fallback }; }
  });

  // ── Connections (first-class connected accounts) ─────────────
  ipcMain.handle("connections-list", async () => {
    try { const r = await serverGetAuthed<{ connections: unknown[] }>("/api/connections"); return { ok: true, connections: r.connections || [] }; }
    catch (err) { return { ok: false, error: err instanceof Error ? err.message : String(err), connections: [] }; }
  });
  ipcMain.handle("connection-rename", async (_e, id: string, label: string) => {
    try { const r = await serverPatchAuthed(`/api/connections/${id}`, { label }); return { ok: true, connection: (r as { connection: unknown }).connection }; }
    catch (err) { return { ok: false, error: err instanceof Error ? err.message : String(err) }; }
  });
  ipcMain.handle("connection-tools-list", async (_e, id: string) => {
    try { const r = await serverGetAuthed<{ tools: unknown[] }>(`/api/connections/${id}/tools`); return { ok: true, tools: r.tools || [] }; }
    catch (err) { return { ok: false, error: err instanceof Error ? err.message : String(err), tools: [] }; }
  });
  ipcMain.handle("connection-tools-set", async (_e, id: string, hiddenTools: string[]) => {
    try { const r = await serverPatchAuthed(`/api/connections/${id}/tools`, { hiddenTools }); return { ok: true, connection: (r as { connection: unknown }).connection }; }
    catch (err) { return { ok: false, error: err instanceof Error ? err.message : String(err) }; }
  });
  ipcMain.handle("connection-disconnect", async (_e, id: string) => {
    try { const r = await serverDeleteAuthed<{ ok?: boolean }>(`/api/connections/${id}`); return { ok: r?.ok !== false }; }
    catch (err) { return { ok: false, error: err instanceof Error ? err.message : String(err) }; }
  });

  // ── Custom MCP connections (server-side, like every other connection —
  // the server opens the MCP client; header values are write-only) ──────────
  ipcMain.handle("mcp-connections-list", async () => {
    try {
      const r = await serverGetAuthed<{ connections: Array<{ iconSha?: string | null }> }>("/api/mcp-connections");
      return { ok: true, connections: (r.connections || []).map((c) => ({
        ...c,
        iconUrl: c.iconSha ? `${AUTH_SERVER}/api/mcp-icons/${c.iconSha}` : null,
      })) };
    }
    catch (err) { return { ok: false, error: err instanceof Error ? err.message : String(err), connections: [] }; }
  });
  ipcMain.handle("mcp-connections-create", async (_e, fields: { name: string; url: string; headers?: Record<string, string> }) => {
    try { return { ok: true, ...(await serverPostAuthed("/api/mcp-connections", fields) as Record<string, unknown>) }; }
    catch (err) { return { ok: false, error: err instanceof Error ? err.message : String(err) }; }
  });
  ipcMain.handle("mcp-connections-update", async (_e, slug: string, fields: Record<string, unknown>) => {
    try { const r = await serverPatchAuthed(`/api/mcp-connections/${slug}`, fields); return { ok: true, connection: (r as { connection: unknown }).connection }; }
    catch (err) { return { ok: false, error: err instanceof Error ? err.message : String(err) }; }
  });
  ipcMain.handle("mcp-connections-delete", async (_e, slug: string) => {
    try { const r = await serverDeleteAuthed<{ ok?: boolean }>(`/api/mcp-connections/${slug}`); return { ok: r?.ok !== false }; }
    catch (err) { return { ok: false, error: err instanceof Error ? err.message : String(err) }; }
  });
  ipcMain.handle("mcp-connections-tools", async (_e, slug: string) => {
    try { return await serverGetAuthed<{ ok: boolean; error?: string; tools: unknown[] }>(`/api/mcp-connections/${slug}/tools`); }
    catch (err) { return { ok: false, error: err instanceof Error ? err.message : String(err), tools: [] }; }
  });
  // Org-published connections a member can install; icon shas become URLs
  // here (the renderer's <img> can't send auth headers, so icons are served
  // publicly by content hash).
  const withIconUrl = <T extends { iconSha?: string | null }>(c: T) => ({
    ...c,
    iconUrl: c.iconSha ? `${AUTH_SERVER}/api/mcp-icons/${c.iconSha}` : null,
  });
  ipcMain.handle("mcp-connections-catalog", async () => {
    try {
      const r = await serverGetAuthed<{ connections: Array<{ iconSha?: string | null }> }>("/api/mcp-connections/catalog");
      return { ok: true, connections: (r.connections || []).map(withIconUrl) };
    } catch (err) { return { ok: false, error: err instanceof Error ? err.message : String(err), connections: [] }; }
  });
  ipcMain.handle("mcp-connections-install", async (_e, slug: string) => {
    try { await serverPostAuthed("/api/mcp-connections/install", { slug }); return { ok: true }; }
    catch (err) { return { ok: false, error: err instanceof Error ? err.message : String(err) }; }
  });

  // ── App proxies (public <slug>.glyphh.app tunnels) ─────────────
  // CRUD passes straight through to the server; every mutation drops the
  // stream handler's slug→target cache so edits take effect immediately.
  ipcMain.handle("app-proxy-get", async (_e, appId: string) => {
    try { const r = await serverGetAuthed<{ proxy: unknown }>(`/api/apps/${appId}/proxy`); return { ok: true, proxy: r.proxy ?? null }; }
    catch (err) { return { ok: false, error: err instanceof Error ? err.message : String(err), proxy: null }; }
  });
  ipcMain.handle("app-proxy-create", async (_e, body: Record<string, unknown>) => {
    try { const proxy = await serverPostAuthed("/api/apps/proxies", body); invalidateProxyCache(); return { ok: true, proxy }; }
    catch (err) { return { ok: false, error: err instanceof Error ? err.message : String(err) }; }
  });
  ipcMain.handle("app-proxy-update", async (_e, id: string, body: Record<string, unknown>) => {
    try { const proxy = await serverPatchAuthed(`/api/apps/proxies/${id}`, body); invalidateProxyCache(); return { ok: true, proxy }; }
    catch (err) { return { ok: false, error: err instanceof Error ? err.message : String(err) }; }
  });
  ipcMain.handle("panel-apps-set-mcp", async (_e, id: string, mcp: Record<string, unknown>) => {
    try { const app = await serverPatchAuthed(`/api/panel-apps/${id}/mcp`, mcp); invalidateServerCache("/api/panel-apps"); return { ok: true, app }; }
    catch (err) { return { ok: false, error: err instanceof Error ? err.message : String(err) }; }
  });
  ipcMain.handle("panel-apps-remove-mcp", async (_e, id: string) => {
    try { await serverDeleteAuthed(`/api/panel-apps/${id}/mcp`); invalidateServerCache("/api/panel-apps"); return { ok: true }; }
    catch (err) { return { ok: false, error: err instanceof Error ? err.message : String(err) }; }
  });
  ipcMain.handle("panel-apps-set-command", async (_e, id: string, key: string, mapping: Record<string, unknown>) => {
    try { const app = await serverPatchAuthed(`/api/panel-apps/${id}/commands/${encodeURIComponent(key)}`, mapping); invalidateServerCache("/api/panel-apps"); return { ok: true, app }; }
    catch (err) { return { ok: false, error: err instanceof Error ? err.message : String(err) }; }
  });
  ipcMain.handle("panel-apps-remove-command", async (_e, id: string, key: string) => {
    try { await serverDeleteAuthed(`/api/panel-apps/${id}/commands/${encodeURIComponent(key)}`); invalidateServerCache("/api/panel-apps"); return { ok: true }; }
    catch (err) { return { ok: false, error: err instanceof Error ? err.message : String(err) }; }
  });

  // Per-app config vars (encrypted secrets — app-secrets.ts). List returns key
  // names + set-dates ONLY; there is deliberately no handler that returns a
  // decrypted value to a renderer — plaintext exists once, at creation.
  ipcMain.handle("app-secrets-list", async (_e, id: string) => listAppSecrets(id));
  ipcMain.handle("app-secrets-set", async (_e, id: string, key: string, value: string, appReadable?: boolean) => setAppSecret(id, key, value, appReadable === true));
  ipcMain.handle("app-secrets-delete", async (_e, id: string, key: string) => deleteAppSecret(id, key));
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
    showThinking();
    try { return { ok: true, ...(await openLayoutByName(String(name))) }; }
    catch (err) { return { ok: false, error: err instanceof Error ? err.message : String(err) }; }
    finally { hideThinking(); }
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
  // Connections are available to all tiers — no pay gate. refuseIfInternal
  // still blocks editing built-in apps.
  ipcMain.handle("apps-set-connection", (_e, id: string, pipedreamSlug: string) =>
    refuseIfInternal(id) ? false : appConnector.setConnection(id, { pipedreamSlug }));
  ipcMain.handle("apps-remove-connection", (_e, id: string) =>
    refuseIfInternal(id) ? false : appConnector.removeConnection(id));
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
  ipcMain.handle("apps-set-connected-slug", () => false);

  // ── yo app package (import / export) ──────────────────────
  // Export an app to a .glyphh bundle. Web apps are manifest-only; bundled apps
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
      defaultPath: `${safeName}.glyphh`,
      filters: [{ name: "Glyphh app", extensions: ["glyphh"] }],
    });
    if (result.canceled || !result.filePath) return { ok: false, error: "Canceled" };
    const dest = result.filePath.endsWith(".glyphh") ? result.filePath : `${result.filePath}.glyphh`;
    // Multi-file / local apps (file:// url) export WITH their code folder; remote
    // web apps (http/yo://) are manifest-only.
    const codeDir = localBundleDir(app.url);
    return exportApp(appConnector, appId, dest, codeDir);
  });

  // Import a .glyphh bundle. A glyphh-app bundle (marketplace unit) installs as
  // a server saved-app; a legacy .glyphh registers into the local connector.
  ipcMain.handle("app-import", async () => {
    const win = getMainWindow();
    if (!win || win.isDestroyed()) return { ok: false, error: "No window" };
    const result = await dialog.showOpenDialog(win, {
      title: "Install app",
      properties: ["openFile"],
      filters: [{ name: "Glyphh app", extensions: ["glyphh"] }],
    });
    if (result.canceled || result.filePaths.length === 0) return { ok: false, error: "Canceled" };
    const file = result.filePaths[0];

    // glyphh-app bundle? → install as a server app (appears on the Apps page).
    if (isGlyphhAppBundle(file)) {
      return installGlyphhAppBundle(file);
    }

    const res = importApp(appConnector, file);
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
