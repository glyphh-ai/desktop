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

import type { OrgApp } from "@glyphh/client";
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
    const rows = (await getClient().apps.mine()).map(toRow);
    // If the org already has a row with the "glyphh" slug (server-seeded, or
    // user-created), THAT row is the built-in: keep its real id — layouts and
    // recents reference it — normalize its archetype, and pin it first.
    // Dropping it in favor of a synthetic row orphans those references (cells
    // render raw UUIDs and the picker loses the app).
    const selfIdx = rows.findIndex((r) => r.slug === "glyphh");
    if (selfIdx >= 0) {
      const self = { ...rows[selfIdx], system: true, appArchetype: "glyphh-self" };
      return [self, ...rows.filter((_, i) => i !== selfIdx)];
    }
    return [GLYPHH_SELF_ROW, ...rows];
  });
}

/** Drop the cached list — call after any app mutation. */
export function invalidateOrgApps(): void {
  appCache.invalidate(CACHE_KEY);
}
