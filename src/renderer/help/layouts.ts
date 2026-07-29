/**
 * Layouts section — grid builder, layout CRUD.
 */

import { paginate, renderPaginationBar, confirmAction, clearInvalid } from "./shared.js";
import { appIconInner, primeConnectedIcons, primeNativeIcons } from "./app-icon.js";
import { gotoSection } from "./navigation.js";

/** Open a saved layout INTO the workbench (agent pinned left, grid to its
 *  right) instead of tiling OS windows. Resolves each cell's panel to its
 *  web app; native/unresolved panels are skipped (they can't run in a
 *  webview). Switches to the agent surface so the workbench is visible. */
export async function openLayoutInWorkbench(name: string): Promise<void> {
  await ensureAppNames();
  const layout = (await window.yo.layoutsList()).find((l) => l.name === name);
  if (!layout) return;
  // A layout also sets the loop + its slot models — apply before the panels
  // tile so the composer is already in the layout's program state.
  if (layout.loop) {
    try {
      await window.yo.loopApplyConfig(layout.loop, layout.modelSelections ?? {});
      // Tell the composer to re-sync its loop + model chips to the new state.
      document.dispatchEvent(new CustomEvent("glyphh:loop-applied"));
    } catch { /* offline — the panels still open; the loop just stays as-is */ }
  }
  gotoSection("code");   // shows the agent surface + boots the workbench
  // Open BY NAME so the workbench's recall path runs: the layout's definition
  // plus the geometry the user last dragged it into (its named memory). The
  // old path here handed over a pristine payload via __wbOpenLayout, which
  // skipped recall — every click snapped back to the server's default
  // placement until an app restart.
  const w = window as unknown as { __wbOpenLayoutByName?: (n: string) => Promise<boolean> };
  // The workbench init runs on the code section's first load; wait a few
  // frames for the hook to exist rather than dropping the click.
  let tries = 0;
  const go = () => {
    if (w.__wbOpenLayoutByName) void w.__wbOpenLayoutByName(layout.name);
    else if (tries++ < 20) requestAnimationFrame(go);
  };
  go();
}


/** A geometric mini-grid preview of a layout — the split structure only, no
 *  app icons (command-center parity, minus the icons the page dropped). Cells
 *  are positioned by their col/row/span as a fraction of the grid. */
function layoutMini(layout: { cols?: number; rows?: number; splits: Array<{ col?: number; row?: number; colSpan?: number; rowSpan?: number }> }): string {
  const cols = Math.max(1, layout.cols || 1);
  const rows = Math.max(1, layout.rows || 1);
  const cells = layout.splits.map((c) => {
    const left = ((c.col ?? 0) / cols) * 100, top = ((c.row ?? 0) / rows) * 100;
    const w = ((c.colSpan ?? 1) / cols) * 100, h = ((c.rowSpan ?? 1) / rows) * 100;
    return `<div class="cc-mini-cell" style="left:${left}%;top:${top}%;width:${w}%;height:${h}%"></div>`;
  }).join("");
  return `<div class="cc-mini">${cells}</div>`;
}

let layoutsPage = 0;
let allLayouts: Array<{ name: string; splits: Array<{ panelId: string; col?: number; row?: number; colSpan?: number; rowSpan?: number }> }> = [];
// Map of app id → the server app (Apps tab, /api/panel-apps), so layout cards
// can show each cell's real icon + name rather than a raw id.
type LayoutApp = {
  id: string;
  name: string;
  url?: string | null;
  isBrowser?: boolean;
  execPath?: string | null;
  appArchetype?: string | null;
  launchConfig?: Record<string, unknown> | null;
  connection?: { accountId?: string; pipedreamSlug: string } | null;
};
let appById: Record<string, LayoutApp> = {};
let allApps: LayoutApp[] = [];
async function ensureAppNames(): Promise<void> {
  try {
    // Apps come from the server (the Apps tab's list, /api/panel-apps) — the
    // same source the Apps page shows. NOT the local internal-app registry.
    const apps = await window.yo.panelAppsList();
    const next: Record<string, LayoutApp> = {};
    for (const a of apps) next[a.id] = { id: a.id, name: a.name, url: a.url, isBrowser: a.isBrowser, execPath: a.execPath, appArchetype: a.appArchetype, launchConfig: a.launchConfig };
    appById = next;
    allApps = Object.values(next);
  } catch { /* keep whatever we have */ }
}
function resolveApp(panelId: string): LayoutApp | undefined {
  return appById[panelId] || appById[panelId.replace(/-\d+$/, "")];
}
function panelLabel(panelId: string): string {
  return resolveApp(panelId)?.name || panelId;
}
/** Built-in workbench tool panels selectable in a layout cell. id = `tool:<ViewKind>`:
 *  namespaced (never collides with an app id/UUID) and the suffix IS the
 *  workbench ViewKind, so code-workbench maps it straight to makeSlot(view).
 *  Stored verbatim as the schema's panelId string — round-trips, no migration. */
