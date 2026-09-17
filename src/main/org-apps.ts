/**
 * org-apps — the desktop's read of the app library, LOCAL now
 * (THE PURGE, 2026-09-10: rows live in ~/.glyphh/apps/<id>/app.json via
 * apps-store; the server app surface is gone).
 *
 * The desktop's renderer contract (SavedPanelApp) predates the store, so the
 * translation happens HERE, once: the Apps page, command palette, app
 * resolver, app host, and LLM tool list all read through `fetchOrgApps()`
 * and see identical data.
 */

import * as appsStore from "./apps-store.js";
import type { LocalAppRow } from "./apps-store.js";
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
  /** The app's steered NEXT version (apps.version) — what the next build releases. */
  version: string;
  /** Secret NAMES the manifest declares — what the app needs configured. */
  secretNames: string[];
  /** The connections the app's manifest requires, with connected status. */
  requiredConnections: { slug: string; actAs: string; connected: boolean }[];
  /** The marketplace listing's uploaded icon — the app's real art. */
  iconUrl: string | null;
  /** The FULL marketplace listing (copy, media, rating, listed state). Carried
   *  through so the app-detail Marketplace tab reads back what a save stored —
   *  without it the read-back blanks every field but the title. */
  listing: null;
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
  version: "",
  secretNames: [],
  requiredConnections: [],
  connectionIds: [],
  iconUrl: null,
  listing: null,
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
  { slug: "apps", name: "Apps", nav: "apps" },
  { slug: "layouts", name: "Layouts", nav: "layouts" },
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
function toRow(app: LocalAppRow): OrgAppRow {
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
    version: app.version,
    secretNames: app.secretNames ?? [],
    requiredConnections: app.requiredConnections,
    connectionIds: app.requiredConnections.map((c) => c.slug),
    iconUrl: typeof app.config?.iconUrl === "string" ? app.config.iconUrl : null,
    listing: null,
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
    const rows = (await appsStore.mine()).map(toRow);
    // A user row that took the "glyphh" slug IS the built-in: keep its real
    // id (layouts/recents reference it), normalize its archetype, pin first.
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
