/**
 * slash-menu.ts — the composer's `/` skill menu, Claude-style.
 *
 * Typing `/` at the start of a word pops the installed-skill list AT THE
 * CARET: search at the top (pre-fed with whatever follows the slash), skills
 * below, arrows + Enter to pick, Escape to dismiss. Picking inserts the
 * skill's slash reference into the prompt; the agent resolves it at run time.
 *
 * Caret pixel position comes from the classic mirror-div trick — a hidden
 * clone of the textarea with identical typography, text up to the caret, and
 * a marker span whose rect IS the caret's rect.
 */

import type { SkillSummary } from "./library-types.js";
import { unwrap } from "./library-types.js";

let menu: HTMLElement | null = null;
let items: SkillSummary[] = [];
let filtered: SkillSummary[] = [];
let active = 0;
let anchor: HTMLTextAreaElement | null = null;
let slashStart = -1; // index of "/" in the textarea's value

/** Pixel position of a character index inside a textarea, via mirror div. */
function caretRect(ta: HTMLTextAreaElement, index: number): { left: number; top: number } {
  const mirror = document.createElement("div");
  const style = getComputedStyle(ta);
  for (const prop of [
    "fontFamily", "fontSize", "fontWeight", "lineHeight", "letterSpacing",
    "paddingTop", "paddingRight", "paddingBottom", "paddingLeft",
    "borderTopWidth", "borderRightWidth", "borderBottomWidth", "borderLeftWidth",
    "boxSizing", "whiteSpace", "wordWrap", "overflowWrap",
  ] as const) mirror.style[prop] = style[prop];
  mirror.style.position = "absolute";
  mirror.style.visibility = "hidden";
  mirror.style.whiteSpace = "pre-wrap";
  mirror.style.width = `${ta.clientWidth}px`;
  mirror.textContent = ta.value.slice(0, index);
  const marker = document.createElement("span");
  marker.textContent = "​";
  mirror.appendChild(marker);
  document.body.appendChild(mirror);
  const taRect = ta.getBoundingClientRect();
  const left = taRect.left + marker.offsetLeft - ta.scrollLeft;
  const top = taRect.top + marker.offsetTop - ta.scrollTop;
  mirror.remove();
  return { left, top };
}

function close(): void {
  menu?.remove();
  menu = null;
  slashStart = -1;
}

function pick(skill: SkillSummary): void {
  if (!anchor || slashStart < 0) return;
  const v = anchor.value;
  // Replace "/query" with the skill's slash reference + a trailing space.
  const after = v.slice(anchor.selectionStart ?? v.length);
  anchor.value = `${v.slice(0, slashStart)}/${skill.slug} ${after}`;
  const caret = slashStart + skill.slug.length + 2;
  anchor.setSelectionRange(caret, caret);
  anchor.dispatchEvent(new Event("input", { bubbles: true })); // autosize etc.
  anchor.focus();
  close();
}

function paint(query: string): void {
  if (!menu) return;
  const q = query.toLowerCase();
  filtered = q
    ? items.filter((s) => `${s.slug} ${s.name} ${s.description}`.toLowerCase().includes(q))
    : items;
  active = Math.min(active, Math.max(0, filtered.length - 1));

  const list = menu.querySelector(".slash-list")!;
  list.textContent = "";
  if (!filtered.length) {
    const empty = document.createElement("div");
    empty.className = "slash-empty";
    empty.textContent = query ? `No skills matching "${query}"` : "No skills installed";
    list.appendChild(empty);
    return;
  }
  filtered.forEach((skill, i) => {
    const row = document.createElement("button");
    row.type = "button";
    row.className = "slash-item" + (i === active ? " active" : "");
    const name = document.createElement("span");
    name.className = "slash-item-slug";
    name.textContent = `/${skill.slug}`;
    const desc = document.createElement("span");
    desc.className = "slash-item-desc";
    desc.textContent = skill.description || skill.name;
    row.append(name, desc);
    if (skill.builtIn) {
      const b = document.createElement("span");
      b.className = "lib-badge";
      b.textContent = "Built-in";
      row.appendChild(b);
    }
    row.addEventListener("mousedown", (e) => { e.preventDefault(); pick(skill); });
    row.addEventListener("mousemove", () => { active = i; paintActive(); });
    list.appendChild(row);
  });
  menu.querySelector<HTMLElement>(".slash-item.active")?.scrollIntoView({ block: "nearest" });
}

