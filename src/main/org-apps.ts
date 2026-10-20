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

import * as path from "node:path";
import * as appsStore from "./apps-store.js";
import { type LocalAppRow } from "./apps-store.js";
import { faviconUrlFor, iconDataUrlForDirs } from "./app-icon-file.js";
import { tabRowOf } from "../shared/member-library.js";
import { mergeAppRows } from "../shared/app-instances.js";

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
  /** A local icon file (≤ 24 KB) as a data URL — the art the web can show
   *  for an app whose icon lives in a folder on this machine (app-icon-file.ts).
   *  Absent when there is none or it is bigger. */
  iconDataUrl?: string;
  /** For a URL tab: the favicon URL the desktop fetches for it, carried so the
   *  web asks its own /webicon proxy for the same mark. Absent otherwise. */
  faviconUrl?: string;
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

/** The tab row in the renderer's shape — ONE projection (shared/member-library.ts
 *  tabRowOf), the same the web applies to the server's record of the tab — plus
 *  the icon the row carries off this machine (app-icon-file.ts): a Glyphh app's
 *  icon file (bundle folder, tab folder, or beside an installed .glyphh entry)
 *  and a URL tab's favicon URL. */
function toRow(app: LocalAppRow, row: OrgAppRow = tabRowOf(app) as OrgAppRow): OrgAppRow {
  const bundleDir = typeof app.config?.bundleDir === "string" ? app.config.bundleDir : null;
  // (the tab folder on this machine is gone — 2026-10-07; a bundle folder
  // or an installed entry beside the row are the only local icon sources)
  const iconDataUrl = iconDataUrlForDirs([
    bundleDir,
    app.kind === "glyphh" && app.nativeRef ? path.dirname(app.nativeRef) : null,
  ]);
  const faviconUrl = app.kind === "web" ? faviconUrlFor(app.prodUrl) : "";
  return { ...(iconDataUrl ? { iconDataUrl } : {}), ...(faviconUrl ? { faviconUrl } : {}), ...row };
}

/** The member's apps in the renderer's shape: the built-in rows, then the
 *  tab rows (shared/app-instances.ts mergeAppRows drops a Glyphh tab with
 *  nothing behind it). A row's local icon rides from this machine. */
export async function fetchOrgApps(): Promise<OrgAppRow[]> {
  const tabs = await appsStore.mine();
  const local = new Map(tabs.map((t) => [t.slug.toLowerCase(), t] as const));
  const rows = mergeAppRows([], tabs).map((row) => {
    const tab = local.get(row.slug.toLowerCase());
    return tab ? toRow(tab, row as OrgAppRow) : (row as OrgAppRow);
  });
  // A user row that took the "glyphh" slug IS the built-in: keep its real
  // id (layouts/recents reference it), normalize its archetype, pin first.
  const selfIdx = rows.findIndex((r) => r.slug === "glyphh");
  if (selfIdx >= 0) {
    const self = { ...rows[selfIdx], system: true, appArchetype: "glyphh-self" };
    return [self, ...NAV_ROWS, ...rows.filter((_, i) => i !== selfIdx)];
  }
  return [GLYPHH_SELF_ROW, ...NAV_ROWS, ...rows];
}
