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
import { recalcWorkbook, cellValue, isFormulaCell, colLetter, shiftFormulaRows, type Workbook, type Worksheet, type SheetCell } from "../shared/sheets-engine.js";
import { renderChartSVG } from "../shared/sheets-charts.js";

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
    if (!sheet.rowHeights) sheet.rowHeights = sheet.rows.map(() => null);
    while (sheet.rowHeights.length < sheet.rows.length) sheet.rowHeights.push(null);
    if (!sheet.colWidths) sheet.colWidths = sheet.columns.map(() => null);
    while (sheet.colWidths.length < sheet.columns.length) sheet.colWidths.push(null);

    // ── LOCAL-FIRST writes + UNDO ──
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
      if (dirty) void saveNow();
    };
    const scheduleSave = (): void => {
      window.clearTimeout(saveTimer);
      saveTimer = window.setTimeout(() => void saveNow(), 700);
    };
    const flushSave = (): void => {
      window.clearTimeout(saveTimer);
      void saveNow();
    };

    const undoStack: string[] = [];
    const redoStack: string[] = [];
    const snapshot = (): string => JSON.stringify({ columns: sheet.columns, rows: sheet.rows, colWidths: sheet.colWidths, rowHeights: sheet.rowHeights });
    const pushUndo = (): void => {
      undoStack.push(snapshot());
      if (undoStack.length > 50) undoStack.shift();
      redoStack.length = 0;
    };
    const restore = (snap: string): void => {
      const d = JSON.parse(snap) as { columns: Worksheet["columns"]; rows: SheetCell[][]; colWidths: Array<number | null>; rowHeights: Array<number | null> };
      sheet.columns = d.columns;
      sheet.rows = d.rows;
      sheet.colWidths = d.colWidths;
      sheet.rowHeights = d.rowHeights;
      recalcWorkbook(wb);
      paintAll();
      scheduleSave();
    };
    const undo = (): void => {
      const snap = undoStack.pop();
      if (snap === undefined) return;
      redoStack.push(snapshot());
      restore(snap);
    };
    const redo = (): void => {
      const snap = redoStack.pop();
      if (snap === undefined) return;
      undoStack.push(snapshot());
      restore(snap);
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
        <div class="gsheet-fx">
          <span class="gsheet-fx-addr">A1</span>
          <span class="gsheet-fx-label">fx</span>
          <input class="gsheet-fx-input" spellcheck="false" autocomplete="off" placeholder='=SUM(B2:B9), =IF(C2>0,"yes","no"), =CONCAT(A2," ",B2)…' />
        </div>
        <div class="gsheet-tabs${wb.sheets.length > 1 ? "" : " hidden"}"></div>
        <div class="gsheet-scroll" tabindex="0"><table class="gsheet-table"><colgroup></colgroup><thead></thead><tbody></tbody></table></div>
        <div class="gsheet-charts"></div>
        <div class="gsheet-foot"><span class="gsheet-stats"></span><span class="gsheet-foot-pager"></span></div>
      </div>`;

    const scroll = body.querySelector<HTMLElement>(".gsheet-scroll")!;
    const colgroup = body.querySelector<HTMLElement>("colgroup")!;
    const thead = body.querySelector<HTMLElement>("thead")!;
    const tbody = body.querySelector<HTMLElement>("tbody")!;
    const statsEl = body.querySelector<HTMLElement>(".gsheet-stats")!;
    const footPager = body.querySelector<HTMLElement>(".gsheet-foot-pager")!;
    const fxAddr = body.querySelector<HTMLElement>(".gsheet-fx-addr")!;
    const fxInput = body.querySelector<HTMLInputElement>(".gsheet-fx-input")!;

    // ── SELECTION ──
    let selA: { r: number; c: number } | null = null;
    let selB: { r: number; c: number } | null = null;
    let dragging = false;
    const selRange = (): { r1: number; r2: number; c1: number; c2: number } | null => {
      if (!selA) return null;
      const b = selB ?? selA;
      return {
        r1: Math.min(selA.r, b.r), r2: Math.max(selA.r, b.r),
        c1: Math.min(selA.c, b.c), c2: Math.max(selA.c, b.c),
      };
    };
    const rawOf = (cell: SheetCell): string => (isFormulaCell(cell) ? cell.f : String(cellValue(cell) ?? ""));
    const syncFx = (): void => {
      if (!selA) { fxAddr.textContent = ""; fxInput.value = ""; return; }
      fxAddr.textContent = `${colLetter(selA.c)}${selA.r + 1}`;
      if (document.activeElement !== fxInput) {
        fxInput.value = rawOf(sheet.rows[selA.r]?.[selA.c] ?? null);
      }
    };
    const paintSel = (): void => {
      const range = selRange();
      tbody.querySelectorAll<HTMLElement>("td.sel, td.sel-anchor").forEach((el) => el.classList.remove("sel", "sel-anchor"));
      if (!range) { statsEl.textContent = ""; syncFx(); return; }
      tbody.querySelectorAll<HTMLElement>("td[data-r]").forEach((el) => {
        const r = Number(el.dataset.r), c = Number(el.dataset.c);
        if (r >= range.r1 && r <= range.r2 && c >= range.c1 && c <= range.c2) el.classList.add("sel");
        if (selA && r === selA.r && c === selA.c) el.classList.add("sel-anchor");
      });
      // Footer stats — the classic strip: rows, sum, average, count.
      const cells = (range.r2 - range.r1 + 1) * (range.c2 - range.c1 + 1);
      if (cells > 1) {
        const nums: number[] = [];
        for (let r = range.r1; r <= range.r2; r++) {
          for (let c = range.c1; c <= range.c2; c++) {
            const v = cellValue(sheet.rows[r]?.[c] ?? null);
            const n = typeof v === "number" ? v : Number(String(v ?? "").replace(/[$,]/g, ""));
            if (v !== null && v !== "" && Number.isFinite(n)) nums.push(n);
          }
        }
        const sum = nums.reduce((x, y) => x + y, 0);
        const parts = [`Rows: ${range.r2 - range.r1 + 1}`];
        if (nums.length) {
          parts.push(`Sum: ${sum.toLocaleString(undefined, { maximumFractionDigits: 4 })}`);
          parts.push(`Avg: ${(sum / nums.length).toLocaleString(undefined, { maximumFractionDigits: 4 })}`);
          parts.push(`Count: ${nums.length}`);
        }
        statsEl.textContent = parts.join("   ·   ");
      } else {
        statsEl.textContent = "";
      }
      syncFx();
    };
    const select = (r: number, c: number, extend = false): void => {
      r = Math.max(0, Math.min(sheet.rows.length - 1, r));
      c = Math.max(0, Math.min(sheet.columns.length - 1, c));
      if (extend && selA) selB = { r, c };
      else { selA = { r, c }; selB = null; }
      const page = Math.floor(r / ROWS_PER);
      if (page !== (slot.rowPage ?? 0)) { slot.rowPage = page; paintRows(); }
      paintSel();
    };

    // ── EDITING ──
    const paintCellTd = (td: HTMLElement, cell: SheetCell, type?: string): void => {
      td.textContent = fmtCell(cell, type);
      td.classList.toggle("gsheet-formula", isFormulaCell(cell));
      td.classList.toggle("gsheet-num", typeof cellValue(cell) === "number");
      if (isFormulaCell(cell)) td.title = cell.f; else td.removeAttribute("title");
    };
    const parseInput = (raw: string): SheetCell => {
      if (raw === "") return null;
      if (raw.startsWith("=")) return { f: raw };
      if (Number.isFinite(Number(raw.replace(/[$,]/g, "")))) return Number(raw.replace(/[$,]/g, ""));
      return raw;
    };
    const commitValue = (r: number, c: number, raw: string): void => {
      pushUndo();
      const row = sheet.rows[r]!;
      while (row.length <= c) row.push(null);
      row[c] = parseInput(raw.trim());
      recalcWorkbook(wb);
      tbody.querySelectorAll<HTMLElement>("td[data-r]").forEach((el) => {
        const rr = Number(el.dataset.r), cc = Number(el.dataset.c);
        const cell = sheet.rows[rr]?.[cc] ?? null;
        if ((rr === r && cc === c) || isFormulaCell(cell)) paintCellTd(el, cell, sheet.columns[cc]?.type);
      });
      paintSel();
      scheduleSave();
    };
    const openEditor = (ri: number, ci: number, initial?: string): void => {
      const td = tbody.querySelector<HTMLElement>(`td[data-r="${ri}"][data-c="${ci}"]`);
      if (!td || td.querySelector("input")) return;
      const cell = sheet.rows[ri]?.[ci] ?? null;
      const input = document.createElement("input");
      input.className = "gsheet-cell-input";
      input.value = initial !== undefined ? initial : rawOf(cell);
      input.spellcheck = false;
      td.textContent = "";
      td.appendChild(input);
      input.focus();
      if (initial === undefined) input.select();
      let done = false;
      const commit = (write: boolean, then?: "down" | "right" | "left" | "up"): void => {
        if (done) return;
        done = true;
        if (write) commitValue(ri, ci, input.value);
        else paintCellTd(td, sheet.rows[ri]?.[ci] ?? null, sheet.columns[ci]?.type);
        scroll.focus({ preventScroll: true });
        if (then === "down") select(ri + 1, ci);
        else if (then === "up") select(ri - 1, ci);
        else if (then === "right") select(ri, ci + 1);
        else if (then === "left") select(ri, ci - 1);
        else paintSel();
      };
      input.addEventListener("keydown", (e) => {
        e.stopPropagation();
        if (e.key === "Enter") { e.preventDefault(); commit(true, e.shiftKey ? "up" : "down"); }
        else if (e.key === "Tab") { e.preventDefault(); commit(true, e.shiftKey ? "left" : "right"); }
        else if (e.key === "Escape") commit(false);
      });
      input.addEventListener("blur", () => commit(true));
    };

    // ── FX BAR ──
    fxInput.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Enter") {
        e.preventDefault();
        if (selA) { commitValue(selA.r, selA.c, fxInput.value); scroll.focus({ preventScroll: true }); }
      } else if (e.key === "Escape") { syncFx(); scroll.focus({ preventScroll: true }); }
    });

    // ── CLIPBOARD + FILL + CLEAR ──
    const copySelection = (): void => {
      const range = selRange();
      if (!range) return;
      const lines: string[] = [];
      for (let r = range.r1; r <= range.r2; r++) {
        const cells: string[] = [];
        for (let c = range.c1; c <= range.c2; c++) cells.push(String(cellValue(sheet.rows[r]?.[c] ?? null) ?? ""));
        lines.push(cells.join("\t"));
      }
      void navigator.clipboard.writeText(lines.join("\n"));
    };
    const pasteAt = async (): Promise<void> => {
      if (!selA) return;
      const text = await navigator.clipboard.readText().catch(() => "");
      if (!text) return;
      pushUndo();
      const lines = text.replace(/\r/g, "").split("\n").filter((l, idx, arr) => idx < arr.length - 1 || l !== "");
      lines.forEach((line, dr) => {
        const r = selA!.r + dr;
        while (sheet.rows.length <= r) { sheet.rows.push(sheet.columns.map(() => null)); sheet.rowHeights!.push(null); }
        const row = sheet.rows[r]!;
        line.split("\t").forEach((val, dc) => {
          const c = selA!.c + dc;
          if (c >= sheet.columns.length) return;
          while (row.length <= c) row.push(null);
          row[c] = parseInput(val);
        });
      });
      recalcWorkbook(wb);
      paintRows();
      paintSel();
      scheduleSave();
    };
    const fillDown = (): void => {
      const range = selRange();
      if (!range || range.r2 === range.r1) return;
      pushUndo();
      for (let c = range.c1; c <= range.c2; c++) {
        const src = sheet.rows[range.r1]?.[c] ?? null;
        for (let r = range.r1 + 1; r <= range.r2; r++) {
          const row = sheet.rows[r]!;
          while (row.length <= c) row.push(null);
          row[c] = isFormulaCell(src) ? { f: shiftFormulaRows(src.f, r - range.r1) } : src;
        }
      }
      recalcWorkbook(wb);
      paintRows();
      paintSel();
      scheduleSave();
    };
    const clearSelection = (): void => {
      const range = selRange();
      if (!range) return;
      pushUndo();
      for (let r = range.r1; r <= range.r2; r++) {
        for (let c = range.c1; c <= range.c2; c++) {
          if (sheet.rows[r] && c < sheet.rows[r]!.length) sheet.rows[r]![c] = null;
        }
      }
      recalcWorkbook(wb);
      paintRows();
      paintSel();
      scheduleSave();
    };

    // ── GRID KEYBOARD ──
    scroll.addEventListener("keydown", (e) => {
      if (!selA) return;
      const meta = e.metaKey || e.ctrlKey;
      if (e.key.startsWith("Arrow")) {
        e.preventDefault();
        const d = e.key === "ArrowDown" ? [1, 0] : e.key === "ArrowUp" ? [-1, 0] : e.key === "ArrowRight" ? [0, 1] : [0, -1];
        const from = e.shiftKey && selB ? selB : e.shiftKey ? selA : selA;
        select(from.r + d[0]!, from.c + d[1]!, e.shiftKey);
      } else if (e.key === "Enter" || e.key === "F2") { e.preventDefault(); openEditor(selA.r, selA.c); }
      else if (e.key === "Delete" || e.key === "Backspace") { e.preventDefault(); clearSelection(); }
      else if (meta && (e.key === "c" || e.key === "C")) { e.preventDefault(); copySelection(); }
      else if (meta && (e.key === "v" || e.key === "V")) { e.preventDefault(); void pasteAt(); }
      else if (meta && (e.key === "d" || e.key === "D")) { e.preventDefault(); fillDown(); }
      else if (meta && !e.shiftKey && (e.key === "z" || e.key === "Z")) { e.preventDefault(); undo(); }
      else if (meta && (e.key === "y" || e.key === "Y" || (e.shiftKey && (e.key === "z" || e.key === "Z")))) { e.preventDefault(); redo(); }
      else if (!meta && e.key.length === 1) { e.preventDefault(); openEditor(selA.r, selA.c, e.key); }
    });
    document.addEventListener("mouseup", () => { dragging = false; }, { passive: true });

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
      pushUndo();
      sheet.rows.push(sheet.columns.map(() => null));
      sheet.rowHeights!.push(null);
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

    const tabs = body.querySelector<HTMLElement>(".gsheet-tabs")!;
    wb.sheets.forEach((ws, i) => {
      const t = document.createElement("button");
      t.className = "gsheet-tab" + (i === tab ? " active" : "");
      t.textContent = ws.name;
      t.addEventListener("click", () => { flushSave(); slot.tab = i; slot.rowPage = 0; refresh(); });
      tabs.appendChild(t);
    });

    // ── STRUCTURE OPS (menus) ──
    const applySort = (i: number, desc: boolean): void => {
      pushUndo();
      slot.sortCol = i;
      slot.sortDesc = desc;
      const val = (row: SheetCell[]): string | number => {
        const v = cellValue(row[i] ?? null);
        return typeof v === "number" ? v : String(v ?? "").toLowerCase();
      };
      // Row heights follow their rows through the sort.
      const zipped = sheet.rows.map((r, idx) => ({ r, h: sheet.rowHeights![idx] ?? null }));
      zipped.sort((x, y) => {
        const vx = val(x.r), vy = val(y.r);
        const cmp = typeof vx === "number" && typeof vy === "number" ? vx - vy : String(vx).localeCompare(String(vy));
        return desc ? -cmp : cmp;
      });
      sheet.rows = zipped.map((z) => z.r);
      sheet.rowHeights = zipped.map((z) => z.h);
      recalcWorkbook(wb);
      paintAll();
      scheduleSave();
    };
    const addColumn = (at: number): void => {
      pushUndo();
      sheet.columns.splice(at, 0, { name: `Column ${sheet.columns.length + 1}` });
      sheet.colWidths!.splice(at, 0, null);
      sheet.rows.forEach((r) => { if (r.length >= at) r.splice(at, 0, null); });
      slot.sortCol = undefined;
      paintAll();
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
        pushUndo();
        sheet.columns.splice(i, 1);
        sheet.colWidths!.splice(i, 1);
        sheet.rows.forEach((r) => { if (r.length > i) r.splice(i, 1); });
        slot.sortCol = undefined;
        selA = selB = null;
        paintAll();
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
        if (write && next && next !== sheet.columns[i]!.name) { pushUndo(); sheet.columns[i]!.name = next; scheduleSave(); }
        paintHeader();
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
    const insertRow = (at: number): void => {
      pushUndo();
      sheet.rows.splice(at, 0, sheet.columns.map(() => null));
      sheet.rowHeights!.splice(at, 0, null);
      paintRows();
      paintSel();
      scheduleSave();
    };
    const deleteRow = (i: number): void => {
      pushUndo();
      sheet.rows.splice(i, 1);
      sheet.rowHeights!.splice(i, 1);
      selA = selB = null;
      paintRows();
      paintSel();
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

    // ── COLGROUP (widths) ──
    function syncColgroup(): void {
      colgroup.textContent = "";
      const rowNumCol = document.createElement("col");
      rowNumCol.style.width = "36px";
      colgroup.appendChild(rowNumCol);
      sheet.columns.forEach((_c, i) => {
        const col = document.createElement("col");
        const w = sheet.colWidths?.[i];
        if (w) col.style.width = `${w}px`;
        colgroup.appendChild(col);
      });
    }

    // ── HEADER: letters row (coordinates + column select + resize) + names row ──
    function paintHeader(): void {
      thead.textContent = "";
      syncColgroup();

      const letters = document.createElement("tr");
      letters.className = "gsheet-letters";
      const corner0 = document.createElement("th");
      corner0.className = "gsheet-corner";
      letters.appendChild(corner0);
      sheet.columns.forEach((_c, i) => {
        const th = document.createElement("th");
        th.className = "gsheet-letter";
        th.textContent = colLetter(i);
        th.title = `Select column ${colLetter(i)}`;
        th.addEventListener("mousedown", (e) => {
          e.preventDefault();
          scroll.focus({ preventScroll: true });
          selA = { r: 0, c: i };
          selB = { r: Math.max(0, sheet.rows.length - 1), c: i };
          paintSel();
        });
        // Column resize handle on the letter cell's right edge.
        const grip = document.createElement("span");
        grip.className = "gsheet-colgrip";
        grip.addEventListener("mousedown", (e) => {
          e.preventDefault();
          e.stopPropagation();
          const startX = e.clientX;
          const startW = th.getBoundingClientRect().width;
          document.body.classList.add("gpoint-col-drag");
          const onMove = (ev: MouseEvent): void => {
            sheet.colWidths![i] = Math.round(Math.max(48, startW + (ev.clientX - startX)));
            syncColgroup();
          };
          const onUp = (): void => {
            document.removeEventListener("mousemove", onMove);
            document.removeEventListener("mouseup", onUp);
            document.body.classList.remove("gpoint-col-drag");
            scheduleSave();
          };
          document.addEventListener("mousemove", onMove);
          document.addEventListener("mouseup", onUp);
        });
        th.appendChild(grip);
        letters.appendChild(th);
      });
      thead.appendChild(letters);

      const headRow = document.createElement("tr");
      const corner = document.createElement("th");
      corner.className = "gsheet-corner";
      headRow.appendChild(corner);
      sheet.columns.forEach((c, i) => {
        const th = document.createElement("th");
        th.className = "gsheet-col";
        const sorted = slot.sortCol === i;
        th.title = `${c.aiPrompt ? `AI column — ${c.aiPrompt}\n` : ""}click to sort, double-click to rename, right-click for more`;
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

    // ── ROWS ──
    function paintRows(): void {
      tbody.textContent = "";
      footPager.textContent = "";
      const paged = officePage(sheet.rows.map((r, i) => ({ r, i })), slot.rowPage ?? 0, ROWS_PER);
      slot.rowPage = paged.page;
      for (const { r, i } of paged.items) {
        const tr = document.createElement("tr");
        const h = sheet.rowHeights?.[i];
        if (h) tr.style.height = `${h}px`;
        const num = document.createElement("td");
        num.className = "gsheet-rownum";
        num.textContent = String(i + 1);
        num.title = `Select row ${i + 1}`;
        num.addEventListener("mousedown", (e) => {
          if (e.button !== 0) return;
          e.preventDefault();
          scroll.focus({ preventScroll: true });
          selA = { r: i, c: 0 };
          selB = { r: i, c: Math.max(0, sheet.columns.length - 1) };
          paintSel();
        });
        num.addEventListener("contextmenu", (e) => rowMenu(e, i));
        // Row resize handle on the number cell's bottom edge.
        const grip = document.createElement("span");
        grip.className = "gsheet-rowgrip";
        grip.addEventListener("mousedown", (e) => {
          e.preventDefault();
          e.stopPropagation();
          const startY = e.clientY;
          const startH = tr.getBoundingClientRect().height;
          const onMove = (ev: MouseEvent): void => {
            sheet.rowHeights![i] = Math.round(Math.max(20, startH + (ev.clientY - startY)));
            tr.style.height = `${sheet.rowHeights![i]}px`;
          };
          const onUp = (): void => {
            document.removeEventListener("mousemove", onMove);
            document.removeEventListener("mouseup", onUp);
            scheduleSave();
          };
          document.addEventListener("mousemove", onMove);
          document.addEventListener("mouseup", onUp);
        });
        num.appendChild(grip);
        tr.appendChild(num);
        sheet.columns.forEach((c, ci) => {
          const td = document.createElement("td");
          td.dataset.r = String(i);
          td.dataset.c = String(ci);
          paintCellTd(td, r[ci] ?? null, c.type);
          td.addEventListener("mousedown", (ev) => {
            if (ev.button !== 0) return;
            ev.preventDefault();
            scroll.focus({ preventScroll: true });
            if (ev.shiftKey && selA) { selB = { r: i, c: ci }; paintSel(); return; }
            selA = { r: i, c: ci };
            selB = null;
            dragging = true;
            paintSel();
          });
          td.addEventListener("mouseover", () => {
            if (!dragging || !selA) return;
            selB = { r: i, c: ci };
            paintSel();
          });
          td.addEventListener("dblclick", () => openEditor(i, ci));
          td.addEventListener("contextmenu", (e) => rowMenu(e, i));
          tr.appendChild(td);
        });
        tbody.appendChild(tr);
      }
      const pager = officePager(sheet.rows.length, paged.page, ROWS_PER, (pg) => { slot.rowPage = pg; paintRows(); paintSel(); });
      if (pager) footPager.appendChild(pager);
    }

    function paintAll(): void {
      paintHeader();
      paintRows();
      paintSel();
    }
    // Charts render read-only below the grid (authoring is via add_chart). They
    // reflect the recalculated workbook, so re-render whenever the grid repaints.
    const chartsEl = body.querySelector<HTMLElement>(".gsheet-charts")!;
    function renderCharts(): void {
      const charts = sheet.charts ?? [];
      if (!charts.length) { chartsEl.innerHTML = ""; chartsEl.classList.remove("has"); return; }
      chartsEl.classList.add("has");
      chartsEl.innerHTML = charts.map((c) => {
        const svg = renderChartSVG(wb, sheet, c, true);
        return `<div class="gsheet-chart">${c.title ? `<div class="gsheet-chart-t">${c.title.replace(/[<>&]/g, "")}</div>` : ""}${svg || '<div class="gsheet-chart-empty">chart has no data</div>'}</div>`;
      }).join("");
    }
    renderCharts();
    paintAll();
    if (sheet.rows.length) select(0, 0);
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
