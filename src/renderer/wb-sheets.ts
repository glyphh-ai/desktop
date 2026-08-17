/**
 * wb-sheets.ts — the SHEETS workbench panel (Glyphh Office).
 *
 * A workbook rendered as a real grid: sticky headers, sheet tabs, click a
 * cell to edit a value or a formula (=SUM(B2:B9), arithmetic, A1 refs —
 * the SHARED engine recalculates before every save), click a column header
 * to sort (persisted), ＋ Row appends, CSV exports client-side. AI columns
 * wear a ✦ badge carrying their prompt — the AGENT materializes those
 * values (fill_column); nothing evaluates prompts at render time.
 *
 * Library → workbook; all transitions re-render in place (never the rails).
 */

import { officePager, officePage } from "./wb-office-ui.js";
import { recalcWorkbook, cellValue, isFormulaCell, colLetter, type Workbook, type Worksheet, type SheetCell } from "../shared/sheets-engine.js";

export interface GSheetMeta { file: string; title: string; sheets: number; totalRows: number; size: number; folderId: string | null; mtime: number }

export interface GSheetSlotState {
  id: number;
  file?: string;
  title?: string;
  /** Active worksheet tab + row page — survive re-renders. */
  tab?: number;
  rowPage?: number;
  page?: number;
  /** Sorted column + direction (view state; the sort itself persists in rows). */
  sortCol?: number;
  sortDesc?: boolean;
}

export interface GSheetHost {
  confirm: (opts: { title: string; body?: string; confirmLabel?: string; danger?: boolean }) => Promise<boolean>;
  icon: string;
}

const api = () => (window as unknown as { glyphh?: {
  gsheetList?: () => Promise<{ ok: boolean; sheets: GSheetMeta[]; error?: string }>;
  gsheetRead?: (file: string) => Promise<{ ok: boolean; title?: string; workbook?: unknown; error?: string }>;
  gsheetWrite?: (file: string, title: string, workbook: unknown) => Promise<{ ok: boolean; file?: string; title?: string; error?: string }>;
  gsheetDelete?: (file: string) => Promise<{ ok: boolean; error?: string }>;
} }).glyphh ?? {};

const wbCache = new Map<string, { title: string; workbook: Workbook }>();
async function loadWorkbook(file: string): Promise<{ title: string; workbook: Workbook } | null> {
  const hit = wbCache.get(file);
  if (hit) return hit;
  const res = await api().gsheetRead?.(file);
  if (!res?.ok || !res.workbook) return null;
  const entry = { title: res.title || file, workbook: res.workbook as Workbook };
  wbCache.set(file, entry);
  return entry;
}

interface PopItem { label: string; danger?: boolean; fn: () => void }
function popMenu(x: number, y: number, items: PopItem[]): void {
  document.querySelectorAll(".gsheet-menu").forEach((el) => el.remove());
  const menu = document.createElement("div");
  menu.className = "ws-popover gsheet-menu";
  for (const it of items) {
    const b = document.createElement("button");
    b.className = "ws-popover-item" + (it.danger ? " danger" : "");
    b.textContent = it.label;
    b.addEventListener("click", () => { close(); it.fn(); });
    menu.appendChild(b);
  }
  document.body.appendChild(menu);
  menu.style.top = `${Math.min(y, window.innerHeight - menu.offsetHeight - 8)}px`;
  menu.style.left = `${Math.min(x, window.innerWidth - menu.offsetWidth - 8)}px`;
  const onDoc = (ev: MouseEvent): void => { if (!menu.contains(ev.target as Node)) close(); };
  const close = (): void => { menu.remove(); document.removeEventListener("mousedown", onDoc, true); };
  document.addEventListener("mousedown", onDoc, true);
}

const fmtCell = (c: SheetCell, type?: string): string => {
  const v = cellValue(c);
  if (v === null || v === "") return "";
  if (typeof v === "number") {
    if (type === "currency") return v.toLocaleString(undefined, { style: "currency", currency: "USD" });
    return v.toLocaleString(undefined, { maximumFractionDigits: 6 });
  }
  return String(v);
};

