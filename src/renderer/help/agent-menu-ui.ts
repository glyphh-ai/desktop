/**
 * agent-menu-ui.ts — THE AGENT WINDOW'S ONE ⋮ MENU, painted: the composer's
 * top-right ⋮ (#code-tools-menu), on the web AND the desktop (his order,
 * 2026-10-05: one menu, never an empty dropdown; 2026-10-06: the same menu
 * on both surfaces — help/agent-menu.ts is the model, this file paints it).
 *
 * THE READS (readSurface): attach.status (is a desktop attached), the
 * attached desktop's app rows (`panelApps.list` over the relay), the member's
 * installed apps (panelAppsList — the cloud instances, the one list), the CLI
 * agents, the desktop's CLI sessions and the member's workspaces
 * (layoutsList). Each door is probed with hostHas: a surface without one
 * reads an empty.
 *
 * THE DOORS: a house row opens its own work panel (__wbOpenTool); every
 * other installed app opens as a panel on THIS surface (__wbOpenApp) —
 * nothing opens on a desktop from the web (his order, 2026-10-06). A CLI row opens on the
 * session's folder through the workbench's door (__wbOpenAgentCli — the
 * attached desktop over remote control, or the cloud worker's pty); a
 * desktop CLI session under it resumes on the desktop (the rail's own open).
 * A workspace row opens through __wbOpenLayoutByName (surface.ts filters the
 * cells the surface cannot host).
 *
 * THE FOLDS: Apps, Agents / CLIs and Workspaces are expandable heads,
 * collapsed on every open; a CLI's desktop sessions nest under its row
 * behind its own chevron.
 */
import { hostHas, onWeb } from "./web-surface.js";
import { toolViewIcon } from "./tool-icons.js";
import { toast } from "./toast.js";
import {
  agentMenuModel, appRowOpen, menuFoldState, isExpanded, toggleFold, sectionHeadLabel,
  type AgentMenu, type FoldState, type MenuAppRow, type MenuMachine, type MenuSession, type MenuWorkspaceRow, type SessionAction, menuLocusOf } from "./agent-menu.js";

interface MenuApi {
  attachStatus?: () => Promise<{ attached: boolean; machines: MenuMachine[] }>;
  layoutsList?: () => Promise<Array<{ name?: string }>>;
}
type RailSessionLike = { id: string; cli: string; title: string; cwd: string; mtime: number; origin?: "cli"; locked?: boolean };
export interface AgentMenuDoors {
  /** The session on screen (null on a fresh landing). */
  session: () => MenuSession | null;
  /** The old kebab's actions. */
  onSession: (action: SessionAction) => void;
}
interface ShellDoors {
  __wbOpenTool?: (view: string) => void;
  __wbOpenLayoutByName?: (name: string) => Promise<boolean>;
  __glyphhOpenSettings?: (sub?: string) => void;
}

const api = (): MenuApi => ((window as unknown as { glyphh?: unknown }).glyphh ?? {}) as MenuApi;
const shell = (): ShellDoors => window as unknown as ShellDoors;

const IC = {
  files: `<svg viewBox="0 0 24 24"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z"/></svg>`,
  terminal: `<svg viewBox="0 0 24 24"><polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/></svg>`,
  monaco: `<svg viewBox="0 0 24 24"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>`,
  preview: `<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>`,
  diff: `<svg viewBox="0 0 24 24"><line x1="12" y1="3" x2="12" y2="21"/><polyline points="8 7 4 11 8 15"/><polyline points="16 9 20 13 16 17"/></svg>`,
  plan: `<svg viewBox="0 0 24 24"><path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/></svg>`,
  agents: `<svg viewBox="0 0 24 24"><circle cx="12" cy="5" r="2.2"/><circle cx="5" cy="18" r="2.2"/><circle cx="19" cy="18" r="2.2"/><path d="M12 7.2v3.3M12 10.5 6.4 16.1M12 10.5l5.6 5.6"/></svg>`,
  artifacts: `<svg viewBox="0 0 24 24"><path d="M12 3l8 4.5v9L12 21l-8-4.5v-9z"/><path d="M12 12l8-4.5M12 12v9M12 12L4 7.5"/></svg>`,
  cli: `<svg viewBox="0 0 24 24"><polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/></svg>`,
  layout: `<svg viewBox="0 0 24 24"><rect x="3" y="3" width="18" height="18" rx="2"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="12" y1="12" x2="12" y2="21"/></svg>`,
  app: `<svg viewBox="0 0 24 24"><rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/></svg>`,
  session: `<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>`,
  rename: `<svg viewBox="0 0 24 24"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>`,
  pin: `<svg viewBox="0 0 24 24"><path d="M12 17v5"/><path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z"/></svg>`,
  "new-panel": `<svg viewBox="0 0 24 24"><rect x="3" y="3" width="18" height="18" rx="3"/><path d="M12 8v8M8 12h8"/></svg>`,
  delete: `<svg viewBox="0 0 24 24"><path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>`,
};
/** The fold chevron (▸ collapsed, rotated to ▾ by the CSS when expanded). */
const CHEV = `<svg class="wam-chev" viewBox="0 0 24 24"><polyline points="9 6 15 12 9 18"/></svg>`;

