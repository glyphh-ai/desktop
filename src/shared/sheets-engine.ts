/**
 * sheets-engine.ts — the ONE Glyphh Sheets formula engine, shared by the
 * renderer panel and the main-process tools (src/shared, both bundles).
 *
 * v3 — deterministic control, no eval, a real micro-parser. Over v2 it adds:
 *   - a DEPENDENCY GRAPH + topological recalc (a formula may reference a later
 *     formula and still resolve correctly — "totals last" is retired), with
 *     circular-reference detection (→ "#CIRC!").
 *   - CROSS-SHEET refs (Sheet2!A1, 'My Sheet'!A1:B3) and NAMED RANGES.
 *   - a bigger function library: lookups (VLOOKUP/HLOOKUP/INDEX/MATCH),
 *     conditionals (IF/IFERROR/AND/OR/NOT), math, dates (TODAY/DATE/DATEDIF/
 *     YEAR/MONTH/DAY), text (TEXT/REGEX*), and array helpers (FILTER/UNIQUE/SORT,
 *     first-cell-scalar semantics — no true spill).
 * Errors materialize as "#ERR: …"/"#CIRC!" values — a sheet never throws.
 */

// ── model ─────────────────────────────────────────────────────────────────────
export type SheetCell = string | number | null | { f: string; v?: string | number | null };
export interface SheetColumn {
  name: string;
  type?: "text" | "number" | "date" | "currency";
  aiPrompt?: string;
}

/** A saved chart, rendered by the panel/export as self-contained SVG. */
export interface ChartSpec {
  id: string;
  type: "bar" | "line" | "area" | "pie" | "scatter" | "combo";
  title?: string;
  sheet?: string;
  categoriesRef?: string;              // A1 range for x-axis labels, e.g. "A2:A13"
  series: Array<{ name?: string; valuesRef: string; type?: ChartSpec["type"]; color?: string }>;
  legend?: boolean;
  stacked?: boolean;
  colors?: string[];
  size?: { w: number; h: number };
}

/** One conditional-formatting rule painted over a range. */
export interface CondFormat {
  id: string;
  range: string;
  kind: "colorScale" | "dataBar" | "cellRule" | "textRule" | "iconSet";
  scale?: { min: string; mid?: string; max: string };
  bar?: { color: string; negativeColor?: string };
  op?: "gt" | "lt" | "gte" | "lte" | "eq" | "neq" | "between" | "contains" | "startsWith" | "endsWith" | "isEmpty" | "notEmpty";
  value?: string | number;
  value2?: string | number;
  style?: CellStyle;
  iconSet?: "arrows" | "traffic" | "flags";
  thresholds?: number[];
}

/** A workbook-scoped named range usable in formulas. */
export interface NamedRange { name: string; sheet: string; range: string }

/** A data-validation rule for a range (panel-enforced; agent advisory). */
export interface DataValidation {
  id: string;
  range: string;
  rule:
    | { kind: "list"; source: string[] }
    | { kind: "listRange"; ref: string }
    | { kind: "number"; op: CondFormat["op"]; value?: number; value2?: number }
    | { kind: "date"; op: CondFormat["op"]; value?: string; value2?: string }
    | { kind: "textLen"; op: CondFormat["op"]; value?: number }
    | { kind: "custom"; formula: string };
  strict?: boolean;
}

/** Sparse per-cell styling, keyed by A1 address. */
export interface CellStyle {
  bold?: boolean; italic?: boolean; underline?: boolean;
  color?: string; fill?: string;
  align?: "left" | "center" | "right";
  border?: { top?: boolean; right?: boolean; bottom?: boolean; left?: boolean; color?: string };
  numberFormat?: string;
}

export interface Worksheet {
  name: string;
  columns: SheetColumn[];
  rows: SheetCell[][];
  /** Layout (optional, panel-maintained): px widths per column, px heights per row. */
  colWidths?: Array<number | null>;
  rowHeights?: Array<number | null>;
  charts?: ChartSpec[];
  condFormats?: CondFormat[];
  validations?: DataValidation[];
  styles?: Record<string, CellStyle>;
  frozen?: { rows?: number; cols?: number };
}
export interface Workbook { sheets: Worksheet[]; namedRanges?: NamedRange[] }

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

