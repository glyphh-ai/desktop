/**
 * Code — the William agent surface: sessions rail | agent | workbench rails.
 *
 * Sessions persist in localStorage (moves to a real store as the loop
 * matures); replies stream from the local William model (llama-server,
 * william.ts bridge) — prompt → thinking spinner → streamed response. The right side is the REAL old
 * workbench (code-workbench-bundle.js — Files / Terminal / Diff / Preview /
 * Plan rails with insert/drag/maximize + per-folder layout persistence); the
 * center header carries its workdir controls and view toggles.
 */

import { confirmAction } from "./shared.js";
import { gotoSection } from "./navigation.js";
import { appIconInner, primeConnectedIcons, primeNativeIcons } from "./app-icon.js";
import { createGlyphhSpinner, type GlyphhSpinner } from "../glyphh-spinner.js";

interface CodeMsg { role: "user" | "assistant"; text: string; at: number }
interface CodeChat { id: string; title: string; createdAt: number; messages: CodeMsg[] }

const STORE_KEY = "codeChats";
const CURRENT_KEY = "codeCurrentChat";

const WILLIAM_SYSTEM =
  "You are William, Glyphh's local coding agent — warm, precise, and direct. " +
  "Answer concretely; when writing code, write complete runnable code.";
// History sent per run — newest-first until the budget is spent.
const HISTORY_MAX_MSGS = 24;
const HISTORY_MAX_CHARS = 20000;

// ── Permission modes + effort (composer chips; Shift+Tab cycles mode) ────
// The mode gates what the agent loop may DO (main: william-permissions.ts);
// plan mode also reshapes the prompt. Effort sets the reply token budget.
const MODES = [
  { id: "ask", label: "Ask", hint: "Every action needs your approval" },
  { id: "plan", label: "Plan", hint: "Read-only — William plans, changes nothing" },
  { id: "acceptEdits", label: "Accept Edits", hint: "File edits auto-approved; commands still ask" },
  { id: "auto", label: "Auto", hint: "Workspace actions auto-approved; risky ones ask" },
  { id: "bypass", label: "Bypass", hint: "Everything auto-approved — trusted sessions only" },
] as const;
const EFFORTS = [
  { id: "low", label: "Low effort", hint: "Quick replies (1k token budget)" },
  { id: "medium", label: "Med effort", hint: "Balanced (4k token budget)" },
  { id: "high", label: "High effort", hint: "Thorough (8k token budget)" },
] as const;
let williamMode: (typeof MODES)[number]["id"] = "ask";
let williamEffort: (typeof EFFORTS)[number]["id"] = "medium";
// Approval cards awaiting a decision (rendered inline in the thread).
let pendingApprovals: Array<{ id: string; kind: string; title: string; detail: string }> = [];

function paintChips(): void {
  const mc = el("code-mode-chip");
  if (mc) {
    const m = MODES.find((x) => x.id === williamMode) ?? MODES[0];
    mc.textContent = m.label;
    mc.title = `${m.hint} — click or Shift+Tab to cycle`;
    mc.className = `code-chip mode-${m.id}`;
  }
  const ec = el("code-effort-chip");
  if (ec) {
    const ef = EFFORTS.find((x) => x.id === williamEffort) ?? EFFORTS[1];
    ec.textContent = ef.label;
    ec.title = `${ef.hint} — click to cycle`;
    ec.className = `code-chip effort-${ef.id}`;
  }
}

function cycleMode(): void {
  const i = MODES.findIndex((m) => m.id === williamMode);
  williamMode = MODES[(i + 1) % MODES.length].id;
  void window.yo.setPreference?.("williamMode", williamMode);
  paintChips();
}

