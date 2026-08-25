/**
 * wb-office-ui.ts — small shared UI for the Glyphh Office panels.
 */

import { renderDocMarkdown } from "./md-doc.js";

/** Mount the mini white-paper preview of a document into a thumb box — the
 *  ONE implementation both the Docs library and Drive render, so they always
 *  match. Fetches the markdown head lazily (small cache). */
const docThumbCache = new Map<string, string>();
export function mountDocThumb(thumb: HTMLElement, file: string): void {
  const paint = (md: string): void => {
    if (!thumb.isConnected) return;
    const sheet = document.createElement("div");
    sheet.className = "gdrive-docthumb";
    const inner = document.createElement("div");
    inner.className = "gdrive-docthumb-inner";
    inner.innerHTML = renderDocMarkdown(md);
    sheet.appendChild(inner);
    thumb.appendChild(sheet);
  };
  const hit = docThumbCache.get(file);
  // A cache hit paints via microtask: callers build the card BEFORE appending
  // it, so a synchronous paint would see isConnected=false and skip — the
  // "previews vanish once the cache warms" bug.
  if (hit !== undefined) { queueMicrotask(() => paint(hit)); return; }
  void (window as unknown as { glyphh?: { gdocRead?: (f: string) => Promise<{ ok: boolean; markdown?: string }> } })
    .glyphh?.gdocRead?.(file)
    .then((res) => {
      if (!res?.ok || typeof res.markdown !== "string") return;
      const head = res.markdown.slice(0, 1500);
      docThumbCache.set(file, head);
      paint(head);
    });
}

/** Drop a document's cached thumb source (it changed). */
export function invalidateDocThumb(file: string): void {
  docThumbCache.delete(file);
}

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
