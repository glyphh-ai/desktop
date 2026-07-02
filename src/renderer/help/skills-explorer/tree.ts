/**
 * tree.ts — the explorer's left tree: each skill is a top-level FOLDER whose
 * children are its files (lazy-loaded on first expand). File-type + folder
 * icons, search filter, single active selection (a skill folder or a file).
 * Ported from the v4 workspace skills explorer.
 */

import { el } from "./dom.js";

export interface SkillMeta {
  name: string; description?: string;
  hasRunner: boolean; hasApp: boolean; scheduled: boolean; scheduleExpr?: string;
}

const CARET = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>`;
const FOLDER = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/></svg>`;
const F_MD = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M7 15V9l3 3 3-3v6"/><path d="M17 9v6"/><path d="m14.5 13 2.5 2 2.5-2"/></svg>`;
const F_JS = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>`;
const F_JSON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 3H7a2 2 0 0 0-2 2v4a2 2 0 0 1-2 2 2 2 0 0 1 2 2v4a2 2 0 0 0 2 2h1"/><path d="M16 3h1a2 2 0 0 1 2 2v4a2 2 0 0 0 2 2 2 2 0 0 0-2 2v4a2 2 0 0 1-2 2h-1"/></svg>`;
const F_DOC = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>`;

function fileIcon(rel: string): string {
  const ext = rel.toLowerCase().split(".").pop() || "";
  if (/^(md|mdx|markdown)$/.test(ext)) return F_MD;
  if (/^(js|mjs|cjs|jsx|ts|tsx)$/.test(ext)) return F_JS;
  if (/^(json|json5|yaml|yml|toml)$/.test(ext)) return F_JSON;
  return F_DOC;
}

export interface SkillTree {
  el: HTMLElement;
  setSkills(skills: SkillMeta[]): void;
  filter(q: string): void;
  setActive(sel: { skill: string; file?: string } | null): void;
}

export function createSkillTree(opts: {
  onSelectSkill: (name: string) => void;
  onSelectFile: (name: string, rel: string) => void;
}): SkillTree {
  const rootEl = el("div", { class: "skill-tree" });
  const folders = new Map<string, { row: HTMLElement; body: HTMLElement; loaded: boolean; expanded: boolean; meta: SkillMeta }>();
  let active: { skill: string; file?: string } | null = null;

  function syncActive(): void {
    rootEl.querySelectorAll<HTMLElement>(".skill-tree-folder-row, .skill-tree-file").forEach((n) => n.classList.remove("active"));
    if (!active) return;
    const f = folders.get(active.skill);
    if (!f) return;
    if (!active.file) f.row.classList.add("active");
    else f.body.querySelector<HTMLElement>(`[data-file="${cssEsc(active.file)}"]`)?.classList.add("active");
  }

  async function expand(name: string, on: boolean): Promise<void> {
    const f = folders.get(name);
    if (!f) return;
    f.expanded = on;
    f.row.querySelector(".skill-tree-caret")?.classList.toggle("open", on);
    f.body.classList.toggle("hidden", !on);
    if (on && !f.loaded) {
      f.loaded = true;
      let files: string[] = await window.yo.skillsListFiles(name).catch(() => []);
      if (!files.length) files = ["SKILL.md"];
      files.sort((a, b) => (a === "SKILL.md" ? -1 : b === "SKILL.md" ? 1 : a === "SKILL.js" ? -1 : b === "SKILL.js" ? 1 : a.localeCompare(b)));
      f.body.innerHTML = "";
      for (const rel of files) {
        const typeClass = /\.(md|mdx|markdown)$/i.test(rel) ? " md"
          : /\.(js|mjs|cjs|jsx|ts|tsx)$/i.test(rel) ? " code"
          : /\.(json|json5|yaml|yml|toml)$/i.test(rel) ? " data" : "";
        const item = el("div", { class: "skill-tree-file", attrs: { "data-file": rel } }, [
          el("span", { class: `skill-tree-ficon${typeClass}`, html: fileIcon(rel) }),
          el("span", { class: "skill-tree-fname", text: rel }),
        ]);
        item.addEventListener("click", (e) => { e.stopPropagation(); active = { skill: name, file: rel }; syncActive(); opts.onSelectFile(name, rel); });
        f.body.append(item);
      }
      syncActive();
    }
  }

  function makeFolder(meta: SkillMeta): void {
    const caret = el("span", { class: "skill-tree-caret", html: CARET });
    const pills: (Node | string)[] = [];
    if (meta.scheduled) pills.push(el("span", { class: "skill-pill skill-pill-scheduled", text: "Scheduled" }));
    if (meta.hasRunner) pills.push(el("span", { class: "skill-pill skill-pill-js", text: "JS" }));
    const row = el("div", { class: "skill-tree-folder-row" }, [
      caret,
      el("span", { class: "skill-tree-ficon", html: FOLDER }),
      el("span", { class: "skill-tree-name", text: meta.name }),
      el("span", { class: "skill-tree-pills" }, pills),
    ]);
    const body = el("div", { class: "skill-tree-files hidden" });
    caret.addEventListener("click", (e) => { e.stopPropagation(); void expand(meta.name, !folders.get(meta.name)!.expanded); });
    row.addEventListener("click", () => { active = { skill: meta.name }; syncActive(); void expand(meta.name, true); opts.onSelectSkill(meta.name); });
    const folder = el("div", { class: "skill-tree-folder", attrs: { "data-skill": meta.name } }, [row, body]);
    rootEl.append(folder);
    folders.set(meta.name, { row, body, loaded: false, expanded: false, meta });
  }

  return {
    el: rootEl,
    setSkills(skills: SkillMeta[]) {
      rootEl.innerHTML = "";
      folders.clear();
      if (!skills.length) { rootEl.append(el("div", { class: "skill-tree-empty", text: "No skills yet. The assistant creates skills for you." })); return; }
      for (const s of skills) makeFolder(s);
      syncActive();
    },
    filter(q: string) {
      const query = q.trim().toLowerCase();
      for (const [name, f] of folders) {
        const hit = !query || name.toLowerCase().includes(query) || (f.meta.description || "").toLowerCase().includes(query);
        (f.row.parentElement as HTMLElement).classList.toggle("hidden", !hit);
      }
    },
    setActive(sel) { active = sel; syncActive(); },
  };
}

function cssEsc(s: string): string { return s.replace(/["\\]/g, "\\$&"); }