// Icons mirror code-workbench's VIEW_META so a layout preview shows the same
// glyph the panel header does. `stroke="currentColor"` lets CSS color them —
// white in dark mode — and they size to the tile via .layout-tool-icon svg.
const TOOL_PANELS: Array<{ id: string; label: string; icon: string }> = [
  { id: "tool:preview",  label: "Browser", icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>` },
  { id: "tool:coding",   label: "Coding Agent", icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/><polyline points="9 9 7 11 9 13"/><polyline points="15 9 17 11 15 13"/></svg>` },
  { id: "tool:diff",     label: "Diff", icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="3" x2="12" y2="21"/><polyline points="8 7 4 11 8 15"/><polyline points="16 9 20 13 16 17"/></svg>` },
  { id: "tool:monaco",   label: "Editor", icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>` },
  { id: "tool:files",    label: "Files", icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z"/></svg>` },
  { id: "tool:plan",     label: "Plan", icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/></svg>` },
  { id: "tool:terminal", label: "Terminal", icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/></svg>` },
];
const toolPanelIcon = (id: string): string => TOOL_PANELS.find((t) => t.id === id)?.icon || "";
const isToolPanel = (id: string): boolean => id.startsWith("tool:");
const toolPanelLabel = (id: string): string => TOOL_PANELS.find((t) => t.id === id)?.label || id.slice(5);
/** One app-icon square for a layout card — identical icon resolution to the
 *  Apps page (Pipedream catalog icon → favicon → initial), via the shared
 *  appIconInner helper. */
function panelIconHtml(panelId: string): string {
  // Built-in workbench panels (Files/Terminal/Browser/…) render their VIEW_META
  // glyph, not an initial — the initial read as "unfinished". Named apps keep
  // their favicon/catalog icon.
  if (isToolPanel(panelId)) {
    const label = toolPanelLabel(panelId);
    return `<span class="layout-app-icon layout-tool-icon" title="${label}">${toolPanelIcon(panelId)}</span>`;
  }
  const app = resolveApp(panelId);
  const name = app?.name || panelId;
  return `<span class="layout-app-icon" title="${name}">${appIconInner(app || {}, name, "layout-app-initial")}</span>`;
}

/** Shared edit-form header: the layout's app-icon list + its name. */
function renderLayoutHead(layout: { name: string; splits: Array<{ panelId: string }> } | null): void {
  const head = document.getElementById("layout-detail-head");
  if (!head) return;
  if (!layout) { head.innerHTML = `<div class="edit-head-name">New layout</div>`; return; }
  const seen = new Set<string>();
  const ids = layout.splits.map((s) => s.panelId).filter(Boolean).filter((id) => (seen.has(id) ? false : (seen.add(id), true)));
  head.innerHTML = `<div class="edit-head-icons">${ids.map((id) => panelIconHtml(id)).join("")}</div><div class="edit-head-name"></div>`;
  head.querySelector(".edit-head-name")!.textContent = layout.name;
}
const layoutsList = document.getElementById("layouts-list")!;
const layoutEditor = document.getElementById("layout-editor")!;
const layoutsToolbar = document.getElementById("layouts-toolbar")!;
const layoutSearchInput = document.getElementById("layout-search") as HTMLInputElement;
const layoutNameInput = document.getElementById("layout-new-name") as HTMLInputElement;
const layoutFormError = document.getElementById("layout-form-error")!;
const layoutDeleteBtn = document.getElementById("layout-delete-btn") as HTMLButtonElement;
let editingLayoutName: string | null = null;
const layoutGridBuilder = document.getElementById("layout-grid-builder")!;
const gridPreview = document.getElementById("grid-preview")!;
const gridColsSelect = document.getElementById("grid-cols") as HTMLSelectElement;
const gridRowsSelect = document.getElementById("grid-rows") as HTMLSelectElement;
const mergeRightBtn = document.getElementById("grid-merge-right") as HTMLButtonElement;
const mergeDownBtn = document.getElementById("grid-merge-down") as HTMLButtonElement;
const splitBtn = document.getElementById("grid-split-btn") as HTMLButtonElement;
// Folder-mode + glyphh-placement rows were cut with OS desktop-layout
// management — the markup is gone, so these are optional. Folder binding is
// preserved on save as "single" (its only remaining value) without a control.
const folderModeRow = document.getElementById("layout-folder-mode-row");
const folderModeSelect = document.getElementById("layout-folder-mode") as HTMLSelectElement | null;

// ── Loop + models this layout activates on open ──────────────────────────
const layoutLoopSelect = document.getElementById("layout-loop-select") as HTMLSelectElement | null;
const layoutSessionSelect = document.getElementById("layout-session-mode") as HTMLSelectElement | null;
const layoutFolderInput = document.getElementById("layout-folder-input") as HTMLInputElement | null;
const layoutFolderPickBtn = document.getElementById("layout-folder-pick") as HTMLButtonElement | null;
const layoutFolderClearBtn = document.getElementById("layout-folder-clear") as HTMLButtonElement | null;
layoutFolderPickBtn?.addEventListener("click", () => {
  void window.yo.layoutsPickFolder().then((dir) => {
    if (dir && layoutFolderInput) layoutFolderInput.value = dir;
  });
});
layoutFolderClearBtn?.addEventListener("click", () => {
  if (layoutFolderInput) layoutFolderInput.value = "";
});
const layoutLoopModels = document.getElementById("layout-loop-models");
/** The layout's loop ("" = leave the active loop as-is) + its per-role picks. */
let builderLoop = "";
let builderModelSelections: Record<string, string> = {};

/** Recompute whether this layout is folder-bound. No-op now the control is
 *  gone; kept so callers don't need to know it was cut. */
async function refreshFolderModeRow(): Promise<void> {
  if (!folderModeRow) return;
  try {
    const apps = await window.yo.panelAppsList();
    const byId = new Map(apps.map((a) => [a.id, a]));
    const folderRequired = builderCells.some((c) => {
      if (!c.panelId) return false;
      const app: any = byId.get(c.panelId);
      return !!app?.requiresFolder;
    });
    folderModeRow.classList.toggle("hidden", !folderRequired);
  } catch {
    folderModeRow.classList.add("hidden");
  }
}

/** Fill the loop dropdown once — "Leave as-is" plus every loop the caller has. */
async function ensureLoopOptions(): Promise<void> {
  if (!layoutLoopSelect || layoutLoopSelect.dataset.filled) return;
  try {
    const res = await window.yo.loopsList();
    const opts = [`<option value="">Leave as-is</option>`];
    for (const l of res.loops) opts.push(`<option value="${l.id}">${escLayout(l.name)}</option>`);
    layoutLoopSelect.innerHTML = opts.join("");
    layoutLoopSelect.dataset.filled = "1";
  } catch { layoutLoopSelect.innerHTML = `<option value="">Leave as-is</option>`; }
}

/** One model dropdown per slot the chosen loop declares. "" = Auto (the loop's
 *  own default). Absent loop → nothing to configure. */
async function renderLoopModels(): Promise<void> {
  if (!layoutLoopModels) return;
  if (!builderLoop) { layoutLoopModels.innerHTML = ""; return; }
  layoutLoopModels.innerHTML = `<div class="settings-hint">Loading models…</div>`;
  let roles: Awaited<ReturnType<typeof window.yo.loopRoles>>["roles"] = [];
  try { roles = (await window.yo.loopRoles(builderLoop)).roles; }
  catch { layoutLoopModels.innerHTML = `<div class="settings-hint">Couldn't load this loop's models.</div>`; return; }
  if (!roles.length) { layoutLoopModels.innerHTML = ""; return; }
  layoutLoopModels.innerHTML = roles.map((r) => {
    const picked = builderModelSelections[r.name] ?? "";
    const opts = [`<option value="">Auto — loop default</option>`]
      .concat(r.choices.map((c) => `<option value="${c.id}"${c.id === picked ? " selected" : ""}>${escLayout(c.name)}</option>`));
    return `<label class="layout-loop-model">
      <span class="layout-loop-model-label">${escLayout(r.label || r.name)}</span>
      <select class="settings-input" data-role="${escLayout(r.name)}">${opts.join("")}</select>
    </label>`;
  }).join("");
  layoutLoopModels.querySelectorAll<HTMLSelectElement>("select[data-role]").forEach((sel) => {
    sel.addEventListener("change", () => {
      const role = sel.dataset.role!;
      if (sel.value) builderModelSelections[role] = sel.value;
      else delete builderModelSelections[role];
    });
  });
}

/** Minimal HTML escape for option labels. */
function escLayout(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

interface BuilderCell {
  panelId: string;
  col: number;
  row: number;
  colSpan: number;
  rowSpan: number;
  /** The app-switch target: opening an app reuses THIS panel. At most one cell
   *  per layout is sticky; if none, the workbench falls back to the first. */
  sticky?: boolean;
  /** Per-cell app setup: the Browser cell's URL, the Terminal cell's first
   *  command (runs after the working folder is set). */
  config?: { url?: string; cmd?: string };
}

/** Mark exactly one cell sticky (or clear it). Enforces single-sticky. */
function setStickyCell(idx: number, on: boolean): void {
  builderCells.forEach((c, i) => { c.sticky = on && i === idx; });
}

let builderCols = 2;
let builderRows = 1;
let builderCells: BuilderCell[] = [];
let builderSelected = -1;

function initBuilderCells() {
  builderCells = [];
  for (let r = 0; r < builderRows; r++) {
    for (let c = 0; c < builderCols; c++) {
      builderCells.push({ panelId: "", col: c, row: r, colSpan: 1, rowSpan: 1 });
    }
  }
  builderSelected = -1;
}

function cellAt(col: number, row: number): number {
  return builderCells.findIndex(
    (c) => col >= c.col && col < c.col + c.colSpan && row >= c.row && row < c.row + c.rowSpan,
  );
}

function canMergeRight(idx: number): boolean {
  const cell = builderCells[idx];
  if (cell.col + cell.colSpan >= builderCols) return false;
  // All cells in the column to the right (within this cell's row range) must be one cell with matching span
  const rightIdx = cellAt(cell.col + cell.colSpan, cell.row);
  if (rightIdx < 0) return false;
  const right = builderCells[rightIdx];
  return right.col === cell.col + cell.colSpan &&
    right.row === cell.row && right.rowSpan === cell.rowSpan;
}

function canMergeDown(idx: number): boolean {
  const cell = builderCells[idx];
  if (cell.row + cell.rowSpan >= builderRows) return false;
  const belowIdx = cellAt(cell.col, cell.row + cell.rowSpan);
  if (belowIdx < 0) return false;
  const below = builderCells[belowIdx];
  return below.row === cell.row + cell.rowSpan &&
    below.col === cell.col && below.colSpan === cell.colSpan;
}

function doMergeRight(idx: number) {
  const cell = builderCells[idx];
  const rightIdx = cellAt(cell.col + cell.colSpan, cell.row);
  if (rightIdx < 0) return;
  cell.colSpan += builderCells[rightIdx].colSpan;
  builderCells.splice(rightIdx, 1);
  builderSelected = builderCells.indexOf(cell);
}

function doMergeDown(idx: number) {
  const cell = builderCells[idx];
  const belowIdx = cellAt(cell.col, cell.row + cell.rowSpan);
  if (belowIdx < 0) return;
  cell.rowSpan += builderCells[belowIdx].rowSpan;
  builderCells.splice(belowIdx, 1);
  builderSelected = builderCells.indexOf(cell);
}

function doSplit(idx: number) {
  const cell = builderCells[idx];
  if (cell.colSpan === 1 && cell.rowSpan === 1) return;
  const newCells: BuilderCell[] = [];
  for (let r = cell.row; r < cell.row + cell.rowSpan; r++) {
    for (let c = cell.col; c < cell.col + cell.colSpan; c++) {
      newCells.push({
        panelId: r === cell.row && c === cell.col ? cell.panelId : "",
        col: c, row: r, colSpan: 1, rowSpan: 1,
      });
    }
  }
  builderCells.splice(idx, 1, ...newCells);
  builderSelected = -1;
}

function updateMergeButtons() {
  if (builderSelected < 0) {
    mergeRightBtn.disabled = true;
    mergeDownBtn.disabled = true;
    splitBtn.disabled = true;
    return;
  }
  const cell = builderCells[builderSelected];
  mergeRightBtn.disabled = !canMergeRight(builderSelected);
  mergeDownBtn.disabled = !canMergeDown(builderSelected);
  splitBtn.disabled = cell.colSpan === 1 && cell.rowSpan === 1;
}

// One-shot self-heal: if the grid rendered a cell whose app id didn't resolve
// to a name (map stale — e.g. the app was created after the last fetch, or the
// layout arrived over the relay), refetch the app list once and re-render.
let namesRefreshing = false;
function healUnresolvedNames(): void {
  if (namesRefreshing) return;
  const unresolved = builderCells.some((c) => c.panelId && !isToolPanel(c.panelId) && !c.panelId.startsWith("agent:") && c.panelId !== "agents-tabbed" && !resolveApp(c.panelId));
  if (!unresolved) return;
  namesRefreshing = true;
  void ensureAppNames().then(() => {
    namesRefreshing = false;
    // Only re-render if the refetch actually resolved something — a deleted
    // app's id stays unresolvable, and looping on it would spin forever.
    if (builderCells.some((c) => c.panelId && resolveApp(c.panelId))) renderGridPreview();
  }).catch(() => { namesRefreshing = false; });
}

// ── App setup — per-cell config the layout applies on open ──────────────────
// Only two slottable configs exist for now: the Browser cell's URL and the
// Terminal cell's first command. The section renders one field per matching
// cell and hides itself when the grid holds neither.
const CELL_CONFIG_SPECS: Record<string, { key: "url" | "cmd"; label: string; placeholder: string }> = {
  "tool:preview": { key: "url", label: "Browser URL", placeholder: "https://…" },
  "tool:terminal": { key: "cmd", label: "Terminal command", placeholder: "npm run dev" },
};

function renderCellConfigs(): void {
  const wrap = document.getElementById("layout-cell-configs");
  const list = document.getElementById("layout-cell-config-list");
  if (!wrap || !list) return;
  list.innerHTML = "";
  let fields = 0;
  builderCells.forEach((c, i) => {
    const spec = CELL_CONFIG_SPECS[c.panelId];
    if (!spec) return;
    fields++;
    const row = document.createElement("div");
    row.className = "layout-cell-config-row";
    const label = document.createElement("span");
    label.className = "layout-cell-config-label";
    label.textContent = `${spec.label} · cell ${c.col + 1},${c.row + 1}`;
    const input = document.createElement("input");
    input.className = "settings-input";
    input.placeholder = spec.placeholder;
    input.spellcheck = false;
    input.value = String(c.config?.[spec.key] ?? "");
    input.addEventListener("input", () => {
      const cell = builderCells[i];
      if (!cell) return;
      const v = input.value.trim();
      if (v) cell.config = { ...(cell.config || {}), [spec.key]: v };
      else if (cell.config) {
        delete cell.config[spec.key];
        if (!Object.keys(cell.config).length) delete cell.config;
      }
    });
    row.append(label, input);
    list.appendChild(row);
  });
  wrap.classList.toggle("hidden", fields === 0);
}

function renderGridPreview() {
  void refreshFolderModeRow();
  renderCellConfigs();
  gridPreview.style.gridTemplateColumns = `repeat(${builderCols}, 1fr)`;
  gridPreview.style.gridTemplateRows = `repeat(${builderRows}, 1fr)`;

  gridPreview.innerHTML = builderCells
    .map((cell, i) => {
      const cls = ["grid-cell"];
      if (cell.panelId) cls.push("assigned");
      if (i === builderSelected) cls.push("selected");
      if (cell.sticky) cls.push("sticky");
      let label = cell.panelId ? panelLabel(cell.panelId) : "\u2014";
      if (cell.panelId && isToolPanel(cell.panelId)) label = toolPanelLabel(cell.panelId);
      else if (cell.panelId?.startsWith("agent:")) label = cell.panelId.slice(6);
      else if (cell.panelId === "agents-tabbed") label = "Agents (tabbed)";
      const pin = cell.sticky
        ? `<span class="grid-cell-sticky" title="Sticky \u2014 apps open here"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="17" x2="12" y2="22"/><path d="M5 17h14l-1.7-6.8a2 2 0 0 0-1-1.3L15 8V4h-6v4l-1.3.9a2 2 0 0 0-1 1.3z"/></svg></span>`
        : "";
      return `<div class="${cls.join(" ")}" data-index="${i}"
        style="grid-column: ${cell.col + 1} / span ${cell.colSpan}; grid-row: ${cell.row + 1} / span ${cell.rowSpan}">
        ${pin}${label}
      </div>`;
    })
    .join("");

  gridPreview.querySelectorAll(".grid-cell").forEach((el) => {
    el.addEventListener("click", (e) => {
      e.stopPropagation();
      const idx = parseInt((el as HTMLElement).dataset.index!, 10);
      showCellPicker(idx, el as HTMLElement);
    });
  });

  updateMergeButtons();
  healUnresolvedNames();
}

async function showCellPicker(cellIndex: number, anchor: HTMLElement) {
  document.querySelectorAll(".cell-panel-picker").forEach((el) => el.remove());
  const rect = anchor.getBoundingClientRect();
  builderSelected = cellIndex;
  renderGridPreview();

  type PickerOption = { id: string; label: string };
  // Server apps only — the exact list shown on the Apps page (/api/panel-apps),
  // matching how apps.ts filters it (web apps with a URL, plus native apps).
  let apps: Array<{ id: string; name: string }>;
  try {
    apps = (await window.yo.panelAppsList()).filter((a: any) => a.url || a.isBrowser === false);
  } catch {
    apps = [];
  }
  apps.sort((a, b) => a.name.localeCompare(b.name));
  // Top up the id→name map from this fresh fetch so a picked app (and any
  // other cell whose id was missing from the stale map) renders by name
  // immediately — this is why cells used to show raw UUIDs until re-picked.
  for (const a of apps) {
    if (!appById[a.id]) appById[a.id] = { id: a.id, name: a.name, url: (a as { url?: string }).url, execPath: (a as { execPath?: string }).execPath };
  }
  const options: PickerOption[] = apps
    .map((a) => ({ id: a.id, label: a.name }))
    .sort((a, b) => a.label.localeCompare(b.label));

  const picker = document.createElement("div");
  picker.className = "cell-panel-picker";
  picker.style.left = `${rect.left}px`;

  const isSticky = !!builderCells[cellIndex].sticky;
  // The sticky toggle only makes sense once a panel holds an app (empty cells
  // aren't rendered as workbench slots, so they can't be the app-switch target).
  const stickyBtn = builderCells[cellIndex].panelId
    ? `<button type="button" class="cell-panel-sticky${isSticky ? " on" : ""}" title="Apps you open land in this panel">`
      + `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="17" x2="12" y2="22"/><path d="M5 17h14l-1.7-6.8a2 2 0 0 0-1-1.3L15 8V4h-6v4l-1.3.9a2 2 0 0 0-1 1.3z"/></svg>`
      + `<span>${isSticky ? "Sticky app panel" : "Make sticky app panel"}</span></button>`
    : "";
  picker.innerHTML = [
    `<input class="cell-panel-search" placeholder="Search…" autocomplete="off" spellcheck="false" />`,
    `<div class="cell-panel-options">`,
    `<div class="cell-panel-option empty" data-id="">Empty</div>`,
    `<div class="cell-panel-group-label">Workbench tools</div>`,
    ...TOOL_PANELS.map((t) => `<div class="cell-panel-option tool" data-id="${t.id}">${t.label}</div>`),
    options.length ? `<div class="cell-panel-group-label">Apps</div>` : "",
    ...options.map((o) => `<div class="cell-panel-option" data-id="${o.id}">${o.label}</div>`),
    `</div>`,
    stickyBtn,
  ].join("");

  document.body.appendChild(picker);

  const pickerHeight = picker.offsetHeight;
  const spaceBelow = window.innerHeight - rect.bottom - 4;
  if (spaceBelow < pickerHeight && rect.top > pickerHeight) {
    picker.style.bottom = `${window.innerHeight - rect.top + 4}px`;
  } else {
    picker.style.top = `${rect.bottom + 4}px`;
  }

  const closePicker = (ev: MouseEvent) => {
    if (!(ev.target as HTMLElement).closest(".cell-panel-picker")) {
      picker.remove();
      document.removeEventListener("click", closePicker);
    }
  };

  const searchInput = picker.querySelector(".cell-panel-search") as HTMLInputElement;
  searchInput.focus();

  searchInput.addEventListener("input", () => {
    const q = searchInput.value.toLowerCase();
    picker.querySelectorAll<HTMLElement>(".cell-panel-option:not(.empty)").forEach((opt) => {
      opt.style.display = (opt.textContent || "").toLowerCase().includes(q) ? "" : "none";
    });
  });

  searchInput.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key === "Escape") {
      picker.remove();
      document.removeEventListener("click", closePicker);
    }
  });

  picker.querySelectorAll(".cell-panel-option").forEach((opt) => {
    opt.addEventListener("click", (ev) => {
      ev.stopPropagation();
      builderCells[cellIndex].panelId = (opt as HTMLElement).dataset.id!;
      picker.remove();
      renderGridPreview();
    });
  });

  picker.querySelector(".cell-panel-sticky")?.addEventListener("click", (ev) => {
    ev.stopPropagation();
    setStickyCell(cellIndex, !builderCells[cellIndex].sticky);
    picker.remove();
    document.removeEventListener("click", closePicker);
    renderGridPreview();
  });

  setTimeout(() => document.addEventListener("click", closePicker), 0);
}

