/**
 * Layouts section — grid builder, layout CRUD.
 */

import { paginate, renderPaginationBar, confirmAction, clearInvalid } from "./shared.js";
import { appIconInner, primeConnectedIcons, primeNativeIcons } from "./app-icon.js";
import { LAYOUTS_EMPTY, emptyStateHtml } from "./empty-sayings.js";
import { gotoSection } from "./navigation.js";

/** Open a saved layout INTO the workbench (agent pinned left, grid to its
 *  right) instead of tiling OS windows. Resolves each cell's panel to its
 *  web app; native/unresolved panels are skipped (they can't run in a
 *  webview). Switches to the agent surface so the workbench is visible. */
async function openLayoutInWorkbench(name: string): Promise<void> {
  await ensureAppNames();
  const layout = (await window.yo.layoutsList()).find((l) => l.name === name);
  if (!layout) return;
  const cells: Array<{ slug: string; name: string; url: string; glyphh: boolean; col: number; row: number }> = [];
  for (const s of layout.splits) {
    const app = resolveApp(s.panelId);
    if (!app?.url) continue;
    cells.push({ slug: app.id, name: app.name, url: app.url, glyphh: false, col: s.col ?? 0, row: s.row ?? 0 });
  }
  if (!cells.length) return;
  gotoSection("code");   // shows the agent surface + boots the workbench
  const payload = { cols: layout.cols || 2, colWidths: layout.colWidths || [], rowHeights: layout.rowHeights || [], cells };
  const w = window as unknown as { __wbOpenLayout?: (l: typeof payload) => void };
  // The workbench init runs on the code section's first load; wait a few
  // frames for __wbOpenLayout to exist rather than dropping the click.
  let tries = 0;
  const go = () => {
    if (w.__wbOpenLayout) w.__wbOpenLayout(payload);
    else if (tries++ < 20) requestAnimationFrame(go);
  };
  go();
}


