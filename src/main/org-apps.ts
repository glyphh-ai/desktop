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
  connectionIds: string[];
  mcp: null;
  commands: Record<string, never>;
  createdAt: string;
  updatedAt: string;
}

const CACHE_KEY = "org-apps";

/** A native app launches an executable; every other kind opens a URL. */
function toRow(app: OrgApp): OrgAppRow {
  return {
    id: app.id,
    orgId: "",
    createdBy: "",
    name: app.name,
    slug: app.slug,
    system: false,
    url: app.prodUrl,
    isBrowser: app.kind !== "native",
    execPath: app.nativeRef,
    appArchetype: app.kind,
    launchConfig: app.config ?? null,
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
  return appCache.cached(CACHE_KEY, async () => (await getClient().apps.mine()).map(toRow));
}

/** Drop the cached list — call after any app mutation. */
export function invalidateOrgApps(): void {
  appCache.invalidate(CACHE_KEY);
}
