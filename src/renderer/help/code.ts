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
import { appIconInner } from "./app-icon.js";

interface CodeMsg { role: "user" | "assistant"; text: string; at: number }
interface CodeChat { id: string; title: string; createdAt: number; messages: CodeMsg[] }

const STORE_KEY = "codeChats";
const CURRENT_KEY = "codeCurrentChat";

const STUB_REPLY =
  "William isn't wired into this panel yet — the local serving layer lands next. " +
  "This is the Code surface: sessions on the left, the agent here, and the workbench " +
  "rails on the right (Files / Terminal / Diff / Preview / Plan) where builds land.";

// Ghost empty-state quotes — the spirit of Ada & William Lovelace, with
// peace and love woven in. Rotates while the thread is empty.
const GHOST_QUOTES = [
  "The Engine weaves algebraic patterns as the loom weaves flowers — may it weave peace, too.",
  "Imagination is the discovering faculty. Love is what it keeps discovering.",
  "Poetical science: half proof, half devotion.",
  "Build gently — even engines can be kind.",
  "Understanding is love's slow algorithm.",
  "We weave what we love into everything we make.",
  "Peace resolves like a well-run loop: no conflicts left.",
  "First, do the loveliest math: care.",
];
let ghostIdx = Math.floor(Math.random() * GHOST_QUOTES.length);
let ghostTimer: ReturnType<typeof setInterval> | null = null;

