/**
 * model-picker.ts — the composer's model drop-up.
 *
 * The picker's SHAPE comes from the loop, not from this file: a loop declares its
 * model slots, so the base loop's single slot renders one dropdown while a
 * planner-and-coder loop renders two, each labelled with what it is for. Adding a
 * slot to a loop adds a dropdown here with no change to this code.
 *
 * Everything shown — which models are choosable, which one a slot resolves to, and
 * where that answer came from — is resolved server-side and rendered verbatim. The
 * picker never decides a default itself, because a dropdown that computes its own
 * answer is a dropdown that can disagree with the run.
 *
 * Split out of code.ts, which had accumulated the whole chat surface.
 */

import { showDropDetail } from "./shared.js";

/** One model slot, resolved for this caller. Mirrors the preload bridge. */
export interface RoleView {
  name: string;
  label: string;
  description: string;
  modelId: string | null;
  source: "selection" | "loop" | "platform" | "fallback" | "none";
  choices: Array<{
    id: string;
    name: string;
    providerSlug: string;
    contextWindow: number | null;
    maxOutputTokens: number | null;
    inputCreditsPerMTok: number;
    outputCreditsPerMTok: number;
    isPlatformDefault: boolean;
  }>;
}

let roles: RoleView[] = [];

/** The slots as last resolved — the compaction meter reads context windows here. */
export function currentRoles(): RoleView[] {
  return roles;
}

/** Overlay a SESSION's own model bindings onto the resolved slots (his rule,
 *  2026-08-20: each session runs its own models — five layouts, five casts,
 *  independent). The chip, the menu's checkmarks, and turn resolution all read
 *  the overlaid state, so what this session shows is what this session runs. */
export function overlayRoleSelections(models?: Record<string, string> | null): void {
  if (!models) return;
  roles = roles.map((r) => {
    const bound = models[r.name];
    return bound && r.choices.some((c) => c.id === bound)
      ? { ...r, modelId: bound, source: "selection" as const }
      : r;
  });
}

/** Pull this loop's slots from the server. Safe to call on every loop change.
 *  `context: "cloud"` resolves for a pod-executed session. */
export async function refreshRoles(loop: string, force?: boolean, context?: "local" | "cloud"): Promise<RoleView[]> {
  try {
    const r = await window.glyphh.loopRoles?.(loop, force, context);
    roles = r?.roles ?? [];
  } catch {
    roles = []; // Offline — the chip falls back to a neutral label.
  }
  return roles;
}

/** A model id's display name, falling back to the id itself. */
function modelName(id: string | null): string {
  if (!id) return "";
  for (const role of roles) {
    const hit = role.choices.find((c) => c.id === id);
    if (hit) return hit.name || id;
  }
  return id;
}

/**
 * What the chip reads. One slot shows the model; several show each slot with its
 * binding — "Planner: Fable 5 / Builder: Sonnet 5" — so a multi-model loop's
 * whole cast is visible without opening the menu.
 */
export function chipText(): string {
  if (!roles.length) return "Model";
  if (roles.length === 1) return modelName(roles[0].modelId) || "Model";
  return roles.map((r) => `${r.label}: ${modelName(r.modelId) || "—"}`).join(" / ");
}

export function chipTitle(): string {
  if (!roles.length) return "Model — click to choose";
  if (roles.length === 1) return `Model: ${modelName(roles[0].modelId)} — click to change`;
  return roles.map((r) => `${r.label}: ${modelName(r.modelId)}`).join("\n");
}

/** Where a slot's model came from — shown so an inherited pick reads differently
 *  from a deliberate one. A user's own selection needs no explanation. */
function sourceNote(source: RoleView["source"]): string {
  switch (source) {
    case "loop": return "This loop's default";
    case "platform": return "Your organization's default";
    case "fallback": return "First model you're allowed";
    case "none": return "No model available";
    default: return "";
  }
}

const CHECK = `<svg class="drop-check" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`;

/** Context windows are the reason a small model needs a different loop — worth
 *  showing, in the units people actually say them in. */
function windowLabel(tokens: number | null): string {
  if (!tokens) return "";
  return tokens >= 1000 ? `${Math.round(tokens / 1000)}k context` : `${tokens} context`;
}

function credits(v: number | null | undefined): string {
  return v == null ? "—" : String(Math.round(v));
}

/**
 * Render the drop-up: one section per slot, each with its choices.
 *
 * `onPicked` fires after the server has stored the selection and returned fresh
 * slots, so the caller repaints from resolved state rather than assuming the
 * pick took.
 */
