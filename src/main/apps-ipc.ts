import { app, ipcMain, dialog, BrowserWindow, screen, net } from "electron";
import { getClient } from "./glyphh-client";
import { refreshForceWebSlugs } from "./force-web";
import fs from "fs";
import path from "path";
import { extractMacAppIcon } from "./app-icon-extract";
import { exportServerApp } from "./glyphh-app-package";
import { deployAppFromWorkdir, pullAppSource, r2DiffWorkdir, appDirInWorkdir } from "./glyphh-app-builder";
import { getExplicitWorkingDirectory } from "./working-directory";
import { hasMcpAccess, AUTH_SERVER } from "./auth";
import * as appsStore from "./apps-store";
import { fetchOrgApps, invalidateOrgApps } from "./org-apps";

import { openAppByRef, openLayoutByName } from "./app-resolver";
import { isGlyphhAppBundle, installGlyphhAppBundle, isGlyphhAppRow } from "./glyphh-app-host";
import { listAppSecrets, setAppSecret, deleteAppSecret } from "./app-secrets";
import { BUILTIN_EFFECT_LIST } from "../shared/drip-effects";
import { getDripManagerInstance } from "./drip-manager";

/** Server-authoritative panel-apps CRUD (Dashboard shell) — the Apps tab's
 *  list is no longer a local object; every read/write goes straight to
 *  yo-server's /api/panel-apps (see saved-app-routes.ts). Errors surface as
 *  { ok: false, error } rather than throwing, so the renderer can show a
 *  message instead of crashing on a network hiccup. */
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

  // The HOUSE DEFAULTS died with the server library — the builtin workpanels
  // are the launcher set now (code-workbench owns those tiles).
  ipcMain.handle("apps-defaults", async () => []);

}

