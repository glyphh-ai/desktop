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

/** Pull this loop's slots from the server. Safe to call on every loop change. */
export async function refreshRoles(loop: string): Promise<RoleView[]> {
  try {
    const r = await window.yo.loopRoles?.(loop);
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
 * What the chip reads. One slot shows the model; several show how many are bound,
 * because four model names do not fit on a chip.
 */
export function chipText(): string {
  if (!roles.length) return "Model";
  if (roles.length === 1) return modelName(roles[0].modelId) || "Model";
  return `${roles.length} models`;
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
  menu.appendChild(searchWrap);

  const list = document.createElement("div");
  list.className = "drop-scroll";
  menu.appendChild(list);

  const closeTips = () => list.querySelectorAll(".model-info-tip").forEach((t) => t.classList.add("hidden"));

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

      if (roles.length > 1 || role.description) {
        const head = document.createElement("div");
        head.className = "code-drop-head" + (role.description ? " drop-head-2line" : "");
        const label = document.createElement("span");
        label.textContent = roles.length > 1 ? role.label : "Model";
        head.appendChild(label);
        if (role.description) {
          const desc = document.createElement("span");
          desc.className = "drop-sub";
          desc.textContent = role.description;
          head.appendChild(desc);
        }
        list.appendChild(head);
      }

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
        const tip = document.createElement("div");
        tip.className = "model-info-tip hidden";
        tip.textContent = info;
        tip.addEventListener("click", (ev) => ev.stopPropagation());
        infoBtn.addEventListener("click", (ev) => {
          ev.stopPropagation();
          const wasHidden = tip.classList.contains("hidden");
          closeTips();
          if (wasHidden) tip.classList.remove("hidden");
        });
        main.appendChild(infoBtn);
        item.appendChild(tip);
        item.appendChild(main);

        const sub = document.createElement("span");
        sub.className = "drop-sub";
        sub.textContent = [windowLabel(choice.contextWindow), price, note].filter(Boolean).join(" · ");
        item.appendChild(sub);

        item.addEventListener("click", () => {
          closeTips();
          menu.classList.add("hidden");
          void (async () => {
            try {
              const r = await window.yo.loopRoleSet?.(loop, role.name, choice.id);
              if (r?.roles) roles = r.roles;
            } catch { /* the pick did not take; the next open shows the truth */ }
            onPicked();
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
