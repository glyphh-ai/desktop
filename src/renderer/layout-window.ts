/**
 * Layout window (5b) — renders a server layout's cells as webviews tiled in
 * a CSS grid inside ONE window ("window" mode; "screen" mode tiles real OS
 * windows instead — see app-window-manager.openLayoutOnScreen). The grid
 * spec arrives via the ?grid= query param from app-window-manager.
 */

declare global {
  interface Window {
    glyphhWin?: { reportWebview: (slug: string, wcId: number) => void };
  }
}

interface LayoutCell {
  slug: string;
  name: string;
  url: string;
  col: number;
  row: number;
  colSpan: number;
  rowSpan: number;
}

interface LayoutGrid {
  name: string;
  cols: number;
  rows: number;
  cells: LayoutCell[];
}

type CellWebview = HTMLElement & { getWebContentsId: () => number };

const params = new URLSearchParams(window.location.search);
let grid: LayoutGrid | null = null;
try { grid = JSON.parse(params.get("grid") || "null") as LayoutGrid; } catch { /* bad param */ }

const gridEl = document.getElementById("grid")!;

if (grid && grid.cells.length > 0) {
  document.title = grid.name;
  gridEl.style.gridTemplateColumns = `repeat(${grid.cols}, 1fr)`;
  gridEl.style.gridTemplateRows = `repeat(${grid.rows}, 1fr)`;

  for (const cell of grid.cells) {
    const view = document.createElement("webview") as CellWebview;
    view.setAttribute("partition", "persist:yo");
    view.setAttribute("allowpopups", "");
    view.style.gridColumn = `${cell.col + 1} / span ${cell.colSpan}`;
    view.style.gridRow = `${cell.row + 1} / span ${cell.rowSpan}`;
    view.addEventListener("dom-ready", () => {
      try { window.glyphhWin?.reportWebview(cell.slug, view.getWebContentsId()); } catch { /* */ }
    });
    view.setAttribute("src", cell.url);
    gridEl.appendChild(view);
  }
}

export {};
