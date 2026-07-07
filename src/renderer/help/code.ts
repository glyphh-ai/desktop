/**
 * Code — the William agent surface: sessions rail | agent | workbench rails.
 *
 * v1 scaffold: sessions persist in localStorage (moves to a real store when the
 * local William serving layer lands); the assistant reply is a stub that
 * exercises the return/stop send control. The center header carries the old
 * workbench's workdir controls (folder / git branch / add-folder — wiring lands
 * with the loop) and its view toggles (Files / Terminal / Diff / Preview /
 * Plan), which open the right-side workbench rails; the rails stay closed
 * until a view is opened.
 */

import { confirmAction } from "./shared.js";

interface CodeMsg { role: "user" | "assistant"; text: string; at: number }
interface CodeChat { id: string; title: string; createdAt: number; messages: CodeMsg[] }

const STORE_KEY = "codeChats";
const CURRENT_KEY = "codeCurrentChat";

const STUB_REPLY =
  "William isn't wired into this panel yet — the local serving layer lands next. " +
  "This is the Code surface: sessions on the left, the agent here, and the workbench " +
  "rails on the right (Files / Terminal / Diff / Preview / Plan) where builds land.";

const VIEW_LABELS: Record<string, string> = {
  files: "Files", terminal: "Terminal", diff: "Diff", preview: "Preview", plan: "Plan",
};

let chats: CodeChat[] = [];
let currentId = "";
let inited = false;
let thinking = false;
let stubTimer: ReturnType<typeof setTimeout> | null = null;
let openViews: string[] = [];
let activeView = "";
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

function newChat(): void {
  const c: CodeChat = { id: `c${Date.now().toString(36)}`, title: "New session", createdAt: Date.now(), messages: [] };
  chats.unshift(c);
  currentId = c.id;
  saveStore();
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

// ── Workbench rails (right) ──────────────────────────────────────────────
function renderWorkbench(): void {
  const wb = el("code-workbench");
  const tabs = el<HTMLDivElement>("code-wb-tabs");
  if (!wb || !tabs) return;
  wb.classList.toggle("collapsed", openViews.length === 0);
  document.querySelectorAll<HTMLButtonElement>(".code-view-btn").forEach((b) =>
    b.classList.toggle("active", openViews.includes(b.dataset.view!)));
  tabs.textContent = "";
  for (const v of openViews) {
    const tab = document.createElement("button");
    tab.className = "code-wb-tab" + (v === activeView ? " active" : "");
    const label = document.createElement("span");
    label.textContent = VIEW_LABELS[v] || v;
    const x = document.createElement("span");
    x.className = "code-wb-tab-x";
    x.textContent = "×";
    x.title = "Close";
    x.addEventListener("click", (e) => { e.stopPropagation(); toggleView(v); });
    tab.append(label, x);
    tab.addEventListener("click", () => { activeView = v; renderWorkbench(); });
    tabs.appendChild(tab);
  }
  document.querySelectorAll<HTMLDivElement>(".code-wb-pane").forEach((p) =>
    p.classList.toggle("active", openViews.length > 0 && p.dataset.wbtab === activeView));
}

function toggleView(v: string): void {
  if (openViews.includes(v)) {
    openViews = openViews.filter((x) => x !== v);
    if (activeView === v) activeView = openViews[openViews.length - 1] || "";
  } else {
    openViews.push(v);
    activeView = v;
  }
  renderWorkbench();
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

// ── Splitters ────────────────────────────────────────────────────────────
function initSplitter(splitterId: string, side: "rail" | "wb"): void {
  const splitter = el(splitterId);
  if (!splitter) return;
  splitter.addEventListener("mousedown", (e) => {
    e.preventDefault();
    const root = document.querySelector<HTMLDivElement>(".code-root");
    const pane = el(side === "rail" ? "code-rail" : "code-workbench");
    if (!root || !pane) return;
    document.body.classList.add("code-dragging");
    const move = (ev: MouseEvent) => {
      const r = root.getBoundingClientRect();
      const w = side === "rail"
        ? Math.min(420, Math.max(170, ev.clientX - r.left))
        : Math.min(Math.round(r.width * 0.65), Math.max(280, r.right - ev.clientX));
      pane.style.width = `${w}px`;
      pane.style.minWidth = `${w}px`;
    };
    const up = () => {
      document.removeEventListener("mousemove", move);
      document.removeEventListener("mouseup", up);
      document.body.classList.remove("code-dragging");
      const w = parseInt(pane.style.width || "0", 10);
      if (w > 0) {
        void window.yo.setPreference?.(side === "rail" ? "codeRailWidth" : "codeWorkbenchWidth", w);
      }
    };
    document.addEventListener("mousemove", move);
    document.addEventListener("mouseup", up);
  });
}

async function applyPanelPrefs(): Promise<void> {
  const railCollapsed = ((await window.yo.getPreference?.("codeRailCollapsed", false)) as boolean) || false;
  el("code-rail")?.classList.toggle("collapsed", railCollapsed);
  const railW = Number(await window.yo.getPreference?.("codeRailWidth", 0)) || 0;
  const wbW = Number(await window.yo.getPreference?.("codeWorkbenchWidth", 0)) || 0;
  const rail = el("code-rail");
  const wb = el("code-workbench");
  if (rail && railW > 0) { rail.style.width = `${railW}px`; rail.style.minWidth = `${railW}px`; }
  if (wb && wbW > 0) { wb.style.width = `${wbW}px`; wb.style.minWidth = `${wbW}px`; }
}

// ── Entry points ─────────────────────────────────────────────────────────
export function loadCode(): void {
  loadStore();
  if (!currentId && chats.length) currentId = chats[0].id;
  renderHistory();
  renderThread();
  renderWorkbench();
  void applyPanelPrefs();
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
    const collapsed = el("code-rail")!.classList.toggle("collapsed");
    void window.yo.setPreference?.("codeRailCollapsed", collapsed);
  });
  document.querySelectorAll<HTMLButtonElement>(".code-view-btn").forEach((btn) => {
    btn.addEventListener("click", () => toggleView(btn.dataset.view!));
  });
  document.addEventListener("mousedown", (e) => {
    if (menuEl && !menuEl.contains(e.target as Node)) closeMenu();
  });
  initSplitter("code-rail-splitter", "rail");
  initSplitter("code-wb-splitter", "wb");
  // Workdir controls (folder / branch / add) are scaffolding — wired with the
  // William loop. No-ops for now.
}
