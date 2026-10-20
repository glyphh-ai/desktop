/**
 * workspace-create.ts — THE WORKSPACE MODAL (his order, 2026-10-08:
 * "a + to the far right next to workspaces then open a modal with name, and
 * the desired agent state… model, session re: start new, continue aka what we had before, and
 * directory. and of course name.").
 *
 * THE GRID LAYOUT EDITOR (his order, 2026-10-20: "in the modal I want the
 * grid layout editor so a user can adjust the layout on new or edit it from
 * the left rail by right click and edit of a layout card"): the old
 * Settings → Workspaces builder, ported — columns × rows, merge right /
 * merge down / split, a picker per cell (agents, work panels, apps), the
 * sticky app panel, drag a panel onto another cell to swap or insert. The
 * form sits left, the grid right. The grid's rules are pure
 * (workspace-grid.ts); this module draws it and asks the questions.
 *
 * Create: the grid starts as whatever is on screen (or the agent beside an
 * empty cell when the workbench has not loaded); the workbench saves it
 * (code-workbench.ts __wbSaveWorkspace) — in place, nothing reloading, when
 * the shape is the screen's; otherwise saved and opened through the one
 * open path. Edit (a workspace tile's menu): the saved grid loads into the
 * editor; the save writes the arrangement and the answers (layouts-save-grid),
 * and an edit to the OPEN workspace that shows on screen re-opens it
 * (__wbRefreshWorkspace).
 *
 * Both ask how the workspace's agent starts: on which loop, in which face
 * (the chat or the loop's terminal) and on which route for a CLI (its own
 * login, or the user's providers) — and the same per agent cell, each cell
 * inheriting the workspace unless it says otherwise. A cell's answers live
 * in its config, so they follow it through merges, splits and drags (an
 * agent cell merged away drops its answers). The Browser and Terminal cells
 * keep their old setup too: the page, the first command, maintain on close.
 * It runs in the SHELL document; an agent panel asks the shell through main
 * (agent-panel-create-workspace).
 */

import { guardWebviewsForModal } from "./shared.js";
import { toastOk } from "./toast.js";
import {
  INHERIT, agentStartOf, editShowsOnScreen, editedWorkspaceGrid, workspaceFormError, withAgentStart,
  type AgentStart, type CellRow, type WorkspaceRow,
} from "./workspace-form.js";
import {
  MAX_GRID, agentCellIndices, applyDrop, assignPanel, canMergeDown, canMergeRight, canSplit, cellBlocked,
  cellLabel, cellPickerApps, cellPickerTools, dropModeAt, emptyGrid, gridCells, gridError, gridFromCells,
  heldHouseViews, mergeDown, mergeRight, resizeGrid, resolveAppRow, setCellConfig, setSticky, splitCell,
  type Grid, type PickerAppRow,
} from "./workspace-grid.js";
import { HOUSE_TOOL_VIEWS, HOUSE_VIEW_OF_APP } from "./house-relay.js";
import { LOOP_IDS, LOOP_NAMES, settle } from "./cli-loops.js";
import type { CliAgentRow } from "./cli-types.js";

type SessionChoice = "keep" | "new" | "last";
type GridPayload = { cols: number; rows: number; cells: CellRow[] };
type SaveWorkspace = (o: { name: string; model?: string; session: SessionChoice; folder?: string; loop?: string | null; view?: "glyphh" | "cli" | null; gateway?: "on" | "off" | null; grid?: GridPayload }) => Promise<{ ok: boolean; error?: string }>;
interface Api {
  loopModels?: (loopId: string, force?: boolean) => Promise<{ ok: boolean; models: Array<{ id: string; name: string; utility?: boolean }> }>;
  layoutsPickFolder?: () => Promise<string | null>;
  layoutsList?: () => Promise<Array<{ name: string }>>;
  layoutsSaveGrid?: (grid: unknown) => Promise<boolean | { error: string }>;
  cliAgentsList?: () => Promise<{ ok: boolean; agents: CliAgentRow[]; gatewayReady?: boolean }>;
  panelAppsList?: () => Promise<PickerAppRow[]>;
}
type WbWindow = {
  __wbSaveWorkspace?: SaveWorkspace;
  __wbCurrentArrangement?: () => GridPayload | null;
  __wbRefreshWorkspace?: (name: string) => Promise<boolean>;
  __glyphhCurrentFolder?: () => string | null;
};

let openOverlay: HTMLElement | null = null;

