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

// ── Inline identity edit — name + description on a detail view ──────────────

/**
 * Add a pencil beside a detail view's title that swaps the title/description
 * block into a small inline form. `onSave` persists the patch and returns
 * null on success (the caller re-renders the detail) or an error to show.
 */
export function wireIdentityEdit(
  host: HTMLElement,
  identity: { name: string; description: string },
  onSave: (patch: { name: string; description: string }) => Promise<string | null>,
): void {
  const title = host.querySelector<HTMLElement>(".lib-read-title");
  const desc = host.querySelector<HTMLElement>(".lib-read-desc");
  if (!title || !desc) return;

  const pencil = document.createElement("button");
  pencil.type = "button";
  pencil.className = "lib-identity-edit";
  pencil.title = "Edit name & description";
  pencil.innerHTML = ROW_MENU_ICONS.edit;
  title.appendChild(pencil);

  pencil.addEventListener("click", () => {
    if (host.querySelector(".lib-identity-form")) return;
    const form = document.createElement("div");
    form.className = "lib-identity-form";
    form.innerHTML = `
      <input type="text" class="settings-input lib-identity-name" maxlength="120" placeholder="Name" spellcheck="false" />
      <textarea class="settings-input lib-identity-desc" rows="3" placeholder="What is it for?"></textarea>
      <div class="settings-actions" style="margin:0;">
        <button type="button" class="action-btn primary lib-identity-save">Save</button>
        <button type="button" class="action-btn lib-identity-cancel">Cancel</button>
      </div>
      <div class="settings-hint danger hidden lib-identity-err"></div>`;
    const nameEl = form.querySelector<HTMLInputElement>(".lib-identity-name")!;
    const descEl = form.querySelector<HTMLTextAreaElement>(".lib-identity-desc")!;
    const errEl = form.querySelector<HTMLElement>(".lib-identity-err")!;
    nameEl.value = identity.name;
    descEl.value = identity.description;
    title.classList.add("hidden");
    desc.classList.add("hidden");
    desc.insertAdjacentElement("afterend", form);
    nameEl.focus();
    nameEl.select();

    const closeForm = (): void => {
      form.remove();
      title.classList.remove("hidden");
      desc.classList.remove("hidden");
    };
    form.querySelector(".lib-identity-cancel")!.addEventListener("click", closeForm);
    form.querySelector(".lib-identity-save")!.addEventListener("click", () => {
      void (async () => {
        const name = nameEl.value.trim();
        if (!name) { errEl.textContent = "A name is required."; errEl.classList.remove("hidden"); return; }
        errEl.classList.add("hidden");
        form.querySelectorAll("button, input, textarea").forEach((el) => ((el as HTMLButtonElement).disabled = true));
        const err = await onSave({ name, description: descEl.value.trim() });
        if (err === null) return;   // caller re-rendered the detail — form is gone
        form.querySelectorAll("button, input, textarea").forEach((el) => ((el as HTMLButtonElement).disabled = false));
        errEl.textContent = err;
        errEl.classList.remove("hidden");
      })();
    });
  });
}

// ── Table row ⋯ menu — shared by the library tables ──────────────────────────

const EDIT_ICON = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.85 2.85 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/></svg>`;
const DELETE_ICON = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/></svg>`;
export const ROW_MENU_ICONS = {
  view: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>`, edit: EDIT_ICON, delete: DELETE_ICON };

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
