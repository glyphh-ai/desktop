/**
 * lib-editor.ts — the split-divider the library READ views share. (The Monaco
 * code editor that lived here died with the hand-forms: the agent authors
 * these objects now, and programs render as read-only prose.)
 */

// ── Split divider — pointer-captured drag ────────────────────────────────────

/**
 * Wire a draggable split divider. POINTER capture, not mouse listeners: the
 * right pane can be a webview (the apps preview) or a busy canvas, and those
 * swallow mouse events — document-level mouseup never fires and the handle
 * sticks to the cursor. Capture routes every subsequent event to the divider
 * itself until release, whatever the pointer is over.
 */
export function wireSplitDivider(divider: HTMLElement, left: HTMLElement): void {
  let startX = 0;
  let startW = 0;
  divider.addEventListener("pointerdown", (e) => {
    divider.setPointerCapture(e.pointerId);
    startX = e.clientX;
    startW = left.offsetWidth;
    divider.classList.add("dragging");
    document.body.style.userSelect = "none";
    e.preventDefault();
  });
  divider.addEventListener("pointermove", (e) => {
    if (!divider.hasPointerCapture(e.pointerId)) return;
    const max = (divider.parentElement?.clientWidth ?? window.innerWidth) * 0.7;
    left.style.width = `${Math.max(320, Math.min(max, startW + (e.clientX - startX)))}px`;
  });
  const release = (e: PointerEvent): void => {
    if (!divider.hasPointerCapture(e.pointerId)) return;
    divider.releasePointerCapture(e.pointerId);
    divider.classList.remove("dragging");
    document.body.style.userSelect = "";
  };
  divider.addEventListener("pointerup", release);
  divider.addEventListener("pointercancel", release);
}

// ── Table row ⋯ menu — shared by the library tables ──────────────────────────

const EDIT_ICON = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.85 2.85 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/></svg>`;
const DELETE_ICON = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/></svg>`;
export const ROW_MENU_ICONS = { edit: EDIT_ICON, delete: DELETE_ICON };

export interface RowMenuItem { icon: string; label: string; danger?: boolean; onClick: () => void }

/** Open the ⋯ popover at an anchor. One menu at a time; click-away closes. */
export function openRowMenu(anchor: HTMLElement, items: RowMenuItem[]): void {
  document.querySelector(".lib-row-menu")?.remove();
  const menu = document.createElement("div");
  menu.className = "lib-row-menu";
  for (const item of items) {
    const b = document.createElement("button");
    b.type = "button";
    b.innerHTML = `<span class="lib-row-menu-icon">${item.icon}</span><span></span>`;
    b.querySelector("span:last-child")!.textContent = item.label;
    if (item.danger) b.classList.add("danger");
    b.addEventListener("click", () => { menu.remove(); item.onClick(); });
    menu.appendChild(b);
  }
  document.body.appendChild(menu);
  const r = anchor.getBoundingClientRect();
  menu.style.top = `${Math.min(r.bottom + 4, window.innerHeight - menu.offsetHeight - 8)}px`;
  menu.style.left = `${Math.min(r.left, window.innerWidth - menu.offsetWidth - 8)}px`;
  const close = (e: MouseEvent): void => {
    if (!menu.contains(e.target as Node)) { menu.remove(); document.removeEventListener("mousedown", close); }
  };
  setTimeout(() => document.addEventListener("mousedown", close), 0);
}

/** The kebab cell for a table row. Wires the click; returns the <td>. */
export function kebabCell(items: () => RowMenuItem[]): HTMLTableCellElement {
  const td = document.createElement("td");
  td.className = "lib-row-kebab-cell";
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "lib-row-kebab";
  btn.title = "More";
  btn.textContent = "⋮";
  btn.addEventListener("click", (e) => { e.stopPropagation(); openRowMenu(btn, items()); });
  td.appendChild(btn);
  return td;
}