const PIN_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="17" x2="12" y2="22"/><path d="M5 17h14l-1.7-6.8a2 2 0 0 0-1-1.3L15 8V4h-6v4l-1.3.9a2 2 0 0 0-1 1.3z"/></svg>`;
const GRIP_SVG = `<svg viewBox="0 0 24 24" fill="currentColor"><circle cx="8" cy="10" r="1.4"/><circle cx="12" cy="10" r="1.4"/><circle cx="16" cy="10" r="1.4"/><circle cx="8" cy="14" r="1.4"/><circle cx="12" cy="14" r="1.4"/><circle cx="16" cy="14" r="1.4"/></svg>`;

const esc = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** The three agent selects, filled: the loops the member has on (and any
 *  loop the stored answer names, so an edit never silently drops it). */
function agentSelectsHtml(cls: string, inheritLabel: string): string {
  return `
    <label class="wsc-row"><span class="wsc-label">Loop</span>
      <select class="settings-input ${cls}-loop"><option value="">${inheritLabel}</option></select></label>
    <label class="wsc-row"><span class="wsc-label">Opens as</span>
      <select class="settings-input ${cls}-view">
        <option value="">${inheritLabel}</option>
        <option value="glyphh">Chat</option>
        <option value="cli">Terminal</option>
      </select></label>
    <label class="wsc-row"><span class="wsc-label">CLI route</span>
      <select class="settings-input ${cls}-gateway">
        <option value="">${inheritLabel}</option>
        <option value="off">Direct — the CLI's own login</option>
        <option value="on">Gateway — my providers</option>
      </select></label>`;
}

function fillLoops(sel: HTMLSelectElement, loops: ReadonlyArray<{ id: string; name: string }>, keep: string): void {
  const ids = new Set(loops.map((l) => l.id));
  for (const l of loops) {
    const o = document.createElement("option");
    o.value = l.id;
    o.textContent = l.name;
    sel.appendChild(o);
  }
  if (keep && !ids.has(keep)) {
    const o = document.createElement("option");
    o.value = keep;
    o.textContent = `${LOOP_NAMES[keep as keyof typeof LOOP_NAMES] ?? keep} (turned off)`;
    sel.appendChild(o);
  }
}

function readAgent(scope: HTMLElement, cls: string): AgentStart {
  const v = (s: string): string => scope.querySelector<HTMLSelectElement>(`.${cls}-${s}`)?.value ?? "";
  const view = v("view");
  const gateway = v("gateway");
  return {
    loop: v("loop"),
    view: view === "glyphh" || view === "cli" ? view : "",
    gateway: gateway === "on" || gateway === "off" ? gateway : "",
  };
}

function setAgent(scope: HTMLElement, cls: string, a: AgentStart): void {
  const set = (s: string, val: string): void => { const el = scope.querySelector<HTMLSelectElement>(`.${cls}-${s}`); if (el) el.value = val; };
  set("loop", a.loop);
  set("view", a.view);
  set("gateway", a.gateway);
}

/** The app's ONE switch row (settings.html's grammar): title (and optional
 *  description) left, the pill switch hard right. The span MUST stay the
 *  input's immediate next sibling (`input:checked + .toggle-switch`). */
function settingsToggle(title: string, desc: string | null, checked: boolean, onChange: (on: boolean) => void): HTMLLabelElement {
  const label = document.createElement("label");
  label.className = "settings-toggle";
  const text = document.createElement("div");
  text.className = "set-pref-text";
  const t = document.createElement("div");
  t.className = "set-pref-title";
  t.textContent = title;
  text.appendChild(t);
  if (desc) {
    const d = document.createElement("div");
    d.className = "set-pref-desc";
    d.textContent = desc;
    text.appendChild(d);
  }
  const cb = document.createElement("input");
  cb.type = "checkbox";
  cb.checked = checked;
  cb.addEventListener("change", () => onChange(cb.checked));
  const sw = document.createElement("span");
  sw.className = "toggle-switch";
  label.append(text, cb, sw);
  return label;
}

/** The Browser cell's page and the Terminal cell's first command (the old builder's CELL_CONFIG_SPECS). */
const CELL_SETUP: Record<string, { key: "url" | "cmd"; label: string; placeholder: string }> = {
  "tool:preview": { key: "url", label: "Browser URL", placeholder: "https://…" },
  "tool:terminal": { key: "cmd", label: "Terminal command", placeholder: "npm run dev" },
};

/** Create a workspace: the grid starts as what is on screen. */
export function openCreateWorkspaceModal(): Promise<void> { return openWorkspaceModal(null); }

/** Edit a saved workspace: its setup and its grid. */
export async function openEditWorkspaceModal(name: string): Promise<void> {
  const api = (window.glyphh ?? {}) as unknown as Api;
  const rows = ((await api.layoutsList?.().catch(() => [])) ?? []) as unknown as WorkspaceRow[];
  const row = rows.find((r) => r.name === name);
  if (!row) return;
  return openWorkspaceModal(row);
}

/** The grid a Create starts from: the arrangement on screen, else the agent beside an empty cell. */
function startingGrid(editing: WorkspaceRow | null): Grid {
  if (editing) return gridFromCells(editing.cols, editing.rows, editing.splits ?? []);
  let screen: GridPayload | null = null;
  try { screen = (window as unknown as WbWindow).__wbCurrentArrangement?.() ?? null; } catch { screen = null; }
  if (screen && screen.cells.length) {
    const g = gridFromCells(screen.cols, screen.rows, screen.cells);
    if (g.cells.some((c) => c.panelId)) return g;
  }
  const g = emptyGrid(2, 1);
  assignPanel(g, 0, "tool:coding");
  return g;
}

async function openWorkspaceModal(editing: WorkspaceRow | null): Promise<void> {
  if (openOverlay?.isConnected) { openOverlay.querySelector<HTMLInputElement>(".wsc-name")?.focus(); return; }
  const api = (window.glyphh ?? {}) as unknown as Api;
  const wbw = window as unknown as WbWindow;
  const save = wbw.__wbSaveWorkspace;
  const folderNow = editing ? editing.folder ?? "" : wbw.__glyphhCurrentFolder?.() || "";

  // ── The editor's state ──
  const grid = startingGrid(editing);
  let selected = -1;
  /** True for the tick after a drag's mouseup — that gesture must not double as a cell click. */
  let dragConsumedClick = false;
  let appRows: PickerAppRow[] = [];
  let loops: Array<{ id: string; name: string }> = [];
  let loopsKnown = false;
  const loopName = (id: string): string => loops.find((l) => l.id === id)?.name ?? LOOP_NAMES[id as keyof typeof LOOP_NAMES] ?? id;
  const labelOf = (panelId: string): string => cellLabel(panelId, appRows, loopName);

  const overlay = document.createElement("div");
  overlay.className = "confirm-overlay wsc-overlay";
  overlay.innerHTML = `
    <div class="confirm-box wsc-box wsc-box-grid" role="dialog" aria-modal="true" aria-labelledby="wsc-title">
      <div class="confirm-head"><h3 id="wsc-title"></h3></div>
      <div class="confirm-body wsc-split">
        <div class="wsc-body wsc-form">
          <label class="wsc-row"><span class="wsc-label">Name</span>
            <input class="settings-input wsc-name" type="text" spellcheck="false" autocomplete="off" placeholder="My workspace" /></label>
          <label class="wsc-row"><span class="wsc-label">Model</span>
            <select class="settings-input wsc-model"><option value="">Default model</option></select></label>
          <label class="wsc-row"><span class="wsc-label">Session</span>
            <select class="settings-input wsc-session">
              <option value="keep">Keep the current session</option>
              <option value="new">Start a new session</option>
              <option value="last">Resume this workspace&rsquo;s last session</option>
            </select></label>
          <div class="wsc-row"><span class="wsc-label">Directory</span>
            <div class="wsc-dir">
              <input class="settings-input wsc-folder" type="text" spellcheck="false" autocomplete="off" placeholder="No folder" />
              <button class="action-btn secondary wsc-browse" type="button">Browse…</button>
            </div></div>
          <div class="wsc-group wsc-agent">
            <div class="wsc-group-head">Agent</div>
            ${agentSelectsHtml("wsc-a", "My default")}
          </div>
          <div class="wsc-cells"></div>
          <div class="wsc-setup"></div>
          <div class="wsc-error hidden"></div>
        </div>
        <div class="wsc-layout">
          <div class="wsc-group-head">Layout</div>
          <div class="grid-builder wsc-grid">
            <div class="grid-dims">
              <label>Cols <select class="wsc-grid-cols"></select></label>
              <span class="dim-sep">&times;</span>
              <label>Rows <select class="wsc-grid-rows"></select></label>
              <button class="action-btn wsc-merge-right" type="button" disabled>&rarr; Merge</button>
              <button class="action-btn wsc-merge-down" type="button" disabled>&darr; Merge</button>
              <button class="action-btn wsc-split-btn" type="button" disabled>Split</button>
            </div>
            <div id="grid-preview" class="wsc-grid-preview"></div>
          </div>
          <div class="settings-hint wsc-grid-hint">Click a cell to choose what fills it; drag a panel onto another cell to swap them, or onto a cell&rsquo;s edge to move it there.</div>
        </div>
      </div>
      <div class="confirm-foot">
        <button class="action-btn secondary wsc-cancel" type="button">Cancel</button>
        <button class="action-btn primary wsc-create" type="button"></button>
      </div>
    </div>`;
  const q = <T extends HTMLElement>(sel: string): T => overlay.querySelector<T>(sel)!;
  q("#wsc-title").textContent = editing ? `Edit ${editing.name}` : "Create workspace";
  const nameIn = q<HTMLInputElement>(".wsc-name");
  const modelSel = q<HTMLSelectElement>(".wsc-model");
  const sessSel = q<HTMLSelectElement>(".wsc-session");
  const folderIn = q<HTMLInputElement>(".wsc-folder");
  const errEl = q<HTMLElement>(".wsc-error");
  const createBtn = q<HTMLButtonElement>(".wsc-create");
  const cellsHost = q<HTMLElement>(".wsc-cells");
  const setupHost = q<HTMLElement>(".wsc-setup");
  const preview = q<HTMLElement>(".wsc-grid-preview");
  const colsSel = q<HTMLSelectElement>(".wsc-grid-cols");
  const rowsSel = q<HTMLSelectElement>(".wsc-grid-rows");
  const mergeRightBtn = q<HTMLButtonElement>(".wsc-merge-right");
  const mergeDownBtn = q<HTMLButtonElement>(".wsc-merge-down");
  const splitBtn = q<HTMLButtonElement>(".wsc-split-btn");
  createBtn.textContent = editing ? "Save" : "Create";
  folderIn.value = folderNow;
  if (editing) {
    nameIn.value = editing.name;
    nameIn.readOnly = true;
    sessSel.value = editing.sessionMode ?? "keep";
  }

  const showError = (msg: string | null): void => {
    errEl.textContent = msg ?? "";
    errEl.classList.toggle("hidden", !msg);
  };

  // ── Grid size controls (1…25, or the grid's own size if a saved one is bigger) ──
  const fillDims = (): void => {
    for (const [sel, now] of [[colsSel, grid.cols], [rowsSel, grid.rows]] as Array<[HTMLSelectElement, number]>) {
      sel.textContent = "";
      for (let n = 1; n <= Math.max(MAX_GRID, now); n++) {
        const o = document.createElement("option");
        o.value = String(n);
        o.textContent = String(n);
        sel.appendChild(o);
      }
      sel.value = String(now);
    }
  };

  const updateMergeButtons = (): void => {
    mergeRightBtn.disabled = selected < 0 || !canMergeRight(grid, selected);
    mergeDownBtn.disabled = selected < 0 || !canMergeDown(grid, selected);
    splitBtn.disabled = selected < 0 || !canSplit(grid, selected);
  };

  // ── Each agent cell's answers (in its config, so they follow the cell) ──
  const renderAgentCells = (): void => {
    cellsHost.textContent = "";
    for (const i of agentCellIndices(grid)) {
      const cell = grid.cells[i]!;
      const block = document.createElement("div");
      block.className = "wsc-group wsc-cell";
      block.innerHTML = `<div class="wsc-group-head"></div>${agentSelectsHtml("wsc-c", "Workspace's")}`;
      const name = cell.panelId === "tool:coding" ? "Glyphh agent" : labelOf(cell.panelId);
      (block.querySelector(".wsc-group-head") as HTMLElement).textContent = `${name} · cell ${cell.col + 1},${cell.row + 1}`;
      // An agent:<cli> cell names its loop in its id; its config may refine the rest.
      const fromId = cell.panelId.toLowerCase().startsWith("agent:") ? cell.panelId.slice(6) : "";
      const a = agentStartOf(cell.config);
      const start = { ...a, loop: a.loop || fromId };
      if (loopsKnown) fillLoops(block.querySelector<HTMLSelectElement>(".wsc-c-loop")!, loops, start.loop);
      setAgent(block, "wsc-c", start);
      block.addEventListener("change", () => {
        const next = withAgentStart(cell.config, readAgent(block, "wsc-c"));
        cell.config = next;
        if (!Object.keys(next).length) delete cell.config;
      });
      cellsHost.appendChild(block);
    }
  };

  // ── The Browser's page and the Terminal's first command ──
  const renderSetup = (): void => {
    setupHost.textContent = "";
    grid.cells.forEach((cell, i) => {
      const spec = CELL_SETUP[cell.panelId];
      if (!spec) return;
      const block = document.createElement("div");
      block.className = "wsc-group wsc-cell-setup";
      const head = document.createElement("div");
      head.className = "wsc-group-head";
      head.textContent = `${spec.label} · cell ${cell.col + 1},${cell.row + 1}`;
      const input = document.createElement("input");
      input.className = "settings-input";
      input.placeholder = spec.placeholder;
      input.spellcheck = false;
      input.value = String(cell.config?.[spec.key] ?? "");
      input.addEventListener("input", () => setCellConfig(grid, i, spec.key, input.value.trim()));
      block.append(head, input);
      if (cell.panelId === "tool:terminal") {
        // Maintain on close (default ON): leaving the workspace PARKS this
        // terminal — the shell and whatever runs in it stay alive.
        const stack = document.createElement("div");
        stack.className = "settings-toggles";
        stack.appendChild(settingsToggle(
          "Maintain on close",
          "Keeps the terminal (and anything running in it) alive when the workspace closes.",
          cell.config?.keepAlive !== false,
          (on) => setCellConfig(grid, i, "keepAlive", on ? undefined : false),
        ));
        block.appendChild(stack);
      }
      setupHost.appendChild(block);
    });
  };

  // ── The grid preview ──
  const renderGrid = (): void => {
    preview.style.gridTemplateColumns = `repeat(${grid.cols}, minmax(0, 1fr))`;
    preview.style.gridTemplateRows = `repeat(${grid.rows}, minmax(0, 1fr))`;
    preview.textContent = "";
    grid.cells.forEach((cell, i) => {
      const el = document.createElement("div");
      el.className = "grid-cell";
      if (cell.panelId) el.classList.add("assigned", "draggable-cell");
      if (i === selected) el.classList.add("selected");
      if (cell.sticky) el.classList.add("sticky");
      el.dataset.index = String(i);
      el.style.gridColumn = `${cell.col + 1} / span ${cell.colSpan}`;
      el.style.gridRow = `${cell.row + 1} / span ${cell.rowSpan}`;
      if (cell.panelId) el.insertAdjacentHTML("beforeend", `<span class="grid-cell-handle" title="Drag to move">${GRIP_SVG}</span>`);
      if (cell.sticky) el.insertAdjacentHTML("beforeend", `<span class="grid-cell-sticky" title="Sticky — apps open here">${PIN_SVG}</span>`);
      const label = document.createElement("span");
      label.className = "wsc-grid-label";
      label.textContent = labelOf(cell.panelId);
      el.appendChild(label);
      el.addEventListener("click", (e) => {
        e.stopPropagation();
        if (dragConsumedClick) return;   // that mouseup ended a drag, not a pick
        void showCellPicker(i, el);
      });
      if (cell.panelId) wireDrag(el, i);
      preview.appendChild(el);
    });
    updateMergeButtons();
  };

  /** Everything that follows the grid: the preview, the agent cells' answers, the panel setup. */
  const renderAll = (): void => {
    renderGrid();
    renderAgentCells();
    renderSetup();
  };

  // ── Drag-to-rearrange: POINTER-based, the live layout manager's gesture.
  //    Contents move, geometry stays (workspace-grid.ts applyDrop). ──
  const clearDropMarks = (): void => {
    preview.querySelectorAll(".drop-swap, .drop-before, .drop-after").forEach((c) => c.classList.remove("drop-swap", "drop-before", "drop-after"));
  };
  const zoneAt = (x: number, y: number): { el: HTMLElement; idx: number; mode: "before" | "after" | "swap" } | null => {
    const el = (document.elementFromPoint(x, y) as HTMLElement | null)?.closest<HTMLElement>(".grid-cell");
    if (!el || !preview.contains(el)) return null;
    const r = el.getBoundingClientRect();
    return { el, idx: parseInt(el.dataset.index!, 10), mode: dropModeAt((x - r.left) / Math.max(1, r.width), (y - r.top) / Math.max(1, r.height)) };
  };
  function wireDrag(el: HTMLElement, idx: number): void {
    el.addEventListener("mousedown", (e) => {
      if (e.button !== 0) return;
      // Kill text selection NOW — a selection under the pointer turns the
      // gesture into a native text-drag that swallows every mousemove.
      e.preventDefault();
      const startX = e.clientX, startY = e.clientY;
      let started = false;
      let ghost: HTMLElement | null = null;
      const move = (ev: MouseEvent): void => {
        if (!started) {
          // A 5px threshold keeps plain clicks (the picker) intact.
          if (Math.abs(ev.clientX - startX) + Math.abs(ev.clientY - startY) < 5) return;
          started = true;
          document.querySelectorAll(".cell-panel-picker").forEach((p) => p.remove());
          el.classList.add("dragging");
          document.body.classList.add("grid-cell-dragging");
          ghost = el.cloneNode(true) as HTMLElement;
          ghost.classList.add("grid-drag-ghost");
          ghost.style.width = `${el.offsetWidth}px`;
          ghost.style.height = `${el.offsetHeight}px`;
          document.body.appendChild(ghost);
        }
        ghost!.style.left = `${ev.clientX + 10}px`;
        ghost!.style.top = `${ev.clientY + 8}px`;
        clearDropMarks();
        const z = zoneAt(ev.clientX, ev.clientY);
        if (z && z.idx !== idx) z.el.classList.add(z.mode === "swap" ? "drop-swap" : z.mode === "before" ? "drop-before" : "drop-after");
      };
      const up = (ev: MouseEvent): void => {
        document.removeEventListener("mousemove", move);
        document.removeEventListener("mouseup", up);
        ghost?.remove();
        document.body.classList.remove("grid-cell-dragging");
        clearDropMarks();
        el.classList.remove("dragging");
        if (!started) return;   // plain click — the click handler opens the picker
        dragConsumedClick = true;
        window.setTimeout(() => { dragConsumedClick = false; }, 0);
        const z = zoneAt(ev.clientX, ev.clientY);
        if (!z || z.idx === idx) return;
        applyDrop(grid, idx, z.idx, z.mode);
        selected = z.idx;
        renderAll();
      };
      document.addEventListener("mousemove", move);
      document.addEventListener("mouseup", up);
    });
  }

  // ── The cell picker: what fills a cell (agents, work panels, apps), and the sticky pin ──
  let appsLoaded: Promise<void> = Promise.resolve();
  const closePickers = (): void => { document.querySelectorAll(".cell-panel-picker").forEach((p) => p.remove()); };
  async function showCellPicker(cellIndex: number, anchor: HTMLElement): Promise<void> {
    closePickers();
    selected = cellIndex;
    renderGrid();
    await appsLoaded;
    if (!overlay.isConnected || !grid.cells[cellIndex]) return;
    const fresh = preview.querySelector<HTMLElement>(`.grid-cell[data-index="${cellIndex}"]`) ?? anchor;
    const rect = fresh.getBoundingClientRect();
    const tools = cellPickerTools(heldHouseViews(appRows, HOUSE_VIEW_OF_APP), HOUSE_TOOL_VIEWS);
    const agents = loops.filter((l) => l.id !== "glyphh").map((l) => ({ id: `agent:${l.id}`, label: l.name }));
    const apps = cellPickerApps(appRows);
    const cell = grid.cells[cellIndex]!;
    const opt = (o: { id: string; label: string }, cls = ""): string => `<div class="cell-panel-option${cls}" data-id="${esc(o.id)}">${esc(o.label)}</div>`;
    const picker = document.createElement("div");
    picker.className = "cell-panel-picker";
    picker.style.left = `${rect.left}px`;
    picker.innerHTML = [
      `<input class="cell-panel-search" placeholder="Search…" autocomplete="off" spellcheck="false" />`,
      `<div class="cell-panel-options">`,
      `<div class="cell-panel-option empty" data-id="">Empty</div>`,
      `<div class="cell-panel-group-label">Workbench tools</div>`,
      ...tools.map((t) => opt(t, " tool")),
      agents.length ? `<div class="cell-panel-group-label">CLI agents</div>` : "",
      ...agents.map((a) => opt(a, " tool")),
      apps.length ? `<div class="cell-panel-group-label">Tabs</div>` : "",
      ...apps.map((a) => opt(a)),
      `</div>`,
      // The sticky toggle only makes sense once a panel holds an app.
      cell.panelId
        ? `<button type="button" class="cell-panel-sticky${cell.sticky ? " on" : ""}" title="Apps you open land in this panel">${PIN_SVG}<span>${cell.sticky ? "Sticky app panel" : "Make sticky app panel"}</span></button>`
        : "",
    ].join("");
    document.body.appendChild(picker);
    const h = picker.offsetHeight;
    const spaceBelow = window.innerHeight - rect.bottom - 4;
    if (spaceBelow < h && rect.top > h) picker.style.bottom = `${window.innerHeight - rect.top + 4}px`;
    else picker.style.top = `${Math.max(4, Math.min(rect.bottom + 4, window.innerHeight - h - 4))}px`;
    picker.style.left = `${Math.max(4, Math.min(rect.left, window.innerWidth - picker.offsetWidth - 4))}px`;

    const done = (): void => {
      picker.remove();
      document.removeEventListener("click", outside);
    };
    function outside(ev: MouseEvent): void {
      if (!(ev.target as HTMLElement).closest(".cell-panel-picker")) done();
    }
    const search = picker.querySelector<HTMLInputElement>(".cell-panel-search")!;
    search.focus();
    search.addEventListener("input", () => {
      const s = search.value.toLowerCase();
      picker.querySelectorAll<HTMLElement>(".cell-panel-option:not(.empty)").forEach((o) => {
        o.style.display = (o.textContent || "").toLowerCase().includes(s) ? "" : "none";
      });
    });
    search.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Escape") { e.preventDefault(); done(); }
    });
    picker.querySelectorAll<HTMLElement>(".cell-panel-option").forEach((o) => {
      o.addEventListener("click", (ev) => {
        ev.stopPropagation();
        assignPanel(grid, cellIndex, o.dataset.id ?? "");
        showError(null);
        done();
        renderAll();
      });
    });
    picker.querySelector(".cell-panel-sticky")?.addEventListener("click", (ev) => {
      ev.stopPropagation();
      setSticky(grid, cellIndex, !grid.cells[cellIndex]!.sticky);
      done();
      renderGrid();
    });
    window.setTimeout(() => document.addEventListener("click", outside), 0);
  }

  // ── Grid controls ──
  colsSel.addEventListener("change", () => { resizeGrid(grid, parseInt(colsSel.value, 10), grid.rows); selected = -1; renderAll(); });
  rowsSel.addEventListener("change", () => { resizeGrid(grid, grid.cols, parseInt(rowsSel.value, 10)); selected = -1; renderAll(); });
  mergeRightBtn.addEventListener("click", () => { if (selected >= 0) { selected = mergeRight(grid, selected); renderAll(); } });
  mergeDownBtn.addEventListener("click", () => { if (selected >= 0) { selected = mergeDown(grid, selected); renderAll(); } });
  splitBtn.addEventListener("click", () => { if (selected >= 0) { splitCell(grid, selected); selected = -1; renderAll(); } });

  const close = (): void => {
    document.removeEventListener("keydown", onKey, true);
    closePickers();
    overlay.remove();
    openOverlay = null;
    guardWebviewsForModal(false);
  };
  /** The grid, checked: a panel, an agent, no native app. */
  const checkGrid = (): string | null =>
    gridError(grid, (p) => cellBlocked(p, resolveAppRow(appRows, p)), labelOf);
  const submit = async (): Promise<void> => {
    if (createBtn.disabled) return;
    const agent = readAgent(q(".wsc-agent"), "wsc-a");
    const arrangement: GridPayload = { cols: grid.cols, rows: grid.rows, cells: gridCells(grid) as CellRow[] };
    if (editing) {
      const gerr = checkGrid();
      if (gerr) { showError(gerr); return; }
      createBtn.disabled = true;
      const payload = editedWorkspaceGrid(editing, {
        model: modelSel.value,
        session: sessSel.value === "new" || sessSel.value === "last" ? sessSel.value : "keep",
        folder: folderIn.value,
        agent,
        cells: {},   // each agent cell's answers are already in its config
        arrangement,
      });
      const res = await api.layoutsSaveGrid?.(payload).catch((e: unknown) => ({ error: e instanceof Error ? e.message : String(e) }));
      createBtn.disabled = false;
      if (!res || (typeof res === "object" && res.error)) { showError((typeof res === "object" && res.error) || "The workspace could not be saved."); return; }
      document.dispatchEvent(new CustomEvent("glyphh:apps-changed"));
      // THE OPEN WORKSPACE SHOWS THE EDIT: re-opened from its new design (the conversation stays).
      const reopened = editShowsOnScreen(editing, payload)
        ? await (wbw.__wbRefreshWorkspace?.(editing.name) ?? Promise.resolve(false)).catch(() => false)
        : false;
      toastOk(reopened ? `${editing.name} saved` : `${editing.name} saved — it opens this way next time`);
      close();
      return;
    }
    const existing = ((await api.layoutsList?.().catch(() => [])) ?? []).map((l) => String(l?.name ?? ""));
    const err = workspaceFormError(nameIn.value, existing);
    if (err) { showError(err); nameIn.focus(); return; }
    const gerr = checkGrid();
    if (gerr) { showError(gerr); return; }
    if (!save) { showError("The workbench has not finished loading. Try again in a moment."); return; }
    createBtn.disabled = true;
    const res = await save({
      name: nameIn.value.trim(),
      ...(modelSel.value ? { model: modelSel.value } : {}),
      session: sessSel.value === "new" || sessSel.value === "last" ? sessSel.value : "keep",
      ...(folderIn.value.trim() ? { folder: folderIn.value.trim() } : {}),
      loop: agent.loop || null,
      view: agent.view || null,
      gateway: agent.gateway || null,
      grid: arrangement,
    }).catch((e: unknown) => ({ ok: false, error: e instanceof Error ? e.message : String(e) }));
    createBtn.disabled = false;
    if (!res.ok) { showError(res.error || "The workspace could not be saved."); return; }
    close();
  };
  function onKey(e: KeyboardEvent): void {
    // An open cell picker takes the keys first: Escape closes it, not the modal.
    if (document.querySelector(".cell-panel-picker")) {
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); closePickers(); }
      return;
    }
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(); }
    else if (e.key === "Enter" && !["SELECT", "BUTTON", "TEXTAREA"].includes((e.target as HTMLElement)?.tagName)) { e.preventDefault(); void submit(); }
  }
  q(".wsc-cancel").addEventListener("click", close);
  createBtn.addEventListener("click", () => { void submit(); });
  overlay.addEventListener("mousedown", (e) => { if (e.target === overlay) close(); });
  q(".wsc-browse").addEventListener("click", () => {
    void api.layoutsPickFolder?.().then((dir) => { if (dir) folderIn.value = dir; });
  });
  nameIn.addEventListener("input", () => showError(null));
  document.addEventListener("keydown", onKey, true);

  fillDims();
  renderAll();
  guardWebviewsForModal(true);
  document.body.appendChild(overlay);
  openOverlay = overlay;
  if (editing) modelSel.focus(); else nameIn.focus();

  // The lists fill in after the modal is up — never block it on main.
  appsLoaded = settle(api.panelAppsList?.(), [] as PickerAppRow[]).then((rows) => {
    appRows = Array.isArray(rows) ? rows : [];
    if (overlay.isConnected) renderGrid();   // the app cells' names
  });
  const wantModel = editing?.modelSelections?.default ?? "";
  void api.loopModels?.("glyphh").then((r) => {
    if (!r?.ok || !overlay.isConnected) return;
    for (const m of r.models.filter((x) => !x.utility)) {
      const o = document.createElement("option");
      o.value = m.id;
      o.textContent = m.name || m.id;
      modelSel.appendChild(o);
    }
    if (wantModel) modelSel.value = wantModel;
  }).catch(() => { /* the default model stands */ });
  void settle(api.cliAgentsList?.(), null).then((r) => {
    if (!overlay.isConnected) return;
    const on = r?.ok ? r.agents.filter((a) => a.enabled) : [];
    loops = LOOP_IDS
      .filter((id) => id === "glyphh" || on.some((a) => a.id === id))
      .map((id) => ({ id: id as string, name: on.find((a) => a.id === id)?.name ?? LOOP_NAMES[id] }));
    loopsKnown = true;
    const ws = editing ? agentStartOf(editing) : INHERIT;
    fillLoops(q<HTMLSelectElement>(".wsc-a-loop"), loops, ws.loop);
    setAgent(q(".wsc-agent"), "wsc-a", ws);
    renderGrid();          // the CLI agent cells' names
    renderAgentCells();    // and their loop lists
  });
}