/** The last read (machines, apps, CLIs, sessions, workspaces) — painted at once on the next open. */
type SurfaceRead = { machines: MenuMachine[]; installed: MenuAppRow[]; sessions: RailSessionLike[]; workspaces: MenuWorkspaceRow[] };
let lastRead: SurfaceRead | null = null;

/** THE INSTALLED APPS (his order, 2026-10-05): panelAppsList — the server's
 *  tab rows and every instance, the one list — mapped to menu rows. Every
 *  row is the cloud's and opens as a panel on this surface. */
interface InstalledAppLike { slug?: string; id?: string; name?: string; kind?: string; appArchetype?: string; iconDataUrl?: string | null; icon?: string | null; launchConfig?: { tool?: string; instance?: string } | null; config?: { tool?: string; instance?: string } | null; machineId?: string; machineName?: string }
export function installedRowsOf(rows: ReadonlyArray<InstalledAppLike>, desktopSlugs: ReadonlySet<string>, machine: MenuMachine | null): MenuAppRow[] {
  const out: MenuAppRow[] = [];
  for (const r of rows) {
    const slug = String(r.slug || r.id || "").trim();
    if (!slug) continue;
    const kind = r.kind ?? (r.appArchetype === "glyphh-app" ? "glyphh" : "web");
    const onDesktop = desktopSlugs.has(slug.toLowerCase());
    // A cloud instance's row names its instance (`instance`, shared/app-instances.ts INSTANCE_CONFIG_KEY).
    const cloud = !!(r.launchConfig?.instance ?? r.config?.instance) || !onDesktop;
    out.push({
      slug, name: String(r.name || slug), kind,
      icon: r.iconDataUrl ?? r.icon ?? null,
      tool: r.launchConfig?.tool ?? r.config?.tool ?? null,
      machineId: cloud ? "" : (r.machineId ?? machine?.id ?? ""),
      machineName: cloud ? "the cloud" : (r.machineName ?? machine?.name ?? ""),
      cloud,
    });
  }
  return out;
}

/** The reads, in parallel, on both surfaces; a door the host lacks reads an empty. */
async function readSurface(): Promise<SurfaceRead> {
  const a = api();
  const [status, installed, layouts] = await Promise.all([
    hostHas("attachStatus") ? a.attachStatus!().catch(() => null) : Promise.resolve(null),
    hostHas("panelAppsList") ? (a as unknown as { panelAppsList?: () => Promise<InstalledAppLike[]> }).panelAppsList!().catch(() => null) : Promise.resolve(null),
    // THE WORKSPACES (his order, 2026-10-05): the member library's rows, by name.
    hostHas("layoutsList") ? a.layoutsList!().catch(() => null) : Promise.resolve(null),
  ]);
  const sessions: RailSessionLike[] = [];
  const machines = status?.machines ?? [];
  const workspaces = (Array.isArray(layouts) ? layouts : []).map((l) => ({ name: String(l?.name ?? "") }));
  return { machines, installed: installedRowsOf(Array.isArray(installed) ? installed : [], new Set(), machines[0] ?? null), sessions, workspaces };
}

function modelFor(doors: AgentMenuDoors, web: SurfaceRead | null): AgentMenu {
  const src = (shell() as unknown as { __glyphhActiveSource?: () => { kind?: unknown } | null }).__glyphhActiveSource?.() ?? null;
  return agentMenuModel({
    surface: onWeb() ? "web" : "desktop",
    session: doors.session(),
    machines: web?.machines ?? [],
    installed: web?.installed ?? [],
    locus: menuLocusOf(src),
    workspaces: web?.workspaces ?? [],
  });
}

