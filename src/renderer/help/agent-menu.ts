/**
 * agent-menu.ts — THE AGENT WINDOW'S ONE ⋮ MENU, as data (his report,
 * 2026-10-05, web AND desktop: a new Glyphh agent on a Work session showed
 * TWO ⋮ on its top row — the session kebab (Rename / Pin / Delete, dead on a
 * fresh session) and the Developer-tools ⋮ — one of them empty, the other the
 * tools. His order: ONE menu, the top-right ⋮; never an empty dropdown; a
 * Work session never lists Files / Terminal / Editor / Diff).
 *
 * ONE MENU ON BOTH SURFACES (his order, 2026-10-06: "Cloud is first and every
 * surface pulls from it"): MENU_SECTION_ORDER is the one frozen list, the
 * same on the desktop and the web. The only differences are capabilities,
 * checked where they are used (help/surface.ts): the Browser row needs a
 * streamed panel; a CLI on a desktop path needs that desktop attached.
 *
 * Sections, each present ONLY when it has something to show:
 *   Panels         the workbench views for THIS session's type — Code: Files,
 *                  Terminal, Editor, Browser, Diff, Plan, Agents; Work: Browser,
 *                  Agents — then Artifacts; the Browser only where a streamed
 *                  panel can be. The Work toolbelt has no files, shell, editor
 *                  or diff.
 *   Session        the open session's own actions — Rename, Pin / Unpin, New
 *                  agent panel, Delete. Absent on a fresh landing (nothing to
 *                  rename or delete), so the menu is never a dead click.
 *   Apps           COLLAPSED on every open (his review: "dropdowns or
 *                  expandable sections that are collapsed on load") — the
 *                  member's INSTALLED GLYPHH APPS: the cloud instances (the
 *                  one list, his order 2026-10-04: apps live in the cloud),
 *                  one row per slug. A HOUSE row — an app whose launchConfig
 *                  .tool names a built-in work panel (Design, Slides, Images,
 *                  Video, Audio, Drive) — opens that panel; every other row
 *                  opens as a panel of its own (the instance proxy). "Apps · 0"
 *                  says it when nothing is installed.
 *   Agents / CLIs  COLLAPSED on every open — the CLI agents as built, on both
 *                  surfaces. A click opens the CLI ON THE SESSION'S FOLDER:
 *                  the attached desktop over remote control, or the cloud
 *                  workspace — whatever the session's locus is. A desktop path
 *                  with no desktop attached: the rows stay, disabled, with one
 *                  line and a link to Settings → Devices. With a desktop
 *                  attached, its live CLI sessions nest under each CLI's row
 *                  behind that row's own chevron (collapsed too).
 *   Workspaces     LAST, COLLAPSED on every open — the member's workspaces by
 *                  name (`layoutsList` — the member library's one list on
 *                  every surface); a click opens one through the workbench's
 *                  layout open (surface.ts surfaceLayoutCells filters the
 *                  cells the surface cannot host). Omitted when the member
 *                  has none.
 *
 * Pure: agent-menu-ui.ts paints exactly this; test/main/agent-menu.test.ts
 * pins the behaviours.
 */
import { surfaceCaps, surfaceHostsView, DESKTOP_TOOL_VIEWS } from "./surface.js";
import { houseViewOf } from "./house-relay.js";

export type MenuSurface = "web" | "desktop";
export type MenuSectionKind = "tools" | "session" | "apps" | "workspaces";

export const CONNECT_DESKTOP_LINE = "Connect your desktop to open apps";
export const CONNECT_DESKTOP_LINK = "Settings → Devices";
export const APPS_SECTION_LABEL = "Apps";
export const WORKSPACES_SECTION_LABEL = "Workspaces";
export const TOOLS_SECTION_LABEL = "Panels";
export const SESSION_SECTION_LABEL = "Session";
export const NO_APPS_LINE = "No Glyphh apps installed yet";

/** THE FROZEN ORDER — one list, both surfaces. */
export const MENU_SECTION_ORDER: ReadonlyArray<MenuSectionKind> = Object.freeze(["tools", "session", "apps", "workspaces"] as MenuSectionKind[]);

/** The sections that open as expandable heads, collapsed on every open. */
export const COLLAPSIBLE_SECTIONS: ReadonlyArray<MenuSectionKind> = Object.freeze(["apps", "workspaces"]);

/** THE ARTIFACTS PANEL (his order, 2026-10-05) lists in the Panels section
 *  on both surfaces and for both types — last, after the type's own views.
 *  On the web it opens full screen (surface.ts webPanelOpensFullScreen). */
export const ARTIFACTS_VIEW = "artifacts";
/** The Code toolbelt: the old Developer-tools list, in its order, then Artifacts. */
export const CODE_TOOL_VIEWS: ReadonlyArray<string> = Object.freeze([...DESKTOP_TOOL_VIEWS, ARTIFACTS_VIEW]);

const TOOL_LABELS: Record<string, string> = {
  files: "Files", terminal: "Terminal", monaco: "Editor", diff: "Diff", plan: "Plan", preview: "Browser", artifacts: "Artifacts",
};