function cycleEffort(): void {
  const i = EFFORTS.findIndex((x) => x.id === williamEffort);
  williamEffort = EFFORTS[(i + 1) % EFFORTS.length].id;
  void window.yo.setPreference?.("williamEffort", williamEffort);
  paintChips();
}

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
// Which chat the agent loop is working (drives the rail dot + spinner row).
let workingChatId: string | null = null;
let spinner: GlyphhSpinner | null = null;
// Active William stream — text accumulates here (chat-keyed, not DOM-keyed,
// so switching sessions mid-stream loses nothing).
let activeRunId: string | null = null;
let streamChatId: string | null = null;
let streamText = "";
let streamBubble: HTMLElement | null = null;
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
    const dot = document.createElement("span");
    const working = thinking && workingChatId === c.id;
    dot.className = "code-chat-dot" + (working ? " working" : "");
    dot.title = working ? "Working" : "Idle";
    const menuBtn = document.createElement("button");
    menuBtn.className = "code-chat-menu-btn";
    menuBtn.title = "More";
    menuBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" stroke="none"><circle cx="12" cy="5" r="1.7"/><circle cx="12" cy="12" r="1.7"/><circle cx="12" cy="19" r="1.7"/></svg>`;
    menuBtn.addEventListener("click", (e) => { e.stopPropagation(); openChatMenu(menuBtn, c); });
    row.append(dot, label, menuBtn);
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
  // Working state — spinner while thinking; once tokens flow the streamed
  // reply renders live in its own bubble.
  spinner?.destroy();
  spinner = null;
  streamBubble = null;
  if (thinking && workingChatId === c.id) {
    for (const a of pendingApprovals) inner.appendChild(approvalCard(a));
    if (streamText && streamChatId === c.id) {
      streamBubble = document.createElement("div");
      streamBubble.className = "code-msg assistant";
      streamBubble.textContent = streamText;
      inner.appendChild(streamBubble);
    } else {
      spinner = createGlyphhSpinner();
      const row = document.createElement("div");
      row.className = "code-msg assistant code-working";
      row.appendChild(spinner.el);
      inner.appendChild(row);
    }
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
  workingChatId = on ? (current()?.id ?? null) : null;
  if (!on) { spinner?.destroy(); spinner = null; }
  const send = el("code-send");
  send?.classList.toggle("thinking", on);
  if (send) send.title = on ? "Stop" : "Send";
  renderHistory(); // rail dots track the loop state
}

function stopThinking(): void {
  // Abort the stream — main answers with william:done { stopped: true },
  // which finalizes whatever streamed so far.
  void window.yo.williamStop?.();
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
  // Working state first so the spinner row + rail dot paint immediately.
  setThinking(true);
  renderHistory();
  renderThread();
  streamChatId = c.id;
  streamText = "";
  void window.yo.williamRun({ messages: buildHistory(c) })
    .then((r) => { activeRunId = r.runId; })
    .catch((err) => {
      finishRun(`⚠ ${err instanceof Error ? err.message : String(err)}`);
    });
}

/** The messages a run sends: William's system prompt + recent history,
 *  newest-first until the budget is spent (then restored to order). */
function buildHistory(c: CodeChat): Array<{ role: string; content: string }> {
  const picked: Array<{ role: string; content: string }> = [];
  let chars = 0;
  for (let i = c.messages.length - 1; i >= 0 && picked.length < HISTORY_MAX_MSGS; i--) {
    const m = c.messages[i];
    chars += m.text.length;
    if (picked.length && chars > HISTORY_MAX_CHARS) break;
    picked.push({ role: m.role, content: m.text });
  }
  let system = WILLIAM_SYSTEM;
  if (williamMode === "plan") {
    system += " PLAN MODE: reply with a concise numbered plan of what you would build or change — no full implementations. End with open questions if anything is unclear.";
  }
  picked.push({ role: "system", content: system });
  return picked.reverse();
}

/** Land the run's outcome in its chat (found by id — the user may have
 *  switched sessions mid-stream) and reset the working state. */
function finishRun(text: string): void {
  const chat = chats.find((ch) => ch.id === streamChatId);
  if (chat && text) chat.messages.push({ role: "assistant", text, at: Date.now() });
  saveStore();
  activeRunId = null;
  streamChatId = null;
  streamText = "";
  streamBubble = null;
  pendingApprovals = [];
  setThinking(false);
  renderThread();
}

/** Inline approval card — Approve / Deny answer main's gate and the card
 *  leaves the thread. */
function approvalCard(a: { id: string; kind: string; title: string; detail: string }): HTMLElement {
  const card = document.createElement("div");
  card.className = "code-approval";
  const kind = document.createElement("div");
  kind.className = "code-approval-kind";
  kind.textContent = a.kind;
  const title = document.createElement("div");
  title.className = "code-approval-title";
  title.textContent = a.title;
  card.append(kind, title);
  if (a.detail) {
    const det = document.createElement("pre");
    det.className = "code-approval-detail";
    det.textContent = a.detail;
    card.appendChild(det);
  }
  const actions = document.createElement("div");
  actions.className = "code-approval-actions";
  const mk = (label: string, allow: boolean, cls: string) => {
    const b = document.createElement("button");
    b.className = `action-btn ${cls}`;
    b.textContent = label;
    b.addEventListener("click", () => {
      pendingApprovals = pendingApprovals.filter((p) => p.id !== a.id);
      void window.yo.williamApprovalRespond?.(a.id, allow);
      renderThread();
    });
    return b;
  };
  actions.append(mk("Approve", true, "primary"), mk("Deny", false, ""));
  card.appendChild(actions);
  return card;
}

