import { describe, it, expect } from "vitest";
import {
  MAX_GRID, emptyGrid, gridFromCells, resizeGrid, cellAt, canMergeRight, canMergeDown, canSplit,
  mergeRight, mergeDown, splitCell, setSticky, assignPanel, setCellConfig, readingOrder, dropModeAt,
  applyDrop, gridCells, evenFractions, fractionsFor, gridShapeSig, gridError, agentCellIndices,
  CELL_TOOLS, heldHouseViews, cellPickerTools, cellPickerApps, resolveAppRow, cellBlocked, cellLabel,
  type Grid, type PickerAppRow,
} from "../../src/renderer/help/workspace-grid.js";

/** Every position covered by exactly one cell — the grid model's invariant. */
function expectTiled(g: Grid): void {
  for (let y = 0; y < g.rows; y++) {
    for (let x = 0; x < g.cols; x++) {
      const covering = g.cells.filter((c) => x >= c.col && x < c.col + c.colSpan && y >= c.row && y < c.row + c.rowSpan);
      expect(covering.length, `position ${x},${y}`).toBe(1);
    }
  }
  for (const c of g.cells) {
    expect(c.col + c.colSpan).toBeLessThanOrEqual(g.cols);
    expect(c.row + c.rowSpan).toBeLessThanOrEqual(g.rows);
  }
}

const ids = (g: Grid): string[] => readingOrder(g).map((i) => g.cells[i]!.panelId);

