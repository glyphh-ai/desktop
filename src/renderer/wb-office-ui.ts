/**
 * wb-office-ui.ts — small shared UI for the Glyphh Office panels.
 */

/** A Prev / "x of y" / Next pager, or null when one page holds everything. */
export function officePager(total: number, page: number, per: number, onPage: (p: number) => void): HTMLElement | null {
  const pages = Math.max(1, Math.ceil(total / per));
  if (pages <= 1) return null;
  const cur = Math.max(0, Math.min(pages - 1, page));
  const bar = document.createElement("div");
  bar.className = "office-pager";
  const prev = document.createElement("button");
  prev.className = "action-btn office-pager-btn";
  prev.textContent = "‹";
  prev.disabled = cur === 0;
  prev.addEventListener("click", () => onPage(cur - 1));
  const label = document.createElement("span");
  label.className = "office-pager-label";
  label.textContent = `${cur + 1} of ${pages}`;
  const next = document.createElement("button");
  next.className = "action-btn office-pager-btn";
  next.textContent = "›";
  next.disabled = cur >= pages - 1;
  next.addEventListener("click", () => onPage(cur + 1));
  bar.append(prev, label, next);
  return bar;
}

/** The slice for the current page (clamped — a shrinking result set can leave
 *  the saved page past the end). */
export function officePage<T>(items: T[], page: number, per: number): { items: T[]; page: number } {
  const pages = Math.max(1, Math.ceil(items.length / per));
  const cur = Math.max(0, Math.min(pages - 1, page));
  return { items: items.slice(cur * per, cur * per + per), page: cur };
}
