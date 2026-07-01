/**
 * skills.ts — the Skills screen as a FILE EXPLORER (ported from the v4 branch,
 * re-themed to .yo). Layout: tree panel (search + new + skill tree) · draggable
 * divider · content pane. Selecting a skill shows its overview; selecting a
 * file opens it (markdown rendered, code in read-only Monaco, media in a player).
 *
 * Mounts into the #skills-explorer-host inside the Skills help-section.
 * navigation.ts calls loadSkills() when the section opens.
 */

import { el, mount } from "./skills-explorer/dom.js";
import { createSkillTree, type SkillMeta } from "./skills-explorer/tree.js";
import { SkillContent } from "./skills-explorer/content.js";
import { confirmAction } from "./shared.js";

const PLUS = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>`;
const REFRESH = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-3-6.7L21 8"/><polyline points="21 3 21 8 16 8"/></svg>`;
const SKILLS_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>`;
const MENU_EDIT = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/></svg>`;
const MENU_UPLOAD = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>`;
const SEARCH = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16" y2="16"/></svg>`;

/** Agent hand-off used to open the in-app agent panel with a build prompt
 *  prefilled. That panel was removed (pivot-mcp); there is currently no
 *  in-app destination for this hand-off, so surface a clear message instead
 *  of silently failing or reconnecting to an internal LLM call. */
function handToAgent(_prompt: string): void {
  void confirmAction("Building skills with the in-app agent isn't available yet — use Claude Code (or another external agent) with this prompt for now.");
}