export interface GSheetPanel {
  renderIntoSlot: (body: HTMLElement, slot: GSheetSlotState, wrap: HTMLElement) => Promise<void>;
  invalidate: (file: string) => void;
}

export function initGSheets(host: GSheetHost): GSheetPanel {

  async function renderIntoSlot(body: HTMLElement, slot: GSheetSlotState, wrap: HTMLElement): Promise<void> {
    try {
      await renderInner(body, slot, wrap);
    } catch (err) {
      console.warn("[gsheet] render failed:", err);
      if (body.isConnected) {
        body.innerHTML = `<div class="gdoc-empty">Sheets hit an error rendering.<br><code class="gpoint-err"></code></div>`;
        const code = body.querySelector(".gpoint-err");
        if (code) code.textContent = err instanceof Error ? err.message : String(err);
      }
    }
  }

  async function renderInner(body: HTMLElement, slot: GSheetSlotState, wrap: HTMLElement): Promise<void> {
    body.classList.add("ws-gsheet-body");
    const refresh = (): void => { if (body.isConnected) void renderIntoSlot(body, slot, wrap); };
    const titleEl = wrap.querySelector(".ws-rail-slot-header .title");
    if (titleEl) titleEl.textContent = slot.file ? (slot.title || "Sheets") : "Sheets";
    if (!slot.file) { await renderLibrary(body, slot, refresh); return; }
    await renderWorkbook(body, slot, refresh);
  }

  // ── LIBRARY ────────────────────────────────────────────────────────────────

  async function renderLibrary(body: HTMLElement, slot: GSheetSlotState, refresh: () => void): Promise<void> {
    body.innerHTML = `
      <div class="gdoc-lib">
        <div class="office-toolbar">
          <input class="office-search" type="text" placeholder="Search workbooks…" spellcheck="false" autocomplete="off" />
          <button class="action-btn primary office-new">＋ New</button>
          <button class="ws-icon-btn office-refresh" title="Refresh">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-2.6-6.3"/><polyline points="21 3 21 9 15 9"/></svg>
          </button>
        </div>
        <div class="office-grid"></div>
        <div class="gdoc-empty hidden">No workbooks yet.<br>＋ New starts one, or ask Glyphh — "make me a sheet of…".</div>
      </div>`;
    body.querySelector(".office-refresh")?.addEventListener("click", refresh);

    const openSheet = (m: { file: string; title: string }): void => {
      slot.file = m.file;
      slot.title = m.title;
      slot.tab = 0;
      slot.rowPage = 0;
      refresh();
    };

    body.querySelector(".office-new")?.addEventListener("click", () => {
      void (async () => {
        const list = await api().gsheetList?.();
        const taken = new Set((list?.ok ? list.sheets : []).map((m) => m.file));
        let stem = "untitled", n = 2;
        while (taken.has(`${stem}.json`)) stem = `untitled-${n++}`;
        const blank: Workbook = {
          sheets: [{
            name: "Sheet1",
            columns: [{ name: "Column 1" }, { name: "Column 2" }, { name: "Column 3" }],
            rows: Array.from({ length: 8 }, () => [null, null, null]),
          }],
        };
        const w = await api().gsheetWrite?.(stem, "Untitled", blank);
        if (!w?.ok) { void host.confirm({ title: "Couldn't create the workbook", body: w?.error || "Unknown error.", confirmLabel: "OK" }); return; }
        wbCache.set(w.file || `${stem}.json`, { title: w.title || "Untitled", workbook: blank });
        openSheet({ file: w.file || `${stem}.json`, title: w.title || "Untitled" });
      })();
    });

    const grid = body.querySelector<HTMLElement>(".office-grid")!;
    const empty = body.querySelector<HTMLElement>(".gdoc-empty");
    const res = await api().gsheetList?.();
    if (!body.isConnected) return;
    if (!res || !Array.isArray(res.sheets) || (!res.ok && !res.sheets.length)) {
      if (empty) {
        empty.innerHTML = res && !res.ok ? `Couldn't load the library.<br>${res.error ?? "Unknown error."}` : "This surface has no workbook library.";
        empty.classList.remove("hidden");
      }
      return;
    }
    const sheets = res.sheets;
    const PER_PAGE = 18;
    const paint = (query: string): void => {
      grid.textContent = "";
      body.querySelector(".office-pager")?.remove();
      const q = query.toLowerCase();
      const matches = sheets.filter((m) => !q || m.title.toLowerCase().includes(q) || m.file.toLowerCase().includes(q));
      empty?.classList.toggle("hidden", matches.length > 0 || sheets.length === 0);
      if (!sheets.length) empty?.classList.remove("hidden");
      const paged = officePage(matches, q ? 0 : (slot.page ?? 0), PER_PAGE);
      if (!q) slot.page = paged.page;
      const pager = officePager(matches.length, paged.page, PER_PAGE, (pg) => { slot.page = pg; paint(query); });
      if (pager && !q) grid.parentElement?.appendChild(pager);
      for (const m of paged.items) {
        const card = document.createElement("div");
        card.className = "gdrive-card";
        card.innerHTML = `
          <div class="gpoint-thumb gdrive-thumb"><div class="gpoint-thumb-ph">${host.icon}</div></div>
          <div class="gdrive-card-row">
            <span class="gdrive-card-title"></span>
            <button class="ws-icon-btn office-card-kebab" title="Options">
              <svg viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="5" r="1.9"/><circle cx="12" cy="12" r="1.9"/><circle cx="12" cy="19" r="1.9"/></svg>
            </button>
          </div>
          <span class="gdrive-card-meta">${m.sheets} sheet${m.sheets === 1 ? "" : "s"} · ${m.totalRows} rows</span>`;
        (card.querySelector(".gdrive-card-title") as HTMLElement).textContent = m.title || m.file;
        mountSheetThumb(card.querySelector<HTMLElement>(".gdrive-thumb")!, m.file);
        card.addEventListener("click", (ev) => {
          if ((ev.target as HTMLElement).closest(".office-card-kebab")) return;
          openSheet(m);
        });
        card.querySelector(".office-card-kebab")?.addEventListener("click", (ev) => {
          ev.stopPropagation();
          const r = (ev.currentTarget as HTMLElement).getBoundingClientRect();
          popMenu(r.right - 150, r.bottom + 4, [
            { label: "Open", fn: () => openSheet(m) },
            { label: "Delete…", danger: true, fn: () => void (async () => {
              const ok = await host.confirm({ title: `Delete “${m.title || m.file}”?`, body: "Removed for the whole org. This can't be undone.", confirmLabel: "Delete", danger: true });
              if (!ok) return;
              await api().gsheetDelete?.(m.file);
              wbCache.delete(m.file);
              refresh();
            })() },
          ]);
        });
        grid.appendChild(card);
      }
    };
    const search = body.querySelector<HTMLInputElement>(".office-search")!;
    let debounce = 0;
    search.addEventListener("keydown", (e) => e.stopPropagation());
    search.addEventListener("input", () => {
      window.clearTimeout(debounce);
      debounce = window.setTimeout(() => paint(search.value.trim()), 160);
    });
    paint("");
  }

  // ── WORKBOOK ───────────────────────────────────────────────────────────────

  async function renderWorkbook(body: HTMLElement, slot: GSheetSlotState, refresh: () => void): Promise<void> {
    const file = slot.file!;
    const entry = await loadWorkbook(file);
    if (!body.isConnected) return;
    if (!entry) {
      slot.file = undefined; slot.title = undefined;
      await renderLibrary(body, slot, refresh);
      return;
    }
    const wb = entry.workbook;
    const tab = Math.max(0, Math.min(wb.sheets.length - 1, slot.tab ?? 0));
    slot.tab = tab;
    const sheet: Worksheet = wb.sheets[tab]!;
    const ROWS_PER = 50;

    // ── LOCAL-FIRST writes: edits mutate + recalc IN MEMORY and repaint only
    // the rows; the server save rides a debounce in the background. A full
    // panel refresh on every keystroke is what made editing jerky.
    let saveTimer = 0;
    let saving = false;
    let dirty = false;
    const saveNow = async (): Promise<void> => {
      if (saving) { dirty = true; return; }
      saving = true;
      dirty = false;
      const w = await api().gsheetWrite?.(file, slot.title || entry.title, wb);
      saving = false;
      if (!w?.ok) {
        void host.confirm({ title: "Couldn't save the workbook", body: w?.error || "Unknown error.", confirmLabel: "OK" });
        wbCache.delete(file);
        return;
      }
      wbCache.set(file, { title: slot.title || entry.title, workbook: wb });
      if (dirty) void saveNow();   // edits landed mid-save — one trailing save
    };
    const scheduleSave = (): void => {
      window.clearTimeout(saveTimer);
      saveTimer = window.setTimeout(() => void saveNow(), 700);
    };
    const flushSave = (): void => {
      window.clearTimeout(saveTimer);
      void saveNow();
    };

    body.innerHTML = `
      <div class="gsheet">
        <div class="gdoc-bar">
          <button class="gpoint-back gsheet-back" title="Back to Sheets">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 6 9 12 15 18"/></svg>
            <span>Sheets</span>
          </button>
          <input class="gpoint-reader-title gsheet-title" spellcheck="false" autocomplete="off" title="Click to rename" />
          <button class="action-btn gsheet-addrow">＋ Row</button>
          <button class="action-btn gsheet-csv">Export CSV</button>
        </div>
        <div class="gsheet-tabs${wb.sheets.length > 1 ? "" : " hidden"}"></div>
        <div class="gsheet-scroll"><table class="gsheet-table"><thead></thead><tbody></tbody></table></div>
        <div class="gsheet-foot"></div>
      </div>`;

    body.querySelector(".gsheet-back")?.addEventListener("click", () => {
      flushSave();
      slot.file = undefined; slot.title = undefined;
      refresh();
    });

    const titleInput = body.querySelector<HTMLInputElement>(".gsheet-title")!;
    titleInput.value = slot.title || entry.title;
    titleInput.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Enter") { e.preventDefault(); titleInput.blur(); }
      else if (e.key === "Escape") { titleInput.value = slot.title || entry.title; titleInput.blur(); }
    });
    titleInput.addEventListener("blur", () => {
      const next = titleInput.value.trim();
      if (!next || next === (slot.title || entry.title)) { titleInput.value = slot.title || entry.title; return; }
      slot.title = next;
      flushSave();
    });

    body.querySelector(".gsheet-addrow")?.addEventListener("click", () => {
      sheet.rows.push(sheet.columns.map(() => null));
      slot.rowPage = Math.floor((sheet.rows.length - 1) / ROWS_PER);
      paintRows();
      scheduleSave();
    });

    body.querySelector(".gsheet-csv")?.addEventListener("click", () => {
      const esc = (v: string): string => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
      const lines = [
        sheet.columns.map((c) => esc(c.name)).join(","),
        ...sheet.rows.map((r) => sheet.columns.map((_c, i) => esc(String(cellValue(r[i] ?? null) ?? ""))).join(",")),
      ];
      const blob = new Blob([lines.join("\n")], { type: "text/csv" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `${(slot.title || entry.title).replace(/[\\/:]/g, "-")}.csv`;
      a.click();
      URL.revokeObjectURL(a.href);
    });

    // Sheet tabs.
    const tabs = body.querySelector<HTMLElement>(".gsheet-tabs")!;
    wb.sheets.forEach((ws, i) => {
      const t = document.createElement("button");
      t.className = "gsheet-tab" + (i === tab ? " active" : "");
      t.textContent = ws.name;
      t.addEventListener("click", () => { flushSave(); slot.tab = i; slot.rowPage = 0; refresh(); });
      tabs.appendChild(t);
    });

    // ── Header: visible sort state, double-click rename, right-click ops. ──
    const thead = body.querySelector<HTMLElement>("thead")!;

    const applySort = (i: number, desc: boolean): void => {
      slot.sortCol = i;
      slot.sortDesc = desc;
      const val = (row: SheetCell[]): string | number => {
        const v = cellValue(row[i] ?? null);
        return typeof v === "number" ? v : String(v ?? "").toLowerCase();
      };
      sheet.rows.sort((x, y) => {
        const vx = val(x), vy = val(y);
        const cmp = typeof vx === "number" && typeof vy === "number" ? vx - vy : String(vx).localeCompare(String(vy));
        return desc ? -cmp : cmp;
      });
      paintHeader();
      paintRows();
      scheduleSave();
    };

    const addColumn = (at: number): void => {
      sheet.columns.splice(at, 0, { name: `Column ${sheet.columns.length + 1}` });
      sheet.rows.forEach((r) => { if (r.length >= at) r.splice(at, 0, null); });
      slot.sortCol = undefined;
      paintHeader();
      paintRows();
      scheduleSave();
    };

    const removeColumn = (i: number): void => {
      void (async () => {
        if (sheet.columns.length <= 1) {
          void host.confirm({ title: "Can't delete the last column", body: "A sheet needs at least one column.", confirmLabel: "OK" });
          return;
        }
        const ok = await host.confirm({ title: `Delete column “${sheet.columns[i]!.name}”?`, body: "Its values are removed from every row.", confirmLabel: "Delete", danger: true });
        if (!ok) return;
        sheet.columns.splice(i, 1);
        sheet.rows.forEach((r) => { if (r.length > i) r.splice(i, 1); });
        slot.sortCol = undefined;
        paintHeader();
        paintRows();
        scheduleSave();
      })();
    };

    const renameColumn = (i: number, th: HTMLElement): void => {
      const nameEl = th.querySelector<HTMLElement>(".gsheet-col-name");
      if (!nameEl || th.querySelector("input")) return;
      const input = document.createElement("input");
      input.className = "gsheet-cell-input";
      input.value = sheet.columns[i]!.name;
      input.spellcheck = false;
      nameEl.replaceWith(input);
      input.focus(); input.select();
      let done = false;
      const commit = (write: boolean): void => {
        if (done) return;
        done = true;
        const next = input.value.trim();
        if (write && next) sheet.columns[i]!.name = next;
        paintHeader();
        if (write && next) scheduleSave();
      };
      input.addEventListener("keydown", (e) => {
        e.stopPropagation();
        if (e.key === "Enter") { e.preventDefault(); commit(true); }
        else if (e.key === "Escape") commit(false);
      });
      input.addEventListener("blur", () => commit(true));
      input.addEventListener("click", (e) => e.stopPropagation());
      input.addEventListener("mousedown", (e) => e.stopPropagation());
    };

    function paintHeader(): void {
      thead.textContent = "";
      const headRow = document.createElement("tr");
      const corner = document.createElement("th");
      corner.className = "gsheet-corner";
      headRow.appendChild(corner);
      sheet.columns.forEach((c, i) => {
        const th = document.createElement("th");
        th.className = "gsheet-col";
        const sorted = slot.sortCol === i;
        th.title = `${c.aiPrompt ? `AI column — ${c.aiPrompt}\n` : ""}${colLetter(i)} — click to sort, double-click to rename, right-click for more`;
        th.innerHTML = `<span class="gsheet-col-name"></span>${c.aiPrompt ? `<span class="gsheet-ai">✦</span>` : ""}<span class="gsheet-sort${sorted ? " active" : ""}">${sorted ? (slot.sortDesc ? "▼" : "▲") : "↕"}</span>`;
        (th.querySelector(".gsheet-col-name") as HTMLElement).textContent = c.name;
        th.addEventListener("click", () => applySort(i, slot.sortCol === i ? !slot.sortDesc : false));
        th.addEventListener("dblclick", (e) => { e.stopPropagation(); renameColumn(i, th); });
        th.addEventListener("contextmenu", (e) => {
          e.preventDefault();
          e.stopPropagation();
          popMenu(e.clientX, e.clientY, [
            { label: "Rename column…", fn: () => renameColumn(i, th) },
            { label: "Add column left", fn: () => addColumn(i) },
            { label: "Add column right", fn: () => addColumn(i + 1) },
            { label: "Sort A → Z", fn: () => applySort(i, false) },
            { label: "Sort Z → A", fn: () => applySort(i, true) },
            { label: "Delete column…", danger: true, fn: () => removeColumn(i) },
          ]);
        });
        headRow.appendChild(th);
      });
      thead.appendChild(headRow);
    }
    paintHeader();

    // ── Row ops (right-click any cell or the row number). ──
    const insertRow = (at: number): void => {
      sheet.rows.splice(at, 0, sheet.columns.map(() => null));
      paintRows();
      scheduleSave();
    };
    const deleteRow = (i: number): void => {
      sheet.rows.splice(i, 1);
      paintRows();
      scheduleSave();
    };
    const rowMenu = (e: MouseEvent, i: number): void => {
      e.preventDefault();
      e.stopPropagation();
      popMenu(e.clientX, e.clientY, [
        { label: "Add row above", fn: () => insertRow(i) },
        { label: "Add row below", fn: () => insertRow(i + 1) },
        { label: "Delete row", danger: true, fn: () => deleteRow(i) },
      ]);
    };

    const tbody = body.querySelector<HTMLElement>("tbody")!;
    const foot = body.querySelector<HTMLElement>(".gsheet-foot")!;

    const paintCellTd = (td: HTMLElement, cell: SheetCell, type?: string): void => {
      td.textContent = fmtCell(cell, type);
      td.classList.toggle("gsheet-formula", isFormulaCell(cell));
      td.classList.toggle("gsheet-num", typeof cellValue(cell) === "number");
      if (isFormulaCell(cell)) td.title = cell.f; else td.removeAttribute("title");
    };

    /** Open the inline editor on (row, col); Enter moves down, Tab right. */
    const openEditor = (ri: number, ci: number): void => {
      const td = tbody.querySelector<HTMLElement>(`td[data-r="${ri}"][data-c="${ci}"]`);
      if (!td || td.querySelector("input")) return;
      const row = sheet.rows[ri]!;
      const cell = row[ci] ?? null;
      const input = document.createElement("input");
      input.className = "gsheet-cell-input";
      input.value = isFormulaCell(cell) ? cell.f : String(cellValue(cell) ?? "");
      input.spellcheck = false;
      td.textContent = "";
      td.appendChild(input);
      input.focus(); input.select();
      let done = false;
      const commit = (write: boolean, then?: "down" | "right" | "left"): void => {
        if (done) return;
        done = true;
        if (!write) {
          paintCellTd(td, row[ci] ?? null, sheet.columns[ci]?.type);
          return;
        }
        const raw = input.value.trim();
        let next: SheetCell;
        if (raw === "") next = null;
        else if (raw.startsWith("=")) next = { f: raw };
        else if (Number.isFinite(Number(raw.replace(/[$,]/g, "")))) next = Number(raw.replace(/[$,]/g, ""));
        else next = raw;
        while (row.length <= ci) row.push(null);
        row[ci] = next;
        // Local recalc, then repaint ONLY this cell + every formula cell.
        recalcWorkbook(wb);
        paintCellTd(td, row[ci] ?? null, sheet.columns[ci]?.type);
        tbody.querySelectorAll<HTMLElement>("td[data-r]").forEach((el) => {
          const r = Number(el.dataset.r), c = Number(el.dataset.c);
          const cc = sheet.rows[r]?.[c] ?? null;
          if (isFormulaCell(cc)) paintCellTd(el, cc, sheet.columns[c]?.type);
        });
        scheduleSave();
        if (then === "down" && ri + 1 < sheet.rows.length) openEditor(ri + 1, ci);
        else if (then === "right" && ci + 1 < sheet.columns.length) openEditor(ri, ci + 1);
        else if (then === "left" && ci > 0) openEditor(ri, ci - 1);
      };
      input.addEventListener("keydown", (e) => {
        e.stopPropagation();
        if (e.key === "Enter") { e.preventDefault(); commit(true, "down"); }
        else if (e.key === "Tab") { e.preventDefault(); commit(true, e.shiftKey ? "left" : "right"); }
        else if (e.key === "Escape") commit(false);
      });
      // Blur (clicking elsewhere) commits IN PLACE — no re-render, so a click
      // on another cell lands on a stable target and opens its own editor.
      input.addEventListener("blur", () => commit(true));
    };

    function paintRows(): void {
      tbody.textContent = "";
      foot.textContent = "";
      const paged = officePage(sheet.rows.map((r, i) => ({ r, i })), slot.rowPage ?? 0, ROWS_PER);
      slot.rowPage = paged.page;
      for (const { r, i } of paged.items) {
        const tr = document.createElement("tr");
        const num = document.createElement("td");
        num.className = "gsheet-rownum";
        num.textContent = String(i + 1);
        num.addEventListener("contextmenu", (e) => rowMenu(e, i));
        tr.appendChild(num);
        sheet.columns.forEach((c, ci) => {
          const td = document.createElement("td");
          td.dataset.r = String(i);
          td.dataset.c = String(ci);
          paintCellTd(td, r[ci] ?? null, c.type);
          td.addEventListener("mousedown", (ev) => {
            // mousedown (not click): the previous editor's blur-commit runs
            // without a repaint, so THIS cell is still there to receive it.
            if (ev.button !== 0) return;
            ev.preventDefault();
            openEditor(i, ci);
          });
          td.addEventListener("contextmenu", (e) => rowMenu(e, i));
          tr.appendChild(td);
        });
        tbody.appendChild(tr);
      }
      const pager = officePager(sheet.rows.length, paged.page, ROWS_PER, (pg) => { slot.rowPage = pg; paintRows(); });
      if (pager) foot.appendChild(pager);
    }
    paintRows();
  }

  return { renderIntoSlot, invalidate: (file) => { wbCache.delete(file); } };
}

