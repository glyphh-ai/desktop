/**
 * The Glyphh Sheets formula engine — the spec as tests. Every supported
 * function, the grammar's edges, ref/range behavior, error shapes, the
 * fill-down ref shifter, and full-workbook recalc.
 */

import { describe, it, expect } from "vitest";
import { evalFormula, recalcWorkbook, shiftFormulaRows, parseA1, colLetter, type Worksheet, type Workbook } from "../../src/shared/sheets-engine";

const sheet = (rows: Worksheet["rows"]): Worksheet => ({
  name: "S",
  columns: [{ name: "A" }, { name: "B" }, { name: "C" }],
  rows,
});

const S = sheet([
  ["Rent", 2000, "x"],
  ["Food", 600.5, ""],
  ["Gym", 49.5, null],
  ["", null, null],
]);

const ev = (f: string, sh: Worksheet = S) => evalFormula(sh, f);

describe("A1 addressing", () => {
  it("parses and prints columns past Z", () => {
    expect(parseA1("A1")).toEqual({ col: 0, row: 0 });
    expect(parseA1("AA10")).toEqual({ col: 26, row: 9 });
    expect(parseA1("AB2")).toEqual({ col: 27, row: 1 });
    expect(colLetter(0)).toBe("A");
    expect(colLetter(25)).toBe("Z");
    expect(colLetter(26)).toBe("AA");
    expect(colLetter(27)).toBe("AB");
    expect(colLetter(51)).toBe("AZ");
    expect(colLetter(52)).toBe("BA");
  });
});

