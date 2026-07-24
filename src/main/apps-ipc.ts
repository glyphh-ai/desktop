import { app, ipcMain, dialog, BrowserWindow, screen } from "electron";
import fs from "fs";
import path from "path";
import { extractMacAppIcon } from "./app-icon-extract";
import type { AppConnector, AppConfig } from "./app-connector";
import { exportServerApp, importApp } from "./glyphh-app-package";
import { hasMcpAccess, AUTH_SERVER } from "./auth";
import { getClient } from "./glyphh-client";
import { probeMcpAuth, authorizeMcpServer } from "./mcp-oauth";
import type { OrgMcpConnection, UpdateListingInput } from "@glyphh/client";
import { fetchOrgApps, invalidateOrgApps } from "./org-apps";
import { listMarketplace, getMarketplaceApp, installMarketplaceApp } from "./marketplace";

import { openAppByRef, openLayoutByName } from "./app-resolver";
import { showThinking, hideThinking } from "./thinking-overlay";
import { isGlyphhAppBundle, installGlyphhAppBundle, isGlyphhAppRow } from "./glyphh-app-host";
import { listAppSecrets, setAppSecret, deleteAppSecret } from "./app-secrets";
import { resolveRoles, setSelection, invalidateRoles, applyLoopConfig, currentLoop } from "./loop-selections";

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

  // Command center as a DESKTOP OVERLAY: a transparent fullscreen always-on-top
  // window on the display under the cursor, hosting only the command center
  // (home.html?solo=cc). Closes on blur/Esc/pick — the page closes itself when
  // the switcher leaves the DOM.
  let ccOverlayWin: BrowserWindow | null = null;
  ipcMain.handle("cc-overlay-open", () => {
    if (ccOverlayWin && !ccOverlayWin.isDestroyed()) { ccOverlayWin.focus(); return { ok: true }; }
    const d = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    ccOverlayWin = new BrowserWindow({
      ...d.bounds,
      frame: false,
      transparent: true,
      resizable: false,
      movable: false,
      alwaysOnTop: true,
      hasShadow: false,
      skipTaskbar: true,
      show: false,
      webPreferences: {
        preload: path.join(__dirname, "..", "renderer", "preload.js"),
        contextIsolation: true,
        nodeIntegration: false,
        webviewTag: true,
      },
    });
    ccOverlayWin.setAlwaysOnTop(true, "screen-saver");
    ccOverlayWin.on("blur", () => { try { ccOverlayWin?.close(); } catch { /* already closing */ } });
    ccOverlayWin.on("closed", () => { ccOverlayWin = null; });
    void ccOverlayWin.loadFile(path.join(__dirname, "..", "renderer", "home.html"), { query: { solo: "cc" } });
    ccOverlayWin.once("ready-to-show", () => ccOverlayWin?.show());
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
    try { return await fetchOrgApps(); }
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
  // App CRUD is the entries API (`/api/apps/entries`). The renderer still
  // speaks the older field names, so translate here: a native app carries an
  // execPath, everything else a url, and `launchConfig` is the entry `config`.
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
  /** The renderer addresses apps by row id; the entries API by slug. */
  const appSlug = async (id: string): Promise<string> => {
    const apps = await fetchOrgApps();
    return apps.find((a) => a.id === id)?.slug ?? id;
  };

  ipcMain.handle("panel-apps-create", async (_e, input: Record<string, unknown>) => {
    try {
      const slug = String(input.slug || input.name || "").toLowerCase().trim()
        .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
      if (!slug) return { ok: false, error: "A name is required." };
      const app = await getClient().apps.createEntry({
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
    try {
      // A retype only travels when the renderer asserts a LAUNCHER shape
      // (`isBrowser`). Without this the type dropdown appeared to save and the
      // row kept its old kind; with it on a built app, the server would refuse
      // the whole patch — a glyphh app's kind comes from its bundle.
      const kind = patch.isBrowser !== undefined ? entryKind(patch) : undefined;
      const app = await getClient().apps.updateEntry(await appSlug(id), {
        ...entryFields(patch),
        ...(kind === "web" || kind === "native" ? { kind } : {}),
      });
      invalidateOrgApps();
      return { ok: true, app };
    }
    catch (err) { return { ok: false, error: err instanceof Error ? err.message : String(err) }; }
  });
  ipcMain.handle("panel-apps-delete", async (_e, id: string) => {
    try { await getClient().apps.removeEntry(await appSlug(id)); invalidateOrgApps(); return { ok: true }; }
    catch (err) { return { ok: false, error: err instanceof Error ? err.message : String(err) }; }
  });
  // ── Loops (Build → Loops on the platform; role-scoped) ───────
  // Offline / signed-out falls back to the built-in Default so the composer's
  // loop picker always has something to show.
  ipcMain.handle("loops-list", async () => {
    const fallback = { loops: [{ id: "default", name: "Default", description: "The standard Glyphh agent loop.", builtIn: true }], canBuild: false };
    try {
      const { loops } = await getClient().loops.list();
      return { ok: true, loops: loops.length ? loops : fallback.loops, canBuild: false };
    } catch { return { ok: true, ...fallback }; }
  });

  // ── Loop model slots — what the picker renders ───────────────
  //
  // The loop decides the picker's SHAPE: a loop declaring one slot gets one
  // dropdown, a planner-and-coder loop gets two. Resolution and storage live in
  // loop-selections so the turn resolves a slot exactly as the dropdown showed it.

  ipcMain.handle("loop-roles", async (_e, p: { loop?: string; force?: boolean }) => {
    const loop = String(p?.loop || "default");
    try {
      // force → drop the 60s cache first, so an org-side model change (a model
      // added/removed/toggled on the platform) is seen without an app restart.
      if (p?.force) invalidateRoles(loop);
      return { ok: true, loop, roles: await resolveRoles(loop) };
    } catch (err) {
      // Signed out or offline: no slots rather than a broken picker.
      console.warn(`[loop-roles] "${loop}" failed:`, err instanceof Error ? err.message : String(err));
      return { ok: false, loop, roles: [] };
    }
  });

  ipcMain.handle("loop-role-set", async (_e, p: { loop?: string; role?: string; modelId?: string | null }) => {
    const loop = String(p?.loop || "default");
    const role = String(p?.role || "");
    if (!role) return { ok: false, loop, roles: [] };
    try {
      setSelection(loop, role, p?.modelId ?? null);
      return { ok: true, loop, roles: await resolveRoles(loop) };
    } catch (err) {
      console.warn(`[loop-roles] set "${loop}.${role}" failed:`, err instanceof Error ? err.message : String(err));
      return { ok: false, loop, roles: [] };
    }
  });

  // Edit a loop's OWN default model for one slot — the model the loop suggests
  // when a caller hasn't picked one. Writes manifest.roles[].default; a loop that
  // declared no slots gets the implicit "default" slot materialised so it has one
  // to carry the model. Server gates the write to org_admins (built-ins immutable).
  ipcMain.handle("loop-set-role-default", async (_e, p: { loopId?: string; role?: string; modelId?: string | null }) => {
    const loopId = String(p?.loopId || "");
    const role = String(p?.role || "default");
    if (!loopId) return { ok: false, error: "loop id is required" };
    try {
      const loop = await getClient().loops.get(loopId);
      const manifest = { ...(loop.manifest ?? {}) };
      const roles = Array.isArray(manifest.roles) && manifest.roles.length
        ? manifest.roles.map((r) => ({ ...r }))
        : [{ name: "default", label: "Model", description: "The model this loop runs on." }];
      const slot = roles.find((r) => r.name === role);
      if (slot) slot.default = p?.modelId ?? null;
      else roles.push({ name: role, default: p?.modelId ?? null });
      await getClient().loops.update(loopId, { manifest: { ...manifest, roles } });
      // The loop's default changed → the composer's resolved slot may move.
      invalidateRoles();
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  // Apply a layout's loop + model config: make its loop active and bind each of
  // its slots to the layout's chosen models. Called when a layout is opened so
  // the workspace lands on the layout's program AND models, not just its panels.
  ipcMain.handle("loop-apply-config", (_e, p: { loop?: string | null; modelSelections?: Record<string, string> }) => {
    try {
      applyLoopConfig(p?.loop ?? null, p?.modelSelections ?? {});
      return { ok: true, loop: currentLoop() };
    } catch (err) {
      console.warn("[loop-apply-config] failed:", err instanceof Error ? err.message : String(err));
      return { ok: false, loop: currentLoop() };
    }
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

  // ── Custom MCP connections (server-side, like every other connection —
  // the server opens the MCP client; header values are write-only). Desktop
  // manages the caller's PERSONAL endpoints; org-shared ones arrive via the
  // catalog below and need no install. Icon shas become URLs here (the
  // renderer's <img> can't send auth headers, so icons are served publicly
  // by content hash).
  const withIconUrl = <T extends { iconSha?: string | null }>(c: T) => ({
    ...c,
    iconUrl: c.iconSha ? `${AUTH_SERVER}/api/mcp-icons/${c.iconSha}` : null,
  });
  /** The renderer's custom-MCP card shape — the SDK connection plus the
   *  fields the cards read (`kind` drives the "Org connection" badge). */
  const toMcpCard = (c: OrgMcpConnection, kind: "personal" | "org") => ({
    ...withIconUrl(c),
    kind,
    hiddenTools: [] as string[],
    createdAt: "",
  });
  ipcMain.handle("mcp-connections-list", async () => {
    try {
      // A member sees their own endpoints plus the org-shared catalog — the
      // page renders both as cards, org ones read-only.
      const client = getClient();
      const [personal, org] = await Promise.all([
        client.connections.personalMcpList(),
        client.connections.orgMcpList().catch(() => [] as OrgMcpConnection[]),
      ]);
      const ownSlugs = new Set(personal.map((c) => c.slug));
      return {
        ok: true,
        connections: [
          ...personal.map((c) => toMcpCard(c, "personal")),
          ...org.filter((c) => !ownSlugs.has(c.slug)).map((c) => toMcpCard(c, "org")),
        ],
      };
    }
    catch (err) { return { ok: false, error: err instanceof Error ? err.message : String(err), connections: [] }; }
  });
  ipcMain.handle("mcp-connections-create", async (_e, fields: { name: string; url: string; headers?: Record<string, string>; oauth?: { clientId: string; clientSecret?: string } }) => {
    try {
      const slug = fields.name.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "mcp";
      let headers = fields.headers ?? {};
      // OAuth 2.1 endpoints: the server dials the URL, so it can't drive the
      // interactive consent. Probe here; if the server demands authorization,
      // run the consent in an in-app web view and hand the bearer to the server.
      // A pre-registered OAuth client (Advanced) is used when provided, else DCR.
      const win = getMainWindow();
      if (win) {
        const probe = await probeMcpAuth(fields.url);
        if (probe.needsAuth) {
          const token = await authorizeMcpServer(win, fields.url, probe.resourceMetadataUrl, fields.oauth?.clientId ? fields.oauth : undefined);
          headers = { ...headers, Authorization: `Bearer ${token}` };
        }
      }
      const r = await getClient().connections.personalMcpCreate({ slug, name: fields.name, url: fields.url, headers });
      return { ok: r.ok, connection: withIconUrl(r.connection), toolCount: r.toolCount, ...(r.error ? { error: r.error } : {}) };
    }
    catch (err) { return { ok: false, error: err instanceof Error ? err.message : String(err) }; }
  });
  ipcMain.handle("mcp-connections-update", async (_e, slug: string, fields: Record<string, unknown>) => {
    try { const r = await getClient().connections.personalMcpUpdate(slug, fields); return { ok: true, connection: withIconUrl(r.connection) }; }
    catch (err) { return { ok: false, error: err instanceof Error ? err.message : String(err) }; }
  });
  ipcMain.handle("mcp-connections-delete", async (_e, slug: string) => {
    try { const r = await getClient().connections.personalMcpRemove(slug); return { ok: r?.ok !== false }; }
    catch (err) { return { ok: false, error: err instanceof Error ? err.message : String(err) }; }
  });
  ipcMain.handle("mcp-connections-tools", async (_e, slug: string) => {
    try { return { ok: true, tools: await getClient().connections.mcpTools(slug) }; }
    catch (err) { return { ok: false, error: err instanceof Error ? err.message : String(err), tools: [] }; }
  });
  // Org-shared custom MCP connections — visible to every member, no install
  // step in the two-axis model (shared connectors are simply available).
  ipcMain.handle("mcp-connections-catalog", async () => {
    try {
      const connections = await getClient().connections.orgMcpList();
      return { ok: true, connections: connections.map(withIconUrl) };
    } catch (err) { return { ok: false, error: err instanceof Error ? err.message : String(err), connections: [] }; }
  });
  ipcMain.handle("mcp-connections-install", async () => {
    // Org connections are shared automatically now — nothing to install.
    return { ok: true };
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
  } = deps;

  registerPanelAppsIpc(getMainWindow);

  // Open a saved layout: every cell becomes a workbench PANEL inside Glyphh.
  // (Layouts used to be able to target the desktop and tile real OS windows —
  // that is gone; Glyphh does not arrange other apps' windows.)
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
      target: (l as { target?: "glyphh" | "desktop" }).target ?? "glyphh",
      glyphh: (l as { glyphh?: { mode: string; fraction?: number } }).glyphh ?? null,
      loop: (l as { loop?: string }).loop ?? null,
      modelSelections: (l as { modelSelections?: Record<string, string> }).modelSelections ?? {},
      splits: l.cells.map((c) => ({ panelId: c.panelId, col: c.col, row: c.row, colSpan: c.colSpan, rowSpan: c.rowSpan, sticky: c.sticky })),
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
  ipcMain.handle("layouts-save-grid", (_e, grid: { name: string; cols: number; rows: number; colWidths: number[]; rowHeights: number[]; cells: Array<{ panelId: string; col: number; row: number; colSpan: number; rowSpan: number; sticky?: boolean }>; folderMode?: "single" | "multi"; target?: "glyphh" | "desktop"; glyphh?: { mode: "rail" | "left" | "right" | "none"; fraction?: number }; loop?: string | null; modelSelections?: Record<string, string> }) => {
    const existing = layoutManager.listLayouts().find(l => l.name === grid.name);
    if (!existing) {
      const gate = canSaveLayout(layoutManager.listLayouts().length);
      if (!gate.allowed) return { error: gate.reason };
    }
    const { loop, modelSelections, ...rest } = grid;
    layoutManager.saveLayout({
      ...rest,
      version: 2,
      folderMode: grid.folderMode ?? "single",
      target: grid.target ?? "glyphh",
      ...(loop ? { loop } : {}),
      ...(modelSelections && Object.keys(modelSelections).length ? { modelSelections } : {}),
    });
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
    // Pull the app's built source (built apps have a release); a launcher or an
    // app with no finished build exports manifest-only.
    let sourceZip: Buffer | undefined;
    try {
      const buf = await getClient().apps.source(app.slug);
      sourceZip = Buffer.from(buf);
    } catch { /* no build / not built — manifest-only export */ }

    // The bundle carries its RELEASE identity: the live release if there is one,
    // else the newest built. An export with no story is what this fixes.
    let release: Parameters<typeof exportServerApp>[0]["release"];
    try {
      const rows = await getClient().apps.releases(app.slug);
      const built = rows.filter((r) => r.status === "ready");
      const chosen = built.find((r) => r.channel === "live") ?? built[0];
      if (chosen) {
        release = {
          version: chosen.version,
          notes: chosen.notes,
          channel: chosen.channel,
          releasedAt: chosen.promotedAt ?? chosen.createdAt,
        };
      }
    } catch { /* no releases readable — export without the release block */ }

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

  // ── Deploy tab (dev-host): status + deploy + take-down ──────────────────────
  // Deploy bundles the app's newest built release and serves it at a dev URL
  // (<slug>.glyphh.app / /hosted/<slug>). Status comes from the org's deployments.
  ipcMain.handle("hosting-status", async (_e, slug: string) => {
    try {
      const deployments = await getClient().hosting.list();
      const d = deployments.find((x) => x.appSlug === slug) ?? null;
      return { ok: true, deployment: d };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });
  ipcMain.handle("hosting-deploy", async (_e, slug: string) => {
    try {
      const d = await getClient().hosting.deploy({ appSlug: slug });
      return { ok: true, deployment: d };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });
  ipcMain.handle("hosting-destroy", async (_e, id: string) => {
    try {
      await getClient().hosting.destroy(id);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  // ── Releases tab: the app's version history ─────────────────────────────────
  // Read + the two owner actions. Cutting a release is the BUILD path
  // (glyphh-app-builder) — this tab annotates and promotes what that produced.
  ipcMain.handle("app-releases", async (_e, slug: string) => {
    try { return { ok: true, releases: await getClient().apps.releases(slug) }; }
    catch (err) { return { ok: false, error: err instanceof Error ? err.message : String(err), releases: [] }; }
  });
  ipcMain.handle("app-release-notes", async (_e, slug: string, releaseId: string, notes: string | null) => {
    try { return { ok: true, release: await getClient().apps.updateReleaseNotes(slug, releaseId, notes) }; }
    catch (err) { return { ok: false, error: err instanceof Error ? err.message : String(err) }; }
  });
  ipcMain.handle("app-release-promote", async (_e, slug: string, releaseId: string) => {
    try {
      const release = await getClient().apps.promoteRelease(slug, releaseId);
      invalidateOrgApps();
      return { ok: true, release };
    } catch (err) { return { ok: false, error: err instanceof Error ? err.message : String(err) }; }
  });

  // ── Marketplace tab: the listing + its images ───────────────────────────────
  ipcMain.handle("app-listing-set", async (_e, slug: string, patch: Record<string, unknown>) => {
    try {
      await getClient().apps.updateListing(slug, patch as UpdateListingInput);
      invalidateOrgApps();
      return { ok: true };
    } catch (err) { return { ok: false, error: err instanceof Error ? err.message : String(err) }; }
  });

  // The file dialog lives in main, so the renderer never handles a path or bytes:
  // it asks for "an icon", and gets back the stored key.
  ipcMain.handle("app-listing-image-add", async (_e, slug: string, kind: "icon" | "screenshot") => {
    const win = getMainWindow();
    if (!win || win.isDestroyed()) return { ok: false, error: "No window" };
    const picked = await dialog.showOpenDialog(win, {
      title: kind === "icon" ? "Choose an app icon" : "Add a screenshot",
      properties: ["openFile"],
      filters: [{ name: "Images", extensions: ["png", "jpg", "jpeg", "webp", "gif"] }],
    });
    if (picked.canceled || !picked.filePaths[0]) return { ok: false, error: "Canceled" };
    try {
      const bytes = fs.readFileSync(picked.filePaths[0]);
      const stored = await getClient().apps.uploadMedia(slug, kind, new Uint8Array(bytes));
      invalidateOrgApps();
      return { ok: true, key: stored.key };
    } catch (err) { return { ok: false, error: err instanceof Error ? err.message : String(err) }; }
  });

  ipcMain.handle("app-listing-image-remove", async (_e, slug: string, key: string) => {
    try { await getClient().apps.removeMedia(slug, key); invalidateOrgApps(); return { ok: true }; }
    catch (err) { return { ok: false, error: err instanceof Error ? err.message : String(err) }; }
  });

  ipcMain.handle("app-listing-list", async (_e, slug: string, listed: boolean) => {
    try {
      const res = listed ? await getClient().apps.list(slug) : await getClient().apps.unlist(slug);
      invalidateOrgApps();
      return { ok: true, listed: res.listed };
    } catch (err) { return { ok: false, error: err instanceof Error ? err.message : String(err) }; }
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
      const buf = await getClient().apps.export(slug);
      fs.writeFileSync(dest, Buffer.from(buf));
      return { ok: true, path: dest };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, error: /no built release/.test(msg) ? "Build + deploy the app first — there's no release to export." : msg };
    }
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
}
