import { app, ipcMain, dialog, BrowserWindow, screen, net } from "electron";
import { refreshForceWebSlugs } from "./force-web";
import fs from "fs";
import path from "path";
import { extractMacAppIcon } from "./app-icon-extract";
import { exportServerApp } from "./glyphh-app-package";
import { deployAppFromWorkdir, pullAppSource, r2DiffWorkdir, appDirInWorkdir } from "./glyphh-app-builder";
import { getExplicitWorkingDirectory } from "./working-directory";
import { deployAppFromCloud, isCloudSource } from "./glyphh-harness-run";
import { loadSessions } from "./glyphh-agent-context";
import { hasMcpAccess, AUTH_SERVER } from "./auth";
import { getClient } from "./glyphh-client";
import { probeMcpAuth, authorizeMcpServer } from "./mcp-oauth";
import type { OrgMcpConnection, UpdateListingInput } from "@glyphh/sdk";
import { fetchOrgApps, invalidateOrgApps } from "./org-apps";
import { registerMarketplaceIpc } from "./marketplace-ipc";

import { openAppByRef, openLayoutByName } from "./app-resolver";
import { showThinking, hideThinking } from "./thinking-overlay";
import { isGlyphhAppBundle, installGlyphhAppBundle, isGlyphhAppRow } from "./glyphh-app-host";
import { listAppSecrets, setAppSecret, deleteAppSecret } from "./app-secrets";
import { resolveRoles, setSelection, invalidateRoles, applyLoopConfig, currentLoop } from "./loop-selections";
import { BUILTIN_EFFECT_LIST } from "../shared/drip-effects";

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

  // The HOUSE DEFAULTS — the glyphh launcher set, command-center only (the
  // Apps page stays the org's own rows via panel-apps-list).
  ipcMain.handle("apps-defaults", async () => {
    try { return await getClient().apps.defaults(); }
    catch { return []; }
  });

  // ── Marketplace ──────────────────────────────────────────────
  // The storefront / reviews / developer / admin transport lives in
  // marketplace-ipc.ts (SDK contract shapes end to end).
  registerMarketplaceIpc();
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
  // The ten built-in work panels (Office / Design / Memory / Media) are
  // Apps-page fixtures, not org apps — no create/update/delete may ever land
  // on their slugs, whoever asks (the agent's tool seam refuses them too,
  // glyphh-agent-tools.ts).
  const BUILTIN_WORKPANELS = new Set(["gpoint", "gdoc", "gsheet", "gdrive", "gdesign", "gmemory", "gimage", "gvideo", "gsound", "gband"]);
  const WORKPANEL_REFUSAL = "work panels are built in — they cannot be altered or removed";

  ipcMain.handle("panel-apps-create", async (_e, input: Record<string, unknown>) => {
    setTimeout(() => { void refreshForceWebSlugs(); }, 500);   // guard set follows app edits
    try {
      const slug = String(input.slug || input.name || "").toLowerCase().trim()
        .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
      if (!slug) return { ok: false, error: "A name is required." };
      if (BUILTIN_WORKPANELS.has(slug)) return { ok: false, error: WORKPANEL_REFUSAL };
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
      const app = await getClient().apps.updateEntry(slug, {
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
      await getClient().apps.removeEntry(slug);
      invalidateOrgApps();
      return { ok: true };
    }
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

  ipcMain.handle("loop-roles", async (_e, p: { loop?: string; force?: boolean; context?: string }) => {
    const loop = String(p?.loop || "default");
    const context = p?.context === "cloud" ? ("cloud" as const) : ("local" as const);
    try {
      // force → drop the 60s cache first, so an org-side model change (a model
      // added/removed/toggled on the platform) is seen without an app restart.
      if (p?.force) invalidateRoles(loop);
      return { ok: true, loop, roles: await resolveRoles(loop, context) };
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
  ipcMain.handle("loop-apply-config", (_e, p: { loop?: string | null; modelSelections?: Record<string, string>; sessionMode?: "keep" | "new" | "last"; folder?: string | null; space?: "chat" | "cowork" | "code" | null }) => {
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

import type { LayoutManager } from "./layout-manager";
import type { DripManager } from "./drip-manager";

interface AppsIpcDeps {
  layoutManager: LayoutManager;
  dripManager: DripManager | null;
  canSaveLayout: (count: number) => { allowed: boolean; reason?: string };
  getMainWindow: () => import("electron").BrowserWindow | null;
}

export function registerAppsIpc(deps: AppsIpcDeps): void {
  const {
    layoutManager,
    dripManager,
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

  // IPC: Drips CRUD
  // Server-authoritative (yo-server /api/drips) — list refreshes from the
  // server; save/delete await the write so a subsequent list is consistent.
  ipcMain.handle("drips-list", async () => (await dripManager?.refreshAndList()) ?? []);
  ipcMain.handle("drips-save", async (_e, name: string, recipe: string) => (await dripManager?.saveCustomAsync(name, recipe)) ?? "");
  ipcMain.handle("drips-delete", async (_e, name: string) => (await dripManager?.deleteCustomAsync(name)) ?? "");
  // STATIC import (../shared/drip-effects) — the old lazy `require` here was
  // invisible to the typechecker (an untyped any), so a rename/move could break
  // it with no compile error and the renderer's catch would silently render an
  // empty menu. A missing module now fails main at boot, loudly.
  ipcMain.handle("drips-builtin-effects", () => BUILTIN_EFFECT_LIST);
  // A PREVIEW is windowed + time-bounded. It used to inherit the command path's
  // full-screen default and, for a looping effect, no timeout at all — an
  // always-on-top click-through overlay over every display, forever, with no way
  // to dismiss it. That is the "black screen, no renderer" report.
  ipcMain.handle("drips-preview", async (_e, recipe: string) => {
    if (!dripManager) return "drip manager not ready";
    return dripManager.execute(recipe.split(/\s+/), { preview: true });
  });
  // The escape hatch every effect needs and none had.
  ipcMain.handle("drips-stop", async () => {
    if (!dripManager) return "drip manager not ready";
    dripManager.stopAll();
    return "stopped";
  });
  ipcMain.handle("drips-running", async () => (dripManager ? dripManager.running() : []));

  // Renderer-side tier check (same gate the connect IPCs enforce) so the UI
  // can lock the MCP / Connection tabs for Free users instead of showing a
  // form that silently fails to save.
  ipcMain.handle("has-mcp-access", () => hasMcpAccess());

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
  ipcMain.handle("app-version-set", async (_e, slug: string, version: string) => {
    try {
      const out = await getClient().apps.setVersion(String(slug), String(version));
      invalidateOrgApps();
      return { ok: true, ...out };
    }
    catch (err) { return { ok: false, error: err instanceof Error ? err.message : String(err) }; }
  });
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

  // ── Dedicated app servers + custom domains (last-mile Phase F) ───────────────
  // Deploy an app to its OWN Fly machine (sized by an app-server image) and point a
  // custom domain at it. Everything through the SDK — the main process holds no state.
  ipcMain.handle("app-servers-list", async () => {
    try {
      return { ok: true, images: await getClient().appServers.list() };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });
  ipcMain.handle("app-server-deploy", async (_e, slug: string, imageKey: string, releaseId?: string) => {
    try {
      const d = await getClient().hosting.deployToServer(slug, releaseId ? { imageKey, releaseId } : { imageKey });
      return { ok: true, queued: d };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });
  ipcMain.handle("app-server-deployments", async (_e, slug: string) => {
    try {
      return { ok: true, deployments: await getClient().hosting.serverDeployments(slug) };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });
  ipcMain.handle("app-server-destroy", async (_e, slug: string, id: string) => {
    try {
      await getClient().hosting.destroyServer(slug, id);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });
  ipcMain.handle("app-domains-list", async (_e, slug: string) => {
    try {
      return { ok: true, domains: await getClient().hosting.domains(slug) };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });
  ipcMain.handle("app-domain-add", async (_e, slug: string, deploymentId: string | null, hostname: string) => {
    try {
      // No deploymentId → the domain binds to the APP's hosted deployment (P2).
      return { ok: true, domain: await getClient().hosting.addDomain(slug, { ...(deploymentId ? { deploymentId } : {}), hostname }) };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });
  ipcMain.handle("app-domain-remove", async (_e, slug: string, id: string) => {
    try {
      await getClient().hosting.removeDomain(slug, id);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  // ── Releases tab: the app's version history ─────────────────────────────────
  // Read + the owner actions. Cutting a release is the BUILD path
  // (glyphh-app-builder) — annotate/promote what it produced, or run it right
  // here: Build packages the working folder's compiled dist, cuts a release,
  // uploads the source, and deploys. This is also the recovery path when a
  // release's source archive is gone from storage ("rebuild the app").
  ipcMain.handle("app-build-deploy", async (_e, slug: string, opts?: { deploy?: boolean }) => {
    try {
      // Auto by session source: a CLOUD session has no local workdir — its app
      // source lives in the pod, so build+deploy runs THERE (remote dev). A local
      // session builds from the working folder as before. Deploy/promote are
      // server-side, so they already work from either.
      const { chats, currentId } = loadSessions();
      const chat = chats.find((c) => c.id === currentId);
      if (chat && isCloudSource(chat.source)) {
        const r = await deployAppFromCloud(slug, chat.id, chat.source ?? { kind: "cloud-new" }, opts ?? {});
        return { ok: r.ok, result: r.result, error: r.error };
      }
      const r = await deployAppFromWorkdir(slug || undefined, opts ?? {});
      invalidateOrgApps(); // the cut advanced apps.version — the Releases tab re-reads it
      return { ok: r.status === "ready", result: r, error: r.error };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });
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

  // ── Co-working: collaborators + per-release org approval ────────────────────
  ipcMain.handle("app-collaborators", async (_e, slug: string) => {
    try { return { ok: true, collaborators: await getClient().apps.collaborators(slug) }; }
    catch (err) { return { ok: false, error: err instanceof Error ? err.message : String(err), collaborators: [] }; }
  });
  ipcMain.handle("app-collaborator-set", async (_e, slug: string, userId: string, role: "read" | "edit" | "admin") => {
    try {
      await getClient().apps.setCollaborator(slug, userId, role);
      return { ok: true, collaborators: await getClient().apps.collaborators(slug) };
    } catch (err) { return { ok: false, error: err instanceof Error ? err.message : String(err) }; }
  });
  ipcMain.handle("app-collaborator-remove", async (_e, slug: string, userId: string) => {
    try { await getClient().apps.removeCollaborator(slug, userId); return { ok: true }; }
    catch (err) { return { ok: false, error: err instanceof Error ? err.message : String(err) }; }
  });
  ipcMain.handle("app-release-org-review", async (_e, slug: string, releaseId: string, action: "submit" | "approve" | "reject") => {
    try {
      await getClient().apps.orgReview(slug, releaseId, action);
      invalidateOrgApps(); // approval may flip visibility private → org
      return { ok: true };
    } catch (err) { return { ok: false, error: err instanceof Error ? err.message : String(err) }; }
  });
  ipcMain.handle("app-org-pending-releases", async () => {
    try { return { ok: true, pending: await getClient().apps.pendingOrgReleases() }; }
    catch (err) { return { ok: false, error: err instanceof Error ? err.message : String(err), pending: [] }; }
  });

  // ── Edge traffic (his order, 2026-09-02): the apex fleet's stats ───────────
  ipcMain.handle("app-traffic", async (_e, slug: string, days?: number) => {
    try { return { ok: true, ...(await getClient().apps.traffic(slug, days ?? 30)) }; }
    catch (err) { return { ok: false, error: err instanceof Error ? err.message : String(err), days: [], hosts: [] }; }
  });
  ipcMain.handle("org-domains-traffic", async (_e, days?: number) => {
    try { return { ok: true, ...(await getClient().org.domainsTraffic(days ?? 30)) }; }
    catch (err) { return { ok: false, error: err instanceof Error ? err.message : String(err), days: [], hosts: [] }; }
  });

  // ── Version history (his order, 2026-09-01): the snapshot chain + restore ──
  ipcMain.handle("app-source-history", async (_e, slug: string) => {
    try { return { ok: true, history: await getClient().apps.sourceHistory(slug) }; }
    catch (err) { return { ok: false, error: err instanceof Error ? err.message : String(err), history: [] }; }
  });
  ipcMain.handle("app-source-restore", async (_e, slug: string, hash: string) => {
    try { return { ok: true, ...(await pullAppSource(slug, { hash })) }; }
    catch (err) { return { ok: false, error: err instanceof Error ? err.message : String(err) }; }
  });
  // The diff panel's R2 lane: status (drift flag + history) and the unified
  // head→local diff over the working folder's app project.
  ipcMain.handle("files:r2-diff", async () => {
    try {
      const wd = getExplicitWorkingDirectory();
      if (!wd) return { status: null, text: "", error: "no working folder" };
      return await r2DiffWorkdir(appDirInWorkdir(wd));
    } catch (err) { return { status: null, text: "", error: err instanceof Error ? err.message : String(err) }; }
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
  ipcMain.handle("app-listing-image-add", async (_e, slug: string, kind: "icon" | "screenshot" | "video") => {
    const win = getMainWindow();
    if (!win || win.isDestroyed()) return { ok: false, error: "No window" };
    const picked = await dialog.showOpenDialog(win, {
      title: kind === "icon" ? "Choose an app icon" : kind === "video" ? "Add a demo video" : "Add screenshots",
      // Screenshots take a BATCH (his rule, 2026-08-20); icon/video stay single.
      properties: kind === "screenshot" ? ["openFile", "multiSelections"] : ["openFile"],
      filters: kind === "video"
        ? [{ name: "Videos", extensions: ["mp4", "webm"] }]
        : [{ name: "Images", extensions: ["png", "jpg", "jpeg", "webp", "gif"] }],
    });
    if (picked.canceled || !picked.filePaths.length) return { ok: false, error: "Canceled" };
    try {
      let lastKey = "";
      for (const p of picked.filePaths) {
        const bytes = fs.readFileSync(p);
        const stored = await getClient().apps.uploadMedia(slug, kind, new Uint8Array(bytes));
        lastKey = stored.key;
      }
      invalidateOrgApps();
      return { ok: true, key: lastKey };
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
}