describe("the grid editor's model (ported from the old Workspaces builder)", () => {
  it("starts as cols × rows empty 1×1 cells, clamped to 1..25", () => {
    const g = emptyGrid(3, 2);
    expect(g.cells).toHaveLength(6);
    expect(g.cells.every((c) => c.panelId === "" && c.colSpan === 1 && c.rowSpan === 1)).toBe(true);
    expectTiled(g);
    expect(emptyGrid(99, 0)).toMatchObject({ cols: MAX_GRID, rows: 1 });
    expect(emptyGrid(Number.NaN, -3)).toMatchObject({ cols: 2, rows: 1 });
  });

  it("finds the cell covering a position, merged cells included", () => {
    const g = gridFromCells(3, 2, [{ panelId: "tool:coding", col: 0, row: 0, colSpan: 2, rowSpan: 2 }]);
    expect(g.cells[cellAt(g, 1, 1)]!.panelId).toBe("tool:coding");
    expect(g.cells[cellAt(g, 2, 1)]!.panelId).toBe("");
    expect(cellAt(g, 5, 5)).toBe(-1);
  });

  it("loads a saved workspace: merged cells on their top-left, the 1×1s they cover gone, pin and setup kept", () => {
    const g = gridFromCells(3, 2, [
      { panelId: "tool:coding", col: 0, row: 0, colSpan: 1, rowSpan: 2, sticky: true, config: { loop: "codex" } },
      { panelId: "tool:terminal", col: 1, row: 0, colSpan: 2, rowSpan: 1, config: { cmd: "npm test" } },
    ]);
    expectTiled(g);
    expect(g.cells).toHaveLength(4);
    expect(g.cells[cellAt(g, 0, 1)]).toMatchObject({ panelId: "tool:coding", sticky: true, config: { loop: "codex" } });
    expect(g.cells[cellAt(g, 2, 0)]).toMatchObject({ panelId: "tool:terminal", colSpan: 2, config: { cmd: "npm test" } });
  });

  it("loads defensively: spans clamp to the edges, cells outside, empty or overlapping are skipped, one pin at most", () => {
    const g = gridFromCells(2, 2, [
      { panelId: "a", col: 1, row: 1, colSpan: 4, rowSpan: 4, sticky: true },
      { panelId: "b", col: 7, row: 0 },
      { panelId: "  ", col: 0, row: 0 },
      { panelId: "c", col: 0, row: 0, colSpan: 2, rowSpan: 2 },   // overlaps a
      { panelId: "d", col: 0, row: 0, sticky: true, config: {} },
    ]);
    expectTiled(g);
    expect(g.cells[cellAt(g, 1, 1)]).toMatchObject({ panelId: "a", colSpan: 1, rowSpan: 1, sticky: true });
    const d = g.cells[cellAt(g, 0, 0)]!;
    expect(d.panelId).toBe("d");
    expect(d.sticky).toBeUndefined();
    expect(d.config).toBeUndefined();
    expect(ids(g)).toEqual(["d", "", "", "a"]);
  });

  it("resizes in place: placed panels survive a grow, a shrink clamps spans and drops only cells pushed out", () => {
    const g = gridFromCells(2, 1, [{ panelId: "tool:coding", col: 0, row: 0, colSpan: 2, rowSpan: 1 }]);
    resizeGrid(g, 3, 2);
    expectTiled(g);
    expect(g.cells[cellAt(g, 0, 0)]).toMatchObject({ panelId: "tool:coding", colSpan: 2 });
    assignPanel(g, cellAt(g, 2, 1), "tool:files");
    resizeGrid(g, 1, 1);
    expectTiled(g);
    expect(g.cells).toEqual([{ panelId: "tool:coding", col: 0, row: 0, colSpan: 1, rowSpan: 1 }]);
    resizeGrid(g, Number.NaN, 0);
    expect(g).toMatchObject({ cols: 1, rows: 1 });
  });

  it("merges right only into one neighbour with the same row range", () => {
    const g = emptyGrid(3, 2);
    expect(canMergeRight(g, cellAt(g, 2, 0))).toBe(false);          // the right edge
    const sel = mergeDown(g, cellAt(g, 0, 0));                        // a 1×2 at col 0
    expect(canMergeRight(g, sel)).toBe(false);                        // col 1 is two cells
    expect(mergeRight(g, sel)).toBe(sel);                             // refused: nothing changes
    mergeDown(g, cellAt(g, 1, 0));
    const merged = mergeRight(g, cellAt(g, 0, 0));
    expect(g.cells[merged]).toMatchObject({ col: 0, row: 0, colSpan: 2, rowSpan: 2 });
    expectTiled(g);
    expect(canMergeRight(g, 99)).toBe(false);
  });

  it("merges down only into one neighbour with the same column range", () => {
    const g = emptyGrid(2, 3);
    expect(canMergeDown(g, cellAt(g, 0, 2))).toBe(false);           // the bottom edge
    const wide = mergeRight(g, cellAt(g, 0, 0));
    expect(canMergeDown(g, wide)).toBe(false);                        // row 1 is two cells
    expect(mergeDown(g, wide)).toBe(wide);
    mergeRight(g, cellAt(g, 0, 1));
    const tall = mergeDown(g, cellAt(g, 0, 0));
    expect(g.cells[tall]).toMatchObject({ colSpan: 2, rowSpan: 2 });
    expectTiled(g);
    expect(canMergeDown(g, -1)).toBe(false);
  });

  it("a merge drops the absorbed cell's panel and setup (an agent cell removed drops its answers)", () => {
    const g = gridFromCells(2, 1, [
      { panelId: "tool:terminal", col: 0, row: 0 },
      { panelId: "agent:codex", col: 1, row: 0, config: { view: "cli" } },
    ]);
    mergeRight(g, 0);
    expect(g.cells).toEqual([{ panelId: "tool:terminal", col: 0, row: 0, colSpan: 2, rowSpan: 1 }]);
    expect(agentCellIndices(g)).toEqual([]);
  });

  it("splits a merged cell into 1×1s; panel, pin and setup stay on the top-left piece", () => {
    const g = gridFromCells(2, 2, [{ panelId: "tool:coding", col: 0, row: 0, colSpan: 2, rowSpan: 2, sticky: true, config: { loop: "claude" } }]);
    expect(canSplit(g, 0)).toBe(true);
    splitCell(g, 0);
    expectTiled(g);
    expect(g.cells).toHaveLength(4);
    expect(g.cells[cellAt(g, 0, 0)]).toEqual({ panelId: "tool:coding", col: 0, row: 0, colSpan: 1, rowSpan: 1, sticky: true, config: { loop: "claude" } });
    expect(ids(g).slice(1)).toEqual(["", "", ""]);
    expect(canSplit(g, 0)).toBe(false);
    splitCell(g, 0);                      // a 1×1: nothing to split
    splitCell(g, 42);
    expect(g.cells).toHaveLength(4);
  });

  it("keeps one sticky cell at most, and never an empty one", () => {
    const g = gridFromCells(3, 1, [{ panelId: "a", col: 0, row: 0 }, { panelId: "b", col: 1, row: 0 }]);
    setSticky(g, 0, true);
    setSticky(g, 1, true);
    expect(g.cells.map((c) => !!c.sticky)).toEqual([false, true, false]);
    setSticky(g, 2, true);                // empty: clears instead
    expect(g.cells.some((c) => c.sticky)).toBe(false);
    setSticky(g, 1, true);
    setSticky(g, 1, false);
    expect(g.cells.some((c) => c.sticky)).toBe(false);
  });

  it("picking a panel drops the old panel's setup, keeps an agent's answers for an agent, and emptying unpins", () => {
    const g = gridFromCells(2, 1, [
      { panelId: "tool:coding", col: 0, row: 0, sticky: true, config: { loop: "codex" } },
      { panelId: "tool:preview", col: 1, row: 0, config: { url: "https://x" } },
    ]);
    assignPanel(g, 0, "agent:claude");
    expect(g.cells[0]).toMatchObject({ panelId: "agent:claude", sticky: true, config: { loop: "codex" } });
    assignPanel(g, 0, "agent:claude");    // same panel: nothing changes
    expect(g.cells[0]!.config).toEqual({ loop: "codex" });
    assignPanel(g, 1, "tool:terminal");
    expect(g.cells[1]!.config).toBeUndefined();
    assignPanel(g, 0, "");
    expect(g.cells[0]).toEqual({ panelId: "", col: 0, row: 0, colSpan: 1, rowSpan: 1 });
    assignPanel(g, 9, "x");               // no such cell
    expect(g.cells).toHaveLength(2);
  });

  it("writes and clears one setup key; an emptied setup drops off the cell", () => {
    const g = emptyGrid(1, 1);
    setCellConfig(g, 0, "url", "https://a");
    setCellConfig(g, 0, "keepAlive", false);
    expect(g.cells[0]!.config).toEqual({ url: "https://a", keepAlive: false });
    setCellConfig(g, 0, "url", "");
    setCellConfig(g, 0, "keepAlive", undefined);
    expect(g.cells[0]!.config).toBeUndefined();
    setCellConfig(g, 3, "url", "x");
  });

  it("reads the drop zone: leading edge before, trailing edge after, the middle swaps", () => {
    expect(dropModeAt(0.1, 0.5)).toBe("before");
    expect(dropModeAt(0.5, 0.1)).toBe("before");
    expect(dropModeAt(0.9, 0.5)).toBe("after");
    expect(dropModeAt(0.5, 0.9)).toBe("after");
    expect(dropModeAt(0.5, 0.5)).toBe("swap");
  });

  it("a mid-cell drop swaps two cells' contents (panel, pin, setup); geometry stays", () => {
    const g = gridFromCells(3, 1, [
      { panelId: "a", col: 0, row: 0, sticky: true, config: { x: 1 } },
      { panelId: "b", col: 1, row: 0, colSpan: 2 },
    ]);
    applyDrop(g, 0, 1, "swap");
    expect(g.cells[0]).toEqual({ panelId: "b", col: 0, row: 0, colSpan: 1, rowSpan: 1 });
    expect(g.cells[1]).toEqual({ panelId: "a", col: 1, row: 0, colSpan: 2, rowSpan: 1, sticky: true, config: { x: 1 } });
  });

  it("an edge drop inserts before/after in reading order, flowing everything between along", () => {
    const g = gridFromCells(2, 2, [
      { panelId: "a", col: 0, row: 0 }, { panelId: "b", col: 1, row: 0 },
      { panelId: "c", col: 0, row: 1 }, { panelId: "d", col: 1, row: 1 },
    ]);
    applyDrop(g, cellAt(g, 1, 1), cellAt(g, 0, 0), "before");
    expect(ids(g)).toEqual(["d", "a", "b", "c"]);
    applyDrop(g, cellAt(g, 0, 0), cellAt(g, 1, 1), "after");
    expect(ids(g)).toEqual(["a", "b", "c", "d"]);
    applyDrop(g, 0, 0, "swap");           // onto itself: nothing
    applyDrop(g, 0, 99, "swap");
    expect(ids(g)).toEqual(["a", "b", "c", "d"]);
  });

  it("a full-height column dropped on an edge moves as a column, its span travelling with it", () => {
    const g = gridFromCells(3, 2, [
      { panelId: "a", col: 0, row: 0 }, { panelId: "b", col: 1, row: 0 },
      { panelId: "c", col: 0, row: 1 }, { panelId: "d", col: 1, row: 1 },
      { panelId: "rail", col: 2, row: 0, rowSpan: 2 },
    ]);
    applyDrop(g, cellAt(g, 2, 0), cellAt(g, 0, 0), "before");
    expectTiled(g);
    expect(g.cells[cellAt(g, 0, 0)]).toMatchObject({ panelId: "rail", rowSpan: 2 });
    expect(g.cells[cellAt(g, 1, 0)]!.panelId).toBe("a");
    expect(g.cells[cellAt(g, 2, 1)]!.panelId).toBe("d");
    // Dropped on its own column's neighbour edge that maps back to itself: nothing moves.
    applyDrop(g, cellAt(g, 0, 0), cellAt(g, 1, 0), "before");
    expect(g.cells[cellAt(g, 0, 0)]!.panelId).toBe("rail");
    // After the last column.
    applyDrop(g, cellAt(g, 0, 0), cellAt(g, 2, 0), "after");
    expectTiled(g);
    expect(g.cells[cellAt(g, 2, 0)]).toMatchObject({ panelId: "rail", rowSpan: 2 });
  });

  it("a column move a merged cell straddles falls through to the contents flow", () => {
    const g = gridFromCells(3, 2, [
      { panelId: "wide", col: 1, row: 0, colSpan: 2 },
      { panelId: "rail", col: 0, row: 0, rowSpan: 2 },
      { panelId: "x", col: 1, row: 1 }, { panelId: "y", col: 2, row: 1 },
    ]);
    applyDrop(g, cellAt(g, 0, 0), cellAt(g, 2, 1), "before");
    expectTiled(g);
    expect(g.cells[cellAt(g, 0, 0)]).toMatchObject({ panelId: "wide", rowSpan: 2 });
    expect(ids(g)).toEqual(["wide", "x", "rail", "y"]);
  });

  it("serializes only assigned cells, in reading order, in the save shape", () => {
    const g = gridFromCells(2, 2, [
      { panelId: "tool:files", col: 1, row: 1 },
      { panelId: "tool:coding", col: 0, row: 0, rowSpan: 2, sticky: true, config: { loop: "codex" } },
    ]);
    expect(gridCells(g)).toEqual([
      { panelId: "tool:coding", col: 0, row: 0, colSpan: 1, rowSpan: 2, sticky: true, config: { loop: "codex" } },
      { panelId: "tool:files", col: 1, row: 1, colSpan: 1, rowSpan: 1 },
    ]);
  });

  it("keeps a workspace's own seams while the count is unchanged, else goes even", () => {
    expect(evenFractions(4)).toEqual([0.25, 0.25, 0.25, 0.25]);
    expect(evenFractions(0)).toEqual([1]);
    expect(fractionsFor([0.7, 0.3], 2)).toEqual([0.7, 0.3]);
    expect(fractionsFor([0.7, 0.3], 3)).toEqual([1 / 3, 1 / 3, 1 / 3]);
    expect(fractionsFor([0.7, 0], 2)).toEqual([0.5, 0.5]);
    expect(fractionsFor(null, 1)).toEqual([1]);
  });

  it("fingerprints a shape whatever the cells' order or case, ignoring empties and setup", () => {
    const a = gridShapeSig(2, 1, [{ panelId: "Tool:Coding", col: 0, row: 0 }, { panelId: "tool:files", col: 1, row: 0, config: { x: 1 } }]);
    const b = gridShapeSig(2, 1, [{ panelId: "tool:files", col: 1, row: 0, colSpan: 1, rowSpan: 1 }, { panelId: "", col: 0, row: 0 }, { panelId: "tool:coding" }]);
    expect(a).toBe(b);
    expect(gridShapeSig(3, 1, [{ panelId: "tool:coding" }])).not.toBe(gridShapeSig(2, 1, [{ panelId: "tool:coding" }]));
  });

  it("checks a grid for a save: a panel, an agent, no native apps", () => {
    const g = emptyGrid(2, 1);
    expect(gridError(g)).toMatch(/at least one panel/);
    assignPanel(g, 1, "tool:files");
    expect(gridError(g)).toMatch(/always has an agent/);
    assignPanel(g, 0, "agent:codex");
    expect(gridError(g)).toBeNull();
    assignPanel(g, 1, "finder-id");
    expect(gridError(g, (p) => p === "finder-id", () => "Finder")).toMatch(/native apps: Finder\./);
    expect(gridError(g, (p) => p === "finder-id")).toMatch(/native apps: finder-id\./);
  });

  const rows: PickerAppRow[] = [
    { id: "glyphh", name: "Glyphh", slug: "glyphh", url: null, isBrowser: false, appArchetype: "glyphh-self" },
    { id: "nav-home", name: "Home", slug: "home", url: null, isBrowser: true, appArchetype: "glyphh-nav", launchConfig: { nav: "dashboard" } },
    { id: "u1", name: "Linear", slug: "linear", url: "https://linear.app", isBrowser: true },
    { id: "u2", name: "Finder", slug: "finder", url: null, isBrowser: false, execPath: "/System/Finder.app" },
    { id: "u3", name: "Notes", slug: "notes", url: null, isBrowser: true, appArchetype: "glyphh-app" },
    { id: "u4", name: "Bots", slug: "bots", url: "https://x/bots", isBrowser: true },
    { id: "u5", name: "Discover", slug: "disc", url: "https://x/d", isBrowser: true, launchConfig: { nav: "discover" } },
    { id: "u6", name: "Old platform", slug: "op", url: "https://x/p", isBrowser: true, launchConfig: { tool: "Platform" } },
    { id: "u7", name: "My slides", slug: "slides", url: null, isBrowser: true, appArchetype: "glyphh-app", launchConfig: { tool: "gpoint" } },
    { id: "u8", name: "Bookmark-less", slug: "nothing", url: null, isBrowser: true },
  ];

  it("offers the base work panels always, a house panel only when held, never Echo or Rail", () => {
    const none = cellPickerTools(new Set(), ["gpoint", "gdrive"]).map((t) => t.id);
    expect(none).toEqual(["tool:preview", "tool:coding", "tool:diff", "tool:monaco", "tool:files", "tool:plan", "tool:terminal", "tool:gdesign", "tool:gimage", "tool:gvideo", "tool:gsound"]);
    const held = heldHouseViews(rows, { slides: "gpoint", drive: "gdrive" });
    expect([...held]).toEqual(["gpoint"]);
    const some = cellPickerTools(held, ["gpoint", "gdrive"]).map((t) => t.id);
    expect(some).toContain("tool:gpoint");
    expect(some).not.toContain("tool:gdrive");
    expect(CELL_TOOLS.map((t) => t.id)).not.toContain("tool:echo");
    expect(CELL_TOOLS.map((t) => t.id)).not.toContain("tool:rail");
  });

  it("offers the Apps page's apps by name, never the Glyphh row, a nav row or a removed feature", () => {
    expect(cellPickerApps(rows)).toEqual([
      { id: "u2", label: "Finder" }, { id: "u1", label: "Linear" }, { id: "u7", label: "My slides" }, { id: "u3", label: "Notes" },
    ]);
    expect(cellPickerApps([{ id: "z", name: "", url: "https://z" }])).toEqual([{ id: "z", label: "z" }]);
  });

  it("resolves an app by id, slug or suffixed id; blocks only a native app", () => {
    expect(resolveAppRow(rows, "U1")?.name).toBe("Linear");
    expect(resolveAppRow(rows, "linear")?.name).toBe("Linear");
    expect(resolveAppRow(rows, "u3-2")?.name).toBe("Notes");
    expect(resolveAppRow(rows, "nope")).toBeUndefined();
    expect(cellBlocked("u2", resolveAppRow(rows, "u2"))).toBe(true);
    expect(cellBlocked("x", { id: "x", name: "X", isBrowser: true, execPath: "/bin/x" })).toBe(true);
    expect(cellBlocked("u1", resolveAppRow(rows, "u1"))).toBe(false);
    expect(cellBlocked("u3", resolveAppRow(rows, "u3"))).toBe(false);
    expect(cellBlocked("glyphh", rows[0])).toBe(false);
    expect(cellBlocked("tool:terminal", undefined)).toBe(false);
    expect(cellBlocked("agent:codex", undefined)).toBe(false);
    expect(cellBlocked("agents-tabbed", undefined)).toBe(false);
    expect(cellBlocked("unknown", undefined)).toBe(false);
  });

  it("names a cell: tool label, loop name, app name, else the raw id", () => {
    const loop = (id: string): string => (id === "codex" ? "Codex" : id);
    expect(cellLabel("", rows, loop)).toBe("—");
    expect(cellLabel("tool:monaco", rows, loop)).toBe("Editor");
    expect(cellLabel("tool:echo", rows, loop)).toBe("echo");
    expect(cellLabel("agent:codex", rows, loop)).toBe("Codex");
    expect(cellLabel("agents-tabbed", rows, loop)).toBe("Loops (tabbed)");
    expect(cellLabel("linear", rows, loop)).toBe("Linear");
    expect(cellLabel("gone-app", rows, loop)).toBe("gone-app");
  });

  it("lists the agent cells in reading order", () => {
    const g = gridFromCells(2, 2, [
      { panelId: "agent:codex", col: 1, row: 1 },
      { panelId: "tool:terminal", col: 0, row: 0 },
      { panelId: "tool:coding", col: 1, row: 0 },
    ]);
    expect(agentCellIndices(g).map((i) => g.cells[i]!.panelId)).toEqual(["tool:coding", "agent:codex"]);
  });
});