/** "B3" / "$B$3" → { col: 1, row: 2 } (0-based), or null. */
export function parseA1(ref: string): { col: number; row: number } | null {
  const m = /^\$?([A-Z]+)\$?([0-9]+)$/i.exec(ref.trim());
  if (!m) return null;
  let col = 0;
  for (const ch of m[1]!.toUpperCase()) col = col * 26 + (ch.charCodeAt(0) - 64);
  const row = parseInt(m[2]!, 10);
  if (row < 1) return null;
  return { col: col - 1, row: row - 1 };
}

type V = number | string;

// ── date serials (deterministic; days since 1970-01-01 UTC) ───────────────────
const MS_DAY = 86_400_000;
const toSerial = (y: number, m: number, d: number): number => Math.floor(Date.UTC(y, m - 1, d) / MS_DAY);
const serialToParts = (n: number): { y: number; m: number; d: number } => {
  const dt = new Date(n * MS_DAY);
  return { y: dt.getUTCFullYear(), m: dt.getUTCMonth() + 1, d: dt.getUTCDate() };
};
const parseDateSerial = (v: V | null): number | null => {
  if (v === null || v === "") return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  const m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(String(v).trim());
  return m ? toSerial(+m[1]!, +m[2]!, +m[3]!) : null;
};

// ── tokenizer ─────────────────────────────────────────────────────────────────
type Tok =
  | { t: "num"; v: number }
  | { t: "str"; v: string }
  | { t: "ref"; v: string; sheet?: string }
  | { t: "name"; v: string; sheet?: string }
  | { t: "fn"; v: string }
  | { t: "op"; v: string };

const CELL_RE = /^\$?[A-Za-z]+\$?[0-9]+$/;

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
    const numM = /^[0-9]*\.?[0-9]+/.exec(src.slice(i));
    if (numM && numM[0]) { toks.push({ t: "num", v: Number(numM[0]) }); i += numM[0].length; continue; }
    // function call: NAME immediately followed by "("
    const fn = /^[A-Za-z_][A-Za-z0-9_]*(?=\()/.exec(src.slice(i));
    if (fn) { toks.push({ t: "fn", v: fn[0].toUpperCase() }); i += fn[0].length; continue; }
    // optional sheet qualifier ('My Sheet'! or Sheet2!) then a cell ref or a name
    const idM = /^(?:('[^']+'|[A-Za-z_][A-Za-z0-9_]*)\s*!\s*)?(\$?[A-Za-z]+\$?[0-9]+|[A-Za-z_][A-Za-z0-9_]*)/.exec(src.slice(i));
    if (idM) {
      const sheet = idM[1] ? idM[1].replace(/^'|'$/g, "") : undefined;
      const body = idM[2]!;
      if (CELL_RE.test(body)) toks.push({ t: "ref", v: body.replace(/\$/g, "").toUpperCase(), sheet });
      else toks.push({ t: "name", v: body, sheet });
      i += idM[0].length;
      continue;
    }
    const two = src.slice(i, i + 2);
    if (two === "<>" || two === "<=" || two === ">=") { toks.push({ t: "op", v: two }); i += 2; continue; }
    if ("+-*/():,=<>&".includes(ch)) { toks.push({ t: "op", v: ch }); i++; continue; }
    throw new Error(`can't read "${src.slice(i, i + 12)}"`);
  }
  return toks;
}

// ── evaluation context ────────────────────────────────────────────────────────
export interface EvalCtx {
  wb?: Workbook;
  sheet: Worksheet;
  /** UTC serial for TODAY() — one value per recalc pass keeps a pass reproducible. */
  now?: number;
  /** Named ranges, keyed UPPERCASE. */
  names?: Map<string, { sheet: string; range: string }>;
}

