/**
 * Drips section — recipe builder, CRUD.
 */

import { paginate, renderPaginationBar, confirmAction, clearInvalid, closeHelp } from "./shared.js";

// ── Drips ─────────────────────────────────────────────────

let dripsPage = 0;
let allDrips: Array<{ name: string; recipe: string }> = [];
let builtinEffects: string[] = [];
const dripsListEl = document.getElementById("drips-list")!;
const dripsToolbar = document.getElementById("drips-toolbar")!;
const dripEditor = document.getElementById("drip-editor")!;
const dripNameInput = document.getElementById("drip-name") as HTMLInputElement;
const dripDeleteBtn = document.getElementById("drip-delete-btn") as HTMLButtonElement;
const dripSearchInput = document.getElementById("drip-search") as HTMLInputElement;
const dripFormError = document.getElementById("drip-form-error")!;
const dripModeSelect = document.getElementById("drip-mode") as HTMLSelectElement;
const dripCountInput = document.getElementById("drip-count") as HTMLInputElement;
const dripEffectsList = document.getElementById("drip-effects-list")!;
const dripRecipePreview = document.getElementById("drip-recipe-preview")!;
let editingDripName: string | null = null;

function buildDripRecipe(): string {
  const mode = dripModeSelect.value;
  const parts: string[] = [];
  if (mode === "persistent") parts.push("-1");
  else if (mode === "counted") parts.push(dripCountInput.value || "3");
  const selects = dripEffectsList.querySelectorAll("select");
  selects.forEach((sel) => { if ((sel as HTMLSelectElement).value) parts.push((sel as HTMLSelectElement).value); });
  return parts.join(" ");
}

function updateDripRecipePreview() {
  const recipe = buildDripRecipe();
  dripRecipePreview.textContent = recipe || "—";
}

