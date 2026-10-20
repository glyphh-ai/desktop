/**
 * composer-plus.ts — THE COMPOSER'S `+` MENU (his order, 2026-10-06, with
 * Claude's composer menu as the reference): one component on BOTH surfaces,
 * to the right of the permission-mode chip. Every row = an icon to the left
 * of the words. The desktop has more rows; the web is the desktop with
 * capability checks (web-surface.ts hostHas) — a row whose door the host
 * cannot serve is not offered.
 *
 *   Add files or photos  ⌘U    the attach door (glyphhPickAttachments — paste
 *                              and drag-drop stay as shortcuts)
 *   Skills ›                   the member's skills, a check toggles each
 *                              (skillSetEnabled); Manage skills → Build › Skills
 *   Connectors ›               the member's custom MCP servers and the
 *                              apps connected through Pipedream — a check
 *                              toggles a server's enabled flag
 *                              (mcpConnectionsUpdate) or an app's switch
 *                              (pipedreamAppEnable), the Connections page's
 *                              own switches; Add connector / Manage
 *                              connectors → Connections
 *   Memory ✓                   the member's memory preference (the Settings →
 *                              Memory switches `memoryInject` + `memoryCapture`
 *                              — there is no per-session memory flag, so this
 *                              is the same preference the page toggles)
 *   ── Loop (desktop) ──
 *   Loop: <name> ›             the loop that runs this session (Glyphh or a CLI)
 *   Route: <Direct|Gateway> ›  a CLI loop's route: its own login, or the
 *                              user's providers through the local router
 *   ── desktop only ──
 *   Add folder…                read access to another directory (Code)
 *   Working folder / Choose…   the session's folder (the OS picker)
 *
 * The MODEL (rows per surface + the door calls) is pure, so the unit test
 * runs it bare; mountComposerPlus paints it into the composer's drop-up.
 */

import { appIconInner } from "./app-icon.js";

export type PlusSurface = "desktop" | "web";
export type PlusSpace = "code";
export type PlusRowId = "attach" | "skills" | "connectors" | "memory" | "loop" | "route" | "add-folder" | "working-folder" | "choose-folder";
export type PlusRowKind = "action" | "submenu" | "check";

export interface PlusRow {
  id: PlusRowId;
  label: string;
  icon: string;
  kind: PlusRowKind;
  shortcut?: string;
  /** A check row's state. */
  checked?: boolean;
  /** A row the web never shows (a native window / the OS filesystem). */
  desktopOnly?: boolean;
  /** A row Code alone shows (a folder is a Code idea; Work has no walker). */
  codeOnly?: boolean;
  /** A separator above this row. */
  sepBefore?: boolean;
  /** A section heading above this row. */
  sectionBefore?: string;
  hint?: string;
}

/** What the host can serve, as the menu reads it. */
export interface PlusCaps {
  attach: boolean;
  folder: boolean;
  skills: boolean;
  connectors: boolean;
  memory: boolean;
}

/** The capability read, from ONE probe (web-surface.ts hostHas on the live
 *  renderer; a stub in the test). */
export function plusCapsOf(has: (name: string) => boolean): PlusCaps {
  return {
    attach: has("glyphhPickAttachments"),
    folder: has("pickWorkingDir"),
    skills: has("skillsList") && has("skillSetEnabled"),
    connectors: has("mcpConnectionsList"),
    memory: has("getPreference") && has("setPreference"),
  };
}