/** Wire the stream events once — deltas paint the live bubble (or just
 *  accumulate when another session is in view). */
function initWilliamEvents(): void {
  window.yo.onWilliamApproval?.((a) => {
    pendingApprovals.push(a);
    if (currentId === streamChatId || currentId === workingChatId) renderThread();
  });
  window.yo.onWilliamDelta?.((d) => {
    if (activeRunId && d.runId !== activeRunId) return;
    streamText += d.delta;
    if (currentId === streamChatId) {
      const thread = el<HTMLDivElement>("code-thread");
      if (streamBubble && streamBubble.isConnected) {
        streamBubble.textContent = streamText;
        if (thread) thread.scrollTop = thread.scrollHeight;
      } else {
        renderThread(); // first token — swaps the spinner for the live bubble
      }
    }
  });
  window.yo.onWilliamDone?.((d) => {
    if (activeRunId && d.runId !== activeRunId) return;
    finishRun(streamText);
  });
  window.yo.onWilliamError?.((d) => {
    if (activeRunId && d.runId !== activeRunId) return;
    finishRun(streamText ? `${streamText}\n\n⚠ ${d.error}` : `⚠ ${d.error}`);
  });
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
  isBrowser?: boolean;
  appArchetype?: string | null;
  launchConfig?: Record<string, unknown> | null;
  system?: boolean;
  connection?: { accountId?: string; pipedreamSlug: string } | null;
}
interface RailLayout { name: string; splits: Array<{ panelId: string }> }
let railApps: RailApp[] = [];
let railLayouts: RailLayout[] = [];
let railOsApps: Array<{ proc: string; path: string }> = [];
let railRecentTs: Record<string, number> = {};
let railAppsPage = 0;
let railLayoutsPage = 0;
let railOsPage = 0;
const RAIL_APPS_PER_PAGE = 9;
const RAIL_LAYOUTS_PER_PAGE = 6;

/** Slice items to a page, clamping in-range (palette parity). */
function railPaginate<T>(items: T[], page: number, size: number): { items: T[]; page: number; totalPages: number } {
  const totalPages = Math.max(1, Math.ceil(items.length / size));
  const pp = Math.max(0, Math.min(page, totalPages - 1));
  return { items: items.slice(pp * size, (pp + 1) * size), page: pp, totalPages };
}

/** Prev / n / Next bar (reuses .pagination-* styling), spanning the grid. */
function railPager(page: number, totalPages: number, onPage: (p: number) => void): HTMLElement {
  const bar = document.createElement("div");
  bar.className = "pagination-bar rail-grid-pager";
  if (totalPages <= 1) return bar;
  const nav = document.createElement("div");
  nav.className = "pagination-nav";
  const mk = (label: string, to: number, disabled: boolean) => {
    const b = document.createElement("button");
    b.className = "pagination-btn";
    b.textContent = label;
    b.disabled = disabled;
    b.addEventListener("click", () => onPage(to));
    return b;
  };
  nav.appendChild(mk("‹", page - 1, page === 0));
  const info = document.createElement("span");
  info.className = "pagination-info";
  info.textContent = `${page + 1}/${totalPages}`;
  nav.appendChild(info);
  nav.appendChild(mk("›", page + 1, page >= totalPages - 1));
  bar.appendChild(nav);
  return bar;
}

/** Basename of an exec/.app path, lowercased, ".app" stripped — dedupe key
 *  (same as the command palette). */
function execKey(p: string | null | undefined): string {
  return (p || "").split(/[\\/]/).pop()?.replace(/\.app$/i, "").toLowerCase() || "";
}

async function loadRecentApps(): Promise<void> {
  try {
    const [apps, layouts, recents] = await Promise.all([
      window.yo.panelAppsList?.() ?? Promise.resolve([]),
      window.yo.layoutsList?.() ?? Promise.resolve([]),
      window.yo.recentsList?.() ?? Promise.resolve([]),
    ]);
    // Palette parity: web apps (have a url) + native library apps.
    railApps = ((apps || []) as unknown as RailApp[]).filter((a) => a.url || a.isBrowser === false);
    railLayouts = (layouts || []) as unknown as RailLayout[];
    railRecentTs = {};
    for (const r of recents || []) {
      const key = `${r.kind}:${r.id}`;
      railRecentTs[key] = Math.max(railRecentTs[key] || 0, r.ts || 0);
    }
  } catch { railApps = []; railLayouts = []; railRecentTs = {}; }
  renderRecentApps();
  // Icons land async (Pipedream catalog + OS file icons), then re-render —
  // same as the palette / Apps page.
  void primeConnectedIcons(railApps as never, renderRecentApps);
  void primeNativeIcons(railApps as never, renderRecentApps);
  void refreshOsApps();
}

