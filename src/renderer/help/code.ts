/**
 * Code — the William agent surface: sessions rail | agent | workbench rails.
 *
 * v1 scaffold: sessions persist in localStorage (moves to a real store when the
 * local William serving layer lands); the assistant reply is a stub that
 * exercises the return/stop send control. The right side is the REAL old
 * workbench (code-workbench-bundle.js — Files / Terminal / Diff / Preview /
 * Plan rails with insert/drag/maximize + per-folder layout persistence); the
 * center header carries its workdir controls and view toggles.
 */

import { confirmAction } from "./shared.js";
import { gotoSection } from "./navigation.js";

interface CodeMsg { role: "user" | "assistant"; text: string; at: number }
interface CodeChat { id: string; title: string; createdAt: number; messages: CodeMsg[] }

const STORE_KEY = "codeChats";
const CURRENT_KEY = "codeCurrentChat";

const STUB_REPLY =
  "William isn't wired into this panel yet — the local serving layer lands next. " +
  "This is the Code surface: sessions on the left, the agent here, and the workbench " +
  "rails on the right (Files / Terminal / Diff / Preview / Plan) where builds land.";

let chats: CodeChat[] = [];
let currentId = "";
let inited = false;
let thinking = false;
let stubTimer: ReturnType<typeof setTimeout> | null = null;
let menuEl: HTMLDivElement | null = null;

function el<T extends HTMLElement = HTMLElement>(id: string): T | null {
  return document.getElementById(id) as T | null;
}
const input = () => el<HTMLTextAreaElement>("code-input");

// ── Session store ────────────────────────────────────────────────────────
function loadStore(): void {
  try { chats = JSON.parse(localStorage.getItem(STORE_KEY) || "[]"); } catch { chats = []; }
  currentId = localStorage.getItem(CURRENT_KEY) || "";
}
function saveStore(): void {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(chats));
    localStorage.setItem(CURRENT_KEY, currentId);
  } catch { /* quota — scaffold store, ignore */ }
}
const current = (): CodeChat | null => chats.find((c) => c.id === currentId) ?? null;

function ensureCodeSection(): void {
  if (!document.querySelector('.help-section[data-section="code"].active')) gotoSection("code");
}

function newChat(): void {
  const c: CodeChat = { id: `c${Date.now().toString(36)}`, title: "New session", createdAt: Date.now(), messages: [] };
  chats.unshift(c);
  currentId = c.id;
  saveStore();
  ensureCodeSection();
  renderHistory();
  renderThread();
  input()?.focus();
}

async function deleteChat(chat: CodeChat): Promise<void> {
  if (!(await confirmAction(`Delete "${chat.title}"?`))) return;
  chats = chats.filter((x) => x.id !== chat.id);
  if (currentId === chat.id) currentId = chats[0]?.id || "";
  saveStore();
  renderHistory();
  renderThread();
}

// ── Session row menu (⋯ → Delete) ────────────────────────────────────────
function closeMenu(): void { menuEl?.remove(); menuEl = null; }

function openChatMenu(anchor: HTMLElement, chat: CodeChat): void {
  closeMenu();
  const m = document.createElement("div");
  m.className = "code-menu";
  const del = document.createElement("button");
  del.className = "code-menu-item danger";
  del.textContent = "Delete";
  del.addEventListener("click", () => { closeMenu(); void deleteChat(chat); });
  m.appendChild(del);
  const r = anchor.getBoundingClientRect();
  m.style.top = `${r.bottom + 4}px`;
  m.style.left = `${Math.max(8, r.right - 120)}px`;
  document.body.appendChild(m);
  menuEl = m;
}

// ── Rendering ────────────────────────────────────────────────────────────
function renderHistory(): void {
  const list = el<HTMLDivElement>("code-history");
  if (!list) return;
  list.textContent = "";
  for (const c of chats) {
    const row = document.createElement("div");
    row.className = "code-history-item" + (c.id === currentId ? " active" : "");
    const label = document.createElement("span");
    label.className = "code-history-title";
    label.textContent = c.title;
    const menuBtn = document.createElement("button");
    menuBtn.className = "code-chat-menu-btn";
    menuBtn.title = "More";
    menuBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" stroke="none"><circle cx="5" cy="12" r="1.7"/><circle cx="12" cy="12" r="1.7"/><circle cx="19" cy="12" r="1.7"/></svg>`;
    menuBtn.addEventListener("click", (e) => { e.stopPropagation(); openChatMenu(menuBtn, c); });
    row.append(label, menuBtn);
    row.addEventListener("click", () => {
      currentId = c.id;
      saveStore();
      ensureCodeSection();
      renderHistory();
      renderThread();
    });
    list.appendChild(row);
  }
}