/** The one app kind the Apps section lists: an installed Glyphh app
 *  (apps-store.ts LocalAppRow.kind "glyphh" — org-apps.ts toRow projects it
 *  as appArchetype "glyphh-app"; web-contract.js desktopAppRow carries it
 *  back as `kind`). */
export const GLYPHH_APP_KIND = "glyphh";

/** One attached desktop (attach.status's machines, name = the member's label for it). */
export interface MenuMachine { id: string; name: string }

/** An installed app's row, tagged with where it lives. */
export interface MenuAppRow {
  slug: string;
  name: string;
  /** The row's kind: "glyphh" (a Glyphh app), "web" (a URL tab), "native". */
  kind?: string;
  /** The art to show: a data URL, the marketplace icon, a proxied favicon, or nothing. */
  icon?: string | null;
  /** A house app's built-in work panel (the tab's launchConfig.tool: "gdesign", "gimage", …); absent otherwise. */
  tool?: string | null;
  machineId: string;
  machineName: string;
  /** An app INSTALLED IN THE CLOUD (an instance): opens as a panel on either
   *  surface, no desktop needed. */
  cloud?: boolean;
}

/** Where the session's folder is (his order, 2026-10-05: the ⋮ menu is
 *  keyed off it): a desktop path, or the cloud. */
export type MenuLocus = "local" | "cloud";



/** The open session, or null on a fresh landing. */
export interface MenuSession { pinned: boolean }

/** One of the member's workspaces (preload / web-contract `layoutsList`), by name. */
export interface MenuWorkspaceRow { name: string }

export interface AgentMenuInput {
  surface: MenuSurface;
  session: MenuSession | null;
  /** attach.status's machines — is a desktop attached, and which. The
   *  desktop itself is always its own machine. */
  machines?: ReadonlyArray<MenuMachine>;
  /** The member's INSTALLED apps — the cloud instances, the one list. */
  installed?: ReadonlyArray<MenuAppRow>;
  /** The session's locus. */
  locus?: MenuLocus;
  /** The member's workspaces (`layoutsList`); none → no section. */
  workspaces?: ReadonlyArray<MenuWorkspaceRow>;
}

export interface MenuAppsSection {
  kind: "apps";
  label: string;
  /** Expandable head, collapsed on open (COLLAPSIBLE_SECTIONS). */
  collapsible: true;
  /** The rows behind the head — the number on it ("Apps · 3"). */
  count: number;
  enabled: boolean;
  rows: MenuAppRow[];
  /** The one line under the rows, or null. */
  note: string | null;
  /** A link beside the note, or null. */
  link: { label: string; settingsSub: string } | null;
}
export interface MenuWorkspacesSection { kind: "workspaces"; label: string; collapsible: true; count: number; rows: MenuWorkspaceRow[] }
export interface MenuToolRow { view: string; label: string }
export interface MenuToolsSection { kind: "tools"; label: string; rows: MenuToolRow[] }
export type SessionAction = "rename" | "pin" | "new-panel" | "delete";
export interface MenuSessionRow { action: SessionAction; label: string; danger: boolean }
export interface MenuSessionSection { kind: "session"; label: string; rows: MenuSessionRow[] }
export type MenuSection = MenuAppsSection | MenuToolsSection | MenuSessionSection | MenuWorkspacesSection;

export interface AgentMenu {
  surface: MenuSurface;
  attached: boolean;
  /** The machine a desktop open lands on: the first attached desktop. */
  machine: MenuMachine | null;
  /** In paint order (MENU_SECTION_ORDER); never an empty section, never an empty list. */
  sections: MenuSection[];
}

/** The tool views a session of this type offers on this surface: the one
 *  list for the type, through the surface's capabilities (the Browser needs
 *  a streamed panel). */
export function toolViewsFor(surface: MenuSurface): ReadonlyArray<string> {
  const caps = surfaceCaps(surface === "web");
  return CODE_TOOL_VIEWS.filter((v) => surfaceHostsView(v, caps));
}

export function toolRowsFor(surface: MenuSurface): MenuToolRow[] {
  return toolViewsFor(surface).map((view) => ({ view, label: TOOL_LABELS[view] ?? view }));
}

/** The open session's rows: Rename, Pin / Unpin, New agent panel, Delete (danger, last). */
export function sessionRowsFor(session: MenuSession | null): MenuSessionRow[] {
  if (!session) return [];
  return [
    { action: "rename", label: "Rename", danger: false },
    { action: "pin", label: session.pinned ? "Unpin" : "Pin", danger: false },
    { action: "new-panel", label: "New agent panel", danger: false },
    { action: "delete", label: "Delete", danger: true },
  ];
}

/** THE APPS FILTER: only Glyphh apps (kind "glyphh") with a slug, one row
 *  per slug (two sources with the same app show it once). */
export function glyphhAppsOnly(rows: ReadonlyArray<MenuAppRow>): MenuAppRow[] {
  const seen = new Set<string>();
  const out: MenuAppRow[] = [];
  for (const r of rows) {
    if (!r.slug || r.kind !== GLYPHH_APP_KIND) continue;
    const k = r.slug.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(r);
  }
  return out;
}