const S = `fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"`;
/** The row icons — the house 24-box stroke glyphs (the settings nav's family). */
export const PLUS_ICONS = {
  attach: `<svg viewBox="0 0 24 24" ${S}><path d="M21.4 11.1l-8.5 8.5a5.5 5.5 0 0 1-7.8-7.8l8.5-8.5a3.7 3.7 0 0 1 5.2 5.2l-8.5 8.5a1.8 1.8 0 0 1-2.6-2.6l7.8-7.8"/></svg>`,
  skills: `<svg viewBox="0 0 24 24" ${S}><rect x="4" y="3" width="16" height="18" rx="2.5"/><path d="M8 8h8M8 12h8M8 16h5"/></svg>`,
  connectors: `<svg viewBox="0 0 24 24" ${S}><path d="M13.4 10.6a4.4 4.4 0 0 1 0 6.2l-2.9 2.9a4.4 4.4 0 0 1-6.2-6.2l1.7-1.7"/><path d="M10.6 13.4a4.4 4.4 0 0 1 0-6.2l2.9-2.9a4.4 4.4 0 0 1 6.2 6.2l-1.7 1.7"/></svg>`,
  memory: `<svg viewBox="0 0 24 24" ${S}><path d="M12 3a5 5 0 0 0-5 5v1a4 4 0 0 0-2 7v1a3 3 0 0 0 3 3h8a3 3 0 0 0 3-3v-1a4 4 0 0 0-2-7V8a5 5 0 0 0-5-5z"/><path d="M12 8v12"/></svg>`,
  folder: `<svg viewBox="0 0 24 24" ${S}><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>`,
  folderPlus: `<svg viewBox="0 0 24 24" ${S}><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><path d="M12 11v6M9 14h6"/></svg>`,
  plus: `<svg viewBox="0 0 24 24" ${S}><path d="M12 5v14M5 12h14"/></svg>`,
  gear: `<svg viewBox="0 0 24 24" ${S}><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/></svg>`,
  back: `<svg viewBox="0 0 24 24" ${S}><polyline points="15 18 9 12 15 6"/></svg>`,
  loop: `<svg viewBox="0 0 24 24" ${S}><path d="M17 2l4 4-4 4"/><path d="M3 11v-1a4 4 0 0 1 4-4h14"/><path d="M7 22l-4-4 4-4"/><path d="M21 13v1a4 4 0 0 1-4 4H3"/></svg>`,
  route: `<svg viewBox="0 0 24 24" ${S}><circle cx="6" cy="6" r="2.5"/><circle cx="6" cy="18" r="2.5"/><circle cx="18" cy="9" r="2.5"/><path d="M6 8.5v7"/><path d="M18 11.5c0 3-4 3.5-10 5"/></svg>`,
} as const;
export const PLUS_CHECK = `<svg class="drop-check" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`;
export const PLUS_CARET = `<svg class="drop-caret" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 6 15 12 9 18"/></svg>`;

export const ATTACH_SHORTCUT = "⌘U";
export const ATTACH_LABEL = "Add files or photos";
export const MANAGE_SKILLS_LABEL = "Manage skills";
export const ADD_CONNECTOR_LABEL = "Add connector";
export const MANAGE_CONNECTORS_LABEL = "Manage connectors";

export interface PlusState {
  surface: PlusSurface;
  space: PlusSpace;
  memoryOn: boolean;
  /** The session's working folder name (desktop; null = not set). */
  workingFolder?: string | null;
  /** The session's loop, and on a CLI loop its route; absent where loops are not offered. */
  loop?: { name: string; route: string | null } | null;
}

/** THE ROWS, per surface: the web (hostHas) never sees a native row; Chat
 *  sees nothing of the folder family; Work sees no "Add folder…" (a belt
 *  with no reader). Pure. */
