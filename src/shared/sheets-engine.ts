/**
 * sheets-engine.ts — the ONE Glyphh Sheets formula engine, shared by the
 * renderer panel and the main-process tools (src/shared, both bundles).
 *
 * Deliberately tiny (deterministic control): arithmetic (+ - * /, parens),
 * A1 cell refs, and SUM/AVG/COUNT/MIN/MAX over rectangular ranges. No eval,
 * a real micro-parser. Errors materialize as "#ERR: …" values — a sheet
 * never throws. Formula cells are evaluated in row-major order and refs read
 * MATERIALIZED values, so a formula referencing a LATER formula sees its
 * previous value — keep totals last (documented in the tools/skill).
 */

export type SheetCell = string | number | null | { f: string; v?: string | number | null };
export interface SheetColumn {
  name: string;
  type?: "text" | "number" | "date" | "currency";
  aiPrompt?: string;
}
export interface Worksheet { name: string; columns: SheetColumn[]; rows: SheetCell[][] }
export interface Workbook { sheets: Worksheet[] }

export const isFormulaCell = (c: SheetCell): c is { f: string; v?: string | number | null } =>
  typeof c === "object" && c !== null && typeof (c as { f?: unknown }).f === "string";

/** A cell's display/compute value (formula cells read their materialized v). */
export function cellValue(c: SheetCell): string | number | null {
  if (c === null || c === undefined) return null;
  if (isFormulaCell(c)) return c.v ?? null;
  return c;
}

/** 0-based column index → A1 letters. */
export function colLetter(i: number): string {
  let s = "";
  for (let n = i; n >= 0; n = Math.floor(n / 26) - 1) {
    s = String.fromCharCode(65 + (n % 26)) + s;
  }
  return s;
}

/** "B3" → { col: 1, row: 2 } (0-based), or null. */
export function parseA1(ref: string): { col: number; row: number } | null {
  const m = /^([A-Z]+)([0-9]+)$/i.exec(ref.trim());
  if (!m) return null;
  let col = 0;
  for (const ch of m[1]!.toUpperCase()) col = col * 26 + (ch.charCodeAt(0) - 64);
  const row = parseInt(m[2]!, 10);
  if (row < 1) return null;
  return { col: col - 1, row: row - 1 };
}

const num = (v: string | number | null): number | null => {
  if (v === null || v === "") return null;
  const n = typeof v === "number" ? v : Number(String(v).replace(/[$,]/g, ""));
  return Number.isFinite(n) ? n : null;
};

type Tok = { t: "num"; v: number } | { t: "ref"; v: string } | { t: "fn"; v: string } | { t: "op"; v: string };