// ── The library/Drive thumbnail: a mini table of the first rows. ─────────────
const thumbCache = new Map<string, Workbook>();
export function mountSheetThumb(thumb: HTMLElement, file: string): void {
  const paint = (wb: Workbook): void => {
    if (!thumb.isConnected) return;
    const sheet = wb.sheets[0];
    if (!sheet) return;
    const box = document.createElement("div");
    box.className = "gsheet-thumbbox";
    const table = document.createElement("table");
    const tr = document.createElement("tr");
    for (const c of sheet.columns.slice(0, 5)) {
      const th = document.createElement("th");
      th.textContent = c.name;
      tr.appendChild(th);
    }
    table.appendChild(tr);
    for (const row of sheet.rows.slice(0, 6)) {
      const trr = document.createElement("tr");
      for (let i = 0; i < Math.min(5, sheet.columns.length); i++) {
        const td = document.createElement("td");
        td.textContent = fmtCell(row[i] ?? null, sheet.columns[i]?.type);
        trr.appendChild(td);
      }
      table.appendChild(trr);
    }
    box.appendChild(table);
    thumb.appendChild(box);
  };
  const hit = thumbCache.get(file);
  if (hit) { queueMicrotask(() => paint(hit)); return; }
  void api().gsheetRead?.(file).then((res) => {
    if (!res?.ok || !res.workbook) return;
    thumbCache.set(file, res.workbook as Workbook);
    paint(res.workbook as Workbook);
  });
}
export function invalidateSheetThumb(file: string): void {
  thumbCache.delete(file);
}
