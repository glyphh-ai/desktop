/**
 * skills.ts — the Skills screen as a FILE EXPLORER (ported from the v4 branch,
 * re-themed to .yo). Layout: tree panel (search + skill tree) · draggable
 * divider · content pane. Selecting a skill shows its overview; selecting a
 * file opens it (markdown rendered, code in read-only Monaco, media in a player).
 *
 * VIEW / RUN ONLY: skills are authored by the assistant (server-side, via the
 * skill-builder system skill) and mirrored here read-only. There is no create /
 * edit / upload / delete surface — just browse, run, and export.
 *
 * Mounts into the #skills-explorer-host inside the Skills help-section.
 * navigation.ts calls loadSkills() when the section opens.
 */

import { el, mount } from "./skills-explorer/dom.js";
import { createSkillTree, type SkillMeta } from "./skills-explorer/tree.js";
import { SkillContent } from "./skills-explorer/content.js";
import { confirmAction } from "./shared.js";

const REFRESH = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-3-6.7L21 8"/><polyline points="21 3 21 8 16 8"/></svg>`;
const SEARCH = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16" y2="16"/></svg>`;

export function loadSkills(): void {
  const host = document.getElementById("skills-explorer-host");
  if (!host) return;

  const content = new SkillContent({
    confirm: (m) => confirmAction(m),
    onChanged: () => void load(),
    onSelectSkill: (name) => { tree.setActive({ skill: name }); void content.showSkill(name); },
    // Authoring is server-side only — no in-app build hand-off.
    buildWithAgent: () => {},
  });

  const tree = createSkillTree({
    onSelectSkill: (name) => { window.yo.setPreference("skillsLastSelected", name); void content.showSkill(name); },
    onSelectFile: (name, rel) => void content.showFile(name, rel),
  });

  // ── Tree panel: search + tree (no create/upload — view/run-only) ──
  const searchInput = el("input", {
    class: "skill-search-input",
    attrs: { type: "text", placeholder: "Search skills…", spellcheck: "false", autocomplete: "off" },
  }) as HTMLInputElement;
  searchInput.addEventListener("input", () => tree.filter(searchInput.value));
  const refreshBtn = el("button", { class: "skill-new-btn", html: REFRESH, attrs: { title: "Refresh skill list" } });
  refreshBtn.addEventListener("click", (e) => { e.stopPropagation(); void load(); });

  const treePanel = el("div", { class: "skill-tree-panel" }, [
    el("div", { class: "skill-tree-toolbar" }, [
      el("span", { class: "skill-tree-title", text: "Skills" }),
      refreshBtn,
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