const row = (icon: string, label: string, cls = ""): HTMLButtonElement => {
  const b = document.createElement("button");
  b.type = "button";
  b.className = `code-view-menu-item${cls ? ` ${cls}` : ""}`;
  // The label is the NAMED span: a house mark is a span too (appIcon), and
  // the first span in the row used to take the name — six apps read as
  // "udi", "esig", "riv" inside their 16px icon boxes (his report, 2026-10-05).
  b.innerHTML = `${icon}<span class="wam-text"></span>`;
  (b.querySelector(".wam-text") as HTMLElement).textContent = label;
  return b;
};
const head = (label: string): HTMLDivElement => {
  const h = document.createElement("div");
  h.className = "code-menu-head";
  h.textContent = label;
  return h;
};
/** An EXPANDABLE head: a menu row (the same class as every other row) with
 *  the chevron, the label and the count; aria-expanded carries the state. */
const foldHead = (key: string, label: string, count: number, open: boolean): HTMLButtonElement => {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "code-view-menu-item code-menu-fold";
  b.dataset.fold = key;
  b.setAttribute("aria-expanded", open ? "true" : "false");
  b.innerHTML = `${CHEV}<span></span>`;
  (b.querySelector("span") as HTMLElement).textContent = sectionHeadLabel(label, count);
  return b;
};
const sep = (): HTMLDivElement => { const d = document.createElement("div"); d.className = "code-menu-sep"; return d; };

function appIcon(a: MenuAppRow): string {
  if (a.icon) {
    const img = document.createElement("img");
    img.className = "wam-icon";
    img.alt = "";
    img.src = a.icon;
    return img.outerHTML;
  }
  // A HOUSE APP WEARS ITS OWN MARK (his order, 2026-10-05: "apps should
  // carry the icon from the apps into this dropdown") — the same coloured
  // mark the Skills page paints for its tool (layouts.ts toolViewIcon).
  if (a.tool) {
    const mark = toolViewIcon(a.tool);
    if (mark) return `<span class="wam-icon wam-mark">${mark}</span>`;
  }
  return IC.app;
}

/** The one line under a section's rows, with its Settings link when it has one. */
function noteLine(text: string, link: { label: string; settingsSub: string } | null, close: () => void): HTMLDivElement {
  const note = document.createElement("div");
  note.className = "code-menu-note disabled";
  note.textContent = text;
  if (link) {
    note.append(" · ");
    const b = document.createElement("button");
    b.type = "button";
    b.className = "code-menu-link";
    b.textContent = link.label;
    const sub = link.settingsSub;
    b.addEventListener("click", (ev) => { ev.stopPropagation(); close(); shell().__glyphhOpenSettings?.(sub); });
    note.appendChild(b);
  }
  return note;
}

/** Paint the model: one block per section, separators between. The fold
 *  state is the menu's own for this open; a toggle repaints in place. */
function paint(menu: HTMLElement, m: AgentMenu, doors: AgentMenuDoors, sessions: RailSessionLike[], folds: FoldState): void {
  menu.textContent = "";
  const close = (): void => menu.classList.add("hidden");
  const repaint = (focusKey: string): void => {
    paint(menu, m, doors, sessions, folds);
    menu.querySelector<HTMLElement>(`[data-fold="${focusKey}"]`)?.focus();
  };
  /** A fold head: click / Enter / Space toggle (a button's own click), the
   *  rows under it wear `wam-folded` while collapsed. */
  const fold = (key: string, label: string, count: number): boolean => {
    const open = isExpanded(folds, key);
    const h = foldHead(key, label, count, open);
    h.addEventListener("click", (ev) => { ev.stopPropagation(); toggleFold(folds, key); repaint(key); });
    menu.appendChild(h);
    return open;
  };
  const under = (b: HTMLElement, open: boolean): HTMLElement => { if (!open) b.classList.add("wam-folded"); return b; };
  m.sections.forEach((s, idx) => {
    if (idx) menu.appendChild(sep());
    if (s.kind === "apps") {
      const open = fold(s.kind, s.label, s.count);
      for (const a of s.rows) {
        const b = under(row(appIcon(a), a.name, "wam-app wam-sub"), open);
        const where = appRowOpen(a, m.surface);
        b.title = where.open === "house-panel" ? `Open ${a.name}` : `Open ${a.name} — installed in the cloud`;
        b.addEventListener("click", () => {
          close();
          if (where.open === "house-panel") { shell().__wbOpenTool?.(where.view); return; }
          (shell() as unknown as { __wbOpenApp?: (x: { slug: string; name: string; url: string; glyphh?: boolean; cloud?: boolean }) => void }).__wbOpenApp?.({ slug: a.slug, name: a.name, url: "", glyphh: true, cloud: true });
        });
        menu.appendChild(b);
      }
      if (s.note) menu.appendChild(under(noteLine(s.note, s.link, close), open));
    } else if (s.kind === "workspaces") {
      // THE WORKSPACES FOLD (his order, 2026-10-05): one row per workspace;
      // a click closes the menu and opens it through the workbench's door
      // (surface.ts surfaceLayoutCells filters what this surface cannot host).
      const open = fold(s.kind, s.label, s.count);
      // CREATE WORKSPACE (his order, 2026-10-08) — always visible under the
      // head, folded or not: saves what is on screen (the shell's modal).
      const create = row(IC.layout, "Create workspace…", "wam-workspace-create wam-sub");
      create.addEventListener("click", () => {
        close();
        (window as unknown as { __glyphhCreateWorkspace?: () => void }).__glyphhCreateWorkspace?.();
      });
      menu.appendChild(create);
      for (const ws of s.rows) {
        const b = under(row(IC.layout, ws.name, "wam-workspace wam-sub"), open);
        b.dataset.workspace = ws.name;
        b.title = `Open ${ws.name}`;
        b.addEventListener("click", () => {
          close();
          const door = shell().__wbOpenLayoutByName;
          if (!door) { console.warn("[agent-menu] no workspace door — the workbench has not booted"); return; }
          void door(ws.name).then((ok) => { if (!ok) toast(`${ws.name} is not in your workspaces`, { kind: "error" }); });
        });
        menu.appendChild(b);
      }
    } else if (s.kind === "tools") {
      menu.appendChild(head(s.label));
      for (const t of s.rows) {
        const b = row(IC[t.view as keyof typeof IC] ?? IC.app, t.label);
        b.dataset.view = t.view;
        b.addEventListener("click", () => { close(); shell().__wbOpenTool?.(t.view); });
        menu.appendChild(b);
      }
    } else {
      menu.appendChild(head(s.label));
      for (const r of s.rows) {
        const b = row(IC[r.action] ?? IC.session, r.label, `wam-session${r.danger ? " danger" : ""}`);
        b.dataset.action = r.action;
        b.addEventListener("click", () => { close(); doors.onSession(r.action); });
        menu.appendChild(b);
      }
    }
  });
}

