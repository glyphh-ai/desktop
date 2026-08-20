/**
 * org-apps — the desktop's read of the org's apps, from the one apps API.
 *
 * The server has a single apps surface: `/api/apps/*` (`client.apps.mine()`
 * returns the entry + launcher config + variants + required connections).
 * `/api/panel-apps` is a legacy name kept only as a GET projection of hosting
 * deployments for the dashboard count — it carries no name/slug/launcher, so
 * nothing that needs a real app record may read it.
 *
 * The desktop's renderer contract (SavedPanelApp) predates the SDK, so the
 * translation happens HERE, once: the Apps page, command palette, app
 * resolver, app host, LLM tool list, and Ada indexer all read through
 * `fetchOrgApps()` and see identical data.
 *
 * `mcp` and `commands` come back empty — custom MCP is its own connection
 * surface now, and per-app command mappings await the app-state work.
 */

import type { OrgApp } from "@glyphh/sdk";
import { getClient } from "./glyphh-client.js";
import { appCache } from "./glyphh-client.js";

/** The renderer's Apps record (mirrors preload's SavedPanelApp). */
export interface OrgAppRow {
  id: string;
  orgId: string;
  createdBy: string;
  name: string;
  slug: string;
  system: boolean;
  url: string | null;
  isBrowser: boolean;
  execPath: string | null;
  appArchetype: string | null;
  launchConfig: Record<string, unknown> | null;
  /** Who may reach the deployed app — 'public' or 'members'. */
  access: string;
  /** True when THIS org published the app — gates the publish-side tabs. */
  owned: boolean;
  /** Newest live release version, or null — drives the auto-update check. */
  latestVersion: string | null;
  /** The connections the app's manifest requires, with connected status. */
  requiredConnections: { slug: string; actAs: string; connected: boolean }[];
  connectionIds: string[];
  mcp: null;
  commands: Record<string, never>;
  createdAt: string;
  updatedAt: string;
}

const CACHE_KEY = "org-apps";

/** The built-in "Glyphh" app — Glyphh itself, always present and always first.
 *  Not a server record: synthesized here so every consumer (rail, command
 *  center, resolver, .dip, agent tools) sees the same row. Opening it focuses
 *  the Glyphh window (app-resolver's isGlyphhSelfRow). system:true keeps it
 *  off the Apps management page, which is user-CRUD only. */
const GLYPHH_SELF_ROW: OrgAppRow = {
  id: "glyphh",
  orgId: "",
  createdBy: "",
  name: "Glyphh",
  slug: "glyphh",
  system: true,
  url: null,
  isBrowser: false,
  execPath: null,
  appArchetype: "glyphh-self",
  launchConfig: null,
  access: "members",
  owned: true,
  latestVersion: null,
  requiredConnections: [],
  connectionIds: [],
  mcp: null,
  commands: {},
  createdAt: "1970-01-01T00:00:00.000Z",
  updatedAt: "1970-01-01T00:00:00.000Z",
};

/** The built-in NAVIGATION apps — Home, Connections, … Account. Like the
 *  Glyphh row they are synthesized (never server records) and system:true
 *  (hidden from the Apps management page), but they DO render on the command
 *  bar. Opening one navigates the home panel to its section (app-resolver
 *  routes archetype 'glyphh-nav' over home:goto-section) — no webview, no
 *  panel. isBrowser stays true so no path mistakes them for native rows and
 *  the rail's apps grid (url || !isBrowser) leaves them out. */
const NAV_SECTIONS: Array<{ slug: string; name: string; nav: string }> = [
  { slug: "home", name: "Home", nav: "dashboard" },
  { slug: "connections", name: "Connections", nav: "connections" },
  { slug: "apps", name: "Apps", nav: "apps" },
  { slug: "layouts", name: "Layouts", nav: "layouts" },
  { slug: "skills", name: "Skills", nav: "skills" },
  { slug: "loops", name: "Loops", nav: "loops" },
  { slug: "agents", name: "Agents", nav: "agents" },
  { slug: "models", name: "Models", nav: "models" },
  { slug: "settings", name: "Settings", nav: "settings" },
];
const NAV_ROWS: OrgAppRow[] = NAV_SECTIONS.map((n) => ({
  ...GLYPHH_SELF_ROW,
  id: `nav-${n.slug}`,
  name: n.name,
  slug: n.slug,
  isBrowser: true,
  appArchetype: "glyphh-nav",
  launchConfig: { nav: n.nav },
}));