export function plusMenuRows(caps: PlusCaps, st: PlusState): PlusRow[] {
  const rows: PlusRow[] = [];
  if (caps.attach) rows.push({ id: "attach", label: ATTACH_LABEL, icon: PLUS_ICONS.attach, kind: "action", shortcut: ATTACH_SHORTCUT, hint: "Images and documents ride the next message" });
  if (caps.skills) rows.push({ id: "skills", label: "Skills", icon: PLUS_ICONS.skills, kind: "submenu", sepBefore: rows.length > 0 });
  if (caps.connectors) rows.push({ id: "connectors", label: "Connectors", icon: PLUS_ICONS.connectors, kind: "submenu" });
  if (caps.memory) rows.push({ id: "memory", label: "Memory", icon: PLUS_ICONS.memory, kind: "check", checked: st.memoryOn, sepBefore: rows.length > 0, hint: st.memoryOn ? "Glyphh remembers this session" : "Off — nothing is remembered" });
  // THE LOOP SECTION (desktop): which loop runs the session, and a CLI's route.
  if (st.loop) {
    rows.push({ id: "loop", label: `Loop: ${st.loop.name}`, icon: PLUS_ICONS.loop, kind: "submenu", sepBefore: rows.length > 0, sectionBefore: "Loop", hint: "The loop that runs this session" });
    if (st.loop.route) rows.push({ id: "route", label: `Route: ${st.loop.route}`, icon: PLUS_ICONS.route, kind: "submenu", hint: "Its own login, or your providers through Glyphh" });
  }
  // The folder family is the DESKTOP's (the OS pickers), where a session has
  // a folder to walk.
  if (st.surface === "desktop") {
    if (caps.attach) rows.push({ id: "add-folder", label: "Add folder…", icon: PLUS_ICONS.folderPlus, kind: "action", desktopOnly: true, codeOnly: true, sepBefore: rows.length > 0, hint: "Give Glyphh read access to another directory" });
    if (caps.folder) {
      const name = st.workingFolder ?? null;
      rows.push({ id: "working-folder", label: name ? `Working folder: ${name}` : "Working folder: not set", icon: PLUS_ICONS.folder, kind: "action", desktopOnly: true, codeOnly: true, sepBefore: !caps.attach && rows.length > 0, hint: "The folder this session works in" });
      rows.push({ id: "choose-folder", label: "Choose working folder…", icon: PLUS_ICONS.folderPlus, kind: "action", desktopOnly: true, codeOnly: true, hint: "Pick (or create) the folder to work in" });
    }
  }
  return rows;
}

// ── The doors (the host's API, as the menu calls it) ─────────────────────
type Env<T> = { ok: boolean; data?: T; error?: string };
export interface PlusSkill { id: string; name: string; enabled: boolean; type?: string }
export interface PlusMcp { slug: string; name: string; enabled: boolean; iconUrl?: string | null }
export interface PlusPdAccount { app: string; appName: string; icon: string | null; enabled: boolean; dead?: boolean }
export interface PlusApi {
  skillsList?: (kinds: string[]) => Promise<Env<PlusSkill[]>>;
  skillSetEnabled?: (id: string, on: boolean) => Promise<Env<PlusSkill>>;
  mcpConnectionsList?: () => Promise<{ ok: boolean; connections: PlusMcp[] }>;
  mcpConnectionsUpdate?: (slug: string, fields: Record<string, unknown>) => Promise<{ ok: boolean; error?: string }>;
  pipedreamAccounts?: (refresh?: boolean) => Promise<Env<PlusPdAccount[]>>;
  pipedreamAppEnable?: (app: string, on: boolean) => Promise<{ ok: boolean; error?: string }>;
  getPreference?: (key: string, defaultVal?: unknown) => Promise<unknown>;
  setPreference?: (key: string, value: unknown) => unknown;
}

/** THE SKILLS the submenu lists — the member's skills (the Skills page's
 *  kind), by name. A door that fails lists nothing. */
export async function readSkillRows(api: PlusApi): Promise<PlusSkill[]> {
  try {
    const r = await api.skillsList?.(["skill"]);
    const rows = r?.ok ? r.data ?? [] : [];
    return rows.map((s) => ({ id: s.id, name: s.name, enabled: s.enabled !== false, type: s.type })).sort((a, b) => a.name.localeCompare(b.name));
  } catch { return []; }
}

export async function toggleSkill(api: PlusApi, id: string, on: boolean): Promise<Env<PlusSkill>> {
  if (!api.skillSetEnabled) return { ok: false, error: "This host cannot change a skill." };
  try { return await api.skillSetEnabled(id, on); }
  catch (e) { return { ok: false, error: e instanceof Error ? e.message : String(e) }; }
}

/** One connector row of the submenu: a custom MCP server or a connected
 *  Pipedream app, and its switch. */