function addEffectRow(value?: string) {
  const row = document.createElement("div");
  row.style.cssText = "display:flex;gap:6px;align-items:center;";
  const sel = document.createElement("select");
  sel.className = "settings-input";
  sel.style.cssText = "flex:1;";
  const placeholder = document.createElement("option");
  placeholder.value = "";
  placeholder.textContent = "Select effect...";
  sel.appendChild(placeholder);
  for (const eff of builtinEffects) {
    const opt = document.createElement("option");
    opt.value = eff;
    opt.textContent = eff;
    sel.appendChild(opt);
  }
  if (value) sel.value = value;
  sel.addEventListener("change", updateDripRecipePreview);
  row.appendChild(sel);

  const removeBtn = document.createElement("button");
  removeBtn.className = "action-btn danger";
  removeBtn.style.cssText = "padding:4px 8px;font-size:11px;flex-shrink:0;";
  removeBtn.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>`;
  removeBtn.addEventListener("click", () => {
    row.remove();
    updateDripRecipePreview();
  });
  row.appendChild(removeBtn);

  dripEffectsList.appendChild(row);
  updateDripRecipePreview();
}

function parseRecipeIntoBuilder(recipe: string) {
  dripEffectsList.innerHTML = "";
  const tokens = recipe.trim().split(/\s+/);
  let mode = "oneshot";
  let idx = 0;

  if (tokens[0] === "-1") { mode = "persistent"; idx = 1; }
  else if (/^\d+$/.test(tokens[0]) && parseInt(tokens[0]) > 1) {
    mode = "counted";
    dripCountInput.value = tokens[0];
    idx = 1;
  }

  dripModeSelect.value = mode;
  dripCountInput.classList.toggle("hidden", mode !== "counted");

  for (; idx < tokens.length; idx++) {
    if (tokens[idx]) addEffectRow(tokens[idx]);
  }
  if (dripEffectsList.children.length === 0) addEffectRow();
  updateDripRecipePreview();
}

async function loadDrips() {
  dripEditor.classList.add("hidden");
  dripFormError.classList.add("hidden");

  document.getElementById("drips-upgrade-gate")!.classList.add("hidden");
  dripsToolbar.classList.remove("hidden");
  dripsListEl.classList.remove("hidden");

  if (builtinEffects.length === 0) {
    // The IPC returns {name, kind} rows (one-shots then loops); the recipe
    // builder's select needs the names. Tolerate a stale string[] bridge.
    const fx = await window.glyphh.dripsBuiltinEffects();
    builtinEffects = (fx || []).map((f) => (typeof f === "string" ? f : f.name));
  }
  allDrips = await window.glyphh.dripsList();
  renderDripsList();
}

// Representative emoji per built-in effect — used for the drip's icon stack.
const EFFECT_EMOJI: Record<string, string> = {
  fireworks: "🎆", hearts: "❤️", confetti: "🎊", stars: "⭐", rain: "🌧️",
  bubbles: "🫧", sparkle: "✨", spiral: "🌀", emoji: "😀", wave: "👋",
  thumbsup: "👍", peace: "✌️", cat: "🐱", matrix: "🟩", aurora: "🌌",
  nebula: "🌌", plasma: "🔮", fireflies: "✨", starfield: "🌟",
};
/** The distinct effect emojis in a recipe (numbers/opacity tokens skipped). */
function dripEmojis(recipe: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of (recipe || "").trim().split(/\s+/)) {
    if (!t || !isNaN(Number(t)) || seen.has(t)) continue;
    seen.add(t);
    out.push(EFFECT_EMOJI[t] || "✨");
  }
  return out;
}
/** Overlapping emoji-square stack for a drip (list rows + edit head). */
function dripIconsHtml(recipe: string): string {
  const emojis = dripEmojis(recipe);
  const shown = emojis.length ? emojis.slice(0, 4) : ["✨"];
  return shown.map((e) => `<span class="drip-emoji-icon">${e}</span>`).join("");
}

function renderDripsList() {
  const query = dripSearchInput.value.trim().toLowerCase();
  const filtered = query ? allDrips.filter((d) => d.name.toLowerCase().includes(query) || d.recipe.toLowerCase().includes(query)) : allDrips;
  const count = document.getElementById("drips-count");
  if (count) count.textContent = `${allDrips.length} drip${allDrips.length === 1 ? "" : "s"}`;

  // The Connections grammar (his order, 2026-09-16): one table, a row per drip.
  const wasHidden = dripsListEl.classList.contains("hidden") || !dripEditor.classList.contains("hidden");
  dripsListEl.className = wasHidden ? "tabs-list hidden" : "tabs-list";
  dripsListEl.innerHTML = "";
  if (allDrips.length === 0) {
    dripsListEl.innerHTML = '<div class="crud-empty">No custom drips yet — <b>+ Add</b> makes your first one.</div>';
    return;
  }
  if (filtered.length === 0) {
    dripsListEl.innerHTML = `<div class="crud-empty">No drips matching "${query.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c] || c))}"</div>`;
    return;
  }
  const table = document.createElement("div");
  table.className = "conn2-table";
  table.innerHTML = `<div class="conn2-tr head"><span class="conn2-head-connector">Drip</span><span>Recipe</span><span class="conn2-head-status">Status</span></div>`;
  for (const drip of filtered) {
    const tr = document.createElement("div");
    tr.className = "conn2-tr openable";
    tr.innerHTML = `<span class="conn2-icon"><span class="conn2-icon-initial"></span></span><span class="conn2-name"></span><span class="conn2-type"><span class="drip-recipe"></span></span><span class="conn2-status"></span>`;
    (tr.querySelector(".conn2-icon-initial") as HTMLElement).textContent = dripEmojis(drip.recipe)[0] || "✨";
    (tr.querySelector(".conn2-name") as HTMLElement).textContent = drip.name;
    (tr.querySelector(".drip-recipe") as HTMLElement).textContent = drip.recipe;
    const play = document.createElement("button");
    play.type = "button";
    play.className = "action-btn conn2-connect";
    play.textContent = "Play";
    play.addEventListener("click", (ev) => { ev.stopPropagation(); window.glyphh.dripsPreview(drip.recipe); });
    (tr.querySelector(".conn2-status") as HTMLElement).appendChild(play);
    tr.addEventListener("click", () => openDripEditor(drip.name, drip.recipe));
    table.appendChild(tr);
  }
  dripsListEl.appendChild(table);
}

function openDripEditor(name: string, recipe: string) {
  editingDripName = name || null;
  dripNameInput.value = name;
  dripDeleteBtn.style.display = name ? "" : "none";
  dripFormError.classList.add("hidden");

  // Shared edit-form header: the drip's emoji stack + its name.
  const dripHead = document.getElementById("drip-detail-head");
  if (dripHead) {
    dripHead.innerHTML = `<div class="edit-head-icons">${dripIconsHtml(recipe)}</div><div class="edit-head-name"></div>`;
    dripHead.querySelector(".edit-head-name")!.textContent = name || "New drip";
  }

  if (recipe) {
    parseRecipeIntoBuilder(recipe);
  } else {
    dripModeSelect.value = "oneshot";
    dripCountInput.classList.add("hidden");
    dripEffectsList.innerHTML = "";
    addEffectRow();
  }

  dripsListEl.classList.add("hidden");
  dripsToolbar.classList.add("hidden");
  dripEditor.classList.remove("hidden");
  dripNameInput.focus();
}

function closeDripEditor() {
  // Leaving the editor stops anything it started. A preview is scoped to the
  // editor that played it — a looping effect must never outlive the screen you
  // launched it from and sit over the app with no way to reach it.
  void window.glyphh.dripsStop().catch(() => { /* manager gone — nothing to stop */ });
  dripEditor.classList.add("hidden");
  dripsListEl.classList.remove("hidden");
  dripsToolbar.classList.remove("hidden");
  editingDripName = null;
  loadDrips();
}

async function saveDrip() {
  let valid = true;
  const name = dripNameInput.value.trim().toLowerCase();
  const recipe = buildDripRecipe();

  if (!name) { dripNameInput.classList.add("invalid"); clearInvalid(dripNameInput); valid = false; }
  const hasEffects = Array.from(dripEffectsList.querySelectorAll("select")).some((s) => (s as HTMLSelectElement).value);
  if (!hasEffects) {
    dripFormError.textContent = "Select at least one effect.";
    dripFormError.classList.remove("hidden");
    valid = false;
  }
  if (!valid) {
    if (!dripFormError.textContent) {
      dripFormError.textContent = "Please fill in all required fields.";
      dripFormError.classList.remove("hidden");
    }
    return;
  }

  if (editingDripName && editingDripName !== name) {
    await window.glyphh.dripsDelete(editingDripName);
  }
  await window.glyphh.dripsSave(name, recipe);
  editingDripName = name;
  closeDripEditor();
}

async function deleteDrip() {
  if (!editingDripName) return;
  const confirmed = await confirmAction({
    title: `Delete “${editingDripName}”?`,
    body: "The drip disappears from your library.",
    confirmLabel: "Delete drip",
    danger: true,
  });
  if (!confirmed) return;
  await window.glyphh.dripsDelete(editingDripName);
  closeDripEditor();
}

export { loadDrips };

export function initDripsEvents() {
  document.getElementById("drip-new-btn")!.addEventListener("click", () => openDripEditor("", ""));
  document.getElementById("drips-refresh-btn")?.addEventListener("click", () => { void loadDrips(); });
  document.getElementById("drip-save-btn")!.addEventListener("click", saveDrip);
  document.getElementById("drip-cancel-btn")!.addEventListener("click", closeDripEditor);
  document.getElementById("drip-back-link")!.addEventListener("click", closeDripEditor);
  document.getElementById("drip-delete-btn")!.addEventListener("click", deleteDrip);
  document.getElementById("drip-preview-btn")!.addEventListener("click", () => {
    const recipe = buildDripRecipe();
    if (recipe) window.glyphh.dripsPreview(recipe);
  });
  document.getElementById("drip-stop-btn")!.addEventListener("click", () => {
    void window.glyphh.dripsStop().catch(() => { /* manager gone — nothing to stop */ });
  });
  dripModeSelect.addEventListener("change", () => {
    dripCountInput.classList.toggle("hidden", dripModeSelect.value !== "counted");
    updateDripRecipePreview();
  });
  dripCountInput.addEventListener("input", updateDripRecipePreview);
  document.getElementById("drip-add-effect")!.addEventListener("click", () => addEffectRow());
  dripSearchInput.addEventListener("input", () => { dripsPage = 0; renderDripsList(); });
}