/** Running OS apps outside the library (osascript enumeration), deduped by
 *  name / executable basename exactly like the palette. Only re-renders when
 *  the set actually changed, so the 6s poll (apps opening/closing show and
 *  hide live) doesn't churn the grid. */
async function refreshOsApps(): Promise<void> {
  try {
    const list = (await window.yo.commandOsApps?.()) || [];
    const libNames = new Set(railApps.map((x) => (x.name || "").trim().toLowerCase()));
    const libExecs = new Set(railApps.map((x) => execKey(x.execPath)).filter(Boolean));
    const next = list.filter((o) =>
      !libNames.has(o.proc.trim().toLowerCase()) && !libExecs.has(execKey(o.path)));
    const sig = (arr: Array<{ proc: string; path: string }>) => arr.map((o) => `${o.proc}\u0000${o.path}`).sort().join("|");
    if (sig(next) === sig(railOsApps)) return;
    railOsApps = next;
    renderRecentApps();
    void primeNativeIcons(railOsApps.map((o) => ({ execPath: o.path || null })) as never, renderRecentApps);
  } catch { /* keep the last known list */ }
}

let railPollTimer: ReturnType<typeof setInterval> | null = null;
function startRailPolling(): void {
  if (railPollTimer) return;
  railPollTimer = setInterval(() => {
    if (document.hidden) return;
    void refreshOsApps();
  }, 6000);
}

