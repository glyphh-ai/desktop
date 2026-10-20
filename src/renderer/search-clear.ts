/**
 * search-clear — adds a small circular × button to the right of every search
 * box, shown only when the box has text. Clicking it clears the box (and fires
 * an `input` event so the existing filter logic re-runs).
 *
 * Call initSearchClears() once after the DOM is ready in each renderer entry
 * point (home.ts, renderer.ts). Idempotent per input.
 */

const SEARCH_SELECTORS = [
  "input.crud-search",
  "input.rail-recents-search",
  "input.yo-history-search",
  "#app-connector-search",
].join(",");

const CLEAR_ICON =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="6" y1="6" x2="18" y2="18"/><line x1="18" y1="6" x2="6" y2="18"/></svg>';

function attach(input: HTMLInputElement): void {
  if (input.dataset.searchClear || !input.parentElement) return;
  input.dataset.searchClear = "1";

  const wrap = document.createElement("span");
  wrap.className = "search-clear-wrap";
  input.parentElement.insertBefore(wrap, input);
  wrap.appendChild(input);

  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "search-clear-btn";
  btn.tabIndex = -1;
  btn.setAttribute("aria-label", "Clear search");
  btn.innerHTML = CLEAR_ICON;
  wrap.appendChild(btn);

  const sync = () => btn.classList.toggle("visible", input.value.length > 0);
  input.addEventListener("input", sync);
  // Keep the input focused when the button is pressed.
  btn.addEventListener("mousedown", (e) => e.preventDefault());
  btn.addEventListener("click", () => {
    input.value = "";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.focus();
    sync();
  });
  sync();
}

/** Attach the clear button to every search input under `root`. */
export function initSearchClears(root: ParentNode = document): void {
  root.querySelectorAll<HTMLInputElement>(SEARCH_SELECTORS).forEach(attach);
}