function stopGhostRotation(): void {
  if (ghostTimer) { clearInterval(ghostTimer); ghostTimer = null; }
}
function startGhostRotation(quoteEl: HTMLElement): void {
  stopGhostRotation();
  ghostTimer = setInterval(() => {
    if (!quoteEl.isConnected) { stopGhostRotation(); return; }
    quoteEl.style.opacity = "0";
    setTimeout(() => {
      ghostIdx = (ghostIdx + 1) % GHOST_QUOTES.length;
      quoteEl.textContent = GHOST_QUOTES[ghostIdx];
      quoteEl.style.opacity = "";
    }, 500);
  }, 7000);
}

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
  // Fresh sessions start clean: all workbench rails closed, folder reset.
  (window as unknown as { __codeWorkbenchNewSession?: () => void }).__codeWorkbenchNewSession?.();
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
  stopGhostRotation();
  const c = current();
  if (!c || !c.messages.length) {
    const ghost = document.createElement("div");
    ghost.className = "code-ghost";
    const mark = document.createElement("img");
    mark.className = "code-ghost-mark";
    mark.src = "brand/glyphh-mark.png";
    mark.alt = "";
    const quote = document.createElement("div");
    quote.className = "code-ghost-quote";
    quote.textContent = GHOST_QUOTES[ghostIdx];
    ghost.append(mark, quote);
    inner.appendChild(ghost);
    startGhostRotation(quote);
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
  // Dot-commands (.dip slack, .drip rain, …) run through the command parser —
  // the composer doubles as the command input.
  if (text.startsWith(".") && text.length > 1) {
    if (!current()) newChat();
    const cc = current()!;
    cc.messages.push({ role: "user", text, at: Date.now() });
    if (cc.title === "New session") cc.title = text.length > 42 ? text.slice(0, 42) + "…" : text;
    ta.value = "";
    autoGrow(ta);
    void window.yo.execCommand(text.slice(1).trim());
    cc.messages.push({ role: "assistant", text: `→ ran ${text}`, at: Date.now() });
    saveStore();
    renderHistory();
    renderThread();
    return;
  }
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

// ── Apps grid — the same list + icons as the Apps page / command center,
//    ordered by last-opened (recents:list), opened with the same .dip the
//    Apps page uses. All apps show; recents float to the top so search
//    still covers the long tail. ─────────────────────────────────────────
interface RailApp {
  id: string;
  slug?: string | null;
  name: string;
  url?: string | null;
  execPath?: string | null;
  system?: boolean;
  connection?: { accountId?: string; pipedreamSlug: string } | null;
}
let railApps: RailApp[] = [];
let railRecentTs: Record<string, number> = {};

async function loadRecentApps(): Promise<void> {
  try {
    const [apps, recents] = await Promise.all([
      window.yo.panelAppsList?.() ?? Promise.resolve([]),
      window.yo.recentsList?.() ?? Promise.resolve([]),
    ]);
    railApps = ((apps || []) as unknown as RailApp[]).filter((a) => !a.system);
    railRecentTs = {};
    for (const r of recents || []) {
      if (r.kind === "app") railRecentTs[r.id] = Math.max(railRecentTs[r.id] || 0, r.ts || 0);
    }
  } catch { railApps = []; railRecentTs = {}; }
  renderRecentApps();
}

function renderRecentApps(): void {
  const list = el<HTMLDivElement>("recent-apps-list");
  if (!list) return;
  const q = (el<HTMLInputElement>("recent-apps-search")?.value || "").trim().toLowerCase();
  list.textContent = "";
  const items = railApps
    .filter((a) => !q || (a.name || "").toLowerCase().includes(q))
    .sort((a, b) => {
      const ta = railRecentTs[a.id] || 0;
      const tb = railRecentTs[b.id] || 0;
      if (ta !== tb) return tb - ta; // last-opened first
      return (a.name || "").localeCompare(b.name || "");
    });
  if (!items.length) {
    const empty = document.createElement("div");
    empty.className = "code-empty";
    empty.style.margin = "10px auto";
    empty.textContent = q ? "No matches." : "Your apps land here.";
    list.appendChild(empty);
    return;
  }
  for (const a of items) {
    const tile = document.createElement("button");
    tile.className = "app-rail-tile";
    tile.type = "button";
    tile.title = a.name;
    const icon = document.createElement("div");
    icon.className = "tile-icon";
    icon.innerHTML = appIconInner(a, a.name, "tile-initial");
    const nm = document.createElement("span");
    nm.className = "tile-name";
    nm.textContent = a.name;
    tile.append(icon, nm);
    tile.addEventListener("click", () => { void window.yo.execCommand(`dip ${a.slug || a.id}`); });
    list.appendChild(tile);
  }
}

// ── Recents disclosure ───────────────────────────────────────────────────
function setRecentsOpen(open: boolean, persist: boolean): void {
  el("recents-toggle")?.classList.toggle("closed", !open);
  el("code-history")?.classList.toggle("hidden", !open);
  el("recents-vsplit")?.classList.toggle("hidden", !open);
  if (persist) void window.yo.setPreference?.("codeRecentsOpen", open);
}

// ── Recents vertical resize ──────────────────────────────────────────────
function initRecentsVsplit(): void {
  const vs = el("recents-vsplit");
  const hist = el("code-history");
  if (!vs || !hist) return;
  vs.addEventListener("mousedown", (e) => {
    e.preventDefault();
    document.body.classList.add("code-vdragging");
    const startY = e.clientY;
    const startH = hist.getBoundingClientRect().height;
    const move = (ev: MouseEvent) => {
      const h = Math.max(60, Math.min(Math.round(window.innerHeight * 0.6), startH + (ev.clientY - startY)));
      hist.style.flex = `0 0 ${h}px`;
    };
    const up = () => {
      document.removeEventListener("mousemove", move);
      document.removeEventListener("mouseup", up);
      document.body.classList.remove("code-vdragging");
      const m = hist.style.flex.match(/(\d+)px/);
      const h = m ? parseInt(m[1], 10) : 0;
      if (h > 0) void window.yo.setPreference?.("codeRecentsH", h);
    };
    document.addEventListener("mousemove", move);
    document.addEventListener("mouseup", up);
  });
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
  document.body.classList.toggle("rail-collapsed", railCollapsed);
  const railW = Number(await window.yo.getPreference?.("codeRailWidth", 0)) || 0;
  const rail = el("app-rail");
  if (rail && railW > 0) { rail.style.width = `${railW}px`; rail.style.minWidth = `${railW}px`; }
  const recentsH = Number(await window.yo.getPreference?.("codeRecentsH", 0)) || 0;
  const hist = el("code-history");
  if (hist && recentsH > 0) hist.style.flex = `0 0 ${recentsH}px`;
  const recentsOpen = (await window.yo.getPreference?.("codeRecentsOpen", true)) as boolean;
  setRecentsOpen(recentsOpen !== false, false);
}

// ── Entry points ─────────────────────────────────────────────────────────
export function loadCode(): void {
  loadStore();
  if (!currentId && chats.length) currentId = chats[0].id;
  renderHistory();
  renderThread();
  void loadRecentApps();
  void applyPanelPrefs();
  // Boot the ported workbench engine (idempotent) — it owns the workdir
  // controls, the view toggles, and everything inside #code-workbench.
  (window as unknown as { __initCodeWorkbench?: () => void }).__initCodeWorkbench?.();
}

export function initCode(): void {
  if (inited) return;
  inited = true;
  el("code-new-chat")?.addEventListener("click", newChat);
  el("recents-toggle")?.addEventListener("click", () => {
    const open = el("recents-toggle")!.classList.contains("closed");
    setRecentsOpen(open, true);
  });
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
    document.body.classList.toggle("rail-collapsed", collapsed);
    void window.yo.setPreference?.("codeRailCollapsed", collapsed);
  });
  document.addEventListener("mousedown", (e) => {
    if (menuEl && !menuEl.contains(e.target as Node)) closeMenu();
  });
  initRailSplitter();
  initRecentsVsplit();
  el<HTMLInputElement>("recent-apps-search")?.addEventListener("input", renderRecentApps);
  // The rail is global (outside the section switcher) — populate Recents and
  // apply collapse/width prefs at boot so it's live on every section.
  loadStore();
  if (!currentId && chats.length) currentId = chats[0].id;
  renderHistory();
  void loadRecentApps();
  void applyPanelPrefs();
}