export interface PlusConnectorRow {
  key: string;
  name: string;
  on: boolean;
  /** The server's slug, or the Pipedream app's. */
  slug: string;
  kind: "mcp" | "pd";
  /** The server's logo, built exactly as the Connections page builds it
   *  (app-icon.ts appIconInner: its iconUrl, else the monogram). His order,
   *  2026-10-06: "pulled from the same place they are pulled from on the
   *  connections page". */
  icon: string;
}
export async function readConnectorRows(api: PlusApi): Promise<PlusConnectorRow[]> {
  const [custom, pd] = await Promise.all([
    api.mcpConnectionsList?.().catch(() => ({ ok: false, connections: [] as PlusMcp[] })) ?? Promise.resolve({ ok: false, connections: [] as PlusMcp[] }),
    api.pipedreamAccounts?.().catch(() => null) ?? Promise.resolve(null),
  ]);
  const rows = (custom?.connections ?? [])
    .map((m): PlusConnectorRow => ({ key: `mcp:${m.slug}`, name: m.name, on: !!m.enabled, slug: m.slug, kind: "mcp", icon: connectorIcon({ iconUrl: m.iconUrl ?? null }, m.name) }));
  // One row per connected app: two accounts of one app share its switch.
  const apps = new Map<string, PlusConnectorRow>();
  for (const a of pd?.ok ? pd.data ?? [] : []) {
    if (a.dead || apps.has(a.app)) continue;
    apps.set(a.app, { key: `pd:${a.app}`, name: a.appName || a.app, on: a.enabled !== false, slug: a.app, kind: "pd", icon: connectorIcon({ iconUrl: a.icon }, a.appName || a.app) });
  }
  return [...rows, ...apps.values()].sort((a, b) => a.name.localeCompare(b.name));
}
/** One connector's icon markup — the Connections page's own builder. */
export function connectorIcon(app: { iconUrl: string | null }, name: string): string {
  return appIconInner(app, name, "drop-icon-initial");
}

/** A connector's switch — the same door the Connections page's "Turn on/off" calls. */
export async function toggleConnector(api: PlusApi, row: PlusConnectorRow, on: boolean): Promise<{ ok: boolean; error?: string }> {
  try {
    if (row.kind === "pd") {
      if (!api.pipedreamAppEnable) return { ok: false, error: "This host cannot switch an app." };
      const r = await api.pipedreamAppEnable(row.slug, on);
      return r.ok ? { ok: true } : { ok: false, error: r.error };
    }
    if (!api.mcpConnectionsUpdate) return { ok: false, error: "This host cannot switch a server." };
    return await api.mcpConnectionsUpdate(row.slug, { enabled: on });
  } catch (e) { return { ok: false, error: e instanceof Error ? e.message : String(e) }; }
}

// ── Memory: the member's preference (there is no per-session flag) ───────
export const MEMORY_PREFS = { accepted: "memoryPolicyAcceptedAt", inject: "memoryInject", capture: "memoryCapture" } as const;
export interface MemoryState { accepted: boolean; on: boolean }
/** On = the policy is accepted and memory is searched (`memoryInject`, the
 *  Settings → Memory "search past sessions" switch; capture rides with it). */
export async function readMemoryState(api: PlusApi): Promise<MemoryState> {
  try {
    const accepted = !!(await api.getPreference?.(MEMORY_PREFS.accepted, ""));
    const inject = await api.getPreference?.(MEMORY_PREFS.inject, true);
    return { accepted, on: accepted && inject !== false };
  } catch { return { accepted: false, on: false }; }
}
/** Flip memory. Writes BOTH switches the page has (search + generate) so
 *  "off" means off. Before the policy is accepted nothing is written — the
 *  caller opens Settings → Memory instead (returns "needs-policy"). */
export function toggleMemory(api: PlusApi, st: MemoryState): "on" | "off" | "needs-policy" {
  if (!st.accepted) return "needs-policy";
  const on = !st.on;
  api.setPreference?.(MEMORY_PREFS.inject, on);
  api.setPreference?.(MEMORY_PREFS.capture, on);
  return on ? "on" : "off";
}