function paintActive(): void {
  menu?.querySelectorAll(".slash-item").forEach((el, i) => el.classList.toggle("active", i === active));
}

async function open(ta: HTMLTextAreaElement, at: number, query = ""): Promise<void> {
  close();
  anchor = ta;
  slashStart = at;
  try {
    // The SAME folders Settings → Build → Skills lists (2026-09-17): the slash
    // menu used to read a JSON store nothing else renders, so a skill an agent
    // saved was invisible here and there.
    type Folder = { id: string; name: string; description: string; enabled: boolean };
    const env = await window.glyphh.skillsList("skill") as { ok: boolean; data?: Folder[] };
    items = (env.ok ? env.data ?? [] : [])
      .filter((sk) => sk.enabled)
      .map((sk): SkillSummary => ({
        id: sk.id, slug: sk.id.slice(sk.id.indexOf(":") + 1), name: sk.name, description: sk.description,
        hasCode: false, schedule: null, updatedAt: "",
      }));
  } catch {
    items = [];
  }

  menu = document.createElement("div");
  menu.className = "slash-menu";
  const search = document.createElement("input");
  search.className = "slash-search";
  search.placeholder = "Search skills…";
  search.spellcheck = false;
  const list = document.createElement("div");
  list.className = "slash-list";
  menu.append(search, list);
  document.body.appendChild(menu);

  // Anchor at the caret and open UPWARD: pinning the menu's BOTTOM just above
  // the caret line means the list grows up however tall it paints — it can
  // never run off the bottom of the window.
  const rect = caretRect(ta, at);
  const width = 340;
  menu.style.left = `${Math.min(rect.left, window.innerWidth - width - 12)}px`;
  menu.style.bottom = `${Math.max(8, window.innerHeight - rect.top + 8)}px`;

  active = 0;
  paint(query);
  search.value = query;
  // The search box mirrors the composer and accepts direct clicks — but focus
  // STAYS in the composer: the user keeps typing there and the filter follows.
  search.addEventListener("input", () => { active = 0; paint(search.value); });
  search.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown") { e.preventDefault(); active = Math.min(active + 1, filtered.length - 1); paintActive(); }
    else if (e.key === "ArrowUp") { e.preventDefault(); active = Math.max(active - 1, 0); paintActive(); }
    else if (e.key === "Enter") { e.preventDefault(); if (filtered[active]) pick(filtered[active]); }
    else if (e.key === "Escape") { e.preventDefault(); close(); anchor?.focus(); }
  });
}

/** Wire the slash menu onto a composer textarea. Call once at init. */
export function attachSlashMenu(ta: HTMLTextAreaElement): void {
  ta.addEventListener("input", () => {
    const caret = ta.selectionStart ?? 0;
    const before = ta.value.slice(0, caret);
    // A slash opens the menu only at a word start ("/", start of line, or after
    // whitespace) — mid-word slashes (URLs, paths) must not trigger it. A
    // SPACE breaks the match, so pressing space dismisses the menu.
    const m = /(^|\s)\/([a-z0-9_-]*)$/i.exec(before);
    if (m) {
      const at = caret - m[2]!.length - 1;
      if (!menu) {
        void open(ta, at, m[2]!);
      } else {
        // Focus stays in the composer — what's typed after the slash IS the
        // filter; the search box just mirrors it.
        const search = menu.querySelector<HTMLInputElement>(".slash-search");
        if (search) search.value = m[2]!;
        active = 0;
        paint(m[2]!);
      }
    } else if (menu) {
      close();
    }
  });
  ta.addEventListener("keydown", (e) => {
    if (!menu) return;
    // Composer-first navigation: the caret never leaves the prompt.
    if (e.key === "ArrowDown") { e.preventDefault(); active = Math.min(active + 1, filtered.length - 1); paintActive(); }
    else if (e.key === "ArrowUp") { e.preventDefault(); active = Math.max(active - 1, 0); paintActive(); }
    else if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); e.stopImmediatePropagation(); if (filtered[active]) pick(filtered[active]); }
    else if (e.key === "Escape") { e.preventDefault(); close(); }
  });
  document.addEventListener("mousedown", (e) => {
    if (menu && !menu.contains(e.target as Node) && e.target !== ta) close();
  });
}