/** Native and glyphh apps launch from a local path; every other kind opens a
 *  URL. A glyphh row keeps the desktop's long-standing "glyphh-app" archetype
 *  tag (isGlyphhAppRow and friends match on it). */
function toRow(app: OrgApp): OrgAppRow {
  return {
    id: app.id,
    orgId: "",
    createdBy: "",
    name: app.name,
    slug: app.slug,
    system: false,
    url: app.prodUrl,
    isBrowser: app.kind !== "native" && app.kind !== "glyphh",
    execPath: app.nativeRef,
    appArchetype: app.kind === "glyphh" ? "glyphh-app" : app.kind,
    launchConfig: app.config ?? null,
    access: app.access,
    owned: app.owned,
    latestVersion: app.latestVersion,
    requiredConnections: app.requiredConnections,
    connectionIds: app.requiredConnections.map((c) => c.slug),
    mcp: null,
    commands: {},
    createdAt: app.createdAt,
    updatedAt: app.updatedAt,
  };
}

/** The org's apps in the renderer's shape, short-TTL cached so the palette
 *  render and the click that follows share one request. */
export function fetchOrgApps(): Promise<OrgAppRow[]> {
  return appCache.cached(CACHE_KEY, async () => {
    // The org's own rows + the HOUSE DEFAULTS (the glyphh launcher set):
    // per-user copies are retired, so .dip/open_app/palette/layout-cell
    // resolution by slug or id must see the canonical glyphh rows. A user
    // row WINS its slug; defaults ride with their REAL global ids (layout
    // cells reference those).
    const [mine, houseDefaults] = await Promise.all([
      getClient().apps.mine(),
      getClient().apps.defaults().catch(() => []),
    ]);
    const mineRows = mine.map(toRow);
    // THE GLYPHH ORG CASE (his rule, 2026-08-19): in the org that OWNS the
    // house defaults, those canonical rows come back from mine() as ordinary
    // owned rows — mark them system so the Apps page (user-built/installed
    // only) hides them there too; the command center still shows system rows.
    const defSlugs = new Set(houseDefaults.map((d) => d.slug.toLowerCase()));
    for (const r of mineRows) if (defSlugs.has(r.slug.toLowerCase())) r.system = true;
    const taken = new Set(mineRows.map((r) => r.slug.toLowerCase()));
    const defaultRows: OrgAppRow[] = houseDefaults
      .filter((d) => !!d.url && !taken.has(d.slug.toLowerCase()))
      .map((d): OrgAppRow => ({
        id: d.id, orgId: "", createdBy: "",
        name: d.name, slug: d.slug,
        system: true,                 // house-owned: not deletable as a user row
        url: d.url, isBrowser: true, execPath: null,
        appArchetype: "web", launchConfig: null,
        access: "members", owned: false,
        latestVersion: null, requiredConnections: [], connectionIds: [],
        mcp: null, commands: {},
        createdAt: "", updatedAt: "",
      }));
    const rows = [...mineRows, ...defaultRows];
    // If the org already has a row with the "glyphh" slug (server-seeded, or
    // user-created), THAT row is the built-in: keep its real id — layouts and
    // recents reference it — normalize its archetype, and pin it first.
    // Dropping it in favor of a synthetic row orphans those references (cells
    // render raw UUIDs and the picker loses the app).
    const selfIdx = rows.findIndex((r) => r.slug === "glyphh");
    if (selfIdx >= 0) {
      const self = { ...rows[selfIdx], system: true, appArchetype: "glyphh-self" };
      return [self, ...NAV_ROWS, ...rows.filter((_, i) => i !== selfIdx)];
    }
    return [GLYPHH_SELF_ROW, ...NAV_ROWS, ...rows];
  });
}

/** Drop the cached list — call after any app mutation. */
export function invalidateOrgApps(): void {
  appCache.invalidate(CACHE_KEY);
}
