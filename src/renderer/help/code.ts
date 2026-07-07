/**
 * Code — the William agent surface: chats rail | agent thread | workbench.
 *
 * v1 scaffold: chats persist in localStorage (moves to a real store when the
 * local William serving layer lands); the assistant reply is a stub until the
 * agent loop is wired. The workbench panes are empty-state placeholders for
 * built bundles (code / repair diffs / live preview).
 */

import { confirmAction } from "./shared.js";

interface CodeMsg { role: "user" | "assistant"; text: string; at: number }
interface CodeChat { id: string; title: string; createdAt: number; messages: CodeMsg[] }

const STORE_KEY = "codeChats";
const CURRENT_KEY = "codeCurrentChat";

const STUB_REPLY =
  "William isn't wired into this panel yet — the local serving layer lands next. " +
  "This is the Code surface: chats on the left, the agent here, and the workbench " +
  "on the right where built bundles (code, diffs, preview) will land.";

let chats: CodeChat[] = [];
let currentId = "";
let inited = false;

function el<T extends HTMLElement = HTMLElement>(id: string): T | null {
  return document.getElementById(id) as T | null;
}
const input = () => el<HTMLTextAreaElement>("code-input");

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
  const c: CodeChat = { id: `c${Date.now().toString(36)}`, title: "New chat", createdAt: Date.now(), messages: [] };
  chats.unshift(c);
  currentId = c.id;
  saveStore();
  renderHistory();
  renderThread();
  input()?.focus();
}

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
    const del = document.createElement("button");
    del.className = "code-history-del";
    del.title = "Delete chat";
    del.textContent = "×";
    del.addEventListener("click", async (e) => {
      e.stopPropagation();
      if (!(await confirmAction(`Delete "${c.title}"?`))) return;
      chats = chats.filter((x) => x.id !== c.id);
      if (currentId === c.id) currentId = chats[0]?.id || "";
      saveStore();
      renderHistory();
      renderThread();
    });
    row.append(label, del);
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
  const c = current();
  if (!c || !c.messages.length) {
    const empty = document.createElement("div");
    empty.className = "code-empty";
    empty.textContent = "Describe the app you want William to build.";
    thread.appendChild(empty);
    return;
  }
  for (const m of c.messages) {
    const bubble = document.createElement("div");
    bubble.className = `code-msg ${m.role}`;
    bubble.textContent = m.text;
    thread.appendChild(bubble);
  }
  thread.scrollTop = thread.scrollHeight;
}

function autoGrow(ta: HTMLTextAreaElement): void {
  ta.style.height = "auto";
  ta.style.height = Math.min(ta.scrollHeight, 180) + "px";
}

function send(): void {
  const ta = input();
  if (!ta) return;
  const text = ta.value.trim();
  if (!text) return;
  if (!current()) newChat();
  const c = current()!;
  c.messages.push({ role: "user", text, at: Date.now() });
  if (c.title === "New chat") c.title = text.length > 42 ? text.slice(0, 42) + "…" : text;
  ta.value = "";
  autoGrow(ta);
  // Stub — replaced by the William agent loop once local serving lands.
  c.messages.push({ role: "assistant", text: STUB_REPLY, at: Date.now() });
  saveStore();
  renderHistory();
  renderThread();
}

async function applyPanelPrefs(): Promise<void> {
  const railCollapsed = ((await window.yo.getPreference?.("codeRailCollapsed", false)) as boolean) || false;
  const wbCollapsed = ((await window.yo.getPreference?.("codeWorkbenchCollapsed", false)) as boolean) || false;
  el("code-rail")?.classList.toggle("collapsed", railCollapsed);
  el("code-workbench")?.classList.toggle("collapsed", wbCollapsed);
}

export function loadCode(): void {
  loadStore();
  if (!currentId && chats.length) currentId = chats[0].id;
  renderHistory();
  renderThread();
  void applyPanelPrefs();
}

export function initCode(): void {
  if (inited) return;
  inited = true;
  el("code-new-chat")?.addEventListener("click", newChat);
  el("code-send")?.addEventListener("click", send);
  const ta = input();
  ta?.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); }
  });
  ta?.addEventListener("input", () => autoGrow(ta!));
  el("code-rail-toggle")?.addEventListener("click", () => {
    const collapsed = el("code-rail")!.classList.toggle("collapsed");
    void window.yo.setPreference?.("codeRailCollapsed", collapsed);
  });
  el("code-workbench-toggle")?.addEventListener("click", () => {
    const collapsed = el("code-workbench")!.classList.toggle("collapsed");
    void window.yo.setPreference?.("codeWorkbenchCollapsed", collapsed);
  });
  document.querySelectorAll<HTMLButtonElement>(".code-wb-tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      document.querySelectorAll<HTMLButtonElement>(".code-wb-tab").forEach((t) => t.classList.toggle("active", t === tab));
      document.querySelectorAll<HTMLDivElement>(".code-wb-pane").forEach((p) => p.classList.toggle("active", p.dataset.wbtab === tab.dataset.wbtab));
    });
  });
}