// ── Where "Manage …" goes, per surface ───────────────────────────────────
export type ManageKind = "skills" | "connectors" | "memory";
export type ManageTarget = { kind: "settings"; sub: string } | { kind: "group"; group: "customize"; sub: string };
/** Skills + Connectors are the Customize page's tabs on BOTH surfaces (his
 *  order, 2026-10-07: the desktop renders the group page too, and the
 *  Settings modal no longer lists them; his report the same day: "The Build
 *  and Customize tabs are confusing. It should just be one tab"). Memory is
 *  a plain settings page on both. `surface` stays in the signature
 *  for the rows that do differ by host. */
export function manageTargetOf(_surface: PlusSurface, kind: ManageKind): ManageTarget {
  const sub = kind === "skills" ? "skills" : kind === "connectors" ? "connections-cfg" : "memory";
  if (kind === "skills" || kind === "connectors") return { kind: "group", group: "customize", sub };
  return { kind: "settings", sub };
}

// ── The DOM: the drop-up, its panes and rows ─────────────────────────────
export interface PlusDoors {
  surface: PlusSurface;
  has: (name: string) => boolean;
  api: PlusApi;
  space: () => PlusSpace;
  attachFiles: () => void;
  attachFolder: () => void;
  workingFolder: () => Promise<string | null>;
  pickWorkingFolder: () => void;
  /** Opens a Manage target (navigation.ts on the live renderer). */
  openTarget: (t: ManageTarget) => void;
  /** Opens Connections, where + Add takes a server of your own. */
  addConnector: () => void;
  toast: (msg: string) => void;
  /** Place an opened drop-up (openChipDropUp on the live renderer). */
  place: (menu: HTMLElement) => void;
  /** The Loop section: the session's loop and route, and the panes that pick
   *  them (the composer owns the loops). Absent = no Loop section. */
  loop?: {
    state: () => { name: string; route: string | null } | null;
    fillLoops: (pane: HTMLElement, done: () => void) => void | Promise<void>;
    fillRoutes: (pane: HTMLElement, done: () => void) => void;
  };
}

export interface PlusController {
  menu: HTMLElement;
  open: () => void;
  close: () => void;
  toggle: () => void;
  /** ⌘U — the attach door, when the host has it. */
  attachFiles: () => void;
}

const appendMarkup = (host: HTMLElement, svg: string): void => { host.insertAdjacentHTML("beforeend", svg); };

/** One row: icon · words · (shortcut | caret | check). */
function rowEl(opts: { label: string; icon: string; kind: PlusRowKind; checked?: boolean; shortcut?: string; hint?: string; sub?: string; muted?: boolean }): HTMLButtonElement {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "code-drop-item code-plus-item" + (opts.checked ? " selected" : "") + (opts.muted ? " muted" : "");
  b.setAttribute("role", opts.kind === "check" ? "menuitemcheckbox" : "menuitem");
  if (opts.kind === "check") b.setAttribute("aria-checked", opts.checked ? "true" : "false");
  if (opts.kind === "submenu") b.setAttribute("aria-haspopup", "menu");
  if (opts.hint) b.title = opts.hint;
  const icon = document.createElement("span");
  icon.className = "drop-icon";
  icon.innerHTML = opts.icon;
  const lines = document.createElement("span");
  lines.className = "drop-lines";
  const main = document.createElement("span");
  main.className = "drop-main";
  main.textContent = opts.label;
  lines.appendChild(main);
  if (opts.sub) {
    const sub = document.createElement("span");
    sub.className = "drop-sub";
    sub.textContent = opts.sub;
    lines.appendChild(sub);
  }
  b.append(icon, lines);
  if (opts.shortcut) {
    const k = document.createElement("span");
    k.className = "drop-key";
    k.textContent = opts.shortcut;
    b.appendChild(k);
  }
  if (opts.kind === "submenu") appendMarkup(b, PLUS_CARET);
  if (opts.kind === "check") {
    const slot = document.createElement("span");
    slot.className = "drop-check-slot";
    if (opts.checked) slot.innerHTML = PLUS_CHECK;
    b.appendChild(slot);
  }
  return b;
}

function sepEl(): HTMLElement {
  const s = document.createElement("div");
  s.className = "code-drop-sep";
  return s;
}