export function renderMenu(menu: HTMLElement, loop: string, onPicked: () => void): void {
  menu.textContent = "";

  if (!roles.length) {
    const empty = document.createElement("div");
    empty.className = "code-drop-head";
    empty.textContent = "No models available";
    menu.appendChild(empty);
    return;
  }

  // Collapsible sections exist only when several SLOTS render headers.
  const multi = roles.length > 1;
  // The menu closes on a pick ONLY when there was exactly one option to pick —
  // with a real choice on offer (any slot count), picking must not yank the
  // menu away: the check moves live and the X closes it.
  const closeOnPick = roles.reduce((n, r) => n + r.choices.length, 0) <= 1;

  // Search stays pinned; only the list below it scrolls. A workspace can allow
  // dozens of models across several slots, and scrolling past the search box to
  // reach the filter defeats the point of having one.
  const searchWrap = document.createElement("div");
  searchWrap.className = "drop-search";
  const search = document.createElement("input");
  search.className = "drop-search-input";
  search.type = "text";
  search.placeholder = "Search models…";
  search.setAttribute("aria-label", "Search models");
  // Typing must not reach the composer's key handling behind the menu.
  search.addEventListener("keydown", (ev) => ev.stopPropagation());
  searchWrap.appendChild(search);
  const pane = document.createElement("div");
  pane.className = "drop-pane";
  menu.appendChild(pane);
  pane.appendChild(searchWrap);

  const closeTips = (): void => { menu.querySelector(".drop-detail")?.remove(); pane.classList.remove("hidden"); };
  const closeMenu = (): void => { closeTips(); menu.classList.add("hidden"); };
  const closeX = document.createElement("button");
  closeX.className = "drop-close-x";
  closeX.type = "button";
  closeX.title = "Close";
  closeX.setAttribute("aria-label", "Close");
  closeX.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>`;
  closeX.addEventListener("click", (ev) => { ev.stopPropagation(); closeMenu(); });
  searchWrap.appendChild(closeX);

  const list = document.createElement("div");
  list.className = "drop-scroll";
  pane.appendChild(list);

  // Collapsible sections: the FIRST slot open, the rest folded — a five-slot
  // loop's menu stays one screen tall. A live search overrides the folds (a
  // match hidden under a closed section reads as "missing").
  const open = new Map<string, boolean>(roles.map((r, i) => [r.name, i === 0]));

  const paint = (query: string): void => {
    list.textContent = "";
    const q = query.trim().toLowerCase();
    // Match on what a user would actually type: the model's name or its provider.
    const matches = (c: RoleView["choices"][number]) =>
      !q || (c.name || c.id).toLowerCase().includes(q) || c.providerSlug.toLowerCase().includes(q);

    let shown = 0;
    for (const role of roles) {
      const choices = role.choices.filter(matches);
      // A slot with nothing left to show drops its header too, rather than
      // leaving a heading over an empty gap.
      if (!choices.length) continue;
      shown += choices.length;
      const expanded = !!q || !multi || !!open.get(role.name);

      if (multi || role.description) {
        const head = document.createElement("div");
        head.className = "code-drop-head" + (role.description ? " drop-head-2line" : "");
        const label = document.createElement("span");
        label.textContent = multi ? role.label : "Model";
        head.appendChild(label);
        if (role.description) {
          const desc = document.createElement("span");
          desc.className = "drop-sub";
          desc.textContent = role.description;
          head.appendChild(desc);
        }
        if (multi) {
          head.classList.add("drop-head-toggle");
          const chev = document.createElement("span");
          chev.className = "drop-chev";
          chev.textContent = expanded ? "▾" : "▸";
          head.appendChild(chev);
          head.addEventListener("click", () => { open.set(role.name, !open.get(role.name)); paint(search.value); });
        }
        list.appendChild(head);
      }

      if (!expanded) continue;

      for (const choice of choices) {
        const selected = choice.id === role.modelId;
        const item = document.createElement("button");
        item.className = "code-drop-item drop-item-2line" + (selected ? " selected" : "");
        item.type = "button";

        const main = document.createElement("div");
        main.className = "drop-main";
        const name = document.createElement("span");
        name.textContent = choice.name || choice.id;
        main.appendChild(name);
        if (selected) main.insertAdjacentHTML("beforeend", CHECK);

        // ⓘ — the sub-line stays scannable; the detail lives in a tooltip that
        // never triggers a model switch.
        const price = `${credits(choice.inputCreditsPerMTok)}/${credits(choice.outputCreditsPerMTok)} credits per 1M tokens`;
        const note = selected ? sourceNote(role.source) : "";
        const info = [
          `${choice.name} — ${choice.providerSlug}.`,
          windowLabel(choice.contextWindow),
          price,
          note,
        ].filter(Boolean).join("\n");

        const infoBtn = document.createElement("button");
        infoBtn.className = "model-info-btn";
        infoBtn.type = "button";
        infoBtn.title = "About this model";
        infoBtn.textContent = "i";
        infoBtn.addEventListener("click", (ev) => {
          ev.stopPropagation();
          showDropDetail(menu, pane, { title: choice.name || choice.id, body: info });
        });
        main.appendChild(infoBtn);
        item.appendChild(main);

        const sub = document.createElement("span");
        sub.className = "drop-sub";
        sub.textContent = [windowLabel(choice.contextWindow), price, note].filter(Boolean).join(" · ");
        item.appendChild(sub);

        item.addEventListener("click", (ev) => {
          // Stop the click reaching the document dismiss handler: paint() below
          // re-renders the list and detaches THIS node, so the outside-click check
          // (modelWrap.contains(target)) would fail and wrongly close a multi-slot
          // menu after the first pick.
          ev.stopPropagation();
          closeTips();
          if (closeOnPick) menu.classList.add("hidden");
          void (async () => {
            try {
              const r = await window.glyphh.loopRoleSet?.(loop, role.name, choice.id);
              if (r?.roles) roles = r.roles;
            } catch { /* the pick did not take; the next open shows the truth */ }
            onPicked();
            if (!closeOnPick && !menu.classList.contains("hidden")) paint(search.value);
          })();
        });
        list.appendChild(item);
      }
    }

    if (!shown) {
      const empty = document.createElement("div");
      empty.className = "drop-empty";
      empty.textContent = `No models match "${query.trim()}"`;
      list.appendChild(empty);
    }
  };

  search.addEventListener("input", () => paint(search.value));
  paint("");
}

/** Focus the search box — called after the menu is unhidden, so a user can type
 *  straight into it instead of reaching for the mouse. */
export function focusSearch(menu: HTMLElement): void {
  const input = menu.querySelector<HTMLInputElement>(".drop-search-input");
  if (!input) return;
  input.value = "";
  input.focus();
}