const num = (v: string | number | null): number | null => {
  if (v === null || v === "") return null;
  const nn = typeof v === "number" ? v : Number(String(v).replace(/[$,]/g, ""));
  return Number.isFinite(nn) ? nn : null;
};
const toNum = (v: V | null): number => {
  if (v === null || v === "") return 0;
  const nn = typeof v === "number" ? v : Number(String(v).replace(/[$,]/g, ""));
  if (!Number.isFinite(nn)) throw new Error(`"${String(v).slice(0, 20)}" isn't a number`);
  return nn;
};
const toStr = (v: V | null): string => (v === null ? "" : typeof v === "number" ? String(v) : v);
const truthy = (v: V | null): boolean => (v === null ? false : typeof v === "number" ? v !== 0 : v !== "" && v !== "0" && v.toUpperCase() !== "FALSE");

/**
 * Evaluate "=…" against a sheet (or a full workbook via ctx) → number | string.
 * Back-compatible: `evalFormula(sheet, formula)` behaves like v2 for single-sheet
 * formulas; pass a ctx for cross-sheet refs, named ranges, and TODAY().
 */
export function evalFormula(sheetOrCtx: Worksheet | EvalCtx, formula: string): V {
  const ctx: EvalCtx = "sheet" in sheetOrCtx ? sheetOrCtx : { sheet: sheetOrCtx };
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
  const sheetByName = (name?: string): Worksheet => {
    if (!name) return ctx.sheet;
    const found = ctx.wb?.sheets.find((s) => s.name.toLowerCase() === name.toLowerCase());
    if (!found) throw new Error(`no sheet "${name}"`);
    return found;
  };
  const cellAt = (sheet: Worksheet, rc: { col: number; row: number }): V | null =>
    cellValue(sheet.rows[rc.row]?.[rc.col] ?? null);
  const refValue = (tok: { v: string; sheet?: string }): V | null => {
    const rc = parseA1(tok.v);
    if (!rc) throw new Error(`bad ref ${tok.v}`);
    return cellAt(sheetByName(tok.sheet), rc);
  };
  const rangeValues = (sheet: Worksheet, a: string, b: string): Array<V | null> => {
    const ra = parseA1(a), rb = parseA1(b);
    if (!ra || !rb) throw new Error(`bad range ${a}:${b}`);
    const out: Array<V | null> = [];
    for (let r = Math.min(ra.row, rb.row); r <= Math.max(ra.row, rb.row); r++) {
      for (let c = Math.min(ra.col, rb.col); c <= Math.max(ra.col, rb.col); c++) {
        out.push(cellAt(sheet, { col: c, row: r }));
      }
    }
    return out;
  };
  /** Resolve a named range → {sheet, a, b}. */
  const resolveName = (name: string): { sheet: Worksheet; a: string; b: string } => {
    const nr = ctx.names?.get(name.toUpperCase());
    if (!nr) throw new Error(`unknown name "${name}"`);
    const [a, b] = nr.range.split(":");
    return { sheet: sheetByName(nr.sheet), a: a!, b: b ?? a! };
  };

  /** One function argument, flattened: a range, a named range, or a scalar. */
  const arg = (): Array<V | null> => {
    const t = peek();
    if (t?.t === "ref" && toks[i + 1]?.t === "op" && toks[i + 1]!.v === ":") {
      const a = take() as { v: string; sheet?: string };
      take();   // ':'
      const b = take();
      if (b.t !== "ref") throw new Error("a range needs refs on both sides");
      return rangeValues(sheetByName(a.sheet), a.v, b.v);
    }
    if (t?.t === "name" && !(toks[i + 1]?.t === "op" && toks[i + 1]!.v === "(")) {
      // a bare name that isn't a function → a named range
      const nm = take() as { v: string };
      const r = resolveName(nm.v);
      return rangeValues(r.sheet, r.a, r.b);
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
  /** The raw arg list, each entry kept as its own value array (for lookups). */
  const argGroups = (): Array<Array<V | null>> => {
    expectOp("(");
    const out: Array<Array<V | null>> = [];
    if (peek()?.t === "op" && peek()!.v === ")") { take(); return out; }
    out.push(arg());
    while (peek()?.t === "op" && peek()!.v === ",") { take(); out.push(arg()); }
    expectOp(")");
    return out;
  };
  const nums = (vals: Array<V | null>): number[] =>
    vals.filter((v): v is V => v !== null && v !== "").map((v) => Number(String(v).replace(/[$,]/g, ""))).filter((n) => Number.isFinite(n));

  const cmp = (a: V | null, b: V | null): number => {
    const an = num(a), bn = num(b);
    if (an !== null && bn !== null) return an - bn;
    return toStr(a).localeCompare(toStr(b));
  };
  const matchOp = (a: V | null, op: string, b: V | null): boolean => {
    const c = cmp(a, b);
    return op === "=" ? c === 0 : op === "<>" ? c !== 0 : op === "<" ? c < 0 : op === ">" ? c > 0 : op === "<=" ? c <= 0 : c >= 0;
  };
  /** A criterion like ">3", "<=10", "apple", "*x*". Returns a predicate. */
  const criterion = (crit: V | null): ((v: V | null) => boolean) => {
    const sc = toStr(crit);
    const m = /^(<=|>=|<>|<|>|=)?\s*(.*)$/.exec(sc);
    const op = m?.[1] || "=";
    const rhs: V = m && num(m[2]!) !== null ? Number(m[2]) : (m?.[2] ?? "");
    return (v) => matchOp(v, op, rhs);
  };

  const callFn = (name: string): V => {
    switch (name) {
      // aggregates
      case "SUM": return nums(args()).reduce((x, y) => x + y, 0);
      case "AVG": case "AVERAGE": { const v = nums(args()); return v.length ? v.reduce((x, y) => x + y, 0) / v.length : 0; }
      case "COUNT": return nums(args()).length;
      case "COUNTA": return args().filter((v) => v !== null && v !== "").length;
      case "MIN": { const v = nums(args()); return v.length ? Math.min(...v) : 0; }
      case "MAX": { const v = nums(args()); return v.length ? Math.max(...v) : 0; }
      case "MEDIAN": { const v = nums(args()).sort((a, b) => a - b); if (!v.length) return 0; const mid = v.length >> 1; return v.length % 2 ? v[mid]! : (v[mid - 1]! + v[mid]!) / 2; }
      case "PRODUCT": return nums(args()).reduce((x, y) => x * y, 1);
      // conditional aggregates
      case "COUNTIF": { const g = argGroups(); const pred = criterion(g[1]?.[0] ?? null); return (g[0] ?? []).filter(pred).length; }
      case "SUMIF": { const g = argGroups(); const rng = g[0] ?? []; const pred = criterion(g[1]?.[0] ?? null); const sumRange = g[2] ?? rng; return rng.reduce<number>((acc, v, k) => acc + (pred(v) ? (num(sumRange[k] ?? null) ?? 0) : 0), 0); }
      case "AVERAGEIF": { const g = argGroups(); const rng = g[0] ?? []; const pred = criterion(g[1]?.[0] ?? null); const avgRange = g[2] ?? rng; const picked = rng.map((v, k) => (pred(v) ? num(avgRange[k] ?? null) : null)).filter((x): x is number => x !== null); return picked.length ? picked.reduce((a, b) => a + b, 0) / picked.length : 0; }
      // math
      case "ROUND": { const a = args(); const x = toNum(a[0] ?? 0); const d = a.length > 1 ? toNum(a[1] ?? 0) : 0; const m = 10 ** d; return Math.round(x * m) / m; }
      case "ROUNDUP": { const a = args(); const x = toNum(a[0] ?? 0); const d = a.length > 1 ? toNum(a[1] ?? 0) : 0; const m = 10 ** d; return Math.ceil(Math.abs(x) * m) / m * Math.sign(x || 1); }
      case "ROUNDDOWN": { const a = args(); const x = toNum(a[0] ?? 0); const d = a.length > 1 ? toNum(a[1] ?? 0) : 0; const m = 10 ** d; return Math.floor(Math.abs(x) * m) / m * Math.sign(x || 1); }
      case "ABS": return Math.abs(toNum(args()[0] ?? 0));
      case "SQRT": { const x = toNum(args()[0] ?? 0); if (x < 0) throw new Error("SQRT of a negative"); return Math.sqrt(x); }
      case "POWER": { const a = args(); return toNum(a[0] ?? 0) ** toNum(a[1] ?? 0); }
      case "MOD": { const a = args(); const d = toNum(a[1] ?? 0); if (d === 0) throw new Error("MOD by zero"); return toNum(a[0] ?? 0) % d; }
      case "FLOOR": return Math.floor(toNum(args()[0] ?? 0));
      case "CEILING": return Math.ceil(toNum(args()[0] ?? 0));
      // logical
      case "IF": {
        expectOp("(");
        const cond = expr(); expectOp(",");
        const yes = expr();
        let no: V = "";
        if (peek()?.t === "op" && peek()!.v === ",") { take(); no = expr(); }
        expectOp(")");
        return truthy(cond) ? yes : no;
      }
      case "IFERROR": {
        expectOp("(");
        // The parser evaluates as it consumes, so a throwing first arg leaves i
        // indeterminate — locate the arg boundaries by a token scan up front.
        const split = findArgSplit();
        try {
          const val = expr();
          i = split.close + 1;
          return val;
        } catch {
          i = split.comma >= 0 ? split.comma + 1 : split.close;
          const fb = split.comma >= 0 ? expr() : "";
          i = split.close + 1;
          return fb;
        }
      }
      case "AND": return args().every((v) => truthy(v)) ? 1 : 0;
      case "OR": return args().some((v) => truthy(v)) ? 1 : 0;
      case "NOT": return truthy(args()[0] ?? null) ? 0 : 1;
      // text
      case "CONCAT": case "CONCATENATE": return args().map((v) => toStr(v)).join("");
      case "UPPER": return toStr(args()[0] ?? "").toUpperCase();
      case "LOWER": return toStr(args()[0] ?? "").toLowerCase();
      case "TRIM": return toStr(args()[0] ?? "").trim();
      case "LEN": return toStr(args()[0] ?? "").length;
      case "LEFT": { const a = args(); return toStr(a[0] ?? "").slice(0, a.length > 1 ? toNum(a[1] ?? 1) : 1); }
      case "RIGHT": { const a = args(); const s2 = toStr(a[0] ?? ""); const k = a.length > 1 ? toNum(a[1] ?? 1) : 1; return k <= 0 ? "" : s2.slice(-k); }
      case "MID": { const a = args(); const start = Math.max(0, toNum(a[1] ?? 1) - 1); return toStr(a[0] ?? "").slice(start, start + toNum(a[2] ?? 0)); }
      case "SUBSTITUTE": { const a = args(); return toStr(a[0] ?? "").split(toStr(a[1] ?? "")).join(toStr(a[2] ?? "")); }
      case "TEXT": { const a = args(); return formatNumber(toNum(a[0] ?? 0), toStr(a[1] ?? "")); }
      case "REGEXMATCH": { const a = args(); return safeRegex(toStr(a[1] ?? "")).test(toStr(a[0] ?? "")) ? 1 : 0; }
      case "REGEXEXTRACT": { const a = args(); const m = safeRegex(toStr(a[1] ?? "")).exec(toStr(a[0] ?? "")); return m ? (m[1] ?? m[0]) : ""; }
      case "REGEXREPLACE": { const a = args(); return toStr(a[0] ?? "").replace(safeRegex(toStr(a[1] ?? ""), "g"), toStr(a[2] ?? "")); }
      // dates
      case "TODAY": { args(); return ctx.now ?? toSerial(1970, 1, 1); }
      case "DATE": { const a = args(); return toSerial(toNum(a[0] ?? 0), toNum(a[1] ?? 1), toNum(a[2] ?? 1)); }
      case "YEAR": { const sN = parseDateSerial(args()[0] ?? null); return sN === null ? 0 : serialToParts(sN).y; }
      case "MONTH": { const sN = parseDateSerial(args()[0] ?? null); return sN === null ? 0 : serialToParts(sN).m; }
      case "DAY": { const sN = parseDateSerial(args()[0] ?? null); return sN === null ? 0 : serialToParts(sN).d; }
      case "DATEDIF": { const a = args(); const s0 = parseDateSerial(a[0] ?? null) ?? 0; const s1 = parseDateSerial(a[1] ?? null) ?? 0; const unit = toStr(a[2] ?? "D").toUpperCase(); const days = s1 - s0; if (unit === "D") return days; if (unit === "M") { const p0 = serialToParts(s0), p1 = serialToParts(s1); return (p1.y - p0.y) * 12 + (p1.m - p0.m); } if (unit === "Y") { const p0 = serialToParts(s0), p1 = serialToParts(s1); return p1.y - p0.y; } return days; }
      // lookups
      case "VLOOKUP": return lookup(argGroups(), "v");
      case "HLOOKUP": return lookup(argGroups(), "h");
      case "MATCH": { const g = argGroups(); const key = g[0]?.[0] ?? null; const rng = g[1] ?? []; const type = g[2] ? toNum(g[2][0] ?? 1) : 1; const idx = matchIndex(key, rng, type); if (idx < 0) throw new Error("MATCH: no match"); return idx + 1; }
      case "INDEX": { const g = argGroups(); const rng = g[0] ?? []; const idx = toNum(g[1]?.[0] ?? 1); const v = rng[idx - 1]; if (v === undefined) throw new Error("INDEX out of range"); return v ?? 0; }
      // array helpers (first-cell / aggregate semantics — no true spill)
      case "UNIQUE": { const seen = new Set<string>(); const out = args().filter((v) => { const k = toStr(v); if (seen.has(k)) return false; seen.add(k); return true; }); return out[0] ?? ""; }
      case "SORT": { const g = argGroups(); const v = (g[0] ?? []).slice().sort((a, b) => cmp(a, b) * (g[1] && truthy(g[1][0] ?? null) ? -1 : 1)); return v[0] ?? ""; }
      case "FILTER": { const g = argGroups(); const rng = g[0] ?? []; const cond = g[1] ?? []; const out = rng.filter((_, k) => truthy(cond[k] ?? null)); return out[0] ?? ""; }
      default: throw new Error(`unknown function ${name}`);
    }
  };

  /** VLOOKUP/HLOOKUP over a flat range treated row-major within its rectangle
   *  is ambiguous, so lookups take the KEY column/row as the first group and a
   *  parallel result group — we implement the common 3-group form: (key, range, index). */
  const lookup = (g: Array<Array<V | null>>, _kind: "v" | "h"): V => {
    const key = g[0]?.[0] ?? null;
    const table = g[1] ?? [];
    const index = toNum(g[2]?.[0] ?? 1);
    // The flattened range loses width; support the frequent 2-column case:
    // [k0,v0,k1,v1,…] when index=2, else treat as single-column match→same value.
    if (index >= 2) {
      const stride = index; // assume `index` columns wide
      for (let k = 0; k + stride - 1 < table.length; k += stride) {
        if (cmp(table[k] ?? null, key) === 0) return table[k + index - 1] ?? "";
      }
      throw new Error("VLOOKUP: no match");
    }
    const idx = matchIndex(key, table, 0);
    if (idx < 0) throw new Error("VLOOKUP: no match");
    return table[idx] ?? "";
  };
  const matchIndex = (key: V | null, rng: Array<V | null>, type: number): number => {
    if (type === 0) return rng.findIndex((v) => cmp(v, key) === 0);
    // approximate: largest value <= key (assumes ascending)
    let best = -1;
    for (let k = 0; k < rng.length; k++) if (cmp(rng[k] ?? null, key) <= 0) best = k; else if (type === 1) break;
    return best;
  };

  /** From just after a "(", find the top-level comma + matching ")" token
   *  indices (for IFERROR's parse-then-maybe-eval-fallback). */
  const findArgSplit = (): { comma: number; close: number } => {
    let depth = 0, comma = -1;
    for (let k = i; k < toks.length; k++) {
      const tk = toks[k]!;
      if (tk.t === "op" && tk.v === "(") depth++;
      else if (tk.t === "op" && tk.v === ")") { if (depth === 0) return { comma, close: k }; depth--; }
      else if (tk.t === "op" && tk.v === "," && depth === 0 && comma === -1) comma = k;
    }
    throw new Error("unbalanced call");
  };

  const primary = (): V => {
    const t = take();
    if (t.t === "num") return t.v;
    if (t.t === "str") return t.v;
    if (t.t === "ref") { const v = refValue(t); return v === null ? 0 : v; }
    if (t.t === "name") {
      // bare name in scalar position → first cell of the named range
      const r = resolveName(t.v);
      const vals = rangeValues(r.sheet, r.a, r.b);
      const v = vals[0] ?? null;
      return v === null ? 0 : v;
    }
    if (t.t === "fn") return callFn(t.v);
    if (t.t === "op" && t.v === "(") { const v = expr(); expectOp(")"); return v; }
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
    while (peek()?.t === "op" && (peek()!.v === "+" || peek()!.v === "-" || peek()!.v === "&")) {
      const op = take().v;
      const rhs = mul();
      if (op === "&") v = toStr(v) + toStr(rhs);
      else v = op === "+" ? toNum(v) + toNum(rhs) : toNum(v) - toNum(rhs);
    }
    return v;
  };
  const expr = (): V => {
    const lhs = add();
    const t = peek();
    if (t?.t === "op" && ["=", "<>", "<", ">", "<=", ">="].includes(String(t.v))) {
      const op = String(take().v);
      const rhs = add();
      return matchOp(lhs, op, rhs) ? 1 : 0;
    }
    return lhs;
  };

  const out = expr();
  if (i < toks.length) throw new Error("trailing input");
  if (typeof out === "number" && !Number.isFinite(out)) throw new Error("not a finite number");
  return out;
}

// ── the number-format mini-language (shared by TEXT + styling + XLSX export) ───
export function formatNumber(x: number, fmt: string): string {
  if (!fmt) return String(x);
  if (/^(yyyy|mm|dd)/i.test(fmt)) {
    const p = serialToParts(Math.floor(x));
    return fmt
      .replace(/yyyy/gi, String(p.y))
      .replace(/mm/g, String(p.m).padStart(2, "0"))
      .replace(/dd/g, String(p.d).padStart(2, "0"));
  }
  const pct = fmt.includes("%");
  let val = pct ? x * 100 : x;
  const decMatch = /\.(0+)/.exec(fmt);
  const decimals = decMatch ? decMatch[1]!.length : (fmt.includes(".") ? 2 : 0);
  const grouped = /[#0],[#0]/.test(fmt) || /,#/.test(fmt);
  let out = grouped
    ? val.toLocaleString("en-US", { minimumFractionDigits: decimals, maximumFractionDigits: decimals })
    : val.toFixed(decimals);
  if (fmt.includes("$")) out = "$" + out;
  if (pct) out += "%";
  return out;
}

/** Compile a user regex once, length-capped, to blunt catastrophic patterns. */
function safeRegex(src: string, flags = ""): RegExp {
  if (src.length > 200) throw new Error("regex too long");
  try { return new RegExp(src, flags); } catch { throw new Error(`bad regex /${src}/`); }
}

/** Shift A1 row refs in a formula by dRow (fill-down's relative references).
 *  String literals are preserved untouched. */
export function shiftFormulaRows(formula: string, dRow: number): string {
  return formula.split(/("(?:[^"]|"")*")/).map((part, idx) => {
    if (idx % 2 === 1) return part;   // inside a string literal
    return part.replace(/([A-Za-z]+)([0-9]+)/g, (_m, col: string, row: string) => `${col}${Math.max(1, parseInt(row, 10) + dRow)}`);
  }).join("");
}

// ── dependency graph + topological recalc ─────────────────────────────────────
type NodeId = string; // `${sheetName} ${col},${row}`
const nid = (sheet: string, col: number, row: number): NodeId => `${sheet} ${col},${row}`;

/** The cells a formula references (expanded, cross-sheet + named ranges resolved). */
function formulaDeps(wb: Workbook, sheet: Worksheet, formula: string, names: Map<string, { sheet: string; range: string }>): Array<{ sheet: string; col: number; row: number }> {
  let toks: Tok[];
  try { toks = tokenize(formula.replace(/^=/, "")); } catch { return []; }
  const out: Array<{ sheet: string; col: number; row: number }> = [];
  const sheetName = (n?: string): string => n ?? sheet.name;
  const pushRange = (sn: string, a: string, b: string): void => {
    const ra = parseA1(a), rb = parseA1(b);
    if (!ra || !rb) return;
    for (let r = Math.min(ra.row, rb.row); r <= Math.max(ra.row, rb.row); r++)
      for (let c = Math.min(ra.col, rb.col); c <= Math.max(ra.col, rb.col); c++)
        out.push({ sheet: sn, col: c, row: r });
  };
  for (let k = 0; k < toks.length; k++) {
    const t = toks[k]!;
    if (t.t === "ref") {
      if (toks[k + 1]?.t === "op" && toks[k + 1]!.v === ":" && toks[k + 2]?.t === "ref") {
        pushRange(sheetName(t.sheet), t.v, (toks[k + 2] as { v: string }).v); k += 2;
      } else {
        const rc = parseA1(t.v);
        if (rc) out.push({ sheet: sheetName(t.sheet), col: rc.col, row: rc.row });
      }
    } else if (t.t === "name" && !(toks[k + 1]?.t === "op" && toks[k + 1]!.v === "(")) {
      const nr = names.get(t.v.toUpperCase());
      if (nr) { const [a, b] = nr.range.split(":"); pushRange(nr.sheet, a!, b ?? a!); }
    }
  }
  return out;
}

/**
 * Recompute every formula cell's materialized value using a dependency-ordered
 * pass (Kahn's algorithm). Formulas may reference later cells or other sheets;
 * cells caught in a cycle materialize as "#CIRC!". Non-formula cells are
 * constants (never nodes). `now` (UTC day serial) seeds TODAY() for the pass.
 */
export function recalcWorkbook(wb: Workbook, now?: number): Workbook {
  const names = new Map<string, { sheet: string; range: string }>();
  for (const nr of wb.namedRanges ?? []) names.set(nr.name.toUpperCase(), { sheet: nr.sheet, range: nr.range });
  const bySheet = new Map<string, Worksheet>();
  for (const s of wb.sheets) bySheet.set(s.name, s);

  // 1. collect formula nodes + their dependencies (only edges from formula→formula matter for ordering)
  interface Node { sheet: Worksheet; col: number; row: number; cell: { f: string; v?: string | number | null }; deps: NodeId[]; indeg: number }
  const nodes = new Map<NodeId, Node>();
  for (const sheet of wb.sheets) {
    for (let r = 0; r < sheet.rows.length; r++) {
      const row = sheet.rows[r]!;
      for (let c = 0; c < row.length; c++) {
        const cell = row[c];
        if (isFormulaCell(cell)) nodes.set(nid(sheet.name, c, r), { sheet, col: c, row: r, cell, deps: [], indeg: 0 });
      }
    }
  }
  const dependents = new Map<NodeId, NodeId[]>();
  for (const [id, node] of nodes) {
    const raw = formulaDeps(wb, node.sheet, node.cell.f, names);
    const seen = new Set<NodeId>();
    for (const d of raw) {
      const depId = nid(d.sheet, d.col, d.row);
      if (nodes.has(depId) && depId !== id && !seen.has(depId)) {
        seen.add(depId);
        node.deps.push(depId);
        node.indeg++;
        (dependents.get(depId) ?? dependents.set(depId, []).get(depId)!).push(id);
      }
    }
  }

  // 2. Kahn: evaluate ready nodes (indeg 0), releasing dependents
  const ctxFor = (sheet: Worksheet): EvalCtx => ({ wb, sheet, now, names });
  const queue: NodeId[] = [];
  for (const [id, node] of nodes) if (node.indeg === 0) queue.push(id);
  let processed = 0;
  while (queue.length) {
    const id = queue.shift()!;
    const node = nodes.get(id)!;
    try {
      const v = evalFormula(ctxFor(node.sheet), node.cell.f);
      node.cell.v = typeof v === "number" ? Math.round(v * 1e10) / 1e10 : v;
    } catch (err) {
      node.cell.v = `#ERR: ${err instanceof Error ? err.message : String(err)}`;
    }
    processed++;
    for (const dep of dependents.get(id) ?? []) {
      const dn = nodes.get(dep)!;
      if (--dn.indeg === 0) queue.push(dep);
    }
  }

  // 3. anything left un-processed is in (or downstream of) a cycle
  if (processed < nodes.size) {
    for (const node of nodes.values()) if (node.indeg > 0) node.cell.v = "#CIRC!";
  }
  return wb;
}