function tokenize(src: string): Tok[] {
  const toks: Tok[] = [];
  const re = /\s*(?:([0-9]*\.?[0-9]+)|([A-Za-z]+[0-9]+)|([A-Za-z]+)(?=\()|([+\-*/():]))/gy;
  let m: RegExpExecArray | null;
  let last = 0;
  while ((m = re.exec(src))) {
    last = re.lastIndex;
    if (m[1] !== undefined) toks.push({ t: "num", v: Number(m[1]) });
    else if (m[2] !== undefined) toks.push({ t: "ref", v: m[2].toUpperCase() });
    else if (m[3] !== undefined) toks.push({ t: "fn", v: m[3].toUpperCase() });
    else if (m[4] !== undefined) toks.push({ t: "op", v: m[4] });
  }
  if (last < src.trim().length && src.slice(last).trim()) throw new Error(`can't read "${src.slice(last).trim().slice(0, 12)}"`);
  return toks;
}

const AGGS = new Set(["SUM", "AVG", "AVERAGE", "COUNT", "MIN", "MAX"]);

/** Evaluate "=…" against a sheet. Throws with a human message on bad input. */
export function evalFormula(sheet: Worksheet, formula: string): number {
  const src = formula.replace(/^=/, "");
  const toks = tokenize(src);
  let i = 0;
  const peek = (): Tok | undefined => toks[i];
  const take = (): Tok => {
    const t = toks[i++];
    if (!t) throw new Error("unexpected end of formula");
    return t;
  };
  const refValue = (ref: string): number => {
    const rc = parseA1(ref);
    if (!rc) throw new Error(`bad ref ${ref}`);
    const cell = sheet.rows[rc.row]?.[rc.col];
    const n = num(cellValue(cell ?? null));
    return n ?? 0;
  };
  const rangeValues = (a: string, b: string): number[] => {
    const ra = parseA1(a), rb = parseA1(b);
    if (!ra || !rb) throw new Error(`bad range ${a}:${b}`);
    const vals: number[] = [];
    for (let r = Math.min(ra.row, rb.row); r <= Math.max(ra.row, rb.row); r++) {
      for (let c = Math.min(ra.col, rb.col); c <= Math.max(ra.col, rb.col); c++) {
        const n = num(cellValue(sheet.rows[r]?.[c] ?? null));
        if (n !== null) vals.push(n);
      }
    }
    return vals;
  };
  const primary = (): number => {
    const t = take();
    if (t.t === "num") return t.v;
    if (t.t === "ref") return refValue(t.v);
    if (t.t === "op" && t.v === "(") {
      const v = expr();
      const close = take();
      if (close.t !== "op" || close.v !== ")") throw new Error("missing )");
      return v;
    }
    if (t.t === "op" && t.v === "-") return -primary();
    if (t.t === "fn") {
      if (!AGGS.has(t.v)) throw new Error(`unknown function ${t.v}`);
      const open = take();
      if (open.t !== "op" || open.v !== "(") throw new Error(`${t.v} needs (range)`);
      const a = take();
      const colon = take();
      const b = take();
      const close = take();
      if (a.t !== "ref" || colon.t !== "op" || colon.v !== ":" || b.t !== "ref" || close.t !== "op" || close.v !== ")") {
        throw new Error(`${t.v} takes a range like B2:B9`);
      }
      const vals = rangeValues(a.v, b.v);
      switch (t.v) {
        case "SUM": return vals.reduce((x, y) => x + y, 0);
        case "AVG": case "AVERAGE": return vals.length ? vals.reduce((x, y) => x + y, 0) / vals.length : 0;
        case "COUNT": return vals.length;
        case "MIN": return vals.length ? Math.min(...vals) : 0;
        case "MAX": return vals.length ? Math.max(...vals) : 0;
      }
    }
    const bad = t as { t: string; v?: unknown };
    throw new Error(`unexpected ${String(bad.v ?? bad.t)}`);
  };
  const term = (): number => {
    let v = primary();
    while (peek()?.t === "op" && (peek()!.v === "*" || peek()!.v === "/")) {
      const op = take().v;
      const rhs = primary();
      v = op === "*" ? v * rhs : (rhs === 0 ? NaN : v / rhs);
    }
    return v;
  };
  const expr = (): number => {
    let v = term();
    while (peek()?.t === "op" && (peek()!.v === "+" || peek()!.v === "-")) {
      const op = take().v;
      const rhs = term();
      v = op === "+" ? v + rhs : v - rhs;
    }
    return v;
  };
  const out = expr();
  if (i < toks.length) throw new Error("trailing input");
  if (!Number.isFinite(out)) throw new Error("division by zero");
  return out;
}

/** Recompute every formula cell's materialized value, in place, row-major. */
export function recalcWorkbook(wb: Workbook): Workbook {
  for (const sheet of wb.sheets) {
    for (const row of sheet.rows) {
      for (let c = 0; c < row.length; c++) {
        const cell = row[c];
        if (!isFormulaCell(cell)) continue;
        try {
          cell.v = Math.round(evalFormula(sheet, cell.f) * 1e10) / 1e10;
        } catch (err) {
          cell.v = `#ERR: ${err instanceof Error ? err.message : String(err)}`;
        }
      }
    }
  }
  return wb;
}