async function loadLayouts() {
  layoutEditor.classList.add("hidden");
  layoutFormError.classList.add("hidden");
  await ensureAppNames();
  allLayouts = await window.yo.layoutsList();
  // The rail's Apps grid mirrors layouts too — tell it to refresh.
  document.dispatchEvent(new CustomEvent("glyphh:apps-changed"));

  document.getElementById("layouts-limit-msg")!.classList.add("hidden");

  renderLayoutsList();
  // Async — re-renders once Pipedream catalog icons (connected apps) and OS
  // file icons (native apps) land, exactly like the Apps page.
  void primeConnectedIcons(allApps, renderLayoutsList);
  void primeNativeIcons(allApps, renderLayoutsList);
}

function renderLayoutsList() {
  const query = layoutSearchInput.value.trim().toLowerCase();
  const filtered = query ? allLayouts.filter((l) => l.name.toLowerCase().includes(query)) : allLayouts;

  // Same tile grid as the Apps/Connections pages (.app-list-wrap .app-grid).
  // Preserve the hidden state — async icon re-renders must not pop the list
  // back over an open editor.
  const wasHidden = layoutsList.classList.contains("hidden") || !layoutEditor.classList.contains("hidden");
  layoutsList.className = wasHidden ? "app-list-wrap hidden" : "app-list-wrap";
  layoutsList.innerHTML = "";

  if (allLayouts.length === 0) {
    layoutsList.innerHTML = '<div class="crud-empty">No layouts yet — click "+ New" to create one.</div>';
    return;
  }
  if (filtered.length === 0) {
    layoutsList.innerHTML = `<div class="crud-empty">No layouts matching "${query}"</div>`;
    return;
  }

  const { items: layouts, state } = paginate(filtered, layoutsPage);
  layoutsPage = state.page;

  // Cards mirror the command center's layout tiles: a geometric mini-grid
  // preview (no app icons) + the name. One visual language across surfaces.
  const grid = document.createElement("div");
  grid.className = "cc-layouts layouts-page-grid";
  for (const layout of layouts) {
    const card = document.createElement("div");
    card.className = "cc-layout-card";
    card.innerHTML = `${layoutMini(layout)}<span class="cc-card-name"></span>`;
    card.querySelector(".cc-card-name")!.textContent = layout.name;
    // The Layouts page is for EDITING — the left-rail Layouts tiles open them.
    card.addEventListener("click", () => editLayout(layout.name));
    grid.appendChild(card);
  }
  layoutsList.appendChild(grid);

  if (state.totalPages > 1) {
    layoutsList.appendChild(renderPaginationBar(state, (p) => { layoutsPage = p; renderLayoutsList(); }));
  }
}