/** Keyboard on the open menu: arrows move, Enter picks, Esc closes (a
 *  sub-pane's Esc steps back first). */
function menuKeys(menu: HTMLElement, e: KeyboardEvent, back: () => boolean, close: () => void): void {
  const pane = menu.querySelector<HTMLElement>(".drop-pane:not(.hidden)") ?? menu;
  const rows = Array.from(pane.querySelectorAll<HTMLButtonElement>(".code-drop-item"));
  const at = rows.findIndex((r) => r === document.activeElement);
  if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); if (!back()) close(); }
  else if (e.key === "ArrowDown" && rows.length) { e.preventDefault(); rows[(at + 1 + rows.length) % rows.length].focus(); }
  else if (e.key === "ArrowUp" && rows.length) { e.preventDefault(); rows[(at - 1 + rows.length) % rows.length].focus(); }
  else if (e.key === "ArrowLeft") { if (back()) e.preventDefault(); }
  else if (e.key === "ArrowRight" && at >= 0 && rows[at].getAttribute("aria-haspopup") === "menu") { e.preventDefault(); rows[at].click(); }
  else if (e.key === "Enter" && at >= 0) { e.preventDefault(); rows[at].click(); }
}

/** Build the `+` menu into `wrap` (the chip's `.code-chipwrap`) and wire the
 *  chip. The menu keeps the id `code-plus-menu` the composer's outside-click
 *  closer already knows. */
