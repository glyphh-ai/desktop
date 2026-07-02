/**
 * Layouts section — grid builder, layout CRUD.
 */

import { paginate, renderPaginationBar, confirmAction, clearInvalid, closeHelp } from "./shared.js";
import { appIconInner, primeConnectedIcons } from "./app-icon.js";


let layoutsPage = 0;
let allLayouts: Array<{ name: string; splits: Array<{ panelId: string; col?: number; row?: number; colSpan?: number; rowSpan?: number }> }> = [];
// Map of app id → the server app (Apps tab, /api/panel-apps), so layout cards
// can show each cell's real icon + name rather than a raw id.
type LayoutApp = {
  id: string;
  name: string;
  url?: string | null;
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
    for (const a of apps) next[a.id] = { id: a.id, name: a.name, url: a.url, connection: a.connection };
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

  document.getElementById("layouts-limit-msg")!.classList.add("hidden");

  renderLayoutsList();
  // Async — re-renders once Pipedream catalog icons for connected apps land,
  // exactly like the Apps page.
  void primeConnectedIcons(allApps, renderLayoutsList);
}

function renderLayoutsList() {
  const query = layoutSearchInput.value.trim().toLowerCase();
  const filtered = query ? allLayouts.filter((l) => l.name.toLowerCase().includes(query)) : allLayouts;

  if (allLayouts.length === 0) {
    layoutsList.innerHTML = `<div class="crud-empty">No layouts yet. Click "+ New" to create one.</div>`;
    return;
  }
  if (filtered.length === 0) {
    layoutsList.innerHTML = `<div class="crud-empty">No layouts matching "${query}"</div>`;
    return;
  }

  const { items: layouts, state } = paginate(filtered, layoutsPage);
  layoutsPage = state.page;
  layoutsList.innerHTML = "";

  for (const layout of layouts) {
    const card = document.createElement("div");
    card.className = "crud-card";
    const cellIds = layout.splits.map((s) => s.panelId).filter(Boolean);
    const seen = new Set<string>();
    const uniqueIds = cellIds.filter((id) => (seen.has(id) ? false : (seen.add(id), true)));
    const iconsHtml = uniqueIds.map((id) => panelIconHtml(id)).join("");
    const names = uniqueIds.map((id) => panelLabel(id)).join(", ");
    card.innerHTML = `
      ${iconsHtml ? `<div class="layout-card-icons">${iconsHtml}</div>` : ""}
      <div class="crud-card-info">
        <span class="crud-card-name">${layout.name}</span>
        <span class="crud-card-meta">${names || "empty"}</span>
      </div>
      <div class="crud-card-actions">
        <button class="crud-card-btn crud-open-btn" title="Open layout">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h13"/><polyline points="13 6 19 12 13 18"/></svg>
        </button>
        <button class="crud-card-btn crud-edit-btn" title="Edit">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.85 2.85 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/></svg>
        </button>
        <button class="crud-card-btn danger crud-delete-btn" title="Delete">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/></svg>
        </button>
      </div>`;

    card.querySelector(".crud-open-btn")!.addEventListener("click", (e) => {
      e.stopPropagation();
      // Hand off to the OS layout manager: real windows tiled across the
      // display. Nothing renders inside the Glyphh client.
      void window.yo.layoutsOpen(layout.name);
      closeHelp();
    });

    card.querySelector(".crud-edit-btn")!.addEventListener("click", (e) => {
      e.stopPropagation();
      editLayout(layout.name);
    });

    card.querySelector(".crud-delete-btn")!.addEventListener("click", async (e) => {
      e.stopPropagation();
      const confirmed = await confirmAction(`Delete layout "${layout.name}"?`);
      if (!confirmed) return;
      await window.yo.layoutsDelete(layout.name);
      loadLayouts();
    });

    card.addEventListener("click", () => editLayout(layout.name));
    layoutsList.appendChild(card);
  }

  layoutsList.appendChild(renderPaginationBar(state, (p) => { layoutsPage = p; renderLayoutsList(); }));
}

async function editLayout(name: string) {
  editingLayoutName = name;
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
  } else {
    builderCols = 2;
    builderRows = 1;
    initBuilderCells();
  }
  gridColsSelect.value = String(builderCols);
  gridRowsSelect.value = String(builderRows);
  folderModeSelect.value = (layout as any)?.folderMode === "multi" ? "multi" : "single";
  layoutNameInput.value = name;
  layoutDeleteBtn.style.display = "";
  layoutFormError.classList.add("hidden");

  layoutGridBuilder.classList.remove("hidden");

  layoutsList.classList.add("hidden");
  layoutsToolbar.classList.add("hidden");
  layoutEditor.classList.remove("hidden");
  renderGridPreview();
}

async function newLayout() {
  editingLayoutName = null;
  builderCols = 2;
  builderRows = 1;
  initBuilderCells();
  gridColsSelect.value = "2";
  gridRowsSelect.value = "1";
  folderModeSelect.value = "single";
  layoutNameInput.value = "";
  layoutDeleteBtn.style.display = "none";
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
  const confirmed = await confirmAction(`Delete layout "${editingLayoutName}"?`);
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
