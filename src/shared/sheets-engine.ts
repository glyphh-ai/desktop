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
export interface Worksheet {
  name: string;
  columns: SheetColumn[];
  rows: SheetCell[][];
  /** Layout (optional, panel-maintained): px widths per column, px heights per row. */
  colWidths?: Array<number | null>;
  rowHeights?: Array<number | null>;
}
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

type V = number | string;

type Tok =
  | { t: "num"; v: number }
  | { t: "str"; v: string }
  | { t: "ref"; v: string }
  | { t: "fn"; v: string }
  | { t: "op"; v: string };

function tokenize(src: string): Tok[] {
  const toks: Tok[] = [];
  let i = 0;
  const n = src.length;
  while (i < n) {
    const ch = src[i]!;
    if (/\s/.test(ch)) { i++; continue; }
    if (ch === '"') {
      let out = "";
      i++;
      while (i < n) {
        if (src[i] === '"' && src[i + 1] === '"') { out += '"'; i += 2; continue; }
        if (src[i] === '"') { i++; break; }
        out += src[i]; i++;
      }
      toks.push({ t: "str", v: out });
      continue;
    }
    const num = /^[0-9]*\.?[0-9]+/.exec(src.slice(i));
    if (num && num[0]) { toks.push({ t: "num", v: Number(num[0]) }); i += num[0].length; continue; }
    const ref = /^[A-Za-z]+[0-9]+/.exec(src.slice(i));
    if (ref && !/^[A-Za-z]+[0-9]+[A-Za-z0-9]/.test(src.slice(i))) {
      toks.push({ t: "ref", v: ref[0].toUpperCase() }); i += ref[0].length; continue;
    }
    const fn = /^[A-Za-z]+(?=\()/.exec(src.slice(i));
    if (fn) { toks.push({ t: "fn", v: fn[0].toUpperCase() }); i += fn[0].length; continue; }
    const two = src.slice(i, i + 2);
    if (two === "<>" || two === "<=" || two === ">=") { toks.push({ t: "op", v: two }); i += 2; continue; }
    if ("+-*/():,=<>".includes(ch)) { toks.push({ t: "op", v: ch }); i++; continue; }
    throw new Error(`can't read "${src.slice(i, i + 12)}"`);
  }
  return toks;
}

const toNum = (v: V | null): number => {
  if (v === null || v === "") return 0;
  const n = typeof v === "number" ? v : Number(String(v).replace(/[$,]/g, ""));
  if (!Number.isFinite(n)) throw new Error(`"${String(v).slice(0, 20)}" isn't a number`);
  return n;
};
const toStr = (v: V | null): string => (v === null ? "" : typeof v === "number" ? String(v) : v);
const truthy = (v: V): boolean => (typeof v === "number" ? v !== 0 : v !== "");

/**
 * Evaluate "=…" against a sheet → number | string. The v2 grammar:
 * comparisons (= <> < > <= >=, → 1/0), arithmetic, parens, "string" literals
 * ("" escapes a quote), A1 refs, and functions with comma args (ranges allowed
 * inside aggregate args): SUM AVG/AVERAGE COUNT MIN MAX ROUND ABS CONCAT
 * UPPER LOWER TRIM LEN LEFT RIGHT MID IF. Throws with a human message.
 */
export function evalFormula(sheet: Worksheet, formula: string): V {
  const toks = tokenize(formula.replace(/^=/, ""));
  let i = 0;
  const peek = (): Tok | undefined => toks[i];
  const take = (): Tok => {
    const t = toks[i++];
    if (!t) throw new Error("unexpected end of formula");
    return t;
  };
  const expectOp = (v: string): void => {
    const t = take();
    if (t.t !== "op" || t.v !== v) throw new Error(`expected "${v}"`);
  };
  const refValue = (ref: string): V | null => {
    const rc = parseA1(ref);
    if (!rc) throw new Error(`bad ref ${ref}`);
    return cellValue(sheet.rows[rc.row]?.[rc.col] ?? null);
  };
  const rangeValues = (a: string, b: string): Array<V | null> => {
    const ra = parseA1(a), rb = parseA1(b);
    if (!ra || !rb) throw new Error(`bad range ${a}:${b}`);
    const out: Array<V | null> = [];
    for (let r = Math.min(ra.row, rb.row); r <= Math.max(ra.row, rb.row); r++) {
      for (let c = Math.min(ra.col, rb.col); c <= Math.max(ra.col, rb.col); c++) {
        out.push(cellValue(sheet.rows[r]?.[c] ?? null));
      }
    }
    return out;
  };

  /** One function argument: a range (A1:B3) or a scalar expression. */
  const arg = (): Array<V | null> => {
    const t = peek();
    if (t?.t === "ref" && toks[i + 1]?.t === "op" && toks[i + 1]!.v === ":") {
      const a = take() as { v: string };
      take();   // ':'
      const b = take();
      if (b.t !== "ref") throw new Error("a range needs refs on both sides");
      return rangeValues(a.v, b.v);
    }
    return [expr()];
  };
  const args = (): Array<V | null> => {
    expectOp("(");
    const out: Array<V | null> = [];
    if (peek()?.t === "op" && peek()!.v === ")") { take(); return out; }
    out.push(...arg());
    while (peek()?.t === "op" && peek()!.v === ",") { take(); out.push(...arg()); }
    expectOp(")");
    return out;
  };
  const nums = (vals: Array<V | null>): number[] =>
    vals.filter((v): v is V => v !== null && v !== "").map((v) => toNum(v)).filter((n) => Number.isFinite(n));

  const callFn = (name: string): V => {
    switch (name) {
      case "SUM": return nums(args()).reduce((x, y) => x + y, 0);
      case "AVG": case "AVERAGE": { const v = nums(args()); return v.length ? v.reduce((x, y) => x + y, 0) / v.length : 0; }
      case "COUNT": return nums(args()).length;
      case "MIN": { const v = nums(args()); return v.length ? Math.min(...v) : 0; }
      case "MAX": { const v = nums(args()); return v.length ? Math.max(...v) : 0; }
      case "ROUND": { const a = args(); const x = toNum(a[0] ?? 0); const d = a.length > 1 ? toNum(a[1] ?? 0) : 0; const m = 10 ** d; return Math.round(x * m) / m; }
      case "ABS": { const a = args(); return Math.abs(toNum(a[0] ?? 0)); }
      case "CONCAT": case "CONCATENATE": return args().map((v) => toStr(v)).join("");
      case "UPPER": { const a = args(); return toStr(a[0] ?? "").toUpperCase(); }
      case "LOWER": { const a = args(); return toStr(a[0] ?? "").toLowerCase(); }
      case "TRIM": { const a = args(); return toStr(a[0] ?? "").trim(); }
      case "LEN": { const a = args(); return toStr(a[0] ?? "").length; }
      case "LEFT": { const a = args(); return toStr(a[0] ?? "").slice(0, a.length > 1 ? toNum(a[1] ?? 1) : 1); }
      case "RIGHT": { const a = args(); const s2 = toStr(a[0] ?? ""); const k = a.length > 1 ? toNum(a[1] ?? 1) : 1; return k <= 0 ? "" : s2.slice(-k); }
      case "MID": { const a = args(); return toStr(a[0] ?? "").slice(Math.max(0, toNum(a[1] ?? 1) - 1), Math.max(0, toNum(a[1] ?? 1) - 1) + toNum(a[2] ?? 0)); }
      case "IF": {
        expectOp("(");
        const cond = expr();
        expectOp(",");
        const yes = expr();
        let no: V = "";
        if (peek()?.t === "op" && peek()!.v === ",") { take(); no = expr(); }
        expectOp(")");
        return truthy(cond) ? yes : no;
      }
      default: throw new Error(`unknown function ${name}`);
    }
  };

  const primary = (): V => {
    const t = take();
    if (t.t === "num") return t.v;
    if (t.t === "str") return t.v;
    if (t.t === "ref") { const v = refValue(t.v); return v === null ? 0 : v; }
    if (t.t === "fn") return callFn(t.v);
    if (t.t === "op" && t.v === "(") {
      const v = expr();
      expectOp(")");
      return v;
    }
    if (t.t === "op" && t.v === "-") return -toNum(primary());
    if (t.t === "op" && t.v === "+") return toNum(primary());
    throw new Error(`unexpected ${t.v}`);
  };
  const mul = (): V => {
    let v = primary();
    while (peek()?.t === "op" && (peek()!.v === "*" || peek()!.v === "/")) {
      const op = take().v;
      const rhs = toNum(primary());
      const lhs = toNum(v);
      if (op === "/" && rhs === 0) throw new Error("division by zero");
      v = op === "*" ? lhs * rhs : lhs / rhs;
    }
    return v;
  };
  const add = (): V => {
    let v = mul();
    while (peek()?.t === "op" && (peek()!.v === "+" || peek()!.v === "-")) {
      const op = take().v;
      const rhs = mul();
      v = op === "+" ? toNum(v) + toNum(rhs) : toNum(v) - toNum(rhs);
    }
    return v;
  };
  const expr = (): V => {
    const lhs = add();
    const t = peek();
    if (t?.t === "op" && ["=", "<>", "<", ">", "<=", ">="].includes(t.v)) {
      const op = take().v;
      const rhs = add();
      const bothNum = typeof lhs === "number" && typeof rhs === "number";
      const cmp = bothNum ? (lhs as number) - (rhs as number) : toStr(lhs).localeCompare(toStr(rhs));
      const pass = op === "=" ? cmp === 0 : op === "<>" ? cmp !== 0 : op === "<" ? cmp < 0 : op === ">" ? cmp > 0 : op === "<=" ? cmp <= 0 : cmp >= 0;
      return pass ? 1 : 0;
    }
    return lhs;
  };

  const out = expr();
  if (i < toks.length) throw new Error("trailing input");
  if (typeof out === "number" && !Number.isFinite(out)) throw new Error("not a finite number");
  return out;
}

/** Shift A1 row refs in a formula by dRow (fill-down's relative references).
 *  String literals are preserved untouched. */
export function shiftFormulaRows(formula: string, dRow: number): string {
  return formula.split(/("(?:[^"]|"")*")/).map((part, idx) => {
    if (idx % 2 === 1) return part;   // inside a string literal
    return part.replace(/([A-Za-z]+)([0-9]+)/g, (_m, col: string, row: string) => `${col}${Math.max(1, parseInt(row, 10) + dRow)}`);
  }).join("");
}

/** Recompute every formula cell's materialized value, in place, row-major. */
export function recalcWorkbook(wb: Workbook): Workbook {
  for (const sheet of wb.sheets) {
    for (const row of sheet.rows) {
      for (let c = 0; c < row.length; c++) {
        const cell = row[c];
        if (!isFormulaCell(cell)) continue;
        try {
          const v = evalFormula(sheet, cell.f);
          cell.v = typeof v === "number" ? Math.round(v * 1e10) / 1e10 : v;
        } catch (err) {
          cell.v = `#ERR: ${err instanceof Error ? err.message : String(err)}`;
        }
      }
    }
  }
  return wb;
}