async function editLayout(name: string) {
  editingLayoutName = name;
  // Names must be current before the grid renders — a stale map shows raw
  // app ids in the cells (healUnresolvedNames covers late misses too).
  await ensureAppNames();
  const layouts = await window.yo.layoutsList();
  const layout = layouts.find((l) => l.name === name);
  if (layout) {
    builderCols = layout.cols || 2;
    builderRows = layout.rows || 1;
    initBuilderCells();
    for (const s of layout.splits) {
      const cell = builderCells.find((c) => c.col === s.col && c.row === s.row);
      if (cell) {
        cell.panelId = s.panelId;
        cell.colSpan = s.colSpan ?? 1;
        cell.rowSpan = s.rowSpan ?? 1;
        cell.sticky = !!(s as { sticky?: boolean }).sticky;
        const cfg = (s as { config?: { url?: string; cmd?: string } }).config;
        if (cfg && (cfg.url || cfg.cmd)) cell.config = { ...cfg };
      }
    }
    // Drop the freshly-initialized 1×1 cells that a merged cell's span now
    // covers — saved layouts only store merged cells by their top-left, so
    // without this the leftovers render stacked underneath the merged cell.
    for (let i = builderCells.length - 1; i >= 0; i--) {
      const c = builderCells[i];
      const covered = builderCells.some((o) => o !== c &&
        c.col >= o.col && c.col < o.col + o.colSpan &&
        c.row >= o.row && c.row < o.row + o.rowSpan);
      if (covered) builderCells.splice(i, 1);
    }
  } else {
    builderCols = 2;
    builderRows = 1;
    initBuilderCells();
  }
  renderLayoutHead(layout ?? null);
  gridColsSelect.value = String(builderCols);
  gridRowsSelect.value = String(builderRows);
  if (folderModeSelect) folderModeSelect.value = (layout as any)?.folderMode === "multi" ? "multi" : "single";
  if (layoutSessionSelect) {
    const sm = (layout as { sessionMode?: string })?.sessionMode;
    layoutSessionSelect.value = sm === "new" || sm === "last" ? sm : "keep";
  }
  if (layoutFolderInput) layoutFolderInput.value = (layout as { folder?: string | null })?.folder ?? "";
  // Loop + models this layout activates on open.
  builderLoop = (layout as { loop?: string })?.loop ?? "";
  builderModelSelections = { ...((layout as { modelSelections?: Record<string, string> })?.modelSelections ?? {}) };
  await ensureLoopOptions();
  if (layoutLoopSelect) layoutLoopSelect.value = builderLoop;
  void renderLoopModels();
  layoutNameInput.value = name;
  layoutDeleteBtn.style.display = "";
  document.getElementById("layout-open-btn")?.classList.remove("hidden");
  layoutFormError.classList.add("hidden");

  layoutGridBuilder.classList.remove("hidden");

  layoutsList.classList.add("hidden");
  layoutsToolbar.classList.add("hidden");
  layoutEditor.classList.remove("hidden");
  renderGridPreview();
}