import type { LayoutManager } from "./layout-manager";

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

  // IPC: layouts CRUD
  // Server-authoritative (yo-server /api/layouts) — refresh the local cache
  // from the server before listing so the Layouts tab shows server truth.
  ipcMain.handle("layouts-list", async () => {
    const rows = (await layoutManager.refreshAndList()).map((l) => ({
      name: l.name,
      cols: l.cols,
      rows: l.rows,
      colWidths: l.colWidths,
      rowHeights: l.rowHeights,
      target: (l as { target?: "glyphh" | "desktop" }).target ?? "glyphh",
      loop: (l as { loop?: string }).loop ?? null,
      modelSelections: (l as { modelSelections?: Record<string, string> }).modelSelections ?? {},
      sessionMode: (l as { sessionMode?: "keep" | "new" | "last" }).sessionMode ?? "keep",
      folder: (l as { folder?: string }).folder ?? null,
      space: (l as { space?: "chat" | "cowork" | "code" }).space ?? null,
      splits: l.cells.map((c) => ({ panelId: c.panelId, col: c.col, row: c.row, colSpan: c.colSpan, rowSpan: c.rowSpan, sticky: c.sticky, config: c.config })),
    }));
    return rows;
  });
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
  ipcMain.handle("layouts-save-grid", async (_e, grid: { name: string; cols: number; rows: number; colWidths: number[]; rowHeights: number[]; cells: Array<{ panelId: string; col: number; row: number; colSpan: number; rowSpan: number; sticky?: boolean; config?: { url?: string; cmd?: string; keepAlive?: boolean; railMenu?: boolean; railRecents?: boolean; railLayouts?: boolean; railHideLeft?: boolean; railHideRight?: boolean } }>; folderMode?: "single" | "multi"; target?: "glyphh" | "desktop"; loop?: string | null; modelSelections?: Record<string, string>; sessionMode?: "keep" | "new" | "last"; folder?: string | null; space?: "chat" | "cowork" | "code" | null }) => {
    const existing = layoutManager.listLayouts().find(l => l.name === grid.name);
    if (!existing) {
      const gate = canSaveLayout(layoutManager.listLayouts().length);
      if (!gate.allowed) return { error: gate.reason };
    }
    const { loop, modelSelections, sessionMode, folder, space, ...rest } = grid;
    await layoutManager.saveLayout({
      ...rest,
      version: 2,
      folderMode: grid.folderMode ?? "single",
      target: grid.target ?? "glyphh",
      ...(loop ? { loop } : {}),
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


  const BUILTIN_WORKPANELS = new Set(["gpoint", "gdoc", "gsheet", "gdrive", "gdesign", "gimage", "gvideo", "gsound"]);
  const WORKPANEL_REFUSAL = "work panels are built in — they cannot be altered or removed";

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
      invalidateOrgApps();
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
      const app = await appsStore.updateEntry(slug, {
        ...entryFields(patch),
        ...(kind === "web" || kind === "native" ? { kind } : {}),
      });
      invalidateOrgApps();
      return { ok: true, app };
    }
    catch (err) { return { ok: false, error: err instanceof Error ? err.message : String(err) }; }
  });
  ipcMain.handle("panel-apps-delete", async (_e, id: string) => {
    try {
      const slug = await appSlug(id);
      if (BUILTIN_WORKPANELS.has(slug)) return { ok: false, error: WORKPANEL_REFUSAL };
      await appsStore.removeEntry(slug);
      invalidateOrgApps();
      return { ok: true };
    }
    catch (err) { return { ok: false, error: err instanceof Error ? err.message : String(err) }; }
  });
  ipcMain.handle("app-secrets-list", async (_e, id: string) => listAppSecrets(id));
  ipcMain.handle("app-secrets-set", async (_e, id: string, key: string, value: string, appReadable?: boolean) => setAppSecret(id, key, value, appReadable === true));
  ipcMain.handle("app-secrets-delete", async (_e, id: string, key: string) => deleteAppSecret(id, key));

  // ── yo app package (import / export) ──────────────────────
  // Export an app to a .glyphh bundle. Resolves the app from the org's SERVER
  // library (fetchOrgApps) — the old path read the legacy local appConnector,
  // which no real app lives in, so Export silently failed. A hosted app carries
  // its built code (downloaded via apps.source()); a launcher exports its
  // manifest only.
  ipcMain.handle("app-export", async (_e, appId: string) => {
    const apps = await fetchOrgApps().catch(() => []);
    const app = apps.find((a) => a.id === appId || a.slug === appId);
    if (!app) return { ok: false, error: `App "${appId}" not found` };
    const win = getMainWindow();
    if (!win || win.isDestroyed()) return { ok: false, error: "No window" };
    const safeName = (app.name || app.slug || app.id).replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || app.slug || app.id;
    const result = await dialog.showSaveDialog(win, {
      title: "Export app",
      defaultPath: `${safeName}.glyphh`,
      filters: [{ name: "Glyphh app", extensions: ["glyphh"] }],
    });
    if (result.canceled || !result.filePath) return { ok: false, error: "Canceled" };
    const dest = result.filePath.endsWith(".glyphh") ? result.filePath : `${result.filePath}.glyphh`;
    // LOCAL source (THE PURGE): a built glyphh app's bytes live beside its
    // entry — zip that folder. A launcher exports manifest-only.
    let sourceZip: Buffer | undefined;
    try {
      if (app.execPath && fs.existsSync(app.execPath)) {
        const AdmZip = (await import("adm-zip")).default;
        const zip = new AdmZip();
        zip.addLocalFolder(path.dirname(app.execPath));
        sourceZip = zip.toBuffer();
      }
    } catch { /* no build — manifest-only export */ }

    // The bundle carries its RELEASE identity from the local row.
    let release: Parameters<typeof exportServerApp>[0]["release"];
    if (app.latestVersion) {
      release = { version: app.latestVersion, notes: "", channel: "live", releasedAt: app.updatedAt };
    }

    return exportServerApp(
      { id: app.id, slug: app.slug, name: app.name, url: app.url, ...(release ? { release } : {}) },
      dest, sourceZip,
    );
  });

  // Update an installed app to its newest published version. The bundle a
  // marketplace glyphh app installs from is not yet downloadable — a deployed
  // app's stored source has its worker stripped, so re-installing that would
  // break the app. Until a bundle-distribution endpoint exists, say so plainly
  // rather than shipping a broken update.
  ipcMain.handle("app-update-installed", async (_e, _slug: string) => {
    return {
      ok: false,
      error: "In-place update isn't available yet — reinstall the app from the marketplace or its .glyphh file to get the newest version.",
    };
  });

  ipcMain.handle("app-build-deploy", async (_e, slug: string, opts?: { deploy?: boolean }) => {
    try {
      // THE PURGE: local build only — no cloud pods, no hosted deploy.
      const r = await deployAppFromWorkdir(slug || undefined, { deploy: false });
      invalidateOrgApps(); // the cut advanced apps.version — the Releases tab re-reads it
      return { ok: r.status === "ready", result: r, error: r.error };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });
  // ── Production tab: graduate to a standalone Supabase repo (download zip) ────
  ipcMain.handle("app-graduate", async (_e, slug: string) => {
    const win = getMainWindow();
    if (!win || win.isDestroyed()) return { ok: false, error: "No window" };
    const safe = slug.replace(/[^a-zA-Z0-9_-]+/g, "-") || "app";
    const result = await dialog.showSaveDialog(win, {
      title: "Export standalone repo",
      defaultPath: `${safe}.zip`,
      filters: [{ name: "Zip archive", extensions: ["zip"] }],
    });
    if (result.canceled || !result.filePath) return { ok: false, error: "Canceled" };
    const dest = result.filePath.endsWith(".zip") ? result.filePath : `${result.filePath}.zip`;
    try {
      // LOCAL (THE PURGE): the standalone-repo builder died with the control
      // plane — export the working project source as the zip instead.
      const wd = getExplicitWorkingDirectory();
      if (!wd) return { ok: false, error: "no working folder is set — open the app's project folder first" };
      const dir = appDirInWorkdir(wd);
      const AdmZip = (await import("adm-zip")).default;
      const zip = new AdmZip();
      zip.addLocalFolder(dir, undefined, (p) => !/(^|\/)(node_modules|dist|\.git)(\/|$)/.test(p));
      fs.writeFileSync(dest, zip.toBuffer());
      return { ok: true, path: dest };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  // Import a .glyphh bundle — the glyphh-app (marketplace unit) format installs
  // as a server saved-app. The legacy local-connector format died with the
  // local app registry.
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

    return { ok: false, error: "This bundle uses the legacy local-app format, which is no longer supported." };
  });

  // ── Connections (first-class connected accounts) ─────────────
  // Desktop is a MEMBER surface: the list is the caller's own (personal)
  // connections plus the org-shared ones (read-only); every mutation acts on
  // a PERSONAL connection.
  //
  // The renderer's Connection contract predates the SDK and is keyed by `id`
  // with Pipedream-flavoured fields, while the SDK addresses connections by
  // `slug`. Adapt here — the IPC shape is the stable boundary — and keep an
  // id→slug index so the per-connection handlers can resolve either.
  interface ConnRef { slug: string; org: boolean }
  const connIndex = new Map<string, ConnRef>();

  ipcMain.handle("connections-list", async () => {
    try {
      const client = getClient();
      // Personal rows carry the rich fields (id, label, health); the resolved
      // list contributes the org-shared ones the member may use but not edit.
      const [personal, resolved, live] = await Promise.all([
        client.connections.personalList(),
        client.connections.list().catch(() => []),
        // Governance truth: what the caller's agents can ACTUALLY call.
        // Null on failure → badges stay off rather than false-accusing.
        client.connections.resolvedTools().then((r) => r.connections).catch(() => null),
      ]);
      // A connection that's connected but absent from the resolved catalog is
      // BLOCKED by policy; present with zero tools = all its tools are blocked.
      const governance = (slug: string): { agentAllowed?: boolean; agentTools?: number; agentAvailable?: number } => {
        if (!live) return {};
        const conn = live.find((x) => x.slug === slug);
        if (!conn) return { agentAllowed: false, agentTools: 0, agentAvailable: 0 };
        return { agentAllowed: true, agentTools: conn.tools.length, agentAvailable: conn.availableTools.length };
      };
      connIndex.clear();
      const connections = personal.map((c) => {
        connIndex.set(c.id, { slug: c.appSlug, org: false });
        return {
          id: c.id,
          accountId: c.id,
          appSlug: c.appSlug,
          appName: c.appName || c.name || c.appSlug,
          label: c.label,
          healthy: c.healthy,
          hiddenTools: [] as string[],
          createdAt: "",
          org: false,
          ...governance(c.appSlug),
        };
      });
      const personalSlugs = new Set(personal.map((c) => c.appSlug));
      for (const c of resolved) {
        // Custom MCP renders from its own card list; only connector accounts here.
        if (c.kind !== "pipedream" || c.scope !== "org" || personalSlugs.has(c.slug)) continue;
        connIndex.set(c.slug, { slug: c.slug, org: true });
        connections.push({
          id: c.slug,
          accountId: c.slug,
          appSlug: c.slug,
          appName: c.name || c.slug,
          label: null,
          healthy: c.enabled,
          hiddenTools: [],
          createdAt: "",
          org: true,
          ...governance(c.slug),
        });
      }
      return { ok: true, connections };
    }
    catch (err) { return { ok: false, error: err instanceof Error ? err.message : String(err), connections: [] }; }
  });

  /** Resolve a renderer connection id (or a bare slug) to its SDK slug. */
  const connSlug = (id: string): string => connIndex.get(id)?.slug ?? id;

  ipcMain.handle("connection-rename", async (_e, id: string, label: string) => {
    try { return { ok: true, connection: await getClient().connections.renamePersonalConnection(id, label) }; }
    catch (err) { return { ok: false, error: err instanceof Error ? err.message : String(err) }; }
  });
  ipcMain.handle("connection-tools-list", async (_e, id: string) => {
    try {
      const slug = connSlug(id);
      const { connections } = await getClient().connections.resolvedTools();
      const conn = connections.find((c) => c.slug === slug);
      if (!conn) return { ok: true, tools: [] };
      // The server stores what's ALLOWED; the renderer speaks hides.
      const allowed = new Set(conn.tools.map((t) => t.key));
      return {
        ok: true,
        tools: conn.availableTools.map((t) => ({
          name: t.key,
          description: t.description ?? t.name,
          hidden: !allowed.has(t.key),
        })),
      };
    }
    catch (err) { return { ok: false, error: err instanceof Error ? err.message : String(err), tools: [] }; }
  });
  ipcMain.handle("connection-tools-set", async (_e, id: string, hiddenTools: string[]) => {
    try {
      const slug = connSlug(id);
      const { connections } = await getClient().connections.resolvedTools();
      const conn = connections.find((c) => c.slug === slug);
      const hidden = new Set(hiddenTools);
      const allowed = (conn?.availableTools ?? []).map((t) => t.key).filter((k) => !hidden.has(k));
      await getClient().connections.setPersonalConnectionTools(slug, allowed);
      return { ok: true, connection: conn ?? null };
    }
    catch (err) { return { ok: false, error: err instanceof Error ? err.message : String(err) }; }
  });
  ipcMain.handle("connection-disconnect", async (_e, id: string) => {
    try { const r = await getClient().connections.personalDisconnect(id); return { ok: r?.ok !== false }; }
    catch (err) { return { ok: false, error: err instanceof Error ? err.message : String(err) }; }
  });
}