export function mountComposerPlus(wrap: HTMLElement, chip: HTMLButtonElement | null, doors: PlusDoors): PlusController {
  const menu = document.createElement("div");
  menu.id = "code-plus-menu";
  menu.className = "code-drop-up code-plus-menu hidden";
  menu.setAttribute("role", "menu");
  wrap.appendChild(menu);
  const caps = plusCapsOf(doors.has);
  let memory: MemoryState = { accepted: false, on: false };

  const close = (): void => { menu.classList.add("hidden"); chip?.focus(); };
  const focusFirst = (pane: HTMLElement): void => { pane.querySelector<HTMLButtonElement>(".code-drop-item")?.focus(); };

  /** The root pane — rebuilt on every open (the memory state is read then). */
  const paintRoot = (): HTMLElement => {
    menu.textContent = "";
    const pane = document.createElement("div");
    pane.className = "drop-pane plus-root";
    menu.appendChild(pane);
    const st: PlusState = { surface: doors.surface, space: doors.space(), memoryOn: memory.on, workingFolder: null, loop: doors.loop?.state() ?? null };
    const rows = plusMenuRows(caps, st);
    for (const r of rows) {
      if (r.sepBefore) pane.appendChild(sepEl());
      if (r.sectionBefore) {
        const head = document.createElement("div");
        head.className = "code-drop-head plus-section";
        head.textContent = r.sectionBefore;
        pane.appendChild(head);
      }
      const b = rowEl({ label: r.label, icon: r.icon, kind: r.kind, checked: r.checked, shortcut: r.shortcut, hint: r.hint });
      b.dataset.plusRow = r.id;
      if (r.codeOnly) b.classList.add("plus-folder-only");
      b.addEventListener("click", (e) => {
        e.stopPropagation();
        switch (r.id) {
          case "attach": close(); doors.attachFiles(); break;
          case "add-folder": close(); doors.attachFolder(); break;
          case "working-folder": case "choose-folder": close(); doors.pickWorkingFolder(); break;
          case "skills": void openSkills(); break;
          case "connectors": void openConnectors(); break;
          case "loop": void openLoops(); break;
          case "route": openRoutes(); break;
          case "memory": {
            const verdict = toggleMemory(doors.api, memory);
            if (verdict === "needs-policy") { close(); doors.openTarget(manageTargetOf(doors.surface, "memory")); doors.toast("Accept the memory policy first — Settings › Memory."); break; }
            memory = { ...memory, on: verdict === "on" };
            doors.toast(verdict === "on" ? "Memory on" : "Memory off");
            // Repaint, and keep the keyboard on the row (the old button is gone).
            paintRoot().querySelector<HTMLButtonElement>('[data-plus-row="memory"]')?.focus();
            break;
          }
        }
      });
      pane.appendChild(b);
    }
    // The working-folder row names the folder once the read lands (desktop).
    const wf = pane.querySelector<HTMLButtonElement>('[data-plus-row="working-folder"]');
    if (wf) void doors.workingFolder().then((dir) => {
      const name = dir ? String(dir).split("/").filter(Boolean).pop() : null;
      const main = wf.querySelector<HTMLElement>(".drop-main");
      if (main) main.textContent = name ? `Working folder: ${name}` : "Working folder: not set";
      wf.title = dir ? String(dir) : "No folder picked yet — click to choose";
    });
    return pane;
  };

  /** A sub-pane replaces the list behind a back row (the drop-up's own
   *  detail pattern — nothing flies out past the panel's edge). */
  const subPane = (title: string): HTMLElement => {
    menu.querySelector(".plus-root")?.classList.add("hidden");
    menu.querySelector(".plus-sub")?.remove();
    const pane = document.createElement("div");
    pane.className = "drop-pane plus-sub";
    pane.dataset.plusSub = title.toLowerCase();
    const back = document.createElement("button");
    back.type = "button";
    back.className = "code-drop-item code-plus-item plus-back";
    const bi = document.createElement("span");
    bi.className = "drop-icon";
    bi.innerHTML = PLUS_ICONS.back;
    const bl = document.createElement("span");
    bl.className = "drop-main";
    bl.textContent = title;
    back.append(bi, bl);
    back.addEventListener("click", (e) => { e.stopPropagation(); goBack(); });
    pane.append(back, sepEl());
    menu.appendChild(pane);
    return pane;
  };
  const goBack = (): boolean => {
    const sub = menu.querySelector<HTMLElement>(".plus-sub");
    if (!sub) return false;
    sub.remove();
    const root = menu.querySelector<HTMLElement>(".plus-root");
    root?.classList.remove("hidden");
    if (root) focusFirst(root);
    return true;
  };
  const loadingRow = (pane: HTMLElement, text: string): HTMLElement => {
    const d = document.createElement("div");
    d.className = "code-drop-head plus-loading";
    d.textContent = text;
    pane.appendChild(d);
    return d;
  };
  const emptyRow = (pane: HTMLElement, text: string): void => {
    const d = document.createElement("div");
    d.className = "code-drop-head plus-empty";
    d.textContent = text;
    pane.appendChild(d);
  };

  const openLoops = async (): Promise<void> => {
    const pane = subPane("Loop");
    await doors.loop?.fillLoops(pane, close);
    if (!pane.isConnected) return;
    doors.place(menu);
    focusFirst(pane);
  };
  const openRoutes = (): void => {
    const pane = subPane("Route");
    doors.loop?.fillRoutes(pane, close);
    doors.place(menu);
    focusFirst(pane);
  };

  const openSkills = async (): Promise<void> => {
    const pane = subPane("Skills");
    const loading = loadingRow(pane, "Loading your skills…");
    const skills = await readSkillRows(doors.api);
    loading.remove();
    if (!pane.isConnected) return;
    if (!skills.length) emptyRow(pane, "No skills yet.");
    for (const s of skills) {
      const b = rowEl({ label: s.name, icon: PLUS_ICONS.skills, kind: "check", checked: s.enabled, hint: s.enabled ? "On — click to turn off" : "Off — click to turn on" });
      b.dataset.skillId = s.id;
      b.addEventListener("click", async (e) => {
        e.stopPropagation();
        const on = b.getAttribute("aria-checked") !== "true";
        const r = await toggleSkill(doors.api, s.id, on);
        if (!r.ok) { doors.toast(r.error || "Couldn't change that."); return; }
        b.setAttribute("aria-checked", on ? "true" : "false");
        b.classList.toggle("selected", on);
        const slot = b.querySelector<HTMLElement>(".drop-check-slot");
        if (slot) slot.innerHTML = on ? PLUS_CHECK : "";
        b.title = on ? "On — click to turn off" : "Off — click to turn on";
      });
      pane.appendChild(b);
    }
    pane.appendChild(sepEl());
    const manage = rowEl({ label: MANAGE_SKILLS_LABEL, icon: PLUS_ICONS.gear, kind: "action" });
    manage.addEventListener("click", (e) => { e.stopPropagation(); close(); doors.openTarget(manageTargetOf(doors.surface, "skills")); });
    pane.appendChild(manage);
    doors.place(menu);
    focusFirst(pane);
  };

  const openConnectors = async (): Promise<void> => {
    const pane = subPane("Connectors");
    const loading = loadingRow(pane, "Loading your connections…");
    const rows = await readConnectorRows(doors.api);
    loading.remove();
    if (!pane.isConnected) return;
    if (!rows.length) emptyRow(pane, "Nothing connected yet.");
    for (const r of rows) {
      const b = rowEl({
        label: r.name, icon: r.icon, kind: "check", checked: r.on, sub: r.kind === "pd" ? "Pipedream" : "MCP server",
        hint: r.on ? "On — click to turn off" : "Off — click to turn on",
      });
      b.dataset.connKey = r.key;
      b.addEventListener("click", async (e) => {
        e.stopPropagation();
        const on = b.getAttribute("aria-checked") !== "true";
        const res = await toggleConnector(doors.api, r, on);
        if (!res.ok) { doors.toast(res.error || "Couldn't change that."); return; }
        b.setAttribute("aria-checked", on ? "true" : "false");
        b.classList.toggle("selected", on);
        const slot = b.querySelector<HTMLElement>(".drop-check-slot");
        if (slot) slot.innerHTML = on ? PLUS_CHECK : "";
      });
      pane.appendChild(b);
    }
    pane.appendChild(sepEl());
    const add = rowEl({ label: ADD_CONNECTOR_LABEL, icon: PLUS_ICONS.plus, kind: "action" });
    add.addEventListener("click", (e) => { e.stopPropagation(); close(); doors.addConnector(); });
    const manage = rowEl({ label: MANAGE_CONNECTORS_LABEL, icon: PLUS_ICONS.gear, kind: "action" });
    manage.addEventListener("click", (e) => { e.stopPropagation(); close(); doors.openTarget(manageTargetOf(doors.surface, "connectors")); });
    pane.append(add, manage);
    doors.place(menu);
    focusFirst(pane);
  };

  const open = (): void => {
    if (!menu.classList.contains("hidden")) return;
    paintRoot();
    menu.classList.remove("hidden");
    doors.place(menu);
    // The memory read lands a beat later; the row repaints with it.
    if (caps.memory) void readMemoryState(doors.api).then((m) => {
      memory = m;
      if (menu.classList.contains("hidden") || menu.querySelector(".plus-sub")) return;
      const row = menu.querySelector<HTMLButtonElement>('[data-plus-row="memory"]');
      if (!row) return;
      row.setAttribute("aria-checked", m.on ? "true" : "false");
      row.classList.toggle("selected", m.on);
      row.title = m.on ? "Glyphh remembers this session" : "Off — nothing is remembered";
      const slot = row.querySelector<HTMLElement>(".drop-check-slot");
      if (slot) slot.innerHTML = m.on ? PLUS_CHECK : "";
    });
    focusFirst(menu);
  };
  const toggle = (): void => { if (menu.classList.contains("hidden")) open(); else close(); };

  menu.addEventListener("keydown", (e) => menuKeys(menu, e, goBack, close));
  // Esc closes the open menu from anywhere (the keys may sit on the composer).
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape" || menu.classList.contains("hidden") || menu.contains(e.target as Node)) return;
    e.stopPropagation();
    if (!goBack()) close();
  }, true);
  chip?.addEventListener("click", (e) => { e.stopPropagation(); toggle(); });
  chip?.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown" && menu.classList.contains("hidden")) { e.preventDefault(); open(); }
  });
  if (chip) chip.setAttribute("aria-haspopup", "menu");

  return { menu, open, close, toggle, attachFiles: () => { if (caps.attach) doors.attachFiles(); } };
}