async function newLayout() {
  editingLayoutName = null;
  renderLayoutHead(null);
  builderCols = 2;
  builderRows = 1;
  initBuilderCells();
  gridColsSelect.value = "2";
  gridRowsSelect.value = "1";
  if (folderModeSelect) folderModeSelect.value = "single";
  if (layoutSessionSelect) layoutSessionSelect.value = "keep";
  if (layoutFolderInput) layoutFolderInput.value = "";
  builderLoop = "";
  builderModelSelections = {};
  void ensureLoopOptions().then(() => { if (layoutLoopSelect) layoutLoopSelect.value = ""; void renderLoopModels(); });
  layoutNameInput.value = "";
  layoutDeleteBtn.style.display = "none";
  document.getElementById("layout-open-btn")?.classList.add("hidden");
  layoutFormError.classList.add("hidden");
  layoutGridBuilder.classList.remove("hidden");
  renderGridPreview();
  layoutsList.classList.add("hidden");
  layoutsToolbar.classList.add("hidden");
  layoutEditor.classList.remove("hidden");
  layoutNameInput.focus();
  renderGridPreview();
}

function cancelLayout() {
  layoutEditor.classList.add("hidden");
  layoutsList.classList.remove("hidden");
  layoutsToolbar.classList.remove("hidden");
  editingLayoutName = null;
  loadLayouts();
}