let layoutsPage = 0;
let allLayouts: Array<{ name: string; splits: Array<{ panelId: string; col?: number; row?: number; colSpan?: number; rowSpan?: number }> }> = [];
// Map of app id → the server app (Apps tab, /api/panel-apps), so layout cards
// can show each cell's real icon + name rather than a raw id.
type LayoutApp = {
  id: string;
  name: string;
  url?: string | null;
  execPath?: string | null;
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
    for (const a of apps) next[a.id] = { id: a.id, name: a.name, url: a.url, execPath: a.execPath };
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
/** One app-icon square for a layout card — identical icon resolution to the
 *  Apps page (Pipedream catalog icon → favicon → initial), via the shared
 *  appIconInner helper. */
function panelIconHtml(panelId: string): string {
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
const folderModeRow = document.getElementById("layout-folder-mode-row")!;
const folderModeSelect = document.getElementById("layout-folder-mode") as HTMLSelectElement;

/** Recompute whether this layout is folder-bound (any cell's app declares
 *  requiresFolder). Shows/hides the folder-mode row accordingly. */
async function refreshFolderModeRow(): Promise<void> {
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

interface BuilderCell {
  panelId: string;
  col: number;
  row: number;
  colSpan: number;
  rowSpan: number;
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
  const unresolved = builderCells.some((c) => c.panelId && !c.panelId.startsWith("agent:") && c.panelId !== "agents-tabbed" && !resolveApp(c.panelId));
  if (!unresolved) return;
  namesRefreshing = true;
  void ensureAppNames().then(() => {
    namesRefreshing = false;
    // Only re-render if the refetch actually resolved something — a deleted
    // app's id stays unresolvable, and looping on it would spin forever.
    if (builderCells.some((c) => c.panelId && resolveApp(c.panelId))) renderGridPreview();
  }).catch(() => { namesRefreshing = false; });
}

function renderGridPreview() {
  void refreshFolderModeRow();
  gridPreview.style.gridTemplateColumns = `repeat(${builderCols}, 1fr)`;
  gridPreview.style.gridTemplateRows = `repeat(${builderRows}, 1fr)`;

  gridPreview.innerHTML = builderCells
    .map((cell, i) => {
      const cls = ["grid-cell"];
      if (cell.panelId) cls.push("assigned");
      if (i === builderSelected) cls.push("selected");
      let label = cell.panelId ? panelLabel(cell.panelId) : "\u2014";
      if (cell.panelId?.startsWith("agent:")) label = cell.panelId.slice(6);
      else if (cell.panelId === "agents-tabbed") label = "Agents (tabbed)";
      return `<div class="${cls.join(" ")}" data-index="${i}"
        style="grid-column: ${cell.col + 1} / span ${cell.colSpan}; grid-row: ${cell.row + 1} / span ${cell.rowSpan}">
        ${label}
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
  const options: PickerOption[] = apps.map((a) => ({ id: a.id, label: a.name }));

  const picker = document.createElement("div");
  picker.className = "cell-panel-picker";
  picker.style.left = `${rect.left}px`;

  picker.innerHTML = [
    `<input class="cell-panel-search" placeholder="Search…" autocomplete="off" spellcheck="false" />`,
    `<div class="cell-panel-options">`,
    `<div class="cell-panel-option empty" data-id="">Empty</div>`,
    ...options.map((o) => `<div class="cell-panel-option" data-id="${o.id}">${o.label}</div>`),
    `</div>`,
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
    layoutsList.innerHTML = emptyStateHtml(LAYOUTS_EMPTY, 'No layouts yet — click "+ New" to create one.');
    return;
  }
  if (filtered.length === 0) {
    layoutsList.innerHTML = `<div class="crud-empty">No layouts matching "${query}"</div>`;
    return;
  }

  const { items: layouts, state } = paginate(filtered, layoutsPage);
  layoutsPage = state.page;

  const grid = document.createElement("div");
  grid.className = "app-grid";
  for (const layout of layouts) {
    const cellIds = layout.splits.map((s) => s.panelId).filter(Boolean);
    const seen = new Set<string>();
    const uniqueIds = cellIds.filter((id) => (seen.has(id) ? false : (seen.add(id), true)));
    const iconsHtml = uniqueIds.map((id) => panelIconHtml(id)).join("")
      || `<span class="layout-app-icon"><span class="layout-app-initial">▦</span></span>`;

    const card = document.createElement("div");
    card.className = "app-card";
    card.style.position = "relative";
    card.innerHTML = `
      <button class="layout-card-edit" title="Edit layout" style="position:absolute;top:6px;right:8px;background:none;border:none;color:var(--text-3);cursor:pointer;font-size:12px;padding:2px;line-height:1;">✎</button>
      <div class="layout-card-icons">${iconsHtml}</div>
      <div class="app-card-name"></div>
      <div class="app-card-id">${uniqueIds.length} app${uniqueIds.length === 1 ? "" : "s"}</div>`;
    card.querySelector(".app-card-name")!.textContent = layout.name;
    // Click opens the layout in the workbench; the ✎ edits it.
    card.querySelector(".layout-card-edit")!.addEventListener("click", (e) => { e.stopPropagation(); void editLayout(layout.name); });
    card.addEventListener("click", () => void openLayoutInWorkbench(layout.name));
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
  folderModeSelect.value = (layout as any)?.folderMode === "multi" ? "multi" : "single";
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
  folderModeSelect.value = "single";
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

  const folderMode = (folderModeSelect.value === "multi" ? "multi" : "single") as "single" | "multi";
  await window.yo.layoutsSaveGrid({
    name,
    cols: builderCols,
    rows: builderRows,
    colWidths: Array(builderCols).fill(1 / builderCols),
    rowHeights: Array(builderRows).fill(1 / builderRows),
    cells: assignedCells,
    folderMode,
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