export function loadSkills(): void {
  const host = document.getElementById("skills-explorer-host");
  if (!host) return;

  const content = new SkillContent({
    confirm: (m) => confirmAction(m),
    onChanged: () => void load(),
    onSelectSkill: (name) => { tree.setActive({ skill: name }); void content.showSkill(name); },
    buildWithAgent: (prompt) => handToAgent(prompt),
  });

  const tree = createSkillTree({
    onSelectSkill: (name) => { window.yo.setPreference("skillsLastSelected", name); void content.showSkill(name); },
    onSelectFile: (name, rel) => void content.showFile(name, rel),
  });

  // ── Tree panel: search + new + tree ──
  const searchInput = el("input", {
    class: "skill-search-input",
    attrs: { type: "text", placeholder: "Search skills…", spellcheck: "false", autocomplete: "off" },
  }) as HTMLInputElement;
  searchInput.addEventListener("input", () => tree.filter(searchInput.value));
  const newBtn = el("button", { class: "skill-new-btn", html: PLUS, attrs: { title: "New skill" } });
  newBtn.addEventListener("click", (e) => { e.stopPropagation(); openCreateMenu(newBtn); });
  const refreshBtn = el("button", { class: "skill-new-btn", html: REFRESH, attrs: { title: "Refresh skill list" } });
  refreshBtn.addEventListener("click", (e) => { e.stopPropagation(); void load(); });

  const treePanel = el("div", { class: "skill-tree-panel" }, [
    el("div", { class: "skill-tree-toolbar" }, [
      el("span", { class: "skill-tree-title", text: "Skills" }),
      refreshBtn,
      newBtn,
    ]),
    el("div", { class: "skill-tree-searchrow" }, [
      el("span", { class: "skill-search", html: SEARCH }, [searchInput]),
    ]),
    el("div", { class: "skill-tree-scroll" }, [tree.el]),
  ]);

  const divider = el("div", { class: "skill-explorer-divider", attrs: { title: "Drag to resize" } });
  const root = el("div", { class: "skills skills-explorer" }, [treePanel, divider, content.root]);
  mount(host, root);
  wireDivider(divider, treePanel, () => content.relayout());

  const load = async () => {
    let skills: SkillMeta[] = [];
    try { skills = await window.yo.skillsListDetailed(); } catch { skills = []; }
    tree.setSkills(skills);
    if (!skills.length) { content.showEmpty(); return; }
    let last = "";
    try { last = (await window.yo.getPreference("skillsLastSelected", "")) as string; } catch { last = ""; }
    const pick = skills.find((s) => s.name === last) || skills[0];
    tree.setActive({ skill: pick.name });
    void content.showSkill(pick.name);
  };

  // ── "+" create menu ──
  let menu: HTMLElement | null = null;
  function closeMenu(): void { menu?.remove(); menu = null; document.removeEventListener("click", closeMenu); }
  function openCreateMenu(anchor: HTMLElement): void {
    if (menu) { closeMenu(); return; }
    const item = (icon: string, label: string, onClick: () => void) => {
      const b = el("button", { class: "ws-popover-item skill-menu-item" }, [
        el("span", { class: "skill-menu-icon", html: icon }),
        el("span", { class: "skill-menu-label", text: label }),
      ]);
      b.addEventListener("click", () => { closeMenu(); onClick(); });
      return b;
    };
    menu = el("div", { class: "ws-popover skill-create-menu open" }, [
      item(SKILLS_ICON, "Create with Glyphh", () => handToAgent("Create a new Glyphh skill that ")),
      item(MENU_EDIT, "Write instructions", () => { tree.setActive(null); content.showCreate(); }),
      item(MENU_UPLOAD, "Upload a skill", () => uploadSkill()),
    ]);
    document.body.append(menu);
    const r = anchor.getBoundingClientRect();
    menu.style.top = `${r.bottom + 4}px`;
    menu.style.left = `${Math.min(r.left, window.innerWidth - 240)}px`;
    setTimeout(() => document.addEventListener("click", closeMenu), 0);
  }

  // ── Upload modal (dropzone + picker) ──
  function uploadSkill(): void {
    const status = el("div", { class: "skill-upload-status" });
    const fileInput = el("input", { attrs: { type: "file", accept: ".yo,.zip" } }) as HTMLInputElement;
    fileInput.style.display = "none";
    const drop = el("div", { class: "skill-upload-drop" }, [
      el("div", { class: "skill-upload-drop-title", text: "Drop a skill bundle here" }),
      el("div", { class: "skill-upload-drop-sub", text: "or click to choose a file" }),
    ]);
    const box = el("div", { class: "skill-upload-box" }, [
      el("div", { class: "skill-upload-head", text: "Upload a skill" }),
      drop, fileInput,
      el("ul", { class: "skill-upload-reqs" }, [
        el("li", { text: "A .yo or .zip bundle." }),
        el("li", { text: "Must contain a SKILL.md (name + description front-matter)." }),
        el("li", { text: "May include SKILL.js and supporting files." }),
      ]),
      status,
      el("div", { class: "skill-upload-actions" }, [
        (() => { const c = el("button", { class: "action-btn", text: "Cancel" }); c.addEventListener("click", close); return c; })(),
      ]),
    ]);
    const overlay = el("div", { class: "skill-upload-overlay" }, [box]);
    function close(): void { overlay.remove(); }
    overlay.addEventListener("click", (e) => { if (e.target === overlay) close(); });
    drop.addEventListener("click", () => fileInput.click());
    drop.addEventListener("dragover", (e) => { e.preventDefault(); drop.classList.add("over"); });
    drop.addEventListener("dragleave", () => drop.classList.remove("over"));
    drop.addEventListener("drop", (e: DragEvent) => { e.preventDefault(); drop.classList.remove("over"); if (e.dataTransfer?.files[0]) void handleFile(e.dataTransfer.files[0]); });
    fileInput.addEventListener("change", () => { if (fileInput.files?.[0]) void handleFile(fileInput.files[0]); });
    async function handleFile(file: File): Promise<void> {
      status.textContent = "Importing…";
      const base64 = await new Promise<string>((res) => {
        const fr = new FileReader();
        fr.onload = () => res(String(fr.result).split(",")[1] || "");
        fr.readAsDataURL(file);
      });
      const r = await window.yo.skillsImport(base64, false).catch(() => ({ imported: [], skipped: [], error: "import failed" }));
      if (r.error) { status.textContent = r.error; return; }
      close();
      await load();
    }
    document.body.append(overlay);
  }

  void load();

  // Auto-reload when anything changes the skills directory — the .Yo agent
  // dropping files via Write, an external editor, drag-and-drop import, etc.
  window.yo.onSkillsChanged?.(() => { void load(); });
}

function wireDivider(divider: HTMLElement, panel: HTMLElement, onResize: () => void): void {
  divider.addEventListener("mousedown", (e: MouseEvent) => {
    e.preventDefault();
    divider.classList.add("dragging");
    const startX = e.clientX;
    const startW = panel.getBoundingClientRect().width;
    const onMove = (ev: MouseEvent) => {
      const w = Math.max(180, Math.min(480, startW + (ev.clientX - startX)));
      panel.style.width = `${w}px`;
      onResize();
    };
    const onUp = () => {
      divider.classList.remove("dragging");
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  });
}

/** Rendering is lazy — loadSkills() rebuilds the explorer when the section opens. */
export function initSkillsEvents(): void { /* no global wiring needed */ }