/** A layout is a grid of PANELS inside the Glyphh window. A native app opens in
 *  its own OS window, so it is the one thing a cell cannot hold. */
function cellBlocked(panelId: string): boolean {
  if (isToolPanel(panelId)) return false;
  if (panelId.startsWith("agent:") || panelId === "agents-tabbed") return false;
  const app = resolveApp(panelId);
  if (!app || app.appArchetype === "glyphh-self") return false;
  return app.isBrowser === false || !!app.execPath;
}

async function saveLayout() {
  const name = layoutNameInput.value.trim();
  if (!name) {
    layoutNameInput.classList.add("invalid");
    clearInvalid(layoutNameInput);
    layoutFormError.textContent = "Layout name is required.";
    layoutFormError.classList.remove("hidden");
    return;
  }
  const assignedCells = builderCells.filter((c) => c.panelId);
  if (assignedCells.length < 1) {
    layoutFormError.textContent = "Assign at least one panel to the grid.";
    layoutFormError.classList.remove("hidden");
    return;
  }

  if (editingLayoutName && editingLayoutName !== name) {
    await window.yo.layoutsDelete(editingLayoutName);
  }

  const folderMode = (folderModeSelect?.value === "multi" ? "multi" : "single") as "single" | "multi";
  const offenders = assignedCells
    .filter((c) => cellBlocked(c.panelId))
    .map((c) => panelLabel(c.panelId));
  if (offenders.length) {
    layoutFormError.textContent =
      `A layout can't contain native apps: ${offenders.join(", ")}. ` +
      "A layout arranges panels inside Glyphh; a native app opens in its own OS window.";
    layoutFormError.classList.remove("hidden");
    return;
  }
  // Only keep model picks for slots the chosen loop still declares — a stale
  // pick from a loop the user switched away from must not ride along.
  const selections = builderLoop ? builderModelSelections : {};
  await window.yo.layoutsSaveGrid({
    name,
    cols: builderCols,
    rows: builderRows,
    colWidths: Array(builderCols).fill(1 / builderCols),
    rowHeights: Array(builderRows).fill(1 / builderRows),
    cells: assignedCells,
    folderMode,
    ...(builderLoop ? { loop: builderLoop } : {}),
    ...(Object.keys(selections).length ? { modelSelections: selections } : {}),
    sessionMode: (layoutSessionSelect?.value === "new" || layoutSessionSelect?.value === "last"
      ? layoutSessionSelect.value : "keep") as "keep" | "new" | "last",
    folder: layoutFolderInput?.value.trim() || null,
  });
  cancelLayout();
}

