/**
 * model-controls — the small shared pieces the model and provider lists use:
 * the row icons, an icon button, and the searchable provider dropdown. They
 * outlived the org's own Models page (BYOK providers), which went with BYOK
 * (his order, 2026-09-29: "Remove the concept of adding BYOK models").
 */

export const MDL_SVG = {
  chevron: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 5 16 12 9 19"/></svg>`,
  edit: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.85 2.85 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5z"/></svg>`,
  trash: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>`,
  plus: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>`,
};

export function icoBtn(svg: string, title: string): HTMLButtonElement {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "mdl-ico-btn";
  b.title = title;
  b.setAttribute("aria-label", title);
  b.innerHTML = svg;
  return b;
}

/** A searchable provider dropdown (search on top) — shared by the
 *  library and the Roles model picker (his order, 2026-09-11). */
export function openProviderDropdown(
  anchor: HTMLElement,
  options: Array<{ slug: string; name: string }>,
  current: string,
  onPick: (slug: string, name: string) => void,
): void {
  document.querySelector(".mdl-provider-drop")?.remove();
  const menu = document.createElement("div");
  menu.className = "code-drop mdl-provider-drop";
  const search = document.createElement("input");
  search.type = "text";
  search.className = "loop-drop-search";
  search.placeholder = "Search providers…";
  search.spellcheck = false;
  search.autocomplete = "off";
  const listHost = document.createElement("div");
  listHost.className = "mdl-provider-drop-list";
  menu.append(search, listHost);
  const names = [{ slug: "", name: "All providers" }].concat(options);
  const paint = (): void => {
    const q = search.value.trim().toLowerCase();
    listHost.textContent = "";
    for (const n of names.filter((x) => !q || x.name.toLowerCase().includes(q) || x.slug.includes(q))) {
      const row = document.createElement("button");
      row.type = "button";
      row.className = "code-drop-item" + (n.slug === current ? " active" : "");
      row.textContent = n.name;
      row.addEventListener("click", () => { menu.remove(); onPick(n.slug, n.name); });
      listHost.appendChild(row);
    }
  };
  search.addEventListener("input", paint);
  paint();
  const r = anchor.getBoundingClientRect();
  menu.style.position = "fixed";
  menu.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - 280))}px`;
  menu.style.top = `${r.bottom + 4}px`;
  menu.style.zIndex = "10000";
  document.body.appendChild(menu);
  const dismiss = (e: MouseEvent): void => {
    if (!menu.contains(e.target as Node) && e.target !== anchor) { menu.remove(); document.removeEventListener("mousedown", dismiss, true); }
  };
  document.addEventListener("mousedown", dismiss, true);
  search.focus();
}