/** WHERE AN APPS ROW OPENS — the same on both surfaces: a house row (a
 *  Glyphh app whose tool names a house panel) opens that panel
 *  (__wbOpenTool(view)); a cloud instance — and on the desktop every row —
 *  opens as a panel of its own (__wbOpenApp); only a row that lives on an
 *  attached desktop, asked from the web, opens THERE (`panels.open {app}`). */
export type AppRowOpen = { open: "house-panel"; view: string } | { open: "panel" };
/** Where an apps row opens: a house row in its house panel, every other
 *  installed app as a panel on THIS surface (his order, 2026-10-06: nothing
 *  opens on a desktop from the web). */
export function appRowOpen(row: Pick<MenuAppRow, "kind" | "tool" | "cloud">, _surface?: MenuSurface): AppRowOpen {
  const view = row.kind === GLYPHH_APP_KIND ? houseViewOf(row.tool) : null;
  if (view) return { open: "house-panel", view };
  return { open: "panel" };
}

/** The locus the ⋮ menu keys off, read from a session source: a local
 *  source (a desktop path) is "local"; anything else — a cloud source, or
 *  no source at all — is "cloud". */
export function menuLocusOf(source: { kind?: unknown } | null | undefined): MenuLocus {
  return source && typeof source === "object" && source.kind === "local" ? "local" : "cloud";
}

/** THE WORKSPACE ROWS: one per name (trimmed, non-empty), the first of a
 *  duplicate name wins (the library merges rows by name already; this guards
 *  the menu against a stray twin). */
export function workspaceRows(rows: ReadonlyArray<MenuWorkspaceRow>): MenuWorkspaceRow[] {
  const seen = new Set<string>();
  const out: MenuWorkspaceRow[] = [];
  for (const r of rows) {
    const name = String(r?.name ?? "").trim();
    if (!name) continue;
    const k = name.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push({ name });
  }
  return out;
}

/** The expandable head's text: "Apps · 3", "Workspaces · 2". */
export function sectionHeadLabel(label: string, count: number): string {
  return `${label} · ${count}`;
}


/** The menu for one open — the same sections on both surfaces. */
export function agentMenuModel(i: AgentMenuInput): AgentMenu {
  const machines = i.machines ?? [];
  const machine = machines[0] ?? null;
  // The desktop IS a desktop: its own folders are always reachable.
  const attached = i.surface === "desktop" || !!machine;
  const byKind = new Map<MenuSectionKind, MenuSection>();
  const tools = toolRowsFor(i.surface);
  if (tools.length) byKind.set("tools", { kind: "tools", label: TOOLS_SECTION_LABEL, rows: tools });
  const session = sessionRowsFor(i.session);
  if (session.length) byKind.set("session", { kind: "session", label: SESSION_SECTION_LABEL, rows: session });
  // APPS = THE INSTALLED APPS, PERIOD (his order, 2026-10-05: "Only
  // installed apps show period. not tied to desktop or not"): the member's
  // instances, the one list on every surface (his order, 2026-10-06) —
  // nothing read off a desktop joins it.
  const appRows = glyphhAppsOnly(i.installed ?? []);
  byKind.set("apps", {
    kind: "apps",
    label: APPS_SECTION_LABEL,
    collapsible: true,
    count: appRows.length,
    enabled: true,
    rows: appRows,
    // "Apps · 0" says it (his order, 2026-10-05): no line under an empty fold.
    note: null,
    link: null,
  });

  // WORKSPACES, LAST (his order, 2026-10-05): the member's workspaces by
  // name, one row each. Always present since 2026-10-08 — "Create
  // workspace…" lives at its head (his order: "agent -> dropdown -> Create
  // Workspace").
  const spaces = workspaceRows(i.workspaces ?? []);
  byKind.set("workspaces", { kind: "workspaces", label: WORKSPACES_SECTION_LABEL, collapsible: true, count: spaces.length, rows: spaces });
  const sections: MenuSection[] = [];
  for (const kind of MENU_SECTION_ORDER) {
    const s = byKind.get(kind);
    if (s) sections.push(s);
  }
  return { surface: i.surface, attached, machine, sections };
}

// ── THE FOLD STATE: what is expanded in the menu on screen ─────────────────
// A fresh set on every open — nothing expanded (his order: collapsed on load,
// at the very least). Keys: a section's kind ("apps", "clis") and a CLI's own
// row (cliFoldKey) for the sessions nested under it.

export type FoldState = Set<string>;

/** The state a menu opens with: everything collapsed. */
export function menuFoldState(): FoldState {
  return new Set<string>();
}


export function isExpanded(state: FoldState, key: string): boolean {
  return state.has(key);
}

/** Toggle one fold; answers the new expanded state. */
export function toggleFold(state: FoldState, key: string): boolean {
  if (state.has(key)) { state.delete(key); return false; }
  state.add(key);
  return true;
}

/** The toast after an app opened on the desktop. */