async function deleteLayout() {
  if (!editingLayoutName) return;
  const confirmed = await confirmAction({
    title: `Delete “${editingLayoutName}”?`,
    body: "The layout disappears from your library — the apps it arranged are untouched.",
    confirmLabel: "Delete layout",
    danger: true,
  });
  if (!confirmed) return;
  await window.yo.layoutsDelete(editingLayoutName);
  cancelLayout();
}



export { loadLayouts };

export function initLayoutsEvents() {
  void ensureAppNames();
  document.getElementById("layout-new-btn")!.addEventListener("click", newLayout);
  document.getElementById("layout-save-btn")!.addEventListener("click", saveLayout);
  document.getElementById("layout-cancel-btn")!.addEventListener("click", cancelLayout);
  document.getElementById("layout-back-link")!.addEventListener("click", cancelLayout);
  document.getElementById("layout-delete-btn")!.addEventListener("click", deleteLayout);
  // Open the layout being edited — real OS windows tiled across the display.
  document.getElementById("layout-open-btn")!.addEventListener("click", () => {
    if (!editingLayoutName) return;
    void openLayoutInWorkbench(editingLayoutName);
  });
  layoutSearchInput.addEventListener("input", () => { layoutsPage = 0; renderLayoutsList(); });

  // Loop picker: switching loops clears the old loop's model picks (its slots
  // don't apply to the new program) and re-renders the per-slot dropdowns.
  layoutLoopSelect?.addEventListener("change", () => {
    builderLoop = layoutLoopSelect.value;
    builderModelSelections = {};
    void renderLoopModels();
  });

  // Grid builder dimension controls
  gridColsSelect.addEventListener("change", () => {
    builderCols = parseInt(gridColsSelect.value, 10);
    initBuilderCells();
    renderGridPreview();
  });
  gridRowsSelect.addEventListener("change", () => {
    builderRows = parseInt(gridRowsSelect.value, 10);
    initBuilderCells();
    renderGridPreview();
  });
  mergeRightBtn.addEventListener("click", () => {
    if (builderSelected >= 0) {
      doMergeRight(builderSelected);
      renderGridPreview();
    }
  });
  mergeDownBtn.addEventListener("click", () => {
    if (builderSelected >= 0) {
      doMergeDown(builderSelected);
      renderGridPreview();
    }
  });
  splitBtn.addEventListener("click", () => {
    if (builderSelected >= 0) {
      doSplit(builderSelected);
      renderGridPreview();
    }
  });
}