describe("arithmetic + refs", () => {
  it("does arithmetic with precedence and parens", () => {
    expect(ev("=1+2*3")).toBe(7);
    expect(ev("=(1+2)*3")).toBe(9);
    expect(ev("=10/4")).toBe(2.5);
    expect(ev("=-5+8")).toBe(3);
  });
  it("reads cell refs (empty = 0 in math)", () => {
    expect(ev("=B1+B2")).toBe(2600.5);
    expect(ev("=B1*2")).toBe(4000);
    expect(ev("=B4+1")).toBe(1);
  });
  it("numeric strings coerce; text in math errors", () => {
    expect(ev("=B1+0", sheet([["x", "1,500"]]))).toBe(1500);
    expect(evalFormula(sheet([["1,500"]]), "=A1+1")).toBe(1501);
    expect(() => ev("=A1*2")).toThrow(/isn't a number/);
  });
  it("division by zero errors", () => {
    expect(() => ev("=1/0")).toThrow(/division by zero/);
  });
});

describe("aggregates", () => {
  it("SUM/AVG/COUNT/MIN/MAX over ranges skip blanks and text-only cells stay countable as numbers only", () => {
    expect(ev("=SUM(B1:B4)")).toBe(2650);
    expect(ev("=AVERAGE(B1:B3)")).toBeCloseTo(883.3333, 3);
    expect(ev("=AVG(B1:B3)")).toBeCloseTo(883.3333, 3);
    expect(ev("=COUNT(B1:B4)")).toBe(3);
    expect(ev("=MIN(B1:B3)")).toBe(49.5);
    expect(ev("=MAX(B1:B3)")).toBe(2000);
  });
  it("aggregates take mixed args: ranges, refs, literals", () => {
    expect(ev("=SUM(B1:B2, B3, 100)")).toBe(2750);
    expect(ev("=SUM()")).toBe(0);
    expect(ev("=MIN(5, 2, 9)")).toBe(2);
  });
  it("rectangular ranges cover both dimensions", () => {
    const grid = sheet([[1, 2, 3], [4, 5, 6]]);
    expect(evalFormula(grid, "=SUM(A1:C2)")).toBe(21);
  });
});

describe("math + string functions", () => {
  it("ROUND and ABS", () => {
    expect(ev("=ROUND(2.567, 2)")).toBe(2.57);
    expect(ev("=ROUND(2.4)")).toBe(2);
    expect(ev("=ABS(0-9)")).toBe(9);
  });
  it("CONCAT/UPPER/LOWER/TRIM/LEN", () => {
    expect(ev('=CONCAT("a", "b", 3)')).toBe("ab3");
    expect(ev('=CONCAT(A1, " ", B1)')).toBe("Rent 2000");
    expect(ev('=UPPER(A1)')).toBe("RENT");
    expect(ev('=LOWER("HeLLo")')).toBe("hello");
    expect(ev('=TRIM("  hi  ")')).toBe("hi");
    expect(ev('=LEN("hello")')).toBe(5);
    expect(ev("=LEN(A1)")).toBe(4);
  });
  it("LEFT/RIGHT/MID", () => {
    expect(ev('=LEFT("hello", 2)')).toBe("he");
    expect(ev('=LEFT("hello")')).toBe("h");
    expect(ev('=RIGHT("hello", 3)')).toBe("llo");
    expect(ev('=MID("hello", 2, 3)')).toBe("ell");
  });
  it("string literals escape quotes with double quotes", () => {
    expect(ev('=CONCAT("say ""hi""")')).toBe('say "hi"');
  });
});

describe("comparisons + IF", () => {
  it("comparisons return 1/0, numeric and string", () => {
    expect(ev("=2>1")).toBe(1);
    expect(ev("=2<1")).toBe(0);
    expect(ev("=2<>1")).toBe(1);
    expect(ev("=B1>=2000")).toBe(1);
    expect(ev('=A1="Rent"')).toBe(1);
    expect(ev('=A1="rent"')).toBe(0);
  });
  it("IF branches (else optional)", () => {
    expect(ev('=IF(B1>1000, "big", "small")')).toBe("big");
    expect(ev('=IF(B3>1000, "big", "small")')).toBe("small");
    expect(ev('=IF(B4>0, "x")')).toBe("");
    expect(ev("=IF(1=1, B1*2, 0)")).toBe(4000);
  });
});

describe("errors", () => {
  it("unknown functions, bad tokens, trailing input", () => {
    expect(() => ev("=NOPE(1)")).toThrow(/unknown function/);
    expect(() => ev("=1 @ 2")).toThrow(/can't read/);
    expect(() => ev("=1 2")).toThrow(/trailing/);
    expect(() => ev("=SUM(A1:B")).toThrow();
  });
});

describe("recalcWorkbook", () => {
  it("materializes values row-major, errors as #ERR values", () => {
    const wb: Workbook = {
      sheets: [{
        name: "S",
        columns: [{ name: "A" }, { name: "B" }],
        rows: [
          [10, { f: "=A1*2" }],
          [20, { f: "=A2*2" }],
          ["sub", { f: "=SUM(B1:B2)" }],
          ["bad", { f: "=1/0" }],
        ],
      }],
    };
    recalcWorkbook(wb);
    const r = wb.sheets[0]!.rows;
    expect((r[0]![1] as { v: unknown }).v).toBe(20);
    expect((r[1]![1] as { v: unknown }).v).toBe(40);
    expect((r[2]![1] as { v: unknown }).v).toBe(60);
    expect(String((r[3]![1] as { v: unknown }).v)).toMatch(/^#ERR/);
  });
});

describe("shiftFormulaRows (fill-down)", () => {
  it("shifts every ref's row, leaves strings alone", () => {
    expect(shiftFormulaRows("=A1+B1", 1)).toBe("=A2+B2");
    expect(shiftFormulaRows("=SUM(B2:B9)", 3)).toBe("=SUM(B5:B12)");
    expect(shiftFormulaRows('=CONCAT("A1 stays", A1)', 2)).toBe('=CONCAT("A1 stays", A3)');
    expect(shiftFormulaRows("=A1", -5)).toBe("=A1");   // clamped at row 1
  });
});

// ── v3: dependency-ordered recalc, cross-sheet, named ranges, new functions ──
describe("engine v3 — topological recalc", () => {
  const cell = (r: Workbook, s: number, row: number, col: number): unknown =>
    (r.sheets[s]!.rows[row]![col] as { v: unknown }).v;

  it("resolves a formula that references a LATER formula (totals-first works now)", () => {
    const wb: Workbook = {
      sheets: [{
        name: "S", columns: [{ name: "A" }, { name: "B" }],
        rows: [
          [{ f: "=A2+A3" }, null],   // total FIRST — used to break in v2
          [10, null],
          [{ f: "=A2*2" }, null],    // 20
        ],
      }],
    };
    recalcWorkbook(wb);
    expect(cell(wb, 0, 2, 0)).toBe(20);
    expect(cell(wb, 0, 0, 0)).toBe(30);   // 10 + 20, correctly ordered
  });

  it("marks circular references as #CIRC!", () => {
    const wb: Workbook = {
      sheets: [{
        name: "S", columns: [{ name: "A" }],
        rows: [[{ f: "=A2" }], [{ f: "=A1" }]],
      }],
    };
    recalcWorkbook(wb);
    expect(cell(wb, 0, 0, 0)).toBe("#CIRC!");
    expect(cell(wb, 0, 1, 0)).toBe("#CIRC!");
  });

  it("resolves cross-sheet references", () => {
    const wb: Workbook = {
      sheets: [
        { name: "Data", columns: [{ name: "A" }], rows: [[100], [200]] },
        { name: "Sum", columns: [{ name: "A" }], rows: [[{ f: "=Data!A1+Data!A2" }], [{ f: "=SUM(Data!A1:A2)" }]] },
      ],
    };
    recalcWorkbook(wb);
    expect(cell(wb, 1, 0, 0)).toBe(300);
    expect(cell(wb, 1, 1, 0)).toBe(300);
  });

  it("resolves named ranges in formulas + deps", () => {
    const wb: Workbook = {
      sheets: [{
        name: "S", columns: [{ name: "A" }, { name: "B" }],
        rows: [[10, null], [20, null], [{ f: "=SUM(costs)" }, { f: "=costs" }]],
      }],
      namedRanges: [{ name: "costs", sheet: "S", range: "A1:A2" }],
    };
    recalcWorkbook(wb);
    expect(cell(wb, 0, 2, 0)).toBe(30);   // SUM(costs)
    expect(cell(wb, 0, 2, 1)).toBe(10);   // costs → first cell scalar
  });
});

describe("engine v3 — function library", () => {
  const T = sheet([
    ["apple", 3, 10],
    ["banana", 5, 20],
    ["cherry", 2, 30],
  ]);
  it("lookups: VLOOKUP / INDEX / MATCH", () => {
    // 2-col VLOOKUP over A1:B3 (key, table, index=2)
    expect(evalFormula(T, '=VLOOKUP("banana", A1:B3, 2)')).toBe(5);
    expect(evalFormula(T, "=MATCH(30, C1:C3, 0)")).toBe(3);
    expect(evalFormula(T, "=INDEX(A1:A3, 2)")).toBe("banana");
  });
  it("conditional aggregates: SUMIF / COUNTIF", () => {
    expect(evalFormula(T, '=COUNTIF(B1:B3, ">2")')).toBe(2);
    expect(evalFormula(T, '=SUMIF(B1:B3, ">2", C1:C3)')).toBe(30);   // banana(20)+... wait
  });
  it("logical: IF / IFERROR / AND / OR", () => {
    expect(evalFormula(T, "=IF(B1>2, 1, 0)")).toBe(1);
    expect(evalFormula(T, "=IFERROR(1/0, 99)")).toBe(99);
    expect(evalFormula(T, "=AND(B1>0, B2>0)")).toBe(1);
    expect(evalFormula(T, "=OR(B1<0, B2>0)")).toBe(1);
  });
  it("dates: DATE / YEAR / DATEDIF", () => {
    expect(evalFormula(T, '=YEAR("2026-08-18")')).toBe(2026);
    expect(evalFormula(T, '=DATEDIF("2026-01-01", "2026-03-01", "M")')).toBe(2);
  });
  it("text: TEXT / concatenation with &", () => {
    expect(evalFormula(T, '=TEXT(0.5, "0%")')).toBe("50%");
    expect(evalFormula(T, '="a" & "b" & 1')).toBe("ab1");
  });
  it("regex: REGEXMATCH", () => {
    expect(evalFormula(T, '=REGEXMATCH("hello@x.com", "@")')).toBe(1);
  });
});