function renderRecentApps(): void {
  const list = el<HTMLDivElement>("recent-apps-list");
  if (!list) return;
  const q = (el<HTMLInputElement>("recent-apps-search")?.value || "").trim().toLowerCase();
  list.textContent = "";
  const gridLabel = (text: string) => {
    const label = document.createElement("div");
    label.className = "code-rail-label rail-grid-label";
    label.textContent = text;
    return label;
  };

  // ── Apps (recency-first, name OR slug match — palette parity) ──
  const apps = railApps
    .filter((a) => !q || (a.name || "").toLowerCase().includes(q) || (a.slug || "").toLowerCase().includes(q))
    .sort((a, b) => {
      const ta = railRecentTs[`app:${a.id}`] || 0;
      const tb = railRecentTs[`app:${b.id}`] || 0;
      return ta !== tb ? tb - ta : (a.name || "").localeCompare(b.name || "");
    });
  const ap = railPaginate(apps, railAppsPage, RAIL_APPS_PER_PAGE);
  railAppsPage = ap.page;
  for (const a of ap.items) {
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
    tile.addEventListener("click", () => {
      // Same open the Apps page's "Open app" uses (per-config launch).
      void window.yo.appLaunch?.({
        slug: a.slug || a.id, name: a.name, url: a.url,
        isBrowser: a.isBrowser, execPath: a.execPath,
        appArchetype: a.appArchetype, launchConfig: a.launchConfig,
      });
    });
    list.appendChild(tile);
  }
  if (ap.totalPages > 1) list.appendChild(railPager(ap.page, ap.totalPages, (pg) => { railAppsPage = pg; renderRecentApps(); }));

  // ── Layouts (mini icon stacks; same open as the Layouts page) ──
  const layouts = railLayouts
    .filter((l) => !q || (l.name || "").toLowerCase().includes(q))
    .sort((a, b) => {
      const ta = railRecentTs[`layout:${a.name}`] || 0;
      const tb = railRecentTs[`layout:${b.name}`] || 0;
      return ta !== tb ? tb - ta : (a.name || "").localeCompare(b.name || "");
    });
  if (layouts.length) {
    list.appendChild(gridLabel("Layouts"));
    const lp = railPaginate(layouts, railLayoutsPage, RAIL_LAYOUTS_PER_PAGE);
    railLayoutsPage = lp.page;
    for (const l of lp.items) {
      const tile = document.createElement("button");
      tile.className = "app-rail-tile";
      tile.type = "button";
      tile.title = `${l.name} (layout)`;
      const icon = document.createElement("div");
      icon.className = "tile-icon tile-layout";
      const seen = new Set<string>();
      const ids = l.splits
        .map((s) => s.panelId)
        .filter((id) => id && !seen.has(id) && (seen.add(id), true))
        .slice(0, 4);
      icon.innerHTML = ids.length
        ? ids.map((id) => {
            const app = railApps.find((a) => a.id === id || a.slug === id);
            return `<span class="mini">${appIconInner(app || {}, app?.name || id, "tile-mini-initial")}</span>`;
          }).join("")
        : `<span class="tile-initial">▦</span>`;
      const nm = document.createElement("span");
      nm.className = "tile-name";
      nm.textContent = l.name;
      tile.append(icon, nm);
      tile.addEventListener("click", () => { void window.yo.layoutsOpen?.(l.name); });
      list.appendChild(tile);
    }
    if (lp.totalPages > 1) list.appendChild(railPager(lp.page, lp.totalPages, (pg) => { railLayoutsPage = pg; renderRecentApps(); }));
  }

  // ── Running apps outside the library — click to focus (palette parity) ──
  const os = railOsApps.filter((o) => !q || o.proc.toLowerCase().includes(q));
  if (os.length) {
    list.appendChild(gridLabel("Running apps"));
    const op = railPaginate(os, railOsPage, RAIL_APPS_PER_PAGE);
    railOsPage = op.page;
    for (const o of op.items) {
      const tile = document.createElement("button");
      tile.className = "app-rail-tile app-rail-tile--os";
      tile.type = "button";
      tile.title = `Switch to ${o.proc}`;
      const icon = document.createElement("div");
      icon.className = "tile-icon";
      icon.innerHTML = appIconInner({ execPath: o.path || null }, o.proc, "tile-initial");
      const nm = document.createElement("span");
      nm.className = "tile-name";
      nm.textContent = o.proc;
      tile.append(icon, nm);
      tile.addEventListener("click", () => { void window.yo.commandFocusApp?.(o.proc); });
      list.appendChild(tile);
    }
    if (op.totalPages > 1) list.appendChild(railPager(op.page, op.totalPages, (pg) => { railOsPage = pg; renderRecentApps(); }));
  }

  if (!apps.length && !layouts.length && !os.length) {
    const empty = document.createElement("div");
    empty.className = "code-empty";
    empty.style.margin = "10px auto";
    empty.textContent = q ? "No matches." : "Your apps land here.";
    list.appendChild(empty);
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
    // Dragging down takes space from the apps grid — cap at the point the
    // grid hits its 96px minimum so it always keeps a scrollable row.
    const gridH = el("recent-apps-list")?.getBoundingClientRect().height ?? 0;
    const maxH = startH + Math.max(0, gridH - 96);
    const move = (ev: MouseEvent) => {
      const h = Math.max(60, Math.min(maxH, startH + (ev.clientY - startY)));
      hist.style.flex = `0 1 ${h}px`;
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
  if (hist && recentsH > 0) hist.style.flex = `0 1 ${recentsH}px`;
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
  el("apps-open-btn")?.addEventListener("click", (e) => { e.stopPropagation(); gotoSection("apps"); });
  // Live updates: Apps/Layouts CRUD announces itself (same renderer); running
  // OS apps poll on a change-detecting 6s loop.
  document.addEventListener("glyphh:apps-changed", () => { void loadRecentApps(); });
  startRailPolling();
  el("recents-toggle")?.addEventListener("click", () => {
    const open = el("recents-toggle")!.classList.contains("closed");
    setRecentsOpen(open, true);
  });
  el("code-send")?.addEventListener("click", send);
  initWilliamEvents();
  el("code-mode-chip")?.addEventListener("click", cycleMode);
  el("code-effort-chip")?.addEventListener("click", cycleEffort);
  void (async () => {
    const m = String((await window.yo.getPreference?.("williamMode", "ask")) || "ask");
    if (MODES.some((x) => x.id === m)) williamMode = m as typeof williamMode;
    const ef = String((await window.yo.getPreference?.("williamEffort", "medium")) || "medium");
    if (EFFORTS.some((x) => x.id === ef)) williamEffort = ef as typeof williamEffort;
    paintChips();
  })();
  const ta = input();
  ta?.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      if (!thinking) send();
    } else if (e.key === "Tab" && e.shiftKey) {
      e.preventDefault();
      cycleMode();
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
  el<HTMLInputElement>("recent-apps-search")?.addEventListener("input", () => {
    railAppsPage = 0; railLayoutsPage = 0; railOsPage = 0;
    renderRecentApps();
  });
  // Enter runs the text as a command — same as the palette input (dip x, …).
  el<HTMLInputElement>("recent-apps-search")?.addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    const text = (e.target as HTMLInputElement).value.trim();
    if (text) void window.yo.execCommand(text.replace(/^\./, ""));
  });
  // The rail is global (outside the section switcher) — populate Recents and
  // apply collapse/width prefs at boot so it's live on every section.
  loadStore();
  if (!currentId && chats.length) currentId = chats[0].id;
  renderHistory();
  void loadRecentApps();
  void applyPanelPrefs();
}