let seq = 0;
/** Wire the ⋮: a click toggles the menu, painted from what is known at
 *  once; the fresh read repaints it as soon as it lands. */
export function mountAgentMenu(menu: HTMLElement, moreBtn: HTMLElement, doors: AgentMenuDoors): void {
  const web = onWeb();
  menu.classList.add("agent-menu-folds");   // the sizing of a menu with folds (styles.css)
  // THE FOLDS: fresh on every open — collapsed (his order, 2026-10-05).
  let folds: FoldState = menuFoldState();
  const refresh = async (): Promise<void> => {
    const mine = ++seq;
    const read = await readSurface();
    if (mine !== seq) return;   // a later open repainted already
    lastRead = read;
    if (!menu.classList.contains("hidden")) paint(menu, modelFor(doors, read), doors, read.sessions, folds);
  };
  moreBtn.addEventListener("click", (ev) => {
    ev.stopPropagation();
    const opening = menu.classList.contains("hidden");
    menu.classList.toggle("hidden");
    if (!opening) return;
    folds = menuFoldState();
    paint(menu, modelFor(doors, lastRead), doors, lastRead?.sessions ?? [], folds);
    void refresh();
  });
  // KEYBOARD: ↑ ↓ move between the visible rows; on a fold head → expands,
  // ← collapses (Enter / Space are the button's own click); Esc closes.
  menu.addEventListener("keydown", (ev) => {
    const rows = Array.from(menu.querySelectorAll<HTMLElement>(".code-view-menu-item:not(.wam-folded), .wam-fold-btn"))
      .filter((el) => !el.closest(".wam-folded"));
    const cur = document.activeElement as HTMLElement | null;
    const at = cur ? rows.indexOf(cur) : -1;
    if (ev.key === "ArrowDown" || ev.key === "ArrowUp") {
      ev.preventDefault();
      if (!rows.length) return;
      const next = ev.key === "ArrowDown" ? (at + 1) % rows.length : (at - 1 + rows.length) % rows.length;
      rows[next]!.focus();
      return;
    }
    const key = cur?.dataset.fold;
    if (key && (ev.key === "ArrowRight" || ev.key === "ArrowLeft")) {
      ev.preventDefault();
      const open = isExpanded(folds, key);
      if ((ev.key === "ArrowRight") !== open) { toggleFold(folds, key); paint(menu, modelFor(doors, lastRead), doors, lastRead?.sessions ?? [], folds); menu.querySelector<HTMLElement>(`[data-fold="${key}"]`)?.focus(); }
      return;
    }
    if (ev.key === "Escape") { menu.classList.add("hidden"); moreBtn.focus(); }
  });
}