function renderThread(): void {
  const thread = el<HTMLDivElement>("code-thread");
  if (!thread) return;
  thread.textContent = "";
  const inner = document.createElement("div");
  inner.className = "code-thread-inner";
  thread.appendChild(inner);
  const c = current();
  if (!c || !c.messages.length) {
    const empty = document.createElement("div");
    empty.className = "code-empty";
    empty.textContent = "Describe the app you want William to build.";
    inner.appendChild(empty);
    return;
  }
  for (const m of c.messages) {
    const bubble = document.createElement("div");
    bubble.className = `code-msg ${m.role}`;
    bubble.textContent = m.text;
    inner.appendChild(bubble);
  }
  thread.scrollTop = thread.scrollHeight;
}

// ── Composer ─────────────────────────────────────────────────────────────
function autoGrow(ta: HTMLTextAreaElement): void {
  // Grow with input up to ~10 lines, then scroll internally.
  ta.style.height = "auto";
  ta.style.height = Math.min(ta.scrollHeight, 220) + "px";
}

function setThinking(on: boolean): void {
  thinking = on;
  const send = el("code-send");
  send?.classList.toggle("thinking", on);
  if (send) send.title = on ? "Stop" : "Send";
}

function stopThinking(): void {
  if (stubTimer) { clearTimeout(stubTimer); stubTimer = null; }
  setThinking(false);
}

function send(): void {
  // While thinking the same control is the stop button.
  if (thinking) { stopThinking(); return; }
  const ta = input();
  if (!ta) return;
  const text = ta.value.trim();
  if (!text) return;
  if (!current()) newChat();
  const c = current()!;
  c.messages.push({ role: "user", text, at: Date.now() });
  if (c.title === "New session") c.title = text.length > 42 ? text.slice(0, 42) + "…" : text;
  ta.value = "";
  autoGrow(ta);
  saveStore();
  renderHistory();
  renderThread();
  // Stub "thinking" — replaced by the William agent loop once serving lands.
  setThinking(true);
  stubTimer = setTimeout(() => {
    stubTimer = null;
    const cur = current();
    if (cur) {
      cur.messages.push({ role: "assistant", text: STUB_REPLY, at: Date.now() });
      saveStore();
      renderThread();
    }
    setThinking(false);
  }, 800);
}

// ── Left-rail splitter ───────────────────────────────────────────────────
function initRailSplitter(): void {
  const splitter = el("code-rail-splitter");
  if (!splitter) return;
  splitter.addEventListener("mousedown", (e) => {
    e.preventDefault();
    const pane = el("app-rail");
    if (!pane) return;
    document.body.classList.add("code-dragging");
    const move = (ev: MouseEvent) => {
      const w = Math.min(420, Math.max(170, ev.clientX));
      pane.style.width = `${w}px`;
      pane.style.minWidth = `${w}px`;
    };
    const up = () => {
      document.removeEventListener("mousemove", move);
      document.removeEventListener("mouseup", up);
      document.body.classList.remove("code-dragging");
      const w = parseInt(pane.style.width || "0", 10);
      if (w > 0) void window.yo.setPreference?.("codeRailWidth", w);
    };
    document.addEventListener("mousemove", move);
    document.addEventListener("mouseup", up);
  });
}

async function applyPanelPrefs(): Promise<void> {
  const railCollapsed = ((await window.yo.getPreference?.("codeRailCollapsed", false)) as boolean) || false;
  el("app-rail")?.classList.toggle("collapsed", railCollapsed);
  const railW = Number(await window.yo.getPreference?.("codeRailWidth", 0)) || 0;
  const rail = el("app-rail");
  if (rail && railW > 0) { rail.style.width = `${railW}px`; rail.style.minWidth = `${railW}px`; }
}

// ── Entry points ─────────────────────────────────────────────────────────
export function loadCode(): void {
  loadStore();
  if (!currentId && chats.length) currentId = chats[0].id;
  renderHistory();
  renderThread();
  void applyPanelPrefs();
  // Boot the ported workbench engine (idempotent) — it owns the workdir
  // controls, the view toggles, and everything inside #code-workbench.
  (window as unknown as { __initCodeWorkbench?: () => void }).__initCodeWorkbench?.();
}

export function initCode(): void {
  if (inited) return;
  inited = true;
  el("code-new-chat")?.addEventListener("click", newChat);
  el("code-send")?.addEventListener("click", send);
  const ta = input();
  ta?.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      if (!thinking) send();
    }
  });
  ta?.addEventListener("input", () => autoGrow(ta!));
  el("code-rail-toggle")?.addEventListener("click", () => {
    const collapsed = el("app-rail")!.classList.toggle("collapsed");
    void window.yo.setPreference?.("codeRailCollapsed", collapsed);
  });
  document.addEventListener("mousedown", (e) => {
    if (menuEl && !menuEl.contains(e.target as Node)) closeMenu();
  });
  initRailSplitter();
  // The rail is global (outside the section switcher) — populate Recents and
  // apply collapse/width prefs at boot so it's live on every section.
  loadStore();
  if (!currentId && chats.length) currentId = chats[0].id;
  renderHistory();
  void applyPanelPrefs();
}
