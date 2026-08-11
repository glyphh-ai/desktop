/**
 * Code — the Glyphh agent surface: agent | workbench rails (sessions live
 * in the Coding Agent panel's history dropdown).
 *
 * Sessions persist on the SERVER THREADS SURFACE via help/thread-store.ts
 * (LWW sync; the surface's local persistence is the offline cache) — one set
 * across desktop, web, and every other surface. Replies stream from the local Glyphh model (llama-server,
 * glyphh-agent.ts bridge) — prompt → thinking spinner → streamed response. The right side is the REAL old
 * workbench (code-workbench-bundle.js — Files / Terminal / Diff / Preview /
 * Plan rails with insert/drag/maximize + per-folder layout persistence); the
 * center header carries its workdir controls and view toggles.
 */

import { showDropDetail, confirmAction } from "./shared.js";
import { appIconInner, primeConnectedIcons, primeNativeIcons } from "./app-icon.js";
import { gotoSection } from "./navigation.js";
import { createGlyphhSpinner, type GlyphhSpinner } from "../glyphh-spinner.js";
import { formatMarkdown } from "../format-markdown.js";
import * as picker from "./model-picker.js";
import { attachSlashMenu } from "./slash-menu.js";
import { openLayoutInWorkbench } from "./layouts.js";
import { createSourceChip, type Source, createGitChip, openMachineFolderBrowser, openNewFolderDrop, closeAllDrops, gitStateFor, probeSources } from "./code-source-chip.js";
import {
  canRunRemote, runRemoteTurn, answerPending, attachToActiveRun,
  APPROVAL_TIMEOUT_MS, ASK_TIMEOUT_MS,
  type RemoteChat, type AttachHandle,
} from "./remote-run.js";
import * as threadStore from "./thread-store.js";
import { greeting } from "./dashboard.js";
import { timeMascotSvg } from "./mascots.js";

interface AttachRef { kind: "image" | "file" | "folder"; path: string; name: string }
interface ConnectCard { id: string; appId: string; name: string; icon?: string | null; status: "offer" | "connecting" | "connected" | "failed"; error?: string }
interface CodeMsg { role: "user" | "assistant"; text: string; at: number; kind?: "tool" | "decline" | "connect"; attachments?: AttachRef[]; decline?: { kind: string; url: string }; connect?: ConnectCard }
interface CodeChat {
  id: string; title: string; createdAt: number; messages: CodeMsg[];
  /** The folder THIS session works in — stamped by its layout or by the pick
   *  made while it was current. Absent → the global workspace folder. */
  workdir?: string;
  /** Pinned sessions float to the top of the history dropdown. */
  pinned?: boolean;
  /** LEGACY flag (pre-mode) — kept for back-compat with old stored sessions. */
  chat?: boolean;
  /** The spaces concept (Chat/Work/Code) is gone — every session is ONE type,
   *  the most-capable Code toolset. The field is kept ONLY for back-compat with
   *  sessions the server/thread-store persisted before the collapse and with the
   *  pod's `mode` contract; it is always written as "code" now (see modeOf). */
  mode?: "chat" | "cowork" | "code";
  /** The workspace SOURCE: where this session RUNS + what it works on —
   *  cloud-new (empty cloud project), cloud-repo (a GitHub clone), or local
   *  (a folder on the machine). Stamped from the source chip when the session
   *  is born; threaded into provisioning (glyphhRun). */
  source?: Source;
  /** The bound REMOTE runtime (web/cloud sources only): the provisioned session
   *  id + data-plane url + one-time runtime token. Written by remote-run.ts on
   *  the first turn and reused for every later turn (no re-provision). The
   *  session id is bound even before the runtime is ready — the session exists
   *  server-side and must not be orphaned. */
  runtime?: { sessionId: string; url: string; token: string };
  /** LWW clock for the server threads surface — stamped by thread-store on
   *  every content change (epoch ms). */
  updatedAt?: number;
  /** Server-side message count for a lazily-adopted thread whose bodies
   *  haven't been fetched yet (thread-store.ensureMessages fills them). */
  messageCount?: number;
}

/** The spaces concept is collapsed: every session runs the most-capable Code
 *  toolset. `modeOf` is the single choke point — it ignores any legacy
 *  chat/cowork stamp and always reports "code", so tool selection, run routing
 *  and the composer are uniform. (Kept as a function so the many call sites and
 *  the pod's `mode` contract stay untouched.) */
function modeOf(_c: CodeChat): "code" {
  return "code";
}

const STORE_KEY = "codeChats";
const CURRENT_KEY = "codeCurrentChat";


// ── Permission modes + effort (composer controls) ────────────────────────
// Mode: a drop-UP menu (checkmark marks the selection; Shift+Tab cycles).
// Effort: far right — a drop-up slider Low→Med→High→Superfly; superfly
// turns the track into a particle matrix and maxes the reply budget.
const MODES = [
  { id: "ask", label: "Ask mode", hint: "Every action needs your approval" },
  { id: "plan", label: "Plan mode", hint: "Read-only — Glyphh plans, changes nothing" },
  { id: "acceptEdits", label: "Accept edits", hint: "File edits auto-approved; commands still ask" },
  { id: "auto", label: "Auto mode", hint: "Workspace actions auto-approved; risky ones ask" },
  { id: "bypass", label: "Bypass permissions", hint: "Everything auto-approved — trusted sessions only" },
] as const;
// The ⓘ explainer — what each mode ACTUALLY gates (mirrors the enforcement
// in glyphh-agent-permissions.ts: reads are always free; the mode decides the rest).
const MODE_DETAILS: Record<(typeof MODES)[number]["id"], string> = {
  ask: "The safest mode. Glyphh can read files freely, but every change — file edits, shell commands, and calls to your connected accounts — pops an approval card above the composer before it runs. Nothing happens without your explicit yes.",
  plan: "Strictly read-only. Glyphh can explore the folder, search, and reason, but every edit, command, or account call is refused outright — it tells you what it WOULD do instead. Use it to get a plan or a review you can act on in another mode.",
  acceptEdits: "File edits inside the working folder run without asking, so refactors flow uninterrupted. Everything else — shell commands, and anything that leaves your machine (connected-account calls, network) — still stops for approval.",
  auto: "Routine work runs unattended: edits, shell commands, and connected-account calls are auto-approved. Only actions flagged dangerous — destructive commands (rm -rf, sudo, force-push) or writes escaping the working folder — still stop and ask.",
  bypass: "No gates at all: every action runs without asking, including dangerous commands and writes outside the working folder. Only for sessions you fully trust — prefer Auto mode for everyday unattended runs.",
};
// Loop: which agent loop runs the session. This chip replaced the old effort
// dial; the dial's turn/token tiers are gone with it — an attended session is
// governed by its human, budgets by the resolved model's own limits.
let loops: Array<{ id: string; name: string; description: string; builtIn?: boolean }> = [
  { id: "default", name: "Default", description: "The standard Glyphh agent loop.", builtIn: true },
];
let loopsCanBuild = false;
let glyphhLoop = "default";
let glyphhMode: (typeof MODES)[number]["id"] = "ask";
// Approval cards awaiting a decision (rendered inline in the thread).
// Ask dock queue — approvals and agent questions render one at a time in a
// card docked just above the composer (never inline in the thread).
//
// The SAME queue and the SAME card serve a LOCAL run (main's permission gate,
// over `glyphh-agent:approval`/`:ask` IPC) and a REMOTE one (the pod's frames,
// via remote-run.ts). Only two fields differ per source: `deadline` (when the
// gate decides on its own — the same 2min/10min either way) and `chatId` (the
// session a late-answer note belongs to). Answering routes through
// respondToDock, which asks remote-run first and falls back to IPC.
interface AskDockCommon { runId?: string; chatId?: string; deadline?: number }
type AskDockItem =
  | ({ type: "approval"; id: string; kind: string; title: string; detail: string } & AskDockCommon)
  | ({ type: "ask"; id: string; questions: Array<{ question: string; options?: string[] }>; answers: string[]; step: number } & AskDockCommon);
let askQueue: AskDockItem[] = [];

function paintChips(): void {
  const mc = el("code-mode-chip");
  if (mc) {
    const m = MODES.find((x) => x.id === glyphhMode) ?? MODES[0];
    mc.textContent = m.label;
    mc.title = `${m.hint} — Shift+Tab cycles`;
    mc.className = `code-chip mode-${m.id}`;
  }
  const ec = el("code-effort-chip");
  if (ec) {
    const lp = loops.find((x) => x.id === glyphhLoop) ?? loops[0];
    ec.textContent = `Loop: ${lp?.name ?? "Default"}`;
    ec.title = lp?.description ?? "Which agent loop runs this session";
    ec.className = "code-chip";
    ec.setAttribute("aria-disabled", "false");
  }
}

function setMode(id: (typeof MODES)[number]["id"]): void {
  glyphhMode = id;
  void window.glyphh.setPreference?.("glyphhMode", id);
  paintChips();
  renderModeMenu();
}

function cycleMode(): void {
  const i = MODES.findIndex((m) => m.id === glyphhMode);
  setMode(MODES[(i + 1) % MODES.length].id);
}

function setLoop(id: string): void {
  glyphhLoop = id;
  void window.glyphh.setPreference?.("glyphhLoop", id);
  paintChips();
  // A different loop declares different slots — the model chip and the meter
  // both go stale the moment the loop changes.
  void refreshModelList();
}

// ── Model selector (drop-up) ──
// The picker's shape comes from the LOOP: it declares model slots, and each one
// renders a dropdown. Resolution and rendering live in model-picker.ts; this file
// only owns the chip and when to refresh.

function paintModelChip(): void {
  const mc = el("code-model-chip");
  if (!mc) return;
  mc.textContent = picker.chipText();
  mc.title = picker.chipTitle();
  mc.className = "code-chip";
}

/** Re-resolve the current loop's slots. Called on load and on every loop change,
 *  because a different loop means different slots. */
async function refreshModelList(force?: boolean): Promise<void> {
  await picker.refreshRoles(glyphhLoop, force);
  paintModelChip();
  refreshCtxMeter();
}

function renderModelMenu(): void {
  const menu = el("code-model-menu");
  if (!menu) return;
  picker.renderMenu(menu, glyphhLoop, () => {
    paintModelChip();
    refreshCtxMeter();
  });
}

// ── Mode drop-up ──
function renderModeMenu(): void {
  const menu = el("code-mode-menu");
  if (!menu) return;
  menu.textContent = "";
  // Header — section label + ⓘ opening the full explainer modal.
  const head = document.createElement("div");
  head.className = "code-drop-head";
  const headLabel = document.createElement("span");
  headLabel.textContent = "Permissions";
  const info = document.createElement("button");
  info.className = "drop-info-btn";
  info.type = "button";
  info.title = "What each mode allows";
  info.textContent = "i";
  info.addEventListener("click", (e) => {
    e.stopPropagation();
    menu.classList.add("hidden");
    showModeInfoModal();
  });
  head.append(headLabel, info);
  menu.appendChild(head);

  for (const m of MODES) {
    const item = document.createElement("button");
    item.className = "code-drop-item";
    item.type = "button";
    const lines = document.createElement("span");
    lines.className = "drop-lines";
    const label = document.createElement("span");
    label.textContent = m.label;
    const hint = document.createElement("span");
    hint.className = "drop-hint";
    hint.textContent = m.hint;
    lines.append(label, hint);
    item.appendChild(lines);
    if (m.id === glyphhMode) {
      item.classList.add("selected");
      item.insertAdjacentHTML("beforeend",
        `<svg class="drop-check" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`);
    }
    item.addEventListener("click", () => {
      setMode(m.id);
      el("code-mode-menu")?.classList.add("hidden");
    });
    menu.appendChild(item);
  }
}

/** The permission-modes explainer — the standard dialog skeleton, a bit
 *  wider than the 420px confirm box (five modes with real paragraphs). */
function showModeInfoModal(): void {
  const overlay = document.createElement("div");
  overlay.className = "confirm-overlay";
  const entries = MODES.map((m) => `
    <div class="mode-info-entry">
      <h4>${m.label}</h4>
      <p>${MODE_DETAILS[m.id]}</p>
    </div>`).join("");
  overlay.innerHTML = `
    <div class="confirm-box mode-info-box">
      <div class="confirm-head"><h3>Permission modes</h3></div>
      <div class="confirm-body">
        <p style="margin:0 0 2px;">Reading files is always allowed — the mode decides what Glyphh may DO. Shift+Tab cycles modes from the composer.</p>
        ${entries}
      </div>
      <div class="confirm-foot"><button class="action-btn primary" type="button">Got it</button></div>
    </div>`;
  const close = (): void => { overlay.remove(); document.removeEventListener("keydown", onKey); };
  const onKey = (e: KeyboardEvent): void => { if (e.key === "Escape") { e.preventDefault(); close(); } };
  overlay.addEventListener("mousedown", (e) => { if (e.target === overlay) close(); });
  overlay.querySelector("button")!.addEventListener("click", close);
  document.addEventListener("keydown", onKey);
  document.body.appendChild(overlay);
}

// ── Loop drop-up — pick which agent loop runs the session ──
// Loops come from the server (Build → Loops, role-scoped); offline keeps the
// built-in Default. canBuild gates the (stub) Loops tab in the nav.
async function refreshLoops(): Promise<void> {
  try {
    const r = await window.glyphh.loopsList?.();
    if (r?.loops?.length) { loops = r.loops; loopsCanBuild = !!r.canBuild; }
    if (!loops.some((l) => l.id === glyphhLoop)) glyphhLoop = loops[0]?.id || "default";
    paintChips();
  } catch { /* offline — the built-in default stands */ }
}

function renderLoopMenu(): void {
  const pop = el("code-effort-pop");
  if (!pop) return;
  pop.textContent = "";
  const head = document.createElement("div");
  head.className = "code-drop-head";
  const headLabel = document.createElement("span");
  headLabel.textContent = "Loop";
  head.appendChild(headLabel);
  pop.appendChild(head);

  // Search — filters as you type; the list below repaints in place.
  const search = document.createElement("input");
  search.type = "text";
  search.className = "loop-drop-search";
  search.placeholder = "Search loops…";
  search.spellcheck = false;
  search.autocomplete = "off";
  search.addEventListener("mousedown", (ev) => ev.stopPropagation());

  const pane = document.createElement("div");
  pane.className = "drop-pane";
  pop.appendChild(pane);
  pane.appendChild(search);
  const list = document.createElement("div");
  list.className = "loop-drop-list";
  pane.appendChild(list);

  const check = `<svg class="drop-check" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`;
  const closeTips = (): void => { pop.querySelector(".drop-detail")?.remove(); pane.classList.remove("hidden"); };
  /** The row shows ONE sentence — the rest lives behind the ⓘ. */
  const firstSentence = (text: string): string => {
    const t = text.trim();
    const m = /^[\s\S]*?[.!?](?=\s|$)/.exec(t);
    return (m ? m[0] : t).trim();
  };

  const paint = (): void => {
    list.textContent = "";
    const q = search.value.trim().toLowerCase();
    const shown = q
      ? loops.filter((l) => `${l.name} ${l.description ?? ""}`.toLowerCase().includes(q))
      : loops;
    if (!shown.length) {
      const empty = document.createElement("div");
      empty.className = "drop-empty";
      empty.textContent = `No loops matching "${q}"`;
      list.appendChild(empty);
      return;
    }
    for (const l of shown) {
      const item = document.createElement("button");
      item.className = "code-drop-item drop-item-2line loop-drop-item" + (l.id === glyphhLoop ? " selected" : "");
      item.type = "button";
      const main = document.createElement("div");
      main.className = "drop-main";
      const span = document.createElement("span");
      span.textContent = l.name;
      main.appendChild(span);
      if (l.id === glyphhLoop) main.insertAdjacentHTML("beforeend", check);

      // ⓘ — the whole description opens IN THIS POPUP, behind a back arrow.
      if (l.description) {
        const infoBtn = document.createElement("button");
        infoBtn.className = "model-info-btn";
        infoBtn.type = "button";
        infoBtn.title = "About this loop";
        infoBtn.textContent = "i";
        infoBtn.addEventListener("click", (ev) => {
          ev.stopPropagation();
          showDropDetail(pop, pane, { title: l.name, body: l.description ?? "" });
        });
        main.appendChild(infoBtn);
      }
      item.appendChild(main);
      if (l.description) {
        // NAME + ONE SENTENCE, clamped to a single line — two lines, never more.
        const sub = document.createElement("span");
        sub.className = "drop-sub loop-drop-sub";
        sub.textContent = firstSentence(l.description);
        item.appendChild(sub);
      }
      item.addEventListener("click", () => {
        closeTips();
        setLoop(l.id);
        renderLoopMenu();
        pop.classList.add("hidden");
      });
      list.appendChild(item);
    }
  };

  search.addEventListener("input", paint);
  paint();
  // The pop just opened from a chip click — put the cursor in the search.
  requestAnimationFrame(() => search.focus());
}

/** Manual compaction (meter click / .compact) — steers the fold with an
 *  optional one-shot focus, reports the outcome into the thread. */
async function runManualCompact(focus: string): Promise<void> {
  const c = current();
  if (!c || thinking) return;
  const meter = el("code-ctx-meter");
  meter?.classList.add("compacting");
  try {
    const r = await window.glyphh.glyphhCompact?.(c.id, focus);
    const u = await window.glyphh.glyphhContextUsage?.(c.id).catch(() => null);
    const pct = u ? ` — context now ${Math.round(u.ratio * 100)}%` : "";
    c.messages.push({
      role: "assistant",
      text: r?.ok ? `✓ Compacted${pct}.` : `⚠ Compaction skipped: ${r?.reason || "unknown"}`,
      at: Date.now(),
    });
  } catch (err) {
    c.messages.push({ role: "assistant", text: `⚠ ${err instanceof Error ? err.message : String(err)}`, at: Date.now() });
  }
  meter?.classList.remove("compacting");
  void saveStore();
  renderThread();
  refreshCtxMeter();
}

// ── Context panel (meter click) — one shared history, one row per model
//    lane that might serve it. Local is the binding lane (compaction keys
//    off it — declined escalations fall back to local, so the history must
//    always stay local-servable); remote lanes show how far the SAME history
//    sits from their windows. Extensible: renders whatever lanes main sends.
async function renderCtxPop(): Promise<void> {
  const pop = el("code-ctx-pop");
  if (!pop || !currentId) return;
  pop.innerHTML = `<div class="ctx-pop-empty">Measuring…</div>`;
  const u = await window.glyphh.glyphhContextUsage?.(currentId).catch(() => null);
  if (!u) { pop.innerHTML = `<div class="ctx-pop-empty">Context unavailable.</div>`; return; }
  const lanes = u.lanes?.length
    ? u.lanes
    : [{ id: "local", kind: "local" as const, tokens: u.tokens, budget: u.budget, ratio: u.ratio, foldAt: u.foldAt }];
  const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));
  const fmt = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k` : String(n));
  pop.innerHTML = `
    <div class="drop-pane">
    <div class="effort-head">
      <span class="effort-title">Compaction</span>
      <button id="ctx-info-btn" class="model-info-btn" type="button" title="How compaction works">i</button>
    </div>
    <div class="effort-desc">How close each model is to folding.</div>
    ${lanes.map((l) => {
      const pct = Math.round(l.ratio * 100);
      const hot = l.foldAt != null && l.ratio >= l.foldAt;
      return `
      <div class="ctx-lane">
        <div class="ctx-lane-head">
          <span class="ctx-lane-name">${esc(l.id)}</span>
          <span class="ctx-lane-kind">${l.kind === "local" ? "local" : "remote"}</span>
        </div>
        <div class="ctx-lane-bar">
          ${l.foldAt != null ? `<div class="ctx-lane-tick" style="left:${l.foldAt * 100}%"></div>` : ""}
          <div class="ctx-lane-fill${hot ? " hot" : ""}" style="width:${pct}%"></div>
        </div>
        <div class="ctx-lane-stats">${fmt(l.tokens)} of ${fmt(l.budget)} tokens · ${pct}%${l.foldAt != null ? ` — compacts at ${Math.round(l.foldAt * 100)}%` : ""}</div>
      </div>`;
    }).join("")}
    <div class="ctx-compact-row">
      <input id="ctx-compact-focus" type="text" placeholder="what the summary must keep (optional)" spellcheck="false" />
      <button id="ctx-compact-btn" type="button" class="ctx-compact-btn"${thinking ? " disabled" : ""}>Compact now</button>
    </div>
    </div>`;
  // ⓘ — the explanation opens IN THIS POPUP behind a back arrow, like every
  // other chip.
  const ctxPane = pop.querySelector<HTMLElement>(".drop-pane");
  pop.querySelector<HTMLButtonElement>("#ctx-info-btn")?.addEventListener("click", (ev) => {
    ev.stopPropagation();
    if (!ctxPane) return;
    showDropDetail(pop, ctxPane, {
      title: "Compaction",
      body: [
        "One shared history, measured against every model that can serve it.",
        "",
        "The local lane is the binding one — declined escalations fall back to the local model, so the history must always fit it. When it crosses the tick, older turns fold into a summary and every lane shrinks together.",
        "",
        "Compact now folds immediately; the optional focus tells the summary what it must keep.",
      ].join("\n"),
    });
  });
  const focusEl = pop.querySelector<HTMLInputElement>("#ctx-compact-focus");
  focusEl?.addEventListener("click", (ev) => ev.stopPropagation());
  const go = () => {
    el("code-ctx-pop")?.classList.add("hidden");
    void runManualCompact((focusEl?.value || "").trim());
  };
  focusEl?.addEventListener("keydown", (ev) => { if (ev.key === "Enter" && !thinking) go(); });
  pop.querySelector<HTMLButtonElement>("#ctx-compact-btn")?.addEventListener("click", (ev) => {
    ev.stopPropagation();
    if (!thinking) go();
  });
}

// ── Compaction meter — how full the fold window is (tick = fold point) ──
let meterTimer: ReturnType<typeof setTimeout> | null = null;

function refreshCtxMeter(): void {
  if (meterTimer) clearTimeout(meterTimer);
  meterTimer = setTimeout(() => {
    meterTimer = null;
    const meter = el("code-ctx-meter");
    if (!meter) return;
    if (!currentId) {
      // a LANDING (lazy new): nothing to measure — show an explicitly
      // empty meter, not the previous session's frozen fill
      const fill = meter.querySelector<HTMLElement>(".ctx-fill");
      if (fill) { fill.style.width = "0%"; fill.classList.remove("hot"); }
      meter.title = "Context — empty (new session)";
      return;
    }
    void window.glyphh.glyphhContextUsage?.(currentId).then((u) => {
      const fill = meter.querySelector<HTMLElement>(".ctx-fill");
      const tick = meter.querySelector<HTMLElement>(".ctx-tick");
      if (!fill || !tick) return;
      const pct = Math.round(u.ratio * 100);
      fill.style.width = `${pct}%`;
      fill.classList.toggle("hot", u.ratio >= u.foldAt);
      tick.style.left = `${u.foldAt * 100}%`;
      // Bar tracks the local lane (the one compaction keys off); the title
      // sketches every lane, the click panel has the full picture.
      const laneBits = (u.lanes || []).map((l) => `${l.id} ${Math.round(l.ratio * 100)}%`).join(" · ");
      meter.title = `Context — ${laneBits || `${pct}%`} — compacts at ${Math.round(u.foldAt * 100)}% of local. Click for details.`;
    }).catch(() => { /* meter is cosmetic */ });
  }, 350);
}

/** A chip's drop-up opens UP AND TO THE LEFT: its right edge stays on the
 *  chip, so a menu wider than its chip grows into the page instead of past
 *  the composer's right edge (which used to widen the row and shove the
 *  input sideways on the Chat/Work landing). Height clamps to the space
 *  above the chip so a short window scrolls the menu instead of clipping
 *  its top. If left growth would leave the viewport, it clamps back. */
function openChipDropUp(menu: HTMLElement): void {
  const wrap = menu.parentElement;
  if (!wrap) return;
  closeAllDrops(menu);   // one picker at a time, across BOTH chip families
  const wrapBox = wrap.getBoundingClientRect();
  // Clamp against the AGENT PANEL, not the viewport: a narrow panel inside a
  // wide window has a narrow window still wide, so a viewport clamp lets the
  // menu spill past the panel edge into the rest of the layout. Fall back to
  // the viewport when the menu isn't inside an agent panel (e.g. the Home
  // composer). An 8px gutter is kept on each side.
  const panel = menu.closest<HTMLElement>(".code-agent");
  const panelBox = panel?.getBoundingClientRect();
  const boundLeft = panelBox ? panelBox.left : 0;
  const boundRight = panelBox ? panelBox.right : window.innerWidth;
  // Align to the chip's side of the bar: a LEFT-side chip (permission mode)
  // grows rightward — right-anchoring it shoved the pane far off to the left.
  if (wrapBox.left < (boundLeft + boundRight) / 2) {
    menu.style.left = "0px";
    menu.style.right = "auto";
  } else {
    menu.style.left = "auto";
    menu.style.right = "0px";
  }
  // bottom: calc(100% + 8px) — the menu's bottom sits 8px above the chip.
  const room = Math.max(140, wrapBox.top - 8 - 12);
  menu.style.maxHeight = `${Math.round(room)}px`;
  menu.style.overflowY = "auto";
  const menuBox = menu.getBoundingClientRect();
  if (menuBox.left < boundLeft + 8) {
    menu.style.right = "auto";
    menu.style.left = `${Math.round(boundLeft + 8 - wrapBox.left)}px`;
  }
  if (menuBox.right > boundRight - 8) {
    menu.style.left = "auto";
    menu.style.right = `${Math.round(8 - (boundRight - wrapBox.right))}px`;
  }
}

function initComposerControls(): void {
  const modeWrap = el("code-mode-wrap");
  const effortWrap = el("code-effort-wrap");
  const modelWrap = el("code-model-wrap");
  if (!modeWrap || !effortWrap) return;
  if (modelWrap) {
    const mmenu = document.createElement("div");
    mmenu.id = "code-model-menu";
    mmenu.className = "code-drop-up hidden";
    modelWrap.appendChild(mmenu);
    el("code-model-chip")?.addEventListener("click", (e) => {
      e.stopPropagation();
      el("code-effort-pop")?.classList.add("hidden");
      el("code-mode-menu")?.classList.add("hidden");
      el("code-ctx-pop")?.classList.add("hidden");
      renderModelMenu();
      const opening = mmenu.classList.contains("hidden");
      mmenu.classList.toggle("hidden");
      if (opening) {
        openChipDropUp(mmenu);
        picker.focusSearch(mmenu);
        // Re-resolve behind the open menu, FORCING past the cache — so a model
        // an admin just added/removed on the platform shows on the next open,
        // no app restart. The rows repaint if the server disagrees.
        void refreshModelList(true).then(() => {
          if (!mmenu.classList.contains("hidden")) { renderModelMenu(); picker.focusSearch(mmenu); }
        });
      }
    });
    void refreshModelList();
  }
  // Menus are built once; rows re-render on open/select.
  const menu = document.createElement("div");
  menu.id = "code-mode-menu";
  menu.className = "code-drop-up hidden";
  modeWrap.appendChild(menu);
  // The loop drop-up (repurposed effort slot) — rows render on open.
  const pop = document.createElement("div");
  pop.id = "code-effort-pop";
  pop.className = "code-drop-up hidden";
  effortWrap.appendChild(pop);
  el("code-mode-chip")?.addEventListener("click", (e) => {
    e.stopPropagation();
    el("code-effort-pop")?.classList.add("hidden");
    el("code-ctx-pop")?.classList.add("hidden");
    renderModeMenu();
    const mm = el("code-mode-menu");
    mm?.classList.toggle("hidden");
    if (mm && !mm.classList.contains("hidden")) openChipDropUp(mm);
  });
  el("code-effort-chip")?.addEventListener("click", (e) => {
    e.stopPropagation();
    el("code-mode-menu")?.classList.add("hidden");
    el("code-ctx-pop")?.classList.add("hidden");
    void refreshLoops().then(() => { renderLoopMenu(); const p2 = el("code-effort-pop"); if (p2 && !p2.classList.contains("hidden")) openChipDropUp(p2); });
    renderLoopMenu();
    const lp = el("code-effort-pop");
    lp?.classList.toggle("hidden");
    if (lp && !lp.classList.contains("hidden")) openChipDropUp(lp);
  });
  // Context panel — per-lane distance to compaction, anchored to the meter.
  const ctxWrap = el("code-ctx-wrap");
  if (ctxWrap) {
    const cpop = document.createElement("div");
    cpop.id = "code-ctx-pop";
    cpop.className = "code-drop-up code-ctx-pop hidden";
    ctxWrap.appendChild(cpop);
  }
  el("code-ctx-meter")?.addEventListener("click", (e) => {
    e.stopPropagation();
    if (!current()) return;
    el("code-mode-menu")?.classList.add("hidden");
    el("code-effort-pop")?.classList.add("hidden");
    el("code-model-menu")?.classList.add("hidden");
    const cpop = el("code-ctx-pop");
    if (!cpop) return;
    const opening = cpop.classList.contains("hidden");
    cpop.classList.toggle("hidden");
    if (opening) { openChipDropUp(cpop); void renderCtxPop(); }
  });
  document.addEventListener("click", (e) => {
    const t = e.target as Node;
    if (!modeWrap.contains(t)) el("code-mode-menu")?.classList.add("hidden");
    if (!effortWrap.contains(t)) el("code-effort-pop")?.classList.add("hidden");
    if (modelWrap && !modelWrap.contains(t)) el("code-model-menu")?.classList.add("hidden");
    if (ctxWrap && !ctxWrap.contains(t)) el("code-ctx-pop")?.classList.add("hidden");
    const plusWrap = el("code-plus-wrap");
    if (plusWrap && !plusWrap.contains(t)) el("code-plus-menu")?.classList.add("hidden");
    // Source-family drops (source/folder/git/+) fall to an outside click too —
    // their own away-handlers cover most paths; this catches the rest.
    document.querySelectorAll<HTMLElement>(".ws-source-drop").forEach((m) => {
      const holder = m.parentElement;
      if (holder && !holder.contains(t as HTMLElement)) m.remove();
    });
  });
}

// Ghost empty-state quotes — the spirit of Ada & Glyphh Lovelace, with
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

// The new-session landing's title mirrors the HOME hero greeting exactly:
// the same time-of-day bucket + the same user name. The name is fetched the
// same way the home gets it (dashboard-data) and cached here; the FIRST paint
// uses whatever's cached (possibly empty → "Welcome back"), then this backfills
// the on-screen title once the name resolves. `greeting()` is re-evaluated on
// every landing paint so the morning/afternoon/evening bucket stays current.
let ghostName = "";
let ghostNameFetched = false;
function ensureGhostName(): void {
  if (ghostNameFetched) return;
  ghostNameFetched = true;
  void window.glyphh.dashboardData?.().then((d) => {
    const n = (d?.name || "").trim();
    if (!n) return;
    ghostName = n;
    // Backfill the title in place if the landing is still on screen.
    const t = document.querySelector<HTMLElement>(".code-ghost-title");
    if (t) t.textContent = greeting(ghostName);
  }).catch(() => { /* landing already shows the fallback */ });
}

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
let spinner: GlyphhSpinner | null = null;
// One live run PER SESSION — sessions are independent in main (concurrent
// runs) and independent streams here: each chat accumulates its own run
// (chat-keyed, not DOM-keyed), and the panel paints only the CURRENT chat's.
interface LiveRun {
  runId: string | null;        // stamped by glyphhRun's ack, or the first event
  text: string;                // streamed text since the last commit
  bubble: HTMLElement | null;  // live DOM block (current chat only)
  startAt: number;
  inTok: number;
  outTok: number;
  creditsMicro: number;
  steps: string[];             // timeline breadcrumbs for the Plan rail
  setupMeta: string;           // first-run model-download status
}
const liveRuns = new Map<string, LiveRun>();
let runTicker: ReturnType<typeof setInterval> | null = null;
/** The chat entry that owns a runId. Events can beat the IPC ack that stamps
 *  the id, so an unmatched runId claims the OLDEST launch still waiting. */
function runEntry(runId: string): [string, LiveRun] | null {
  for (const e of liveRuns) { if (e[1].runId === runId) return e; }
  for (const e of liveRuns) { if (e[1].runId === null) { e[1].runId = runId; return e; } }
  return null;
}
const currentRun = (): LiveRun | null => liveRuns.get(currentId) ?? null;

// ── Observe a run happening ELSEWHERE (run-stream broker consumer) ─────────────
// "Open a thread anywhere, see the live turn." When the thread on screen has a run
// executing on ANOTHER surface (this user's desktop, or a cloud pod), we subscribe
// to that run's frame stream and drive the SAME liveRuns entry a local turn does —
// so it renders identically. Read-only: the surface that OWNS the run answers its
// approvals/asks; we only watch. One observer at a time (the thread in view).
let observedChatId: string | null = null;
const observers = new Map<string, AttachHandle>();

function stopObserving(chatId: string): void {
  const h = observers.get(chatId);
  if (h) { h.stop(); observers.delete(chatId); }
}

/** Reconcile the observer to the thread on screen: detach the old one, attach the
 *  new (unless WE are driving that thread locally). Cheap + idempotent — guarded on
 *  an actual thread change, so it's safe to call from every renderThread. */
function syncActiveRunAttach(): void {
  const id = currentId || null;
  if (observedChatId === id) return;              // same thread — nothing to do
  if (observedChatId) stopObserving(observedChatId);
  observedChatId = id;
  if (!id) return;
  if (liveRuns.has(id) || remoteAborters.has(id)) return; // our own run drives this
  const chat = chats.find((c) => c.id === id);
  if (chat) observeIfRunning(chat);
}

function observeIfRunning(chat: CodeChat): void {
  const chatId = chat.id;
  const handle = attachToActiveRun(
    chat as unknown as RemoteChat,
    {
      // Same grammar as launchRemote's live-run callbacks, minus approval/ask
      // (the executing surface owns those). Every hop drives THIS chat's liveRuns.
      onUserPrompt: (text) => {
        const ch = chats.find((c) => c.id === chatId);
        if (!ch) return;
        // The observed turn's user message (first run frame) — render it like a local send.
        ch.messages.push({ role: "user", text, at: Date.now() });
        void saveStore();
        if (chatId === currentId) renderThread();
      },
      onStep: (step) => {
        const r = liveRuns.get(chatId);
        const ch = chats.find((c) => c.id === chatId);
        if (!r || !ch) return;
        if (r.text.trim()) { ch.messages.push({ role: "assistant", text: r.text, at: Date.now() }); r.text = ""; r.bubble = null; }
        const bad = step.status === "denied" || step.status === "failed" || !!step.error;
        const glyph = bad ? "✕" : step.status ? "✓" : "⚙";
        const detail = step.error || (step.status && step.status !== "ok" ? step.status : "");
        const label = `${glyph} ${step.type}${detail ? ` — ${detail}` : ""}`;
        r.steps.push(label);
        ch.messages.push({ role: "assistant", kind: "tool", text: label, at: Date.now() });
        void saveStore();
        if (chatId === currentId) { broadcastTimeline(true); renderThread(); }
      },
      onToken: (delta) => {
        const r = liveRuns.get(chatId);
        if (!r) return;
        r.text += delta;
        queueStreamPaint(chatId);
      },
      // The run settled — land it, but KEEP the observer: the watcher keeps polling and
      // will pick up the next run started on this thread (onRun re-seeds a fresh turn).
      onDone: (text) => { finishRun(chatId, text); },
      onError: (detail) => {
        const r = liveRuns.get(chatId);
        const prefix = r?.text ? `${r.text}\n\n` : "";
        finishRun(chatId, `${prefix}⚠ ${detail}`);
      },
    },
    // Per run (fires before its first frame): seed a fresh working state so the spinner +
    // rail dot paint and the streamed block has somewhere to land.
    (runId) => {
      liveRuns.set(chatId, {
        runId, text: "", bubble: null, startAt: Date.now(),
        inTok: 0, outTok: 0, creditsMicro: 0, steps: [], setupMeta: "",
      });
      ensureRunTicker();
      if (chatId === currentId) { broadcastTimeline(true); setThinking(true); renderHistory(); renderThread(); }
    },
  );
  observers.set(chatId, handle);
}

// Streamed tokens re-render the CURRENT chat's live block as MARKDOWN, throttled
// to one paint per animation frame — smooth at token rate, code fences and lists
// take shape as they arrive. Module-scoped so BOTH run paths share it: the local
// glyphhRun deltas (onGlyphhAgentDelta) and the web remote turn (remote-run.ts).
let streamPaintQueued = false;
function paintStream(): void {
  streamPaintQueued = false;
  const run = currentRun();
  const thread = el<HTMLDivElement>("code-thread");
  if (run?.bubble && run.bubble.isConnected) {
    run.bubble.innerHTML = formatMarkdown(run.text);
    if (thread && threadPinned) thread.scrollTop = thread.scrollHeight;
  } else {
    renderThread(); // first token — adds the live block under the spinner
  }
}
/** Coalesce a stream repaint to the next frame (only when the run is current). */
function queueStreamPaint(chatId: string): void {
  if (currentId === chatId && !streamPaintQueued) {
    streamPaintQueued = true;
    requestAnimationFrame(paintStream);
  }
}

function broadcastTimeline(running: boolean): void {
  try {
    document.dispatchEvent(new CustomEvent("glyphh-agent:timeline", { detail: { steps: [...(currentRun()?.steps ?? [])], running } }));
  } catch { /* no listeners */ }
}

/** Micro-credits → a "N credits" label — the number the user is billed, the
 *  headline of the footer. Small runs get decimals, big ones stay whole. */
function fmtCredits(micro: number): string {
  const c = micro / 1_000_000;
  const n = c >= 100 ? Math.round(c).toLocaleString()
    : c >= 1 ? c.toFixed(1)
    : c.toFixed(3).replace(/0+$/, "").replace(/\.$/, "");
  return `${n} credit${c === 1 ? "" : "s"}`;
}

/** 1_234 → "1.2k", so the footer stays tight as a run grows into six figures. */
function fmtTok(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

function fmtElapsed(ms: number): string {
  const s = Math.floor(ms / 1000);
  return s >= 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s}s`;
}

function paintRunMeta(): void {
  const run = currentRun();
  if (!run) return;
  // While Glyphh sets himself up (first-run model download), the setup
  // line owns the spinner meta; the token meter takes over once ready.
  if (run.setupMeta) { spinner?.setMeta(run.setupMeta); return; }
  const io = run.inTok + run.outTok > 0 ? ` · ↑${fmtTok(run.inTok)} ↓${fmtTok(run.outTok)}` : "";
  const cr = run.creditsMicro > 0 ? ` · ${fmtCredits(run.creditsMicro)}` : "";
  spinner?.setMeta(`${fmtElapsed(Date.now() - run.startAt)}${io}${cr}`);
}

/** One ticker serves every live run; it stops when the last one lands. */
function ensureRunTicker(): void {
  if (!runTicker) runTicker = setInterval(paintRunMeta, 1000);
}
function stopRunTickerIfIdle(): void {
  if (liveRuns.size === 0 && runTicker) { clearInterval(runTicker); runTicker = null; }
}
function el<T extends HTMLElement = HTMLElement>(id: string): T | null {
  return document.getElementById(id) as T | null;
}
const input = () => el<HTMLTextAreaElement>("code-input");

// ── Session store ────────────────────────────────────────────────────────
let storeLoaded = false;
let storeLoading: Promise<void> | null = null;
/** Sessions live on the SERVER THREADS SURFACE (thread-store.ts), with the
 *  surface's local persistence as the offline cache — hydrate reconciles the
 *  two by LWW at boot (the cache's pre-cutover history migrates up once).
 *  First load also migrates any legacy localStorage sessions, then clears
 *  them. Single-flight: both boot paths (loadCode + initCode) land here. */
async function loadStore(): Promise<void> {
  if (storeLoaded) return;
  if (storeLoading) return storeLoading;
  storeLoading = (async () => {
    try {
      const s = await threadStore.hydrate();
      chats = s.chats as CodeChat[];
      currentId = s.currentId;
    } catch { chats = []; currentId = ""; }
    if (!chats.length) {
      try {
        const legacy = JSON.parse(localStorage.getItem(STORE_KEY) || "[]") as CodeChat[];
        if (Array.isArray(legacy) && legacy.length) {
          chats = legacy;
          currentId = localStorage.getItem(CURRENT_KEY) || "";
          await saveStore();
          localStorage.removeItem(STORE_KEY);
          localStorage.removeItem(CURRENT_KEY);
        }
      } catch { /* no legacy sessions */ }
    }
    // A background reconcile (retry timer / another surface's write) changed
    // the shared array — repaint the lists (never the live thread mid-run).
    threadStore.onRemoteChange(() => renderHistory());
    storeLoaded = true;
  })();
  return storeLoading;
}
function saveStore(): Promise<void> {
  return threadStore.persist(chats, currentId);
}
/** A thread adopted from the server carries only metadata until opened —
 *  fetch its messages, then repaint whatever is showing it. */
function hydrateMessagesIfNeeded(id: string): void {
  if (!id) return;
  void threadStore.ensureMessages(id).then((loaded) => {
    if (!loaded) return;
    renderHistory();
    if (currentId === id) { renderThread(); refreshCtxMeter(); }
  });
}
const current = (): CodeChat | null => chats.find((c) => c.id === currentId) ?? null;

/** The rail's session interactions (New session, clicking a message row)
 *  land on the AGENT PANEL — but they must not blow away an open layout.
 *  Agent already visible → nothing to do (the session loads in place).
 *  Workspace has panels (a layout or apps) → the agent JOINS it ("code"
 *  guarantees a coding slot without clearing). Empty workspace → the full
 *  Glyphh-mark move: agent full screen ("agent"). */
function ensureCodeSection(): void {
  if (document.querySelector(".code-root.agent-hosted")) return;
  const hasPanels = !!document.querySelector("#code-wb-rails .ws-rail-slot");
  gotoSection(hasPanels ? "code" : "agent");
}

/** The session surface the Coding Agent workspace panel drives — same
 *  sessions, same store, exposed across the bundle boundary via window.
 *  Every history repaint also fires "agent-sessions-changed" so the panel's
 *  header title/dropdown stay current. */
/** The app-standard confirm modal, exposed for the workbench bundle (it
 *  can't import help modules; #confirm-modal lives in this document). */
(window as unknown as { __appConfirm?: unknown }).__appConfirm = confirmAction;

(window as unknown as { __agentSessions?: unknown }).__agentSessions = {
  list: (): Array<{ id: string; title: string; createdAt: number; mode: "chat" | "cowork" | "code" }> =>
    chats.map((c) => ({ id: c.id, title: c.title, createdAt: c.createdAt, mode: modeOf(c) })),
  currentId: (): string | null => currentId,
  currentTitle: (): string => current()?.title ?? "New session",
  switch: (id: string): void => {
    const target = chats.find((c) => c.id === id);
    if (!target) return;
    currentId = id;
    threadPinned = true;
    void saveStore();
    syncThinking();   // this session's own run state, not the last one's
    renderHistory();
    renderThread();
    // The switched-to session's OWN source drives the chip/locus/run.
    repaintSourceUi();
    broadcastTimeline(!!currentRun());
    // SURFACE THE AGENT: called from the + New Session screen's session column,
    // this used to set the session and repaint a thread nobody could see — the
    // click read as doing nothing at all.
    if (document.body.classList.contains("composer-on-home")) {
      ensureCodeSection();
      gotoSection("agent");
    }
  },
  startNew: (): void => {
    // LAZY, like both + buttons: clear the selection and repaint. The record
    // is born on the first send (a layout that asked for a new session gets
    // its folder via pendingWorkdir below, so nothing is lost by waiting).
    currentId = "";
    void saveStore();
    renderHistory();
    renderThread();
  },
  /** Repaint the thread + history from the store. The agent card calls this
   *  after adoption so an empty session shows the BRANDED landing (mark +
   *  slogan) instead of a blank panel — the thread may never have been
   *  painted if the card opened before the store finished loading. */
  repaint: (): void => { renderHistory(); renderThread(); },
  /** Message counts, so a caller can prefer a session with real content. */
  counts: (): Record<string, number> => Object.fromEntries(chats.map((c) => [c.id, c.messages.length])),
  /** Bind the CURRENT session to a folder (layout opens + folder picks).
   *  With no session yet — the lazy landing — the folder is held and applied
   *  to the one the next send creates. */
  stampWorkdir: (dir: string): void => {
    if (!dir) return;
    const c = current();
    if (!c) { pendingWorkdir = dir; return; }
    c.workdir = dir;
    void saveStore();
  },
};

// The @-mention summon ("@an-fable …") sets the model on the CURRENT loop's
// primary role and repaints the chip — the ghost overlay calls this after boot.
(window as unknown as { __agentUseModel?: (modelId: string) => Promise<boolean> }).__agentUseModel =
  async (modelId: string): Promise<boolean> => {
    try {
      await picker.refreshRoles(glyphhLoop);
      const role = picker.currentRoles()[0];
      if (!role) return false;
      await window.glyphh.loopRoleSet?.(glyphhLoop, role.name, modelId);
      await refreshModelList(true);
      return true;
    } catch { return false; }
  };

/** A folder a layout asked for while no session existed — applied to the
 *  session the next send creates. */
let pendingWorkdir = "";

/** Keep body[data-session-space] in lockstep with the active space. The CSS for
 *  the chips row, the view toggles and the session kebab all key off it, and it
 *  was ONLY written by paintCw — which doesn't run on boot or when the landing
 *  mounts, so the + New Session screen came up unstyled until the user clicked
 *  a tab (which called paintCw and "fixed" it). */
function syncSpaceAttrs(): void {
  // Spaces are gone — every surface is the Code agent. Keep the dataset stamped
  // to "code" so any consumer that still reads it (workbench/dashboard) sees a
  // valid, stable value.
  document.body.dataset.sessionSpace = "code";
  document.body.dataset.railSpace = "code";
  sourceChip?.setSource(activeSource());
  paintSourceDependents();
}
(window as unknown as { __syncSpaceAttrs?: () => void }).__syncSpaceAttrs = syncSpaceAttrs;

function newChat(): void {
  // Every session is a Code session (the most-capable toolset). The mode field
  // is retained only for the pod/thread-store contract and is always "code".
  const c: CodeChat = { id: `c${Date.now().toString(36)}`, title: "New session", createdAt: Date.now(), messages: [], mode: "code" };
  if (pendingWorkdir) { c.workdir = pendingWorkdir; pendingWorkdir = ""; }
  // Stamp the pending source — a local source seeds the session's own workdir
  // so the run targets that folder.
  c.source = pendingSource;
  if (c.source.kind === "local" && c.source.path && !c.workdir) c.workdir = c.source.path;
  chats.unshift(c);
  currentId = c.id;
  lastSession = c.id;
  void window.glyphh.setPreference?.(LAST_SESSION_PREF, c.id);
  threadPinned = true;
  void saveStore();
  syncThinking();   // fresh session — no run of its own yet
  ensureCodeSection();
  // Fresh sessions start clean: all workbench rails closed, folder reset.
  (window as unknown as { __codeWorkbenchNewSession?: () => void }).__codeWorkbenchNewSession?.();
  renderHistory();
  renderThread();
  input()?.focus();  void checkWorkdirGate();
}

// ── Rendering ────────────────────────────────────────────────────────────


/**
 * Leave the open session for its tab's + New Session screen — the MAIN one,
 * every time. Backing out of a session and closing one both mean "I am done
 * here", so they land on the same screen a fresh start does, whether the agent
 * was full-screen or hosted in a layout.
 */
function leaveSessionToLanding(): void {
  currentId = "";
  void saveStore();
  renderHistory();
  renderThread();
  void checkWorkdirGate();
  syncSpaceAttrs();
  gotoSection("dashboard");
}

/**
 * The session is no longer CURRENT.
 *
 * Closing a session — by hand, or because a layout replaced the agent panel —
 * ends it as the resume target: the next visit opens a fresh + New Session
 * instead of silently reopening what was closed. Deleting one lands here too.
 * (The optional arg is a legacy space hint from the workbench bridge — ignored
 * now that there is one session type.)
 */
function forgetCurrentSession(_space?: "chat" | "cowork" | "code"): void {
  const cur = current();
  // BOTH the in-memory resume target and its persisted twin — clearing only
  // the first let the session come back on the next launch.
  lastSession = "";
  void window.glyphh.setPreference?.(LAST_SESSION_PREF, "");
  // ...AND the workspace state that belonged to it: a closed session must not
  // leave its folder behind for the next new session to inherit.
  pendingSource = { ...DEFAULT_SOURCE };
  void window.glyphh.setPreference?.(SOURCE_PREF, null);
  pendingWorkdir = "";
  sourceChip?.setSource(activeSource());
  paintSourceDependents();
  // Closing the session you were in leaves you on the landing, not an empty
  // agent screen.
  if (cur) leaveSessionToLanding();
  else { renderHistory(); renderThread(); }
}
// The workbench closes PANELS; it has no idea which session was in one.
(window as unknown as { __glyphhForgetSession?: (s?: "chat" | "cowork" | "code") => void })
  .__glyphhForgetSession = forgetCurrentSession;
// The WORKBENCH owns the panels, so it is what notices a seat closing.
(window as unknown as { __glyphhSessionClosed?: (s?: "chat" | "cowork" | "code") => void })
  .__glyphhSessionClosed = forgetCurrentSession;

async function deleteChat(chat: CodeChat): Promise<void> {
  if (!(await confirmAction({
    title: `Delete “${chat.title}”?`,
    body: "This session's history is gone for good.",
    confirmLabel: "Delete session",
    danger: true,
  }))) return;
  chats = chats.filter((x) => x.id !== chat.id);
  // A deleted session can never be the resume target again.
  if (lastSession === chat.id) forgetCurrentSession();
  if (currentId === chat.id) currentId = chats[0]?.id || "";
  threadStore.remove(chat.id); // server tombstone (offline-safe)
  void saveStore();
  renderHistory();
  renderThread();
}

let menuEl: HTMLDivElement | null = null;

function closeMenu(): void { menuEl?.remove(); menuEl = null; }

function beginRename(chat: CodeChat, label: HTMLElement): void {
  const field = document.createElement("input");
  field.type = "text";
  field.className = "code-history-rename";
  field.value = chat.title;
  field.addEventListener("click", (ev) => ev.stopPropagation());
  let done = false;
  const restore = (): void => { label.textContent = chat.title; label.title = chat.title; field.replaceWith(label); };
  const commit = (): void => {
    if (done) return;
    done = true;
    const t = field.value.trim();
    if (t && t !== chat.title) {
      chat.title = t;
      void saveStore();
      // The coding tile's header/dropdown follow this event.
      window.dispatchEvent(new CustomEvent("agent-sessions-changed"));
    }
    restore();
  };
  field.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter") { ev.preventDefault(); commit(); }
    else if (ev.key === "Escape") { ev.preventDefault(); done = true; restore(); }
  });
  field.addEventListener("blur", commit);
  label.replaceWith(field);
  field.focus();
  field.select();
}

function openChatMenu(anchor: HTMLElement, chat: CodeChat): void {
  closeMenu();
  const m = document.createElement("div");
  m.className = "code-menu";
  const ren = document.createElement("button");
  ren.className = "code-menu-item";
  ren.textContent = "Rename";
  ren.addEventListener("click", () => {
    closeMenu();
    const label = anchor.closest(".code-history-item")?.querySelector<HTMLElement>(".code-history-title");
    if (label) beginRename(chat, label);
  });
  m.appendChild(ren);
  // Pin — the same toggle the row's leading icon runs, so the menu and the
  // icon can never disagree about what pinning does.
  const pin = document.createElement("button");
  pin.className = "code-menu-item";
  pin.textContent = chat.pinned ? "Unpin" : "Pin";
  pin.addEventListener("click", () => { closeMenu(); togglePin(chat); });
  m.appendChild(pin);
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

// ── In-thread session header (SessionHeader port) ──────────────────────────
// The head's LEFT is `‹ <locus> <name>` (‹ opens the space's list view); the
// RIGHT carries a ⋮ kebab (Rename / Pin / Delete). The head is sticky and
// fades in as the thread scrolls (data-scrolled on the head). Rename edits the
// LOCAL title; Pin toggles chat.pinned; Delete runs the app's confirm+delete.
const HEAD_LOCUS_REMOTE = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.5 19a4.5 4.5 0 0 0 0-9 6 6 0 0 0-11.6-1.5A4 4 0 0 0 6 19Z"/></svg>`;
const HEAD_LOCUS_LOCAL = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>`;

/** Paint the head's locus icon from the current session's source (remote =
 *  cloud, local = machine). Hidden when there's no open session. */
function paintSessionHeadLocus(): void {
  const locus = el("code-session-locus");
  const back = el("code-session-back");
  if (!locus || !back) return;
  const c = current();
  // No open session (a landing) → the head is a plain title, no back/locus,
  // and no kebab (the platform renders SessionHeader only for an open session).
  back.classList.toggle("headless", !c);
  back.closest(".code-agent-head")?.classList.toggle("head-landing", !c);
  if (!c) { locus.innerHTML = ""; return; }
  const remote = !!c.source && c.source.kind !== "local";
  locus.innerHTML = remote ? HEAD_LOCUS_REMOTE : HEAD_LOCUS_LOCAL;
  locus.title = remote ? "Runs in the cloud (Fly)" : "Runs on your machine";
}

/** Rename the current session inline in the head (Enter commits, Esc cancels). */
function renameCurrentInline(): void {
  const c = current();
  const titleEl = el("code-session-title");
  if (!c || !titleEl) return;
  const field = document.createElement("input");
  field.type = "text";
  field.className = "session-head-rename";
  field.value = c.title;
  field.maxLength = 120;
  field.spellcheck = false;
  field.addEventListener("click", (ev) => ev.stopPropagation());
  let done = false;
  const restore = (): void => { titleEl.textContent = c.title; field.replaceWith(titleEl); };
  const commit = (): void => {
    if (done) return; done = true;
    const t = field.value.trim();
    if (t && t !== c.title) {
      c.title = t; void saveStore();
      window.dispatchEvent(new CustomEvent("agent-sessions-changed"));
      renderHistory();
    }
    restore();
  };
  field.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter") { ev.preventDefault(); commit(); }
    else if (ev.key === "Escape") { ev.preventDefault(); done = true; restore(); }
  });
  field.addEventListener("blur", commit);
  titleEl.replaceWith(field);
  field.focus(); field.select();
}

/** Toggle a session's pin (chat.pinned — floats it in the lists). The rail's
 *  leading icon and the session menu's Pin both land here, so the two can't
 *  drift apart. */
function togglePin(c: CodeChat): void {
  c.pinned = !c.pinned;
  void saveStore();
  renderHistory();
  window.dispatchEvent(new CustomEvent("agent-sessions-changed"));
}

/** The open session's pin — the head kebab's Pin item. */
function toggleCurrentPin(): void {
  const c = current();
  if (c) togglePin(c);
}

let headKebabEl: HTMLDivElement | null = null;
function closeHeadKebab(): void { headKebabEl?.remove(); headKebabEl = null; }

// Kebab item icons (SessionHeader port: IcRename / IcPin / IcTrash).
const IC_RENAME = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>`;
const IC_PIN = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 17v5"/><path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z"/></svg>`;
const IC_TRASH = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>`;

/** Paint Rename / Pin / Delete into the workbench's "More" menu — the Code
 *  agent's ONE dropdown. Called by the workbench each time that menu opens, so
 *  the pin label and the target session are always current. */
(window as unknown as { __paintSessionActions?: (host: HTMLElement) => void }).__paintSessionActions = (host) => {
  host.querySelector(".code-view-session-actions")?.remove();
  const c = current();
  if (!host || !c) return;
  const wrap = document.createElement("div");
  wrap.className = "code-view-session-actions";
  const mk = (label: string, danger: boolean, on: () => void): HTMLButtonElement => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "code-view-btn code-view-menu-item" + (danger ? " danger" : "");
    b.innerHTML = `<span>${label}</span>`;
    b.addEventListener("click", () => { host.classList.add("hidden"); on(); });
    return b;
  };
  wrap.append(
    mk("Rename", false, renameCurrentInline),
    mk(c.pinned ? "Unpin" : "Pin", false, toggleCurrentPin),
    mk("Delete", true, () => { void deleteChat(c); }),
  );
  host.appendChild(wrap);
};

function openHeadKebab(anchor: HTMLElement): void {
  closeHeadKebab();
  const c = current();
  if (!c) return;
  const m = document.createElement("div");
  m.className = "code-menu session-head-menu";
  const mk = (icon: string, label: string, danger: boolean, on: () => void): HTMLButtonElement => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "code-menu-item" + (danger ? " danger" : "");
    b.innerHTML = `${icon}<span></span>`;
    (b.querySelector("span") as HTMLElement).textContent = label;
    b.addEventListener("click", () => { closeHeadKebab(); on(); });
    return b;
  };
  m.append(
    mk(IC_RENAME, "Rename", false, renameCurrentInline),
    mk(IC_PIN, c.pinned ? "Unpin" : "Pin", false, toggleCurrentPin),
    mk(IC_TRASH, "Delete", true, () => { void deleteChat(c); }),
  );
  const r = anchor.getBoundingClientRect();
  m.style.top = `${r.bottom + 4}px`;
  m.style.left = `${Math.max(8, r.right - 150)}px`;
  document.body.appendChild(m);
  headKebabEl = m;
}

function renderHistory(): void {
  window.dispatchEvent(new CustomEvent("agent-sessions-changed"));
  // The agent head's session title rides every history repaint.
  const sessTitleEl = el("code-session-title");
  if (sessTitleEl) sessTitleEl.textContent = current()?.title ?? "New session";
  paintSessionHeadLocus();
  window.dispatchEvent(new CustomEvent("agent-sessions-changed"));
  const list = el<HTMLDivElement>("code-history");
  if (!list) return;
  list.textContent = "";
  cwPaint?.();
  const q = recentsQuery.trim().toLowerCase();
  const visible = chats.filter((c) => !q || c.title.toLowerCase().includes(q));
  // All sessions, not just rows surviving the filter — a search that matches
  // nothing must keep its own box on screen to be cleared.
  paintRecentsSearch(chats.length);

  // Pinned sessions leave their normal group and sit at the top under one
  // heading. Nothing pinned, no heading: an empty "Pinned" would be a permanent
  // reminder of a feature you aren't using.
  const pinned = visible.filter((c) => c.pinned);
  const rest = visible.filter((c) => !c.pinned);
  if (pinned.length) {
    list.appendChild(recentsHead("Pinned", "Pinned sessions"));
    for (const c of pinned) list.appendChild(historyRow(c));
  }

  // Sessions split by WHERE they run — Cloud, then a group per local folder.
  // A folder whose sessions are all pinned drops out entirely, because the
  // groups are built from what's left.
  for (const g of groupRecents(rest)) {
    list.appendChild(recentsHead(g.label, g.title));
    for (const c of g.rows) list.appendChild(historyRow(c));
  }
}

/** Where a session runs, as a grouping key. Anything not explicitly local is
 *  cloud — a session born before the source chip existed has no `source`. */
function locusKey(c: CodeChat): string {
  const src = c.source;
  if (src && src.kind === "local") return `local:${src.path || c.workdir || ""}`;
  return "cloud";
}

/** The last path segment, for a heading. Handles both separators — a Windows
 *  workdir must not render as one long unbroken string. */
function folderName(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, "");
  const cut = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  return (cut === -1 ? trimmed : trimmed.slice(cut + 1)) || path;
}

interface RecentsGroup { key: string; label: string; title: string; rows: CodeChat[] }

/**
 * Cloud first, then one group per local folder. Folders keep the order their
 * first session appears in — `chats` is already ordered the way the rail wants
 * to read, so this never re-sorts anyone.
 */
function groupRecents(rows: CodeChat[]): RecentsGroup[] {
  const byKey = new Map<string, RecentsGroup>();
  for (const c of rows) {
    const key = locusKey(c);
    let g = byKey.get(key);
    if (!g) {
      const path = key === "cloud" ? "" : key.slice("local:".length);
      g = key === "cloud"
        ? { key, label: "Cloud", title: "Runs in the cloud", rows: [] }
        : { key, label: path ? folderName(path) : "Local", title: path || "On this machine", rows: [] };
      byKey.set(key, g);
    }
    g.rows.push(c);
  }
  const all = [...byKey.values()];
  const cloud = all.filter((g) => g.key === "cloud");
  return [...cloud, ...all.filter((g) => g.key !== "cloud")];
}

function recentsHead(label: string, title: string): HTMLDivElement {
  const head = document.createElement("div");
  head.className = "code-history-sec";
  head.textContent = label;
  head.title = title;
  return head;
}

/** One recents row. Its leading icon is the PIN control — the same toggle the
 *  session menu offers — and carries a dot while pinned. */
function historyRow(c: CodeChat): HTMLDivElement {
  const row = document.createElement("div");
  row.className = "code-history-item" + (c.id === currentId ? " active" : "");
  const label = document.createElement("span");
  label.className = "code-history-title";
  label.textContent = c.title;
  label.title = c.title;
  // Rename is a menu action (⋯ → Rename), not a click on the title — a
  // selection-gated title click fought the row's own select handler and
  // never reliably fired. The label is now just a label.
  // Leading slot: the RUNNING pulse while live, else the session's LOCUS icon
  // (cloud vs machine) — one session type now, so the old `<>` code glyph was
  // dead weight; the icon reads from this session's own source (locusKey), so it
  // stays correct once the per-session source is restored. Either way it
  // TOGGLES THE PIN on click.
  const working = liveRuns.has(c.id);
  const local = locusKey(c).startsWith("local:");
  const dot = document.createElement("span");
  if (working) {
    dot.className = "code-chat-dot working";
  } else {
    dot.className = "code-sess-ic";
    dot.innerHTML = local ? HEAD_LOCUS_LOCAL : HEAD_LOCUS_REMOTE;
  }
  dot.classList.toggle("pinned", !!c.pinned);
  const typeName = working ? "Working" : local ? "Local" : "Cloud";
  dot.title = `${typeName} — click to ${c.pinned ? "unpin" : "pin"}`;
  dot.addEventListener("click", (e) => {
    e.stopPropagation();   // pinning must not also open the session
    togglePin(c);
  });
  const menuBtn = document.createElement("button");
  menuBtn.className = "code-chat-menu-btn";
  menuBtn.title = "More";
  menuBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" stroke="none"><circle cx="12" cy="5" r="1.7"/><circle cx="12" cy="12" r="1.7"/><circle cx="12" cy="19" r="1.7"/></svg>`;
  menuBtn.addEventListener("click", (e) => { e.stopPropagation(); openChatMenu(menuBtn, c); });
  row.append(dot, label, menuBtn);
  row.addEventListener("click", () => {
    currentId = c.id;
    lastSession = c.id;
    void window.glyphh.setPreference?.(LAST_SESSION_PREF, c.id);
    threadPinned = true;
    void saveStore();
    ensureCodeSection();
    renderHistory();
    renderThread();
    refreshCtxMeter();
    void checkWorkdirGate();
    // The opened session's OWN source drives the chip, the head locus and the
    // run — without this the chip stays on the previous (pending) source and
    // every rail-opened session looked like it ran in the cloud.
    repaintSourceUi();
    // a rail session press behaves like the Glyphh icon: the agent ALONE
    gotoSection("agent");
  });
  return row;
}

const DECLINE_WARN_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>`;
/** The inline CONNECT card — the agent's connect_account tool offers an
 *  account connection right in the thread; the button runs the SAME in-app
 *  OAuth the Connections page uses (connectorsConnect), and the waiting tool
 *  is answered when it finishes. The user never leaves the chat. */
function connectCardEl(chat: CodeChat, card: ConnectCard): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "code-connect-card";
  const initial = (card.name || "?").charAt(0).toUpperCase();
  wrap.innerHTML = `
    ${card.icon ? `<img class="ccx-icon" src="${card.icon}" />` : `<span class="ccx-initial">${initial}</span>`}
    <div class="ccx-info">
      <div class="ccx-name"></div>
      <div class="ccx-sub"></div>
    </div>
    <button type="button" class="ccx-btn"></button>`;
  (wrap.querySelector(".ccx-name") as HTMLElement).textContent = card.name;
  const sub = wrap.querySelector(".ccx-sub") as HTMLElement;
  const btn = wrap.querySelector(".ccx-btn") as HTMLButtonElement;
  const paint = (): void => {
    wrap.dataset.status = card.status;
    if (card.status === "connected") {
      sub.textContent = "Connected — the agent can use this account now.";
      btn.textContent = "Connected ✓";
      btn.disabled = true;
    } else if (card.status === "connecting") {
      sub.textContent = "Finishing the authorization…";
      btn.textContent = "Connecting…";
      btn.disabled = true;
    } else if (card.status === "failed") {
      sub.textContent = card.error || "The connection didn't complete.";
      btn.textContent = "Retry";
      btn.disabled = false;
    } else {
      sub.textContent = "The agent needs this account — authorize it right here.";
      btn.textContent = "Connect";
      btn.disabled = false;
    }
  };
  paint();
  btn.addEventListener("click", () => {
    card.status = "connecting";
    paint();
    void saveStore();
    void window.glyphh.connectorsConnect(card.appId).then((res) => {
      card.status = res.ok ? "connected" : "failed";
      if (!res.ok) card.error = res.error || "Authorization failed.";
      paint();
      void saveStore();
      // answer the WAITING tool (retries after a failure answer again — the
      // respond handler ignores unknown ids, so that's harmless)
      void window.glyphh.glyphhAgentConnectRespond?.({ id: card.id, connected: res.ok, ...(res.ok ? {} : { reason: card.error }) });
    });
  });
  return wrap;
}

/** A styled card for a gateway decline (out of credits / role / rate) — replaces
 *  the raw "API Error: 400 …" text with a title, explanation, and one-click
 *  actions (buy credits / manage plan; and switch to a free on-device model). */
function declineCardEl(d: { kind: string; url: string }): HTMLElement {
  const COPY: Record<string, { title: string; body: string; cta: string }> = {
    credits: { title: "Out of credits", body: "The Claude model you picked needs gateway credits to run. Buy more, or switch to an on-device model — those run free on your machine.", cta: "Buy more credits" },
    role: { title: "Model not allowed", body: "This model isn't enabled for your account or role. Manage your plan, or switch to a free on-device model.", cta: "Manage plan" },
    rate: { title: "Rate limited", body: "The gateway is busy right now. Try again in a moment, or switch to a free on-device model.", cta: "Open account" },
    generic: { title: "Model unavailable", body: "The gateway declined this model. Check your account, or switch to a free on-device model.", cta: "Open account" },
  };
  const c = COPY[d.kind] || COPY.generic;
  const card = document.createElement("div");
  card.className = `decline-card decline-card--${d.kind}`;
  card.innerHTML = `
    <div class="decline-card-icon">${DECLINE_WARN_SVG}</div>
    <div class="decline-card-main">
      <div class="decline-card-title"></div>
      <div class="decline-card-body"></div>
      <div class="decline-card-actions">
        ${d.url ? `<button class="decline-card-cta" type="button"></button>` : ""}
        <button class="decline-card-alt" type="button">Pick an on-device model</button>
      </div>
    </div>`;
  (card.querySelector(".decline-card-title") as HTMLElement).textContent = c.title;
  (card.querySelector(".decline-card-body") as HTMLElement).textContent = c.body;
  const cta = card.querySelector<HTMLButtonElement>(".decline-card-cta");
  if (cta) {
    cta.textContent = c.cta;
    // Open in the in-app workbench browser (same mechanics as Manage Account),
    // NOT the system browser.
    cta.addEventListener("click", () => openUrlInWorkbench(d.kind === "credits" ? "Billing" : "Account", d.url));
  }
  card.querySelector<HTMLButtonElement>(".decline-card-alt")?.addEventListener("click", () => el("code-model-chip")?.click());
  return card;
}

// ── Stick-to-bottom ──────────────────────────────────────────
// While the agent streams, the thread follows the newest token ONLY if the
// user is already at the bottom. Scrolling up releases the pin (so history is
// readable mid-generation); scrolling back to the bottom re-engages it.
let threadPinned = true;
let threadScrollWired = false;

function wireThreadScroll(thread: HTMLDivElement): void {
  if (threadScrollWired) return;
  threadScrollWired = true;
  thread.addEventListener("scroll", () => {
    threadPinned = thread.scrollHeight - thread.scrollTop - thread.clientHeight < 48;
    // The sticky head fades in as content scrolls under it (SessionHeader).
    el("code-session-back")?.closest(".code-agent-head")?.classList.toggle("scrolled", thread.scrollTop > 6);
  }, { passive: true });
}

/** Jump to the newest message and re-engage following (send / chat switch). */
function pinThreadToBottom(): void {
  threadPinned = true;
  const thread = el<HTMLDivElement>("code-thread");
  if (thread) thread.scrollTop = thread.scrollHeight;
}

// The Code space's landing: greeting + a two-column body (code prompt
// suggestions LEFT that seed the composer, a "Waiting on you" session list
// RIGHT). The composer stays pinned at the bottom of .code-agent. Scoped to
// this app's LOCAL code-space sessions (there is no SDK runtime-session list
// here — sessions are the local store); ranked working-first, then pinned,
// then last-active.
const CODE_PROMPTS = [
  "Fix a bug — point me at the symptom",
  "Build a feature in this repo",
  "Refactor a file without changing behavior",
  "Write tests for a function or flow",
  "Explain how part of the codebase works",
  "Review the changes on a branch",
];

const IC_REMOTE = `<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.5 19a4.5 4.5 0 0 0 0-9 6 6 0 0 0-11.6-1.5A4 4 0 0 0 6 19Z"/></svg>`;
const IC_LOCAL = `<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>`;

/** "3m", "2h", "5d" — a compact age from a ms timestamp. */
function timeAgo(ms: number): string {
  if (!ms) return "";
  const s = Math.floor((Date.now() - ms) / 1000);
  if (s < 60) return "just now";
  const m = Math.floor(s / 60); if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60); if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24); return `${d}d ago`;
}

function codeGreeting(name: string): string {
  return name ? `Welcome back, ${name}` : "Welcome back";
}

// The Code landing's own HeroFlow backdrop (rise variant) — a canvas behind
// the two-column body. Stopped + cleared whenever the thread repaints.


/** Open a local session by id (the Code home + the rail's recents). */
function openLocalSession(id: string): void {
  if (!chats.some((x) => x.id === id)) return;
  currentId = id;
  const c = current();
  if (c) { lastSession = c.id; void window.glyphh.setPreference?.(LAST_SESSION_PREF, c.id); }
  threadPinned = true;
  void saveStore();
  ensureCodeSection();
  renderHistory();
  renderThread();
  refreshCtxMeter();
  void checkWorkdirGate();
  // The opened session's stored source drives the chip/locus/run (see the rail
  // row handler) — not the pending pick that was showing before.
  repaintSourceUi();
  gotoSection("agent");
}

function renderThread(): void {
  // The composer's working state belongs to the SESSION ON SCREEN — every
  // switch lands here, so recompute (a background session keeps running;
  // this one's send must not wear its stop state).
  syncThinking();
  syncActiveRunAttach();   // attach to / detach from a run happening on another surface
  const thread = el<HTMLDivElement>("code-thread");
  if (!thread) return;
  wireThreadScroll(thread);
  thread.textContent = "";
  const inner = document.createElement("div");
  inner.className = "code-thread-inner";
  thread.appendChild(inner);
  stopGhostRotation();
  const c = current();
  // A server-adopted thread paints as soon as its lazily-fetched messages land.
  if (c) hydrateMessagesIfNeeded(c.id);
  // EVERY agent's empty thread is the SAME: the mascot + a line. Code used to
  // render its own two-column landing here, so the coding agent looked like a
  // different product from Chat and Work — the + New Session screen is where
  // suggestions and session lists belong, not inside an agent.
  if (!c || !c.messages.length) {
    const ghost = document.createElement("div");
    ghost.className = "code-ghost";
    // MASCOT = the time-of-day cousin, picked by the user's LOCAL hour and
    // rendered as inline SVG (purple/accent). Re-evaluated on every landing
    // paint, so the bucket stays current.
    const mark = document.createElement("div");
    mark.className = "code-ghost-mark";
    mark.innerHTML = timeMascotSvg();
    // TITLE = the home hero's greeting (title font): time-of-day + user name.
    // Re-evaluated here so the bucket is current; name backfills async.
    ensureGhostName();
    const title = document.createElement("div");
    title.className = "code-ghost-title";
    title.textContent = greeting(ghostName);
    // SAYING = the rotating slogan (secondary font); rotation preserved.
    const quote = document.createElement("div");
    quote.className = "code-ghost-quote";
    quote.textContent = GHOST_QUOTES[ghostIdx];
    ghost.append(mark, title, quote);
    inner.appendChild(ghost);
    startGhostRotation(quote);
    return;
  }
  // Consecutive tool breadcrumbs group into one collapsible row ("Ran N
  // tool calls · M failed ›") once a run is over — quiet by default,
  // inspectable on click. The ACTIVE run's steps stay expanded live.
  const blocks: Array<{ tool: true; msgs: CodeMsg[] } | { tool: false; msg: CodeMsg }> = [];
  for (const m of c.messages) {
    const last = blocks[blocks.length - 1];
    if (m.kind === "tool") {
      if (last && last.tool) last.msgs.push(m);
      else blocks.push({ tool: true, msgs: [m] });
    } else {
      blocks.push({ tool: false, msg: m });
    }
  }
  const liveRun = liveRuns.get(c.id) ?? null;
  blocks.forEach((b, i) => {
    if (!b.tool) {
      // User = right-aligned pill; agent = markdown transcript text (no
      // bubble) — headings, lists, links, and code blocks render for real.
      const el = document.createElement("div");
      if (b.msg.role === "user") {
        el.className = "code-msg user";
        el.textContent = b.msg.text;
        // Attachment chips ride under the pill, same right alignment.
        if (b.msg.attachments?.length) {
          const atts = document.createElement("div");
          atts.className = "code-msg-atts";
          for (const a of b.msg.attachments) atts.appendChild(attachChipEl(a));
          if (b.msg.text) inner.appendChild(el);
          inner.appendChild(atts);
          return;
        }
      } else if (b.msg.kind === "decline" && b.msg.decline) {
        el.className = "code-decline-wrap";
        el.appendChild(declineCardEl(b.msg.decline));
      } else if (b.msg.kind === "connect" && b.msg.connect) {
        el.className = "code-connect-wrap";
        el.appendChild(connectCardEl(c, b.msg.connect));
      } else {
        el.className = "code-agent-text";
        el.innerHTML = formatMarkdown(b.msg.text);
      }
      inner.appendChild(el);
      return;
    }
    // The active run's trailing group folds into a working TRAY too (a summary by
    // default, expandable for the detail actions) — same treatment as finished groups,
    // so a live turn doesn't dump a wall of raw tool lines.
    inner.appendChild(toolGroupEl(c.id, b.msgs, !!liveRun && i === blocks.length - 1));
  });
  // Working state — the streamed reply renders as plain agent text, and a
  // working spinner ALWAYS sits at the bottom while thinking (through tool
  // execution and inter-turn waits, not just before the first token).
  spinner?.destroy();
  spinner = null;
  if (liveRun) {
    liveRun.bubble = null;
    if (liveRun.text) {
      liveRun.bubble = document.createElement("div");
      liveRun.bubble.className = "code-agent-text";
      liveRun.bubble.innerHTML = formatMarkdown(liveRun.text);
      inner.appendChild(liveRun.bubble);
    }
    spinner = createGlyphhSpinner();
    paintRunMeta();
    const row = document.createElement("div");
    row.className = "code-working";
    row.appendChild(spinner.el);
    inner.appendChild(row);
  }
  if (threadPinned) thread.scrollTop = thread.scrollHeight;
}

const FILE_ICON = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>`;
const TERM_ICON = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/></svg>`;
const FOLDER_ICON = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>`;

function diffBadgeHtml(text: string): { rest: string; badge: string } {
  const diff = /\s\[\+(\d+) -(\d+)\]\s*$/.exec(text);
  if (!diff) return { rest: text, badge: "" };
  return {
    rest: text.slice(0, diff.index),
    badge: `<span class="code-diff-badge"><span class="diff-add">+${diff[1]}</span> <span class="diff-del">-${diff[2]}</span></span>`,
  };
}

const escAttr = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** One tool breadcrumb. File writes and shell runs render as CARDS that open
 *  the matching workbench view (Monaco tab / terminal); everything else is a
 *  quiet line. "+N -M" splits out as a colored diff badge. */
function toolLineEl(text: string): HTMLElement {
  const { rest, badge } = diffBadgeHtml(text);

  // "✓ Write /abs/path" (and Read) → file card; click routes through the
  // workbench's smart opener (editor / Browser panel / native viewer by
  // type). Unix and Windows absolute paths both match.
  const write = /^([✓✕⚙]) (?:Write|Read) ((?:\/|[A-Za-z]:[\\/])\S.*?)\s*$/.exec(rest);
  if (write && write[1] === "✓") {
    const path = write[2];
    const base = path.split(/[\\/]/).pop() || path;
    const dir = path.slice(0, path.length - base.length).replace(/[\\/]$/, "");
    const card = document.createElement("button");
    card.type = "button";
    card.className = "code-file-card";
    card.dataset.path = path;
    card.title = "Open in the workbench";
    card.innerHTML = `${FILE_ICON}<span class="cfc-name">${escAttr(base)}</span><span class="cfc-dir">${escAttr(dir)}</span>${badge}`;
    return card;
  }

  // "✓ Run: cmd" → terminal card, click reveals the workbench terminal.
  const run = /^([✓✕]) Run: (.+)$/.exec(rest);
  if (run) {
    const card = document.createElement("button");
    card.type = "button";
    card.className = "code-run-card" + (run[1] === "✕" ? " failed" : "");
    card.title = "Open the workbench terminal";
    card.innerHTML = `${TERM_ICON}<span class="crc-cmd">${escAttr(run[2].slice(0, 120))}</span>`;
    return card;
  }

  const line = document.createElement("div");
  line.className = "code-tool-line";
  if (badge) {
    line.textContent = rest + " ";
    line.insertAdjacentHTML("beforeend", badge);
  } else {
    line.textContent = text;
  }
  return line;
}

// Expanded tool groups (keyed chatId:firstMsgTimestamp) — transient UI state.
const expandedToolGroups = new Set<string>();

function toolGroupEl(chatId: string, msgs: CodeMsg[], live = false): HTMLElement {
  const key = `${chatId}:${msgs[0]?.at ?? 0}`;
  const open = expandedToolGroups.has(key);
  const wrap = document.createElement("div");
  wrap.className = "code-tool-group" + (live ? " live" : "");
  const failed = msgs.filter((m) => m.text.startsWith("✕")).length;
  const head = document.createElement("button");
  head.type = "button";
  head.className = "code-tool-summary" + (open ? " open" : "");
  head.innerHTML = `<span></span><svg class="tg-chev" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>`;
  // Live = present-tense "Working" tray (the count updates as tools stream in); settled =
  // the recap with a failure count. Collapsed by default either way — expand for detail.
  (head.firstChild as HTMLElement).textContent = live
    ? `Working — ${msgs.length} tool call${msgs.length === 1 ? "" : "s"}…`
    : `Ran ${msgs.length} tool call${msgs.length === 1 ? "" : "s"}${failed ? ` · ${failed} failed` : ""}`;
  head.addEventListener("click", () => {
    if (expandedToolGroups.has(key)) expandedToolGroups.delete(key);
    else expandedToolGroups.add(key);
    renderThread();
  });
  wrap.appendChild(head);
  if (open) {
    for (const m of msgs) wrap.appendChild(toolLineEl(m.text));
  }
  return wrap;
}

// ── Working-folder gate — a session builds inside a folder the user chose.
//    Until one has ever been picked, the composer sleeps: placeholder
//    explains, a click pops the OS picker, and picking wakes it. The folder
//    persists as last-used, so this is a once-per-setup moment. ──
type WbBridge = {
  getCwd?: () => Promise<string | null>;
  getCwdExplicit?: () => Promise<string | null>;
  pickCwd?: (opts?: { nullOnCancel?: boolean }) => Promise<string | null>;
  onCwdChanged?: (cb: (dir: string | null) => void) => void;
};
const wb = () => (window as unknown as { wb?: WbBridge }).wb;

// The composer gates ONLY when no working folder has ever been chosen —
// once one exists it persists as last-used and sessions start ready (the
// picker, when opened, defaults to that folder so switching is one click).
let workdirReady = true; // painted by checkWorkdirGate

/**
 * Rail search behaviour: type to filter, Esc to clear.
 *
 * The × belongs to search-clear.ts, which already enhances every
 * `input.rail-recents-search` and dispatches `input` when it clears — so this
 * only listens. (A second × of my own ended up orphaned outside the wrapper
 * that enhancer injects.)
 */
function wireRailSearch(input: HTMLInputElement | null, onChange: (v: string) => void): void {
  if (!input) return;
  input.addEventListener("input", () => onChange(input.value));
  input.addEventListener("keydown", (e) => {
    if (e.key !== "Escape" || !input.value) return;
    input.value = "";
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

/** The Recents search only earns its space when Recents is OPEN and actually
 *  has rows to filter. */
function paintRecentsSearch(rows: number): void {
  const input = el<HTMLInputElement>("recents-search");
  const box = input?.closest<HTMLElement>(".app-rail-search");
  if (!box) return;
  const collapsed = !!el("recents-toggle")?.classList.contains("closed");
  const show = !collapsed && (rows > 0 || !!recentsQuery.trim());
  box.classList.toggle("hidden", !show);
}

/** The rail's Recents filter — session titles. */
let recentsQuery = "";
/** The last-selected session id (persisted). One session type now, one slot. */
let lastSession = "";
const LAST_SESSION_PREF = "lastSessionCode";
/** Repaints session-scoped composer chrome — set by initComposerControls,
 *  called on session switches. */
let cwPaint: (() => void) | null = null;
// ── Workspace SOURCE (the location chip on the composer) ──────────────────
// Where the next session runs + what it works on (cloud project / repo / local
// folder). One pending pick now (spaces are gone), stamped onto the record the
// first send creates.
const DEFAULT_SOURCE: Source = { kind: "cloud-new" };
let pendingSource: Source = { ...DEFAULT_SOURCE };
const SOURCE_PREF = "workspaceSourceCode";
let sourceChip: ReturnType<typeof createSourceChip> | null = null;
let gitChip: ReturnType<typeof createGitChip> | null = null;

/** The source for the ACTIVE surface — the current session's stamped source,
 *  else the pending pick. */
function activeSource(): Source {
  const cur = document.body.classList.contains("composer-on-home") ? null : current();
  if (cur?.source) return cur.source;
  return pendingSource;
}

/** Value-equality for two sources — a pick that matches the session's own
 *  source is a no-op, so we never spawn a redundant new session for it. */
function sameSource(a?: Source, b?: Source): boolean {
  if (!a || !b) return a === b;
  if (a.kind !== b.kind) return false;
  if (a.kind === "cloud-repo" && b.kind === "cloud-repo") return a.repo === b.repo;
  if (a.kind === "local" && b.kind === "local") return a.path === b.path && (a.machineId ?? "") === (b.machineId ?? "");
  return true; // cloud-new === cloud-new
}

/** Repaint EVERY source-dependent surface from the active source: the chip's
 *  label + session id, the head locus icon, and the folder/repo/static chrome.
 *  The rail-open paths call this so an opened session's real source shows up
 *  instead of the last-painted (pending) one. */
function repaintSourceUi(): void {
  sourceChip?.setSource(activeSource());
  sourceChip?.setSessionId(current()?.id ?? null);
  paintSessionHeadLocus();
  paintSourceDependents();
}

/**
 * A source pick from the chip.
 *
 * Source is IMMUTABLE per session (the runtime/workspace/transcript bind to it
 * at birth), so the pick behaves differently by session state:
 *   · no session, or the composer is on Home  → set the pending pick.
 *   · an UNBORN current session (no messages)  → re-stamp its source in place.
 *   · a BORN current session, picking the SAME source → nothing to do.
 *   · a BORN current session, picking a DIFFERENT source → start a NEW session
 *     carrying the pick (lazily, like startNew): clear currentId + set
 *     pendingSource, WITHOUT tearing down an open layout — the new session is
 *     born on the next send, in the same panel. This is what makes a layout's
 *     source change actually take effect (it used to hit the guard and no-op).
 * Persisted either way.
 */
function pickSource(next: Source): void {
  const cur = current();
  const onHome = document.body.classList.contains("composer-on-home");

  // A BORN session's source is LOCKED — only a NEW (unborn) session can change
  // its source. Ignore any pick on a born session (the chip is also made static
  // in paintSourceDependents; this also guards the folder/repo pickers, which
  // route through here). Just resettle the chip on the session's real source.
  if (cur && cur.messages.length > 0 && !onHome) {
    repaintSourceUi();
    return;
  }

  // No session / Home / an UNBORN current session — set the pending pick and,
  // for an unborn current session, re-stamp its source (still cheap to change).
  pendingSource = next;
  paintSourceDependents();
  void window.glyphh.setPreference?.(SOURCE_PREF, next);
  if (cur && cur.messages.length === 0) { cur.source = next; void saveStore(); }
  sourceChip?.setSource(next);
}

/** Mount the source chip above the composer (once). */
function mountSourceChip(): void {
  if (sourceChip) { sourceChip.setSource(activeSource()); return; }
  // The chip mounts AFTER prefs restore (async) — land it in whichever slot is
  // live right now: the landing's chips row when the composer sits on Home,
  // else its place above the agent composer.
  const host = (document.body.classList.contains("composer-on-home") && document.getElementById("dash-source-slot"))
    || el("code-source-slot");
  if (!host) return;
  sourceChip = createSourceChip({
    getSource: activeSource,
    onPick: pickSource,
    getSessionId: () => current()?.id ?? null,
  });
  host.appendChild(sourceChip.el);
  // The GIT chip sits AFTER the folder in the landing row: repo picker on a
  // cloud source (what the remote agent checks out), hidden on local (the
  // passive branch mirror covers local).
  if (!gitChip) {
    gitChip = createGitChip({ getSource: activeSource, onPick: pickSource });
    const branchMirror = document.getElementById("dash-wd-branch-wrap");
    branchMirror?.insertAdjacentElement("afterend", gitChip.el);
  }
}

/** The composer's resting prompt. */
function readyPlaceholder(): string {
  return "Describe what to build or fix…";
}

function paintComposerGate(): void {
  const ta = input();
  if (!ta) return;
  ta.disabled = !workdirReady;
  ta.placeholder = workdirReady
    ? readyPlaceholder()
    : "Pick a working folder to start — click here to choose";
  el("code-send")?.toggleAttribute("disabled", !workdirReady);
  const wrap = document.querySelector(".code-input-wrap");
  wrap?.classList.toggle("gated", !workdirReady);
  // With TEXT in the composer (a seeded prompt) the placeholder is
  // invisible — the gate needs its own voice, or the chat just looks dead.
  let note = wrap?.querySelector<HTMLElement>(".code-gate-note") ?? null;
  if (!workdirReady) {
    if (!note && wrap) {
      const btn = document.createElement("button");
      btn.type = "button";
      note = btn;
      btn.className = "code-gate-note";
      btn.textContent = "Pick a working folder to start →";
      btn.addEventListener("click", (ev) => {
        ev.stopPropagation();
        void wb()?.pickCwd?.({ nullOnCancel: true }).then(() => checkWorkdirGate());
      });
      wrap.prepend(btn);
    }
  } else {
    note?.remove();
  }
}

async function checkWorkdirGate(): Promise<void> {
  // The folder GATE is gone (2026-08-05): a session without an explicit pick
  // runs from the default root — the user's home dir on a machine, the
  // project root in the cloud. The composer never blocks on a folder.
  workdirReady = true;
  paintComposerGate();
  paintSourceDependents();
}

function initWorkdirGate(): void {
  void checkWorkdirGate();
  initWebFolderChips();
}

/**
 * Chips follow the SPACE, not the source:
 *   chat   — the source chip alone, reading "Cloud", inert (chat always runs there)
 *   cowork — source + folder + add; no repo chip
 *   code   — all of them
 *
 * The source state no longer disables anything. Picking a folder on a machine
 * is HOW a session moves cloud→local, so greying the folder chip out whenever
 * the source was cloud (the default) left every chip dead with no way back —
 * exactly what Chris hit: "the chips are not editable anywhere".
 */
const CHIP_TITLES: Record<string, string> = {
  "dash-wd-btn": "Pick the working folder",
  "dash-wd-add": "Add folder",
  "code-workdir-btn": "Pick the working folder",
  "code-workdir-add": "Add folder",
  "code-plus-chip": "Attach files",
};

/**
 * Move the source + repo chips into whichever composer row is on screen.
 *
 * There is ONE of each, and they used to be appended to whichever row existed
 * when prefs finished loading — so the AGENT view could come up with no source
 * chip and no repo chip at all while the landing held both. The composer moves
 * between Home and the thread; its chips have to move with it.
 */
function homeChips(): void {
  const onHome = document.body.classList.contains("composer-on-home");
  const host = document.getElementById(onHome ? "dash-source-slot" : "code-source-slot");
  // FIRST in the row, always — `<source> <folder> <git> <+>`. Checking only
  // the parent left it wherever it was appended, which put the source chip
  // last in the agent row.
  if (host && sourceChip && host.firstElementChild !== sourceChip.el) host.prepend(sourceChip.el);
  // The repo chip sits AFTER the folder, so it anchors off that row's branch
  // mirror rather than the slot itself.
  const mirror = document.getElementById(onHome ? "dash-wd-branch-wrap" : "code-workdir-branch-wrap");
  if (mirror && gitChip && gitChip.el.previousElementSibling !== mirror) {
    mirror.insertAdjacentElement("afterend", gitChip.el);
  }
}


/**
 * Validate the picked folder: is git ALREADY enabled there?
 *
 * Runs on both surfaces (desktop FS bridge / attach relay), so a web session
 * driving a machine gets the same answer as the desktop. A repo shows its
 * branch; a plain folder says so, which is the signal that a session started
 * here would be starting from no history. An unreachable machine shows
 * nothing at all rather than claiming "no repo" about a folder we never read.
 */
let gitStateSeq = 0;
function paintGitState(): void {
  const src = activeSource();
  const onHome = document.body.classList.contains("composer-on-home");
  const wrap = document.getElementById(onHome ? "dash-wd-branch-wrap" : "code-workdir-branch-wrap");
  const label = document.getElementById(onHome ? "dash-wd-branch" : "code-workdir-branch");
  if (!wrap || !label) return;
  const hide = (): void => { (wrap as HTMLElement).style.display = "none"; };
  if (src.kind !== "local") { hide(); return; }
  const seq = ++gitStateSeq;
  // The DESKTOP's local source carries no path — the machine's own working
  // directory is the folder in play there, so fall back to it.
  const dirOf = async (): Promise<string> => src.path
    || (await (wb() as unknown as { getCwdExplicit?: () => Promise<string | null> })?.getCwdExplicit?.().catch(() => null)) || "";
  void dirOf().then((dir) => (dir ? gitStateFor(dir) : null)).then((git) => {
    if (seq !== gitStateSeq) return;   // a newer pick landed while we asked
    if (!git) { hide(); return; }
    (wrap as HTMLElement).style.display = "";
    wrap.classList.toggle("no-git", !git.isRepo);
    label.textContent = git.isRepo ? (git.branch || "git") : "No git";
    wrap.setAttribute("title", git.isRepo
      ? `Git repository${git.branch ? ` on ${git.branch}` : ""}`
      : "No git repository in this folder yet");
  });
}



/** An unreachable source means the turn cannot run — the composer says so and
 *  refuses the send rather than accepting a prompt that would fail. */
function paintComposerReach(state: "connecting" | "live" | "down", src: Source): void {
  const ta = input();
  const send = el("code-send");
  const wrap = document.querySelector<HTMLElement>(".code-input-wrap");
  // Disabled WHILE CONNECTING, everywhere — you cannot send to a source that
  // has not answered yet. A FAILED source only blocks a bound session: on the
  // landing a dead source falls back to Cloud instead, so it never parks there
  // with a dead box.
  // Identical on both screens: the composer is blocked ONLY while the source
  // is being reached. A source that cannot be reached resolves by falling back
  // (below), never by leaving a dead box behind.
  const blocked = state === "connecting";
  if (ta) {
    ta.disabled = blocked;
    ta.placeholder = state === "connecting"
      ? "Connecting to your source…"
      : state === "down"
        ? (src.kind === "local"
            ? "Machine unavailable — pick another source to start"
            : "Cloud unavailable — pick another source to start")
        : readyPlaceholder();
  }
  send?.toggleAttribute("disabled", blocked);
  wrap?.classList.toggle("gated", blocked);
}

/**
 * Reflect REACHABILITY on the chip itself. A session that cannot connect
 * anywhere must not look ready to run: the chip goes quiet and says so, rather
 * than letting the failure surface on the first send.
 */
let reachSeq = 0;
function paintSourceReach(): void {
  const chip = sourceChip?.el.querySelector<HTMLElement>(".cl-runtime-chip");
  if (!chip) return;
  const src = activeSource();
  const seq = ++reachSeq;
  const setLabel = (text: string): void => {
    const lbl = chip.querySelector<HTMLElement>(".cl-runtime-lbl");
    if (lbl) lbl.textContent = text;
  };

  // CONNECTING — the attempt is visible while it happens. A source that
  // silently sat there looking ready told the user nothing about whether the
  // machine was actually reachable.
  chip.classList.remove("cl-runtime-down", "cl-runtime-live");
  chip.classList.add("cl-runtime-connecting");
  // Keep the source's NAME and append the state — "Cloud · Connecting…" —
  // rather than replacing it, so you never lose track of what is being reached.
  sourceChip?.setSource(src);
  const baseName = (chip.querySelector<HTMLElement>(".cl-runtime-lbl")?.textContent ?? "")
    .replace(/\s*·\s*Connecting….*$/, "").trim();
  setLabel(baseName ? `${baseName} · Connecting…` : "Connecting…");
  chip.setAttribute("title", src.kind === "local"
    ? "Connecting to your machine…"
    : "Connecting to the cloud runtime…");
  paintComposerReach("connecting", src);

  const settle = (attempt: number): void => void probeSources(attempt > 0).then((reach) => {
    if (seq !== reachSeq) return;   // a newer source landed mid-probe
    const ok = src.kind === "local" ? reach.local : reach.cloud;
    // STILL UNKNOWN — the bridge hasn't finished booting. Stay on
    // "Connecting…" and ask again rather than declaring a failure we haven't
    // actually observed.
    // UNKNOWN (bridge still booting) or a FIRST failure — neither is a verdict.
    // A probe fired before the SDK has its token throws once and would
    // otherwise be cached as "unavailable" for the full TTL.
    // On the LANDING the connect must resolve FAST — a long retry window there
    // holds the composer disabled on a source that is probably fine (the cloud
    // probe is known to under-report). A bound session can afford to wait.
    // ~7s of genuine trying before we call it failed. A machine that is waking,
    // a relay reconnecting or an SDK still bootstrapping all answer within
    // that; anything shorter reports a failure the user could have waited out.
    const patience = 8;
    if ((ok === null || ok === false) && attempt < patience) {
      // The SDK client answers calls before its token has finished
      // bootstrapping, so the first second or two of failures are about US not
      // being ready, not about the runtime being down.
      setTimeout(() => settle(attempt + 1), attempt < 4 ? 400 : 1200);
      return;
    }
    chip.classList.remove("cl-runtime-connecting");
    if (ok) {
      // LIVE — the chip goes back to naming the source it connected to.
      chip.classList.remove("cl-runtime-down");
      chip.classList.add("cl-runtime-live");
      sourceChip?.setSource(src);   // back to the bare name
      chip.setAttribute("title", "Where this session runs and what it works on");
      paintComposerReach("live", src);
      return;
    }
    // Only a DEFINITIVE failure earns the red state. `attach.status()` is
    // authoritative — it answers "is a machine attached" and nothing else. A
    // failing sessions.list() is not: it can throw for auth-bootstrap reasons
    // that have nothing to do with the runtime's health, and claiming the
    // cloud is down when it is serving fine is a worse lie than staying quiet.
    if (ok === null) {
      // Never ANSWERED (transport never came up) — that is not a failure we
      // observed, so say nothing rather than accuse a runtime that may be fine.
      chip.classList.remove("cl-runtime-down");
      sourceChip?.setSource(src);
      chip.setAttribute("title", "Where this session runs and what it works on");
      try { console.warn("[source] reachability never confirmed — chip left neutral"); } catch { /* no console */ }
      paintComposerReach("live", src);
      return;
    }
    // FAILED — the source the USER chose could not be reached, and it says so.
    // It is NEVER silently reassigned: switching someone's session to Cloud
    // behind their back moves where their work runs and hides the real
    // problem (an unattached desktop) behind a chip that looks fine.
    chip.classList.add("cl-runtime-down");
    setLabel(src.kind === "local" ? "Machine unavailable" : "Cloud unavailable");
    chip.setAttribute("title", src.kind === "local"
      ? "Couldn't reach your machine — open the Glyphh desktop, or switch to Cloud"
      : "Couldn't reach the cloud runtime — switch to a connected machine");
    paintComposerReach("down", src);
  });
  settle(0);
}

function paintSourceDependents(): void {
  homeChips();
  paintSourceReach();
  const cloud = activeSource().kind !== "local";
  // A CLOUD source has no machine folder to browse and nowhere to put a new
  // one — the folder chip and its + go away entirely rather than sitting there
  // inert.
  const FOLDER_CHIPS = new Set(["dash-wd-btn", "dash-wd-add", "code-workdir-btn", "code-workdir-add"]);
  for (const [id, title] of Object.entries(CHIP_TITLES)) {
    const el2 = document.getElementById(id);
    if (!el2) continue;
    el2.classList.remove("chip-disabled");
    el2.classList.toggle("hidden", cloud && FOLDER_CHIPS.has(id));
    el2.setAttribute("title", title);
  }
  // The source is changeable ONLY on a NEW (unborn) session. Once a session is
  // born (sent — runtime bound) its source is LOCKED: the chip goes static
  // (pointer-events:none) so the picker won't open. A new/unborn session (on
  // Home OR hosted in a layout) keeps the chip live so the source can be set.
  {
    const c2 = current();
    const bornLocked = !!c2 && c2.messages.length > 0
      && !document.body.classList.contains("composer-on-home");
    sourceChip?.el.classList.toggle("cl-chip-static", bornLocked);
  }
  paintGitState();
  // GIT position: local → the passive branch mirror; cloud → the repo chip.
  const mirror = document.getElementById("dash-wd-branch-wrap");
  if (mirror && cloud) (mirror as HTMLElement).style.display = "none";
  gitChip?.refresh();
  // The repo picker chooses what a CLOUD workspace checks out — on a local
  // folder there is nothing for it to pick, and the folder's real git state
  // (branch, or none) is already on the branch chip via paintGitState.
  if (gitChip) gitChip.el.style.display = cloud ? "" : "none";
  // WEB: the folder chip shows the SESSION source's folder (the machine's cwd
  // concept doesn't reach a browser) — Home until a pick lands.
  // The folder chip names the folder the session is IN — the last segment of
  // the picked path, not the root it was browsed from. Painted on BOTH rows and
  // both surfaces from the SOURCE, so a machine's cwd can't overwrite the pick.
  {
    const src = activeSource();
    if (src.kind === "local" && src.path) {
      const leaf = src.path.replace(/\/+$/, "").split("/").filter(Boolean).pop() || src.path;
      for (const id of ["dash-wd-name", "code-workdir-name"]) {
        const nameEl = document.getElementById(id);
        if (nameEl) nameEl.textContent = leaf;
      }
      for (const id of ["dash-wd-btn", "code-workdir-btn"]) {
        document.getElementById(id)?.setAttribute("title", `working directory: ${src.path}`);
      }
    }
  }
}

/** Web target check (the bridge stamps the html class; the global came later). */
function onWebTarget(): boolean {
  return !!(window as unknown as { __GLYPHH_WEB__?: boolean }).__GLYPHH_WEB__
    || document.documentElement.classList.contains("glyphh-web");
}

/** WEB plumbing for the landing's folder + new-folder chips: both open the
 *  MACHINE folder browser over the attach relay (fs.list / fs.mkdir) — the
 *  native OS picker they trigger on desktop cannot exist in a browser. The
 *  pick stamps the SOURCE (session-scoped), never the machine's own cwd. */
function initWebFolderChips(): void {
  if (!onWebTarget()) return;
  const wire = (id: string, open: (anchor: HTMLElement, o: { getSource: typeof activeSource; onPick: typeof pickSource }) => void): void => {
    const chip = document.getElementById(id);
    chip?.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopImmediatePropagation();   // the workbench's native-picker handler must not run
      open(chip, { getSource: activeSource, onPick: pickSource });
    }, true);
  };
  // BOTH rows — the landing's and the agent's. They are the same controls on
  // two surfaces, and the agent view is where a session actually changes its
  // folder mid-flight.
  wire("dash-wd-btn", openMachineFolderBrowser);    // folder chip = the browser
  wire("dash-wd-add", openNewFolderDrop);           // + = new folder ONLY
  wire("code-workdir-btn", openMachineFolderBrowser);
  wire("code-workdir-add", openNewFolderDrop);
}

// ── Composer attachments ─────────────────────────────────────────────────
// Images (pasted screenshots, picked files), files, and folders queue as
// chips and ride the next send. Pasted image DATA saves to the user-scoped
// attachments dir in main; everything else is a path reference.
/**
 * Notes typed while a run is in flight.
 *
 * Enter used to do nothing at all while thinking, so a thought you had mid-run
 * had nowhere to go — you either interrupted the agent or lost it. These queue
 * instead, stay deletable, and go as the next turn when the run ends (whether it
 * finished on its own or you stopped it).
 *
 * Deliberately NOT per-chat: switching sessions mid-run is rare, and a note that
 * follows you is visible and removable, where one pinned to a chat you left is
 * neither.
 */
let pendingNotes: Array<{ id: string; text: string }> = [];

let pendingAttach: AttachRef[] = [];

function attachChipEl(a: AttachRef, onRemove?: () => void): HTMLElement {
  const chip = document.createElement("div");
  chip.className = `code-attach-chip ${a.kind}`;
  chip.title = a.path;
  if (a.kind === "image") {
    const img = document.createElement("img");
    img.src = `file://${encodeURI(a.path)}`;
    img.alt = "";
    // Unloadable thumb (moved file, odd format) degrades to the file glyph.
    img.onerror = () => {
      const ic = document.createElement("span");
      ic.className = "cac-ic";
      ic.innerHTML = FILE_ICON;
      img.replaceWith(ic);
    };
    chip.appendChild(img);
  } else {
    const ic = document.createElement("span");
    ic.className = "cac-ic";
    ic.innerHTML = a.kind === "folder" ? FOLDER_ICON : FILE_ICON;
    chip.appendChild(ic);
  }
  const name = document.createElement("span");
  name.className = "cac-name";
  name.textContent = a.name;
  chip.appendChild(name);
  if (onRemove) {
    const x = document.createElement("button");
    x.className = "cac-x";
    x.type = "button";
    x.textContent = "×";
    x.title = "Remove";
    x.addEventListener("click", (e) => { e.stopPropagation(); onRemove(); });
    chip.appendChild(x);
  }
  return chip;
}

function paintAttachChips(): void {
  const wrap = el<HTMLDivElement>("code-attach-chips");
  if (!wrap) return;
  wrap.hidden = !pendingAttach.length;
  wrap.textContent = "";
  pendingAttach.forEach((a, i) => {
    wrap.appendChild(attachChipEl(a, () => { pendingAttach.splice(i, 1); paintAttachChips(); }));
  });
}

function paintPendingNotes(): void {
  const wrap = el<HTMLDivElement>("code-pending-notes");
  if (!wrap) return;
  wrap.hidden = !pendingNotes.length;
  wrap.textContent = "";
  if (!pendingNotes.length) return;

  const head = document.createElement("div");
  head.className = "cpn-head";
  head.textContent = pendingNotes.length === 1
    ? "1 note waiting — sends when this run ends"
    : `${pendingNotes.length} notes waiting — send when this run ends`;
  wrap.appendChild(head);

  for (const note of pendingNotes) {
    const row = document.createElement("div");
    row.className = "cpn-row";

    const text = document.createElement("div");
    text.className = "cpn-text";
    text.textContent = note.text;
    text.title = note.text;

    const del = document.createElement("button");
    del.className = "cpn-del";
    del.type = "button";
    del.textContent = "×";
    del.title = "Remove this note";
    del.setAttribute("aria-label", `Remove note: ${note.text.slice(0, 60)}`);
    del.addEventListener("click", () => {
      pendingNotes = pendingNotes.filter((n) => n.id !== note.id);
      paintPendingNotes();
    });

    row.append(text, del);
    wrap.appendChild(row);
  }
}

/** Queue what is in the composer as a note. Returns false when there was nothing. */
function queueNote(): boolean {
  const ta = input();
  const text = ta?.value.trim();
  if (!ta || !text) return false;
  pendingNotes.push({ id: `n${Date.now()}${Math.random().toString(36).slice(2, 6)}`, text });
  ta.value = "";
  autoGrow(ta);
  paintPendingNotes();
  return true;
}

/**
 * Send the queued notes as the next turn. Called when a run ends — including
 * when the user stopped it, which is the point: stopping with notes waiting
 * means "enough, here is what I actually want".
 *
 * They go through the composer and the normal send path so a queued note is
 * indistinguishable from a typed one — same title handling, same store write,
 * same run launch.
 */
function flushPendingNotes(): void {
  if (!pendingNotes.length) return;
  const ta = input();
  if (!ta) return;
  const text = pendingNotes.map((n) => n.text).join("\n\n");
  pendingNotes = [];
  paintPendingNotes();
  ta.value = ta.value.trim() ? `${text}\n\n${ta.value.trim()}` : text;
  autoGrow(ta);
  // After the finishRun paint settles, so the new turn lands under the old one.
  setTimeout(() => send(), 0);
}

function queueAttachments(refs: AttachRef[]): void {
  // Same path twice = once (re-dropping a folder shouldn't stack chips).
  for (const r of refs) if (!pendingAttach.some((p) => p.path === r.path)) pendingAttach.push(r);
  paintAttachChips();
}

/** Paste: Finder files carry paths (classify), raw image data (screenshots)
 *  saves through main. Plain-text pastes keep their default behavior. */
async function handleComposerPaste(e: ClipboardEvent): Promise<void> {
  const items = e.clipboardData?.items;
  if (!items) return;
  const files: File[] = [];
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    if (it.kind === "file") { const f = it.getAsFile(); if (f) files.push(f); }
  }
  if (!files.length) return;
  e.preventDefault();
  const paths: string[] = [];
  const refs: AttachRef[] = [];
  for (const f of files) {
    const p = window.glyphh.getPathForFile(f);
    if (p) { paths.push(p); continue; }
    if (!f.type.startsWith("image/")) continue;
    try { refs.push(await window.glyphh.glyphhSaveClipboardImage(await f.arrayBuffer())); }
    catch { /* oversized/empty clipboard image — skip */ }
  }
  if (paths.length) refs.push(...await window.glyphh.glyphhClassifyPaths(paths));
  if (refs.length) queueAttachments(refs);
}

function wireComposerAttachments(): void {
  // The + menu (right of the mode chip) — everything a user ADDS to the
  // session lives here; paste and drag-drop stay as shortcuts.
  const plusWrap = el("code-plus-wrap");
  if (plusWrap) {
    const menu = document.createElement("div");
    menu.id = "code-plus-menu";
    menu.className = "code-drop-up hidden";
    const mkItem = (label: string, hint: string, pick: () => void) => {
      const b = document.createElement("button");
      b.className = "code-drop-item";
      b.type = "button";
      b.title = hint;
      const span = document.createElement("span");
      span.textContent = label;
      b.appendChild(span);
      b.addEventListener("click", () => { menu.classList.add("hidden"); pick(); });
      return b;
    };
    menu.append(
      mkItem("Attach files…", "Images and documents ride the next message", () => {
        void window.glyphh.glyphhPickAttachments("files").then((refs) => { if (refs.length) queueAttachments(refs); });
      }),
      mkItem("Add folder…", "Give Glyphh read access to another directory", () => {
        void window.glyphh.glyphhPickAttachments("folder").then((refs) => { if (refs.length) queueAttachments(refs); });
      }),
    );
    // WORK and CODE run inside a working folder — the + is where you set it,
    // right from the landing or the thread (Chat has no folder concept; CSS
    // hides these under data-session-space="chat").
    const sep = document.createElement("div");
    sep.className = "code-drop-sep plus-folder-only";
    const curItem = mkItem("Working folder", "The folder this session works in", () => {
      void wb()?.pickCwd?.({ nullOnCancel: true }).then(() => checkWorkdirGate());
    });
    curItem.classList.add("plus-folder-only");
    const newItem = mkItem("Choose working folder…", "Pick (or create) the folder to work in", () => {
      void wb()?.pickCwd?.({ nullOnCancel: true }).then(() => checkWorkdirGate());
    });
    newItem.classList.add("plus-folder-only");
    menu.append(sep, curItem, newItem);
    const paintPlusFolder = (): void => {
      void wb()?.getCwdExplicit?.().then((dir) => {
        const name = dir ? String(dir).split("/").filter(Boolean).pop() : null;
        (curItem.querySelector("span") as HTMLElement).textContent = name ? `Working folder: ${name}` : "Working folder: not set";
        curItem.title = dir ? String(dir) : "No folder picked yet — click to choose";
      });
    };
    plusWrap.appendChild(menu);
    el("code-plus-chip")?.addEventListener("click", (e) => {
      e.stopPropagation();
      el("code-mode-menu")?.classList.add("hidden");
      el("code-effort-pop")?.classList.add("hidden");
      el("code-model-menu")?.classList.add("hidden");
      el("code-ctx-pop")?.classList.add("hidden");
      paintPlusFolder();
      menu.classList.toggle("hidden");
    });
  }
  input()?.addEventListener("paste", (e) => { void handleComposerPaste(e); });
  const comp = document.querySelector<HTMLElement>(".code-composer");
  if (!comp) return;
  comp.addEventListener("dragover", (e) => { e.preventDefault(); comp.classList.add("dropping"); });
  comp.addEventListener("dragleave", (e) => {
    if (!comp.contains(e.relatedTarget as Node)) comp.classList.remove("dropping");
  });
  comp.addEventListener("drop", (e) => {
    e.preventDefault();
    comp.classList.remove("dropping");
    const paths = Array.from(e.dataTransfer?.files ?? []).map((f) => window.glyphh.getPathForFile(f)).filter(Boolean);
    if (!paths.length) return;
    void window.glyphh.glyphhClassifyPaths(paths).then((refs) => { if (refs.length) queueAttachments(refs); });
  });
}

/**
 * Keep the window's drag strip clear of the chrome cluster.
 *
 * The strip is `-webkit-app-region: drag`, and a button underneath a drag region
 * stops receiving clicks — Electron hands the whole area to the window manager.
 * The offset used to be a hardcoded 176px, which was exactly the cluster's width
 * until the Reset button was added: the launcher then sat 184–210px, entirely
 * inside the strip, and went dead while Reset (ending at 176) still worked.
 *
 * Measuring instead of hardcoding means the next button added cannot repeat it.
 */
function syncDragStripOffset(): void {
  const cluster = document.getElementById("panel-wc");
  const strip = document.querySelector<HTMLElement>(".app-rail-top");
  if (!cluster || !strip) return;
  const apply = (): void => {
    const w = cluster.getBoundingClientRect().width;
    // Hidden (a locked single-section panel) → leave the CSS default alone.
    if (w > 0) strip.style.marginLeft = `${Math.ceil(w) + 8}px`;
  };
  apply();
  // Buttons appear and hide with mode (rail toggle, locked panels), so track it.
  new ResizeObserver(apply).observe(cluster);
}

// ── Composer ─────────────────────────────────────────────────────────────
function autoGrow(ta: HTMLTextAreaElement): void {
  // Grow with input up to ~10 lines, then scroll internally. Skip while the
  // textarea has no real width (the agent card mid-entrance): scrollHeight
  // wraps into a tower and the height sticks tall after the card widens.
  if (ta.clientWidth < 60) return;
  ta.style.height = "auto";
  ta.style.height = Math.min(ta.scrollHeight, 220) + "px";
}
/** Recompute the composer height whenever its WIDTH changes — card
 *  entrances, adoptions, and layout switches all resize it after the last
 *  input event, and a height measured at the wrong width must not stick. */
let composerRO: ResizeObserver | null = null;
function watchComposerWidth(ta: HTMLTextAreaElement): void {
  if (composerRO) return;
  let lastW = ta.clientWidth;
  composerRO = new ResizeObserver(() => {
    if (ta.clientWidth !== lastW) { lastW = ta.clientWidth; autoGrow(ta); }
  });
  composerRO.observe(ta);
}

function setThinking(on: boolean): void {
  thinking = on;
  if (!on) { spinner?.destroy(); spinner = null; }
  const send = el("code-send");
  send?.classList.toggle("thinking", on);
  if (send) send.title = on ? "Stop" : "Send";
  renderHistory(); // the panel header tracks the loop state
}

/** `thinking` is VIEW state: whether the CURRENT chat is running. Re-derive
 *  on session switches so each session shows its own spinner and composer. */
function syncThinking(): void {
  setThinking(!!currentRun());
}

function stopThinking(): void {
  // Abort the CURRENT chat's stream — main answers with glyphh-agent:done
  // { stopped: true } for that run; other sessions keep working.
  void window.glyphh.glyphhStop?.(currentId);
  // A REMOTE (web/cloud) turn has no main-side run — abort its own signal, which
  // fires runRemoteTurn's onStopped → finishRun(stopped) for this chat.
  remoteAborters.get(currentId)?.abort();
}

/** `.dip <app-or-layout>` — the ONE mechanism, callable from any input in the
 *  app: layouts run the exact function a layout click in the launcher runs
 *  (`__wbOpenLayoutByName` → the switcher's `openLayoutRow` → grid open);
 *  apps fall back to the app card's resolver (appLaunch). Nothing else. */
/** Flip to the working surface WITHOUT injecting the agent panel — the
 *  neutral pre-open used by .dip, app commands, and layout opens (their
 *  panels define the view). */
export function showWorkspaceSurface(): void {
  const w = window as unknown as { __initCodeWorkbench?: () => void; __wbOpenSection?: (s: string) => void };
  w.__initCodeWorkbench?.();
  let tries = 0;
  const go = (): void => {
    if (w.__wbOpenSection) w.__wbOpenSection("workspace");
    else if (tries++ < 40) requestAnimationFrame(go);
  };
  go();
}

export function runDip(ref: string): void {
  showWorkspaceSurface();
  const w = window as unknown as {
    __initCodeWorkbench?: () => void;
    __wbOpenLayoutByName?: (name: string) => Promise<boolean>;
    __wbClearPanels?: () => void;
    __wbGridPanels?: () => boolean;
  };
  w.__initCodeWorkbench?.();
  void (async () => {
    // The workbench boots async — wait for the hook like the launcher does.
    for (let i = 0; i < 40 && !w.__wbOpenLayoutByName; i++) {
      await new Promise((r) => requestAnimationFrame(r));
    }
    // Workbench verbs come before name lookup — `clear` closes every panel,
    // `grid` re-flows the open ones into an even grid.
    const verb = ref.toLowerCase();
    if (verb === "clear") { w.__wbClearPanels?.(); return; }
    if (verb === "grid") { w.__wbGridPanels?.(); return; }
    // A layouts-list failure (offline, server hiccup) must not kill the
    // whole .dip — fall through to the app path.
    if (await w.__wbOpenLayoutByName?.(ref).catch(() => false)) return;
    const yo2 = window.glyphh as unknown as { appLaunch?: (s: { slug: string; name: string }) => Promise<{ ok: boolean; error?: string }> };
    const asApp = await yo2.appLaunch?.({ slug: ref, name: ref }).catch(() => ({ ok: false }) as { ok: boolean; error?: string });
    if (asApp?.ok) return;
    if (!current()) newChat();
    // Name the layouts the resolver actually sees — "not found" with no
    // context turns into a support question; this answers it in place.
    const known = await window.glyphh.layoutsList?.().then((ls) => ls.map((l) => l.name)).catch(() => [] as string[]);
    const hint = known?.length ? ` Layouts: ${known.join(", ")}.` : "";
    current()!.messages.push({
      role: "assistant",
      text: `⚠ .dip: ${asApp?.error || `no app or layout named "${ref}"`}.${hint}`,
      at: Date.now(),
    });
    void saveStore(); renderHistory(); renderThread();
  })();
}

/** `.dip` / `.drip` work from ANY input or textarea in the app — same
 *  handlers the composer uses, wired once at startup (capture phase, so it
 *  runs before any field's own Enter handling). The composer is excluded:
 *  its send() path already routes both. */
export function wireGlobalDotCommands(): void {
  document.addEventListener("keydown", (ev) => {
    if (ev.key !== "Enter" || ev.isComposing) return;
    const t = ev.target;
    if (!(t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement)) return;
    if (t.id === "code-input") return;
    const v = t.value.trim();
    const dip = /^\.dip\s+(.+)$/i.exec(v);
    const drip = dip ? null : /^\.drip(?:\s+(.+))?$/i.exec(v);
    if (!dip && !drip) return;
    ev.preventDefault();
    ev.stopPropagation();
    t.value = "";
    t.dispatchEvent(new Event("input", { bubbles: true }));
    if (dip) runDip(dip[1].trim());
    else void (window.glyphh as unknown as { dripsPreview?: (r: string) => Promise<string> }).dripsPreview?.((drip![1] || "fireworks").trim());
  }, true);
}

function send(): void {
  // While thinking the same control is the stop button.
  if (thinking) { stopThinking(); return; }
  const ta = input();
  if (!ta) return;
  const text = ta.value.trim();
  if (!text && !pendingAttach.length) return;
  // Sending from the HOME-adopted composer: the footer goes back to the
  // agent and the chat opens alone — the stream lands where the user is.
  if (document.body.classList.contains("composer-on-home")) {
    adoptComposer(null);
    gotoSection("agent");
  }
  // Dot-commands (.dip slack, .drip rain, …) run through the command parser —
  // the composer doubles as the command input.
  // `.compact [focus]` → fold the session's older turns now, optionally
  // steering what the summary must keep.
  const comp = /^\.compact(?:\s+(.+))?$/is.exec(text);
  if (comp) {
    if (!current()) newChat();
    const cc = current()!;
    cc.messages.push({ role: "user", text, at: Date.now() });
    ta.value = "";
    autoGrow(ta);
    void saveStore();
    renderHistory();
    renderThread();
    void runManualCompact((comp[1] || "").trim());
    return;
  }
  // `.remember <fact>` → Glyphh's persistent memory (memory.md), loaded
  // into every session's prompt prefix.
  const rem = /^\.remember\s+(.+)/is.exec(text);
  if (rem) {
    if (!current()) newChat();
    const cc = current()!;
    cc.messages.push({ role: "user", text, at: Date.now() });
    ta.value = "";
    autoGrow(ta);
    void window.glyphh.glyphhRemember?.(rem[1].trim())
      .then(() => cc.messages.push({ role: "assistant", text: "✓ Remembered — it rides along in every session now.", at: Date.now() }))
      .catch((err) => cc.messages.push({ role: "assistant", text: `⚠ ${err instanceof Error ? err.message : String(err)}`, at: Date.now() }))
      .then(() => { void saveStore(); renderHistory(); renderThread(); });
    return;
  }
  // `.drip <effect>` → play a drip effect (server-backed engine). Not the agent.
  const drip = /^\.drip(?:\s+(.+))?$/is.exec(text);
  if (drip) {
    ta.value = "";
    autoGrow(ta);
    void (window.glyphh as unknown as { dripsPreview?: (r: string) => Promise<string> })
      .dripsPreview?.((drip[1] || "fireworks").trim());
    return;
  }
  // `.dip <app-or-layout>` → THE SWITCHER'S OWN function, not a lookalike.
  const dip = /^\.dip\s+(.+)$/is.exec(text);
  if (dip) {
    ta.value = "";
    autoGrow(ta);
    runDip(dip[1].trim());
    return;
  }

  if (text.startsWith(".") && text.length > 1) {
    if (!current()) newChat();
    const cc = current()!;
    cc.messages.push({ role: "user", text, at: Date.now() });
    if (cc.title === "New session") cc.title = text.length > 42 ? text.slice(0, 42) + "…" : text;
    ta.value = "";
    autoGrow(ta);
    void window.glyphh.execCommand(text.slice(1).trim());
    cc.messages.push({ role: "assistant", text: `→ ran ${text}`, at: Date.now() });
    void saveStore();
    renderHistory();
    renderThread();
    return;
  }
  if (!current()) newChat();
  const c = current()!;
  const attachments = pendingAttach.slice();
  pendingAttach = [];
  paintAttachChips();
  c.messages.push({ role: "user", text, at: Date.now(), ...(attachments.length ? { attachments } : {}) });
  if (c.title === "New session") {
    const t = text || attachments.map((a) => a.name).join(", ");
    c.title = t.length > 42 ? t.slice(0, 42) + "…" : t;
  }
  ta.value = "";
  autoGrow(ta);
  void saveStore();
  // Sending re-engages following: the user's own turn always comes into view.
  pinThreadToBottom();
  // Working state first so the spinner row + rail dot paint immediately.
  // If we were merely OBSERVING this thread's run from another surface, this send
  // takes it over locally — drop the observer so the two don't drive one liveRun.
  stopObserving(c.id);
  liveRuns.set(c.id, {
    runId: null, text: "", bubble: null, startAt: Date.now(),
    inTok: 0, outTok: 0, creditsMicro: 0, steps: [], setupMeta: "",
  });
  ensureRunTicker();
  broadcastTimeline(true);
  setThinking(true);
  renderHistory();
  renderThread();
  refreshCtxMeter();
  // Main assembles the prompt from the store — the save must land first.
  // A session must run inside a folder the user chose: the first send on a
  // fresh setup pops the OS folder picker, then the run proceeds.
  // The workspace SOURCE rides the run: a LOCAL source targets its folder (also
  // the workdir); a CLOUD source (new project / repo) tells main to provision a
  // remote runtime. main reads what it supports and ignores the rest (older
  // builds just run local, as before).
  const src = c.source ?? pendingSource;
  // A REMOTE source on WEB (cloud-new / cloud-repo, window.glyphhSdk present) can't
  // ride the local harness (main's glyphhRun) — it PROVISIONS + STREAMS a Fly
  // runtime through the SDK. Desktop-local and the honest-state fallback keep the
  // glyphhRun path below.
  // WEB = the SHARED CLOUD ROTOR, period (Chris, convergence pass): every
  // tool-bearing web turn rides the remote transport — a machine-sourced
  // session on web previously fell into the local runner, whose web stub
  // resolves undefined ("Cannot read properties of undefined (reading
  // 'runId')"). Driving the attached machine from web is deferred.
  // WEB = the shared cloud rotor for EVERY space, chat included. Excluding chat
  // sent those turns to window.glyphh.glyphhRun — a method the web bridge does
  // not implement — so a Chat turn spun forever with no answer and no error
  // (Work and Code worked, which is exactly why it hid). The pod runs chat as a
  // tool-less completion, the same shape the desktop's chatRun produced.
  const webAlwaysRemote = onWebTarget() && !!(window as unknown as { glyphhSdk?: { sessions?: { create?: unknown } } }).glyphhSdk?.sessions?.create;
  if (canRunRemote(src) || webAlwaysRemote) { void saveStore().then(() => launchRemote(c, text, src ?? { kind: "cloud-new" })); return; }
  const launch = (retried: boolean): Promise<void> =>
    window.glyphh.glyphhRun({ chatId: c.id, attachments, ...(c.workdir ? { workdir: c.workdir } : {}), mode: modeOf(c), ...(src ? { source: src } : {}) })
      .then((r) => { const run = liveRuns.get(c.id); if (run && !run.runId) run.runId = r?.runId ?? `r-local-${c.id}`; })
      .catch(async (err) => {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes("NO_WORKDIR") && !retried) {
          await (window as unknown as { wb?: { pickCwd?: () => Promise<string | null> } }).wb?.pickCwd?.();
          return launch(true);
        }
        if (msg.includes("NO_WORKDIR")) {
          finishRun(c.id, "⚠ Pick a working folder to start — Glyphh works inside the folder you choose (folder button at the top of this pane).");
          return;
        }
        finishRun(c.id, `⚠ ${msg}`);
      });
  void saveStore().then(() => launch(false));
}

// ── Remote (web/cloud) run path ───────────────────────────────────────────────
// One AbortController per live remote run, keyed by chat id — stopThinking()
// aborts the CURRENT chat's turn (the turn's own AbortSignal), other sessions
// keep streaming. The runtime binding lives on the chat record (remote-run.ts
// provisions once, reuses it for later turns), persisted via saveStore.
const remoteAborters = new Map<string, AbortController>();

/** Provision (or reuse) a Fly runtime for this chat's remote source and stream
 *  the turn through it, driving the SAME liveRuns entry the local path uses so
 *  the thread renders identically. Any unavailable stage lands the app's honest
 *  "runtime not connected" state — never a fake reply. */
function launchRemote(c: CodeChat, prompt: string, src: Source): void {
  const chatId = c.id;
  const ac = new AbortController();
  remoteAborters.set(chatId, ac);
  const bindSave = (): void => { void saveStore(); };
  // A synthetic run id so runEntry()/liveRuns bookkeeping stays consistent with
  // the local path (there's no main-side ack to stamp one here).
  const run = liveRuns.get(chatId);
  if (run && !run.runId) run.runId = `r-remote-${chatId}`;

  const pushStep = (label: string): void => {
    const chat = chats.find((ch) => ch.id === chatId);
    const r = liveRuns.get(chatId);
    if (!chat || !r) return;
    // Commit streamed text before the breadcrumb, then start a fresh block —
    // text → step → text flows DOWN the page (same order the local path keeps).
    if (r.text.trim()) { chat.messages.push({ role: "assistant", text: r.text, at: Date.now() }); r.text = ""; r.bubble = null; }
    r.steps.push(label);
    chat.messages.push({ role: "assistant", kind: "tool", text: label, at: Date.now() });
    void saveStore();
    if (chatId === currentId) { broadcastTimeline(true); renderThread(); }
  };

  void runRemoteTurn(
    c as unknown as RemoteChat,
    prompt,
    bindSave,
    {
      onStep: (step) => {
        const r = liveRuns.get(chatId);
        if (!r) return;
        // Match the LOCAL path's grammar exactly (✓ done / ✕ denied-or-failed /
        // ⚙ started) — remote breadcrumbs were rendering every outcome as ⚙,
        // so a denial read like a tool that was merely starting.
        const bad = step.status === "denied" || step.status === "failed" || !!step.error;
        const glyph = bad ? "✕" : step.status ? "✓" : "⚙";
        const detail = step.error || (step.status && step.status !== "ok" ? step.status : "");
        pushStep(`${glyph} ${step.type}${detail ? ` — ${detail}` : ""}`);
      },
      onToken: (delta) => {
        const r = liveRuns.get(chatId);
        if (!r) return;
        r.text += delta;
        queueStreamPaint(chatId);
      },
      // A parked pod frame lands in the SAME ask dock a local run uses — the
      // card is answered through respondToDock, which routes back to this run's
      // handle via remote-run's pending registry. runId is the SYNTHETIC one
      // liveRuns carries, so finishRun clears this run's cards (and only those).
      onApproval: (a) => {
        askQueue.push({ type: "approval", id: a.id, kind: a.kind, title: a.title, detail: a.detail, runId: liveRuns.get(chatId)?.runId ?? undefined, chatId, deadline: a.deadline });
        paintAskDock();
      },
      onAsk: (a) => {
        askQueue.push({ type: "ask", id: a.id, questions: a.questions, answers: [], step: 0, runId: liveRuns.get(chatId)?.runId ?? undefined, chatId, deadline: a.deadline });
        paintAskDock();
      },
      onDone: (text) => { finishRun(chatId, text); },
      onStopped: () => { finishRun(chatId, liveRuns.get(chatId)?.text || "", true); },
      onError: (detail) => {
        const r = liveRuns.get(chatId);
        const prefix = r?.text ? `${r.text}\n\n` : "";
        finishRun(chatId, `${prefix}⚠ ${detail}`);
      },
    },
    // No model override — the loop resolves its own model server-side (matches
    // the local path, where main resolves the loop's roles). The permission mode
    // DOES ride the turn: the pod's own default is `auto`, so without it a
    // session left in Ask mode would run unattended.
    { rotor: glyphhLoop, permission: glyphhMode, signal: ac.signal },
  ).then((outcome) => {
    remoteAborters.delete(chatId);
    // An UNAVAILABLE stage is the honest "runtime not connected" state: the
    // runtime for the org's region isn't deployed/routed yet. Render the
    // designed message, never a fake reply. onError already committed for the
    // { error } case; only unavailable needs its own copy here.
    if ("unavailable" in outcome && outcome.unavailable && !liveRuns.get(chatId)?.text) {
      // SELF-DIAGNOSE: probe the runtime we just failed to reach and say WHICH
      // layer broke — reachable/unreachable, and whether it's a CORS block (a
      // browser reports those as an opaque network error, which is why "POST
      // /run failed" told nobody anything).
      const rtUrl = (c as { runtime?: { url?: string } }).runtime?.url;
      void probeRuntime(rtUrl).then((probe) => {
        finishRun(chatId, remoteUnavailableMessage(outcome.stage, outcome.detail, rtUrl, probe));
      });
    } else if (liveRuns.has(chatId)) {
      // A callback path we didn't already finish (defensive) — land whatever text exists.
      finishRun(chatId, liveRuns.get(chatId)?.text || "");
    }
  }).catch((err) => {
    remoteAborters.delete(chatId);
    if (liveRuns.has(chatId)) finishRun(chatId, `⚠ ${err instanceof Error ? err.message : String(err)}`);
  });
}

/** The app's honest not-connected copy for a remote turn that couldn't reach a
 *  live runtime. The session EXISTS server-side (remote-run bound its id); a
 *  runtime just isn't deployed + routed for the org's region yet. */
/** Probe the runtime the turn couldn't use: reachable? CORS-blocked? down?
 *  Runs only on the failure path, bounded, never throws. */
async function probeRuntime(url?: string): Promise<string> {
  if (!url) return "";
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 4000);
    try {
      const res = await fetch(`${url.replace(/\/$/, "")}/healthz`, { signal: ctl.signal });
      return res.ok ? "the runtime IS reachable from this browser — the failure is auth or capacity, not the network"
        : `the runtime answered ${res.status} on /healthz`;
    } finally { clearTimeout(t); }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return /abort/i.test(msg)
      ? "the runtime did not answer within 4s (down, or blocked before it could reply)"
      : `this browser could not reach the runtime at all (${msg}) — a blocked cross-origin request or nothing listening`;
  }
}

function remoteUnavailableMessage(stage: string, detail: string, runtimeUrl?: string, probe?: string): string {
  const why =
    stage === "provision" || stage === "provision-poll" ? "the cloud runtime couldn't be provisioned"
    : stage === "not-ready" ? "the cloud runtime didn't come up in time"
    : stage === "open" || stage === "stream" ? "the cloud runtime is unreachable from here"
    : "the cloud runtime isn't connected";
  // NAME THE ENDPOINT. The old copy blamed "your org's region" for every
  // failure, which is useless when the real cause is which SERVER this build
  // talks to (a control plane without the harness routes provisions a runtime
  // nothing can run on). Stage + address turns a mystery into a diagnosis.
  const api = (window as unknown as { __GLYPHH_API_URL__?: string; glyphh?: { serverUrl?: string } });
  const server = api.__GLYPHH_API_URL__ || api.glyphh?.serverUrl || "";
  const where = [server && `control plane ${server}`, runtimeUrl && `runtime ${runtimeUrl}`]
    .filter(Boolean).join(" · ");
  return `⚠ Cloud runtime not connected — ${why} (at ${stage}).${where ? ` ${where}.` : ""}${probe ? ` Diagnosis: ${probe}.` : ""} (${detail})`;
}

// Stopping isn't failure — it's a choice. All peace, no violence.
const STOP_LINES = [
  "You paused the vibe — Glyphh set its tools down gently.",
  "Peace restored. Everything finished so far stays yours.",
  "The loop rests — happy to pick this back up whenever.",
  "Gently stopped. Glyphh tucked the work away, mid-glyph.",
  "You called it — Glyphh bowed out with grace.",
  "Stillness. The trail so far is saved.",
];

/** Land a run's outcome in ITS chat (the user may be looking at another
 *  session) and reset only that run's state — other sessions keep working. */
function finishRun(chatId: string, text: string, stopped = false): void {
  const run = liveRuns.get(chatId);
  const chat = chats.find((ch) => ch.id === chatId);
  if (chat && text) chat.messages.push({ role: "assistant", text, at: Date.now() });
  if (chat && stopped) {
    chat.messages.push({
      role: "assistant",
      kind: "tool",
      text: `☮ ${STOP_LINES[Math.floor(Math.random() * STOP_LINES.length)]}`,
      at: Date.now(),
    });
  }
  void saveStore();
  liveRuns.delete(chatId);
  // This run's pending cards vanish; other runs' stay queued. (paintAskDock
  // restarts the countdown for whatever card is now on top, or stops it.)
  if (run?.runId) askQueue = askQueue.filter((q) => q.runId !== run.runId);
  paintAskDock();
  stopRunTickerIfIdle();
  renderHistory();   // the panel header goes idle even for a background session
  if (chatId === currentId) {
    broadcastTimeline(false);
    setThinking(false);
    renderThread();
    refreshCtxMeter();
    // Anything typed while this run was in flight goes now, as its own turn.
    flushPendingNotes();
  }
}

// ── Ask dock — approvals + agent questions above the composer ─────────────
//
// One card at a time; a queue counter ("1 of 3") shows what's stacked and a
// step chip ("Step 1 of 2") walks multi-question asks. Every question keeps
// a free-text answer available — options are shortcuts, never a cage.

function askDockShift(): void {
  askQueue.shift();
  paintAskDock();
}

/**
 * Answer the dock's card — the ONE call both sources go through.
 *
 * remote-run holds the parked ids it streamed, so it answers a REMOTE card on
 * its own run handle; an id it doesn't know is a LOCAL card and goes over the
 * desktop IPC exactly as before. The dock's buttons never branch on source.
 *
 * A `late` routing means the runtime's own deadline beat the click — the pod
 * already denied/answered and there is nothing left to resolve. That is not an
 * error: it's swallowed and noted in the session so the transcript stays honest.
 */
function respondToDock(item: AskDockItem, reply: { allow?: boolean; answers?: string[] }): void {
  void answerPending(item.id, reply).then((routing) => {
    if (routing === "unknown") {
      if (reply.answers) void window.glyphh.glyphhAskRespond?.(item.id, reply.answers);
      else void window.glyphh.glyphhApprovalRespond?.(item.id, !!reply.allow);
      return;
    }
    if (routing === "late") {
      pushDockNote(item.chatId, item.type === "approval"
        ? "⏳ That answer arrived after the runtime's deadline — it had already denied the action."
        : "⏳ That answer arrived after the runtime's deadline — Glyphh had already carried on without one.");
    }
  });
}

/** Land a quiet breadcrumb in a session's transcript (used for late answers and
 *  gate timeouts). Falls back to the session in view when the card carried none. */
function pushDockNote(chatId: string | undefined, text: string): void {
  const chat = chats.find((c) => c.id === chatId) ?? chats.find((c) => c.id === currentId);
  if (!chat) return;
  chat.messages.push({ role: "assistant", kind: "tool", text, at: Date.now() });
  void saveStore();
  if (chat.id === currentId) renderThread();
}

// The dock's countdown ticks once a second while a card with a deadline is up.
// Both gates decide FOR the user when it runs out (approval → denied, ask →
// answered empty), so the card says so rather than sitting there implying the
// run waits forever.
let dockTicker: number | null = null;

function stopDockTicker(): void {
  if (dockTicker !== null) { clearInterval(dockTicker); dockTicker = null; }
}

const mmss = (ms: number): string => {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

/** The quiet "it decides on its own" line + its live countdown. Returns the
 *  element, and drives expiry: at the deadline the actions go dead (the gate
 *  has already ruled) and the card clears itself a beat later. */
function dockTimeoutNote(item: AskDockItem, actions: HTMLElement): HTMLElement {
  const note = document.createElement("div");
  note.className = "cad-timeout";
  const deadline = item.deadline;
  if (!deadline) { note.hidden = true; return note; }
  let expired = false;
  const tick = (): void => {
    const left = deadline - Date.now();
    if (left > 0) {
      note.textContent = item.type === "approval"
        ? `Denied automatically in ${mmss(left)} if you don't answer.`
        : `Glyphh carries on without an answer in ${mmss(left)}.`;
      return;
    }
    if (expired) return;
    expired = true;
    stopDockTicker();
    note.textContent = item.type === "approval"
      ? "Timed out — the runtime denied this on its own."
      : "Timed out — Glyphh carried on without an answer.";
    actions.querySelectorAll("button").forEach((b) => { b.disabled = true; });
    // Let the user read the outcome, then clear the card — the run has moved on
    // (a denied tool leaves its own ✕ breadcrumb in the thread).
    setTimeout(() => { if (askQueue[0] === item) askDockShift(); }, 2500);
  };
  tick();
  stopDockTicker();
  dockTicker = setInterval(tick, 1000) as unknown as number;
  return note;
}

function dockHead(label: string, tone: string, item: AskDockItem): HTMLElement {
  const head = document.createElement("div");
  head.className = "cad-head";
  const chip = document.createElement("span");
  chip.className = `cad-kind ${tone}`;
  chip.textContent = label;
  head.appendChild(chip);
  if (item.type === "ask" && item.questions.length > 1) {
    const step = document.createElement("span");
    step.className = "cad-step";
    step.textContent = `Step ${item.step + 1} of ${item.questions.length}`;
    head.appendChild(step);
  }
  if (askQueue.length > 1) {
    const count = document.createElement("span");
    count.className = "cad-count";
    count.textContent = `1 of ${askQueue.length} waiting`;
    head.appendChild(count);
  }
  return head;
}

function paintAskDock(): void {
  const dock = el<HTMLDivElement>("code-ask-dock");
  if (!dock) return;
  const item = askQueue[0];
  dock.hidden = !item;
  dock.textContent = "";
  stopDockTicker();
  if (!item) return;

  if (item.type === "approval") {
    // Human labels — a raw kind ("dangerous") says the class, not the ask.
    const KIND_LABEL: Record<string, string> = {
      dangerous: "Dangerous — needs your OK",
      command: "Run a command",
      edit: "Make a change",
      network: "Network access",
      read: "Read",
    };
    dock.appendChild(dockHead(KIND_LABEL[item.kind] ?? item.kind, "warn", item));
    const title = document.createElement("div");
    title.className = "cad-title";
    title.textContent = item.title;
    dock.appendChild(title);
    if (item.kind === "dangerous" && !item.detail) {
      const why = document.createElement("div");
      why.className = "cad-why";
      why.textContent = "Outside auto mode's safe bounds — these always ask.";
      dock.appendChild(why);
    }
    if (item.detail) {
      const det = document.createElement("pre");
      det.className = "cad-detail";
      det.textContent = item.detail;
      dock.appendChild(det);
    }
    const actions = document.createElement("div");
    actions.className = "cad-actions";
    const mk = (label: string, allow: boolean, cls: string) => {
      const b = document.createElement("button");
      b.className = `action-btn ${cls}`;
      b.textContent = label;
      b.addEventListener("click", () => {
        respondToDock(item, { allow });
        askDockShift();
      });
      return b;
    };
    actions.append(mk("Deny", false, "secondary"), mk("Approve", true, "primary"));
    dock.appendChild(actions);
    dock.appendChild(dockTimeoutNote(item, actions));
    return;
  }

  // Agent question — options as one-click answers plus a custom input.
  const q = item.questions[item.step];
  dock.appendChild(dockHead("Glyphh asks", "ask", item));
  const title = document.createElement("div");
  title.className = "cad-title";
  title.textContent = q.question;
  dock.appendChild(title);
  const answer = (value: string) => {
    item.answers[item.step] = value;
    item.step += 1;
    if (item.step >= item.questions.length) {
      respondToDock(item, { answers: item.questions.map((_x, i) => item.answers[i] ?? "") });
      askDockShift();
    } else {
      paintAskDock();
    }
  };
  if (q.options?.length) {
    const opts = document.createElement("div");
    opts.className = "cad-options";
    for (const o of q.options) {
      const b = document.createElement("button");
      b.className = "cad-option";
      b.type = "button";
      b.textContent = o;
      b.addEventListener("click", () => answer(o));
      opts.appendChild(b);
    }
    dock.appendChild(opts);
  }
  const custom = document.createElement("div");
  custom.className = "cad-custom";
  const inp = document.createElement("input");
  inp.type = "text";
  inp.placeholder = q.options?.length ? "Or type your own answer…" : "Type your answer…";
  inp.spellcheck = false;
  const sendBtn = document.createElement("button");
  sendBtn.className = "action-btn primary";
  sendBtn.type = "button";
  sendBtn.textContent = "Answer";
  const submitCustom = () => { if (inp.value.trim()) answer(inp.value.trim()); };
  sendBtn.addEventListener("click", submitCustom);
  inp.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); submitCustom(); } });
  const skip = document.createElement("button");
  skip.className = "cad-skip";
  skip.type = "button";
  skip.textContent = "Skip";
  skip.title = "Answer nothing — Glyphh proceeds on its best judgment";
  skip.addEventListener("click", () => answer(""));
  custom.append(inp, sendBtn, skip);
  dock.appendChild(custom);
  dock.appendChild(dockTimeoutNote(item, custom));
  if (!q.options?.length) inp.focus();
}

/** Wire the stream events once — deltas paint the live bubble (or just
 *  accumulate when another session is in view). */
function initGlyphhAgentEvents(): void {
  window.glyphh.onGlyphhAgentSetup?.((d) => {
    if (d.phase === "downloading") {
      for (const r of liveRuns.values()) r.setupMeta = `Downloading ${d.model || "Glyphh"} — ${d.pct ?? 0}%${d.totalGB ? ` (${d.receivedGB ?? 0}/${d.totalGB}GB)` : ""}`;
    } else if (d.phase === "manifest") {
      for (const r of liveRuns.values()) r.setupMeta = "Fetching model manifest…";
    } else if (d.phase === "building") {
      for (const r of liveRuns.values()) r.setupMeta = String((d as { text?: string }).text || "");
    } else if (d.phase === "preview") {
      const { html, label } = d as { html?: string; label?: string };
      if (html) {
        const stub = `<script>window.glyphh={call:async()=>({ok:false,error:"preview"}),app:{slug:"preview"}};</script>`;
        const doc = html.includes("<head>") ? html.replace("<head>", `<head>${stub}`) : stub + html;
        (window as unknown as { __wbPreviewHtml?: (h: string, l?: string) => void }).__wbPreviewHtml?.(doc, label);
      }
    } else {
      for (const r of liveRuns.values()) r.setupMeta = "";
    }
    paintRunMeta();
  });
  window.glyphh.onGlyphhAgentCredits?.((d) => {
    const e = runEntry(d.runId);
    if (!e) return;
    e[1].creditsMicro = d.creditsMicro;
    if (e[0] === currentId) paintRunMeta();
  });
  window.glyphh.onGlyphhAgentProgress?.((d) => {
    const e = runEntry(d.runId);
    if (!e) return;
    e[1].inTok = d.inTokens;
    e[1].outTok = d.outTokens;
    if (e[0] === currentId) paintRunMeta();
  });
  // A LOCAL gate parks in main with the same deadlines the pod uses
  // (glyphh-agent-permissions.ts), so the card counts down identically.
  // A LOCAL gate parks in main with the same deadlines the pod uses
  // (glyphh-agent-permissions.ts), so the card counts down identically.
  window.glyphh.onGlyphhAgentApproval?.((a) => {
    askQueue.push({ type: "approval", ...a, deadline: Date.now() + APPROVAL_TIMEOUT_MS });
    paintAskDock();
  });
  window.glyphh.onGlyphhAgentAsk?.((d) => {
    askQueue.push({ type: "ask", id: d.id, questions: d.questions, answers: [], step: 0, runId: (d as { runId?: string }).runId, deadline: Date.now() + ASK_TIMEOUT_MS });
    paintAskDock();
  });
  // Agent-loop activity → compact breadcrumb rows in the thread (persisted,
  // so a re-render or restart keeps the run's story).
  window.glyphh.onGlyphhAgentTool?.((d) => {
    const e = runEntry(d.runId);
    if (!e) return;
    const [runChatId, run] = e;
    const chat = chats.find((ch) => ch.id === runChatId);
    if (!chat) return;
    if (d.phase === "start") run.steps.push(`⚙ ${d.name}${d.thought ? ` — ${d.thought}` : ""}`);
    else if (d.phase === "done" && run.steps.length) {
      run.steps[run.steps.length - 1] = `${d.denied || d.failed ? "✕" : "✓"} ${d.title || d.name}`;
    }
    if (runChatId === currentId) broadcastTimeline(true);
    if (d.phase === "start") {
      // COMMIT the text streamed so far before appending the tool row, and
      // start a fresh live block after it. Without this the live bubble stays
      // pinned at the bottom while tool rows insert above it — the run reads
      // as spooling upward and "stuck" even though it is advancing. The real
      // order is text → tool → more text, flowing DOWN the page.
      if (run.text.trim()) {
        chat.messages.push({ role: "assistant", text: run.text, at: Date.now() });
        run.text = "";
        run.bubble = null;
      }
      chat.messages.push({ role: "assistant", kind: "tool", text: `⚙ ${d.name}${d.thought ? ` — ${d.thought}` : ""}`, at: Date.now() });
    } else if (d.phase === "done") {
      const bad = d.denied || d.failed;
      // Failures surface the tool's own first line — the model can gloss,
      // the breadcrumb doesn't. Successful edits keep their "+N -M" diff badge.
      const reason = d.denied ? " — denied" : d.failed ? ` — ${String(d.preview || "").split("\n")[0].slice(0, 90)}` : "";
      const diff = !bad ? (/\[\+\d+ -\d+\]/.exec(String(d.preview || ""))?.[0] ?? "") : "";
      const text = `${bad ? "✕" : "✓"} ${d.title || d.name}${reason}${diff ? ` ${diff}` : ""}`;
      const last = chat.messages[chat.messages.length - 1];
      if (last?.kind === "tool" && last.text.startsWith(`⚙ ${d.name}`)) last.text = text;
      else chat.messages.push({ role: "assistant", kind: "tool", text, at: Date.now() });
    }
    void saveStore();
    if (currentId === runChatId) renderThread();
  });
  window.glyphh.onGlyphhAgentConnect?.((p) => {
    // the card belongs to the session whose run asked — with parallel runs
    // that's the single live one, else the current session
    const liveIds = [...liveRuns.keys()];
    const targetId = liveIds.length === 1 ? liveIds[0]! : currentId;
    const chat = chats.find((ch) => ch.id === targetId) ?? current();
    if (!chat) { void window.glyphh.glyphhAgentConnectRespond?.({ id: p.id, connected: false, reason: "no session" }); return; }
    chat.messages.push({
      role: "assistant",
      kind: "connect",
      text: "",
      connect: { id: p.id, appId: p.app.appId, name: p.app.name, icon: p.app.icon, status: "offer" },
      at: Date.now(),
    });
    void saveStore();
    if (chat.id === currentId) { renderThread(); pinThreadToBottom(); }
  });
  window.glyphh.onGlyphhAgentDelta?.((d) => {
    const e = runEntry(d.runId);
    if (!e) return;
    e[1].text += d.delta;
    queueStreamPaint(e[0]);
  });
  window.glyphh.onGlyphhAgentDone?.((d) => {
    const e = runEntry(d.runId);
    if (!e) return;
    finishRun(e[0], e[1].text, d.stopped);
  });
  window.glyphh.onGlyphhAgentError?.((d) => {
    const e = runEntry(d.runId);
    if (!e) return;
    const [runChatId, run] = e;
    // A picked-frontier decline (out of credits / role / rate) arrives with a
    // %%GLYPHHERR:<kind>:<url>%% marker — render a styled card, not the raw
    // "API Error: 400 …" echo. Look in both the stream buffer and the error.
    const marker = /%%GLYPHHERR:([a-z]+):([^%]*)%%/.exec(`${run.text}\n${d.error}`);
    if (marker) {
      const chat = chats.find((ch) => ch.id === runChatId);
      if (chat) chat.messages.push({ role: "assistant", kind: "decline", text: "", decline: { kind: marker[1], url: marker[2].trim() }, at: Date.now() });
      finishRun(runChatId, "");
      return;
    }
    finishRun(runChatId, run.text ? `${run.text}\n\n⚠ ${d.error}` : `⚠ ${d.error}`);
  });
}

// ── Recents disclosure ───────────────────────────────────────────────────
function setRecentsOpen(open: boolean, persist: boolean): void {
  el("recents-toggle")?.classList.toggle("closed", !open);
  el("code-history")?.classList.toggle("hidden", !open);
  if (persist) void window.glyphh.setPreference?.("codeRecentsOpen", open);
  syncRailLayout();
}

// ── Rail sections (Apps, Layouts) — each collapsible, state remembered ───────
interface RailSectionDef { toggle: string; body: string; pref: string }
// Both start COLLAPSED — the rail leads with sessions; Apps and Layouts are
// there when wanted. The pref keys carry a "2": the v1 keys hold stale
// "open" values from before these sections were hidden, and honoring those
// would expand the rail on exactly the machines that were using it.
const RAIL_SECTIONS: RailSectionDef[] = [
  { toggle: "rail-apps-toggle", body: "rail-apps-body", pref: "railAppsOpen2" },
  { toggle: "rail-layouts-toggle", body: "rail-layouts-body", pref: "railLayoutsOpen2" },
];
/** The user's chosen Recents height — the splitter's flex-basis. Kept in a var
 *  so syncRailLayout can restore it after a "both sections closed" fill. */
let railRecentsH = 170;

function setRailSectionOpen(def: RailSectionDef, open: boolean, persist: boolean): void {
  el(def.toggle)?.classList.toggle("closed", !open);
  el(def.body)?.classList.toggle("hidden", !open);
  if (persist) void window.glyphh.setPreference?.(def.pref, open);
  syncRailLayout();
}

/**
 * One authority over how the rail's lower stack shares vertical space:
 *
 *   - Recents open + a section open → the splitter is live; Recents holds its
 *     chosen height and the open section(s) take the rest.
 *   - Recents open + BOTH sections closed → nothing below to resize, so Recents
 *     fills all the way to the user area and the splitter hides.
 *   - Recents closed → the sections own the whole stack; no splitter.
 *
 * Without this, collapsing both sections left Recents pinned at its dragged
 * height with dead space beneath it — the "doesn't go past a certain point" bug.
 */
function syncRailLayout(): void {
  const hist = el("code-history");
  const vs = el("recents-vsplit");
  const recentsOpen = !hist?.classList.contains("hidden");
  const anySectionOpen = RAIL_SECTIONS.some((d) => !el(d.body)?.classList.contains("hidden"));
  vs?.classList.toggle("hidden", !(recentsOpen && anySectionOpen));
  if (hist && recentsOpen) hist.style.flex = anySectionOpen ? `0 1 ${railRecentsH}px` : "1 1 auto";
}

/** Bind each rail section's disclosure toggle + restore its remembered state. */
function initRailSections(): void {
  for (const def of RAIL_SECTIONS) {
    el(def.toggle)?.addEventListener("click", () => {
      const open = el(def.toggle)!.classList.contains("closed"); // was closed → open it
      setRailSectionOpen(def, open, true);
    });
    void window.glyphh.getPreference?.(def.pref, false).then((v) => setRailSectionOpen(def, v === true, false));
  }
}

// ── Apps grid (rail, below Recents) — the same list + icons as the Apps page
//    / command center, ordered by last-opened (recents), opened with the same
//    launch the Apps page uses. All apps show; recents float to the top so the
//    search still covers the long tail. ─────────────────────────────────────
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
let railRecentTs: Record<string, number> = {};
let railAppsPage = 0;
let railLayoutsPage = 0;
// Both rail grids page at 9 — the same 3×3 block, so Apps and Layouts read
// as one system rather than two differently-sized lists.
const RAIL_APPS_PER_PAGE = 15;
const RAIL_LAYOUTS_PER_PAGE = 15;

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

async function loadRecentApps(): Promise<void> {
  try {
    const [apps, layouts, recents] = await Promise.all([
      window.glyphh.panelAppsList?.() ?? Promise.resolve([]),
      window.glyphh.layoutsList?.() ?? Promise.resolve([]),
      window.glyphh.recentsList?.() ?? Promise.resolve([]),
    ]);
    // Palette parity: web apps (have a url) + native library apps. The
    // agent's own row (glyphh-self) stays OUT — the Glyphh mark in the
    // header is the chat entry, not an app in the list.
    railApps = ((apps || []) as unknown as RailApp[]).filter((a) => a.appArchetype !== "glyphh-self" && (a.url || a.isBrowser === false));
    railLayouts = (layouts || []) as unknown as RailLayout[];
    railRecentTs = {};
    // the wall's arranged order (same preference the command centre writes)
    try {
      const pref = await window.glyphh.getPreference?.("ccIconOrder", []);
      railCcOrder = Array.isArray(pref) ? pref.map(String) : [];
    } catch { railCcOrder = []; }
    for (const r of recents || []) {
      const key = `${r.kind}:${r.id}`;
      railRecentTs[key] = Math.max(railRecentTs[key] || 0, r.ts || 0);
    }
    // Render INSIDE the try so a render-path error is contained here (an empty rail),
    // not escalated to an app-level unhandled rejection / blank screen. Desktop
    // behavior is identical — it doesn't throw here.
    renderRecentApps();
  } catch { railApps = []; railLayouts = []; railRecentTs = {}; renderRecentApps(); }
  // Icons land async (Pipedream catalog + OS file icons), then re-render —
  // same as the palette / Apps page.
  void primeConnectedIcons(railApps as never, renderRecentApps);
  void primeNativeIcons(railApps as never, renderRecentApps);
}

/** Both rail sections. Apps and Layouts each own a search + pagination and live
 *  under their own collapsible header (see initRailSections). */
let railCcOrder: string[] = [];
function renderRecentApps(): void { renderRailApps(); renderRailLayouts(); }
// The wall re-saves its order on every drag — mirror it into the rail at once,
// so the two lists can never disagree about what the user arranged.
window.addEventListener("glyphh:cc-order-changed", (e) => {
  const keys = (e as CustomEvent).detail;
  if (Array.isArray(keys)) { railCcOrder = keys.map(String); renderRecentApps(); }
});

/** The empty state for a rail grid: a short "No matches." while searching,
 *  otherwise a single ACTION — the sentence that used to sit here ("Your
 *  layouts land here") described nothing the user could do and wrapped
 *  badly in a narrow rail. */
function railEmpty(list: HTMLElement, q: string, label: string, section: string): void {
  if (q) {
    const none = document.createElement("div");
    none.className = "code-empty app-rail-empty";
    none.textContent = "No matches.";
    list.appendChild(none);
    return;
  }
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "app-rail-empty-btn";
  btn.textContent = `+ ${label}`;
  btn.title = `New ${label.toLowerCase()}`;
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    gotoSection(section);
    // Land ON the create form, not just the page — the button says "+".
    // The page's own New button is the one authority for what "new" means.
    window.setTimeout(() => document.getElementById(`${section === "apps" ? "app" : "layout"}-new-btn`)?.click(), 60);
  });
  list.appendChild(btn);
}

function renderRailApps(): void {
  const list = el<HTMLDivElement>("recent-apps-list");
  if (!list) return;
  const q = (el<HTMLInputElement>("recent-apps-search")?.value || "").trim().toLowerCase();
  list.textContent = "";

  // ORDER FOLLOWS THE COMMAND CENTRE: the wall is where apps are dragged, and
  // its saved order (ccIconOrder) is the one the user arranged — the rail was
  // sorting by recency instead, so the two disagreed. Anything not in that
  // order falls in after it, recency-first.
  const order = railCcOrder;
  const rank = (a: RailApp): number => {
    const i = order.indexOf(`app:${(a.slug || a.id || "").toLowerCase()}`);
    return i === -1 ? Number.MAX_SAFE_INTEGER : i;
  };
  const apps = railApps
    .filter((a) => !q || (a.name || "").toLowerCase().includes(q) || (a.slug || "").toLowerCase().includes(q))
    .sort((a, b) => {
      const ra = rank(a), rb = rank(b);
      if (ra !== rb) return ra - rb;
      const ta = railRecentTs[`app:${a.id}`] || 0;
      const tb = railRecentTs[`app:${b.id}`] || 0;
      return ta !== tb ? tb - ta : (a.name || "").localeCompare(b.name || "");
    });
  // HOME is a FIXED first tile — same control as the wall's, not an installed
  // app: it can't be reordered, paged away, edited or deleted.
  const home = document.createElement("button");
  home.className = "app-rail-tile app-rail-tile-home";
  home.type = "button";
  home.title = "Home — new session";
  const homeIcon = document.createElement("div");
  homeIcon.className = "tile-icon";
  const homeImg = document.createElement("img");
  homeImg.src = "brand/glyphh-mark.png";
  homeImg.alt = "";
  homeIcon.appendChild(homeImg);
  const homeName = document.createElement("div");
  homeName.className = "tile-name";
  homeName.textContent = "Home";
  home.append(homeIcon, homeName);
  home.addEventListener("click", () => {
    (window as unknown as { __glyphhNewSession?: () => void }).__glyphhNewSession?.();
  });
  list.appendChild(home);

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
      openCommandCenter();   // rail clicks land in Echo — the layout manager
      void window.glyphh.appLaunch?.({
        slug: a.slug || a.id, name: a.name, url: a.url,
        isBrowser: a.isBrowser, execPath: a.execPath,
        appArchetype: a.appArchetype, launchConfig: a.launchConfig,
      });
    });
    list.appendChild(tile);
  }
  if (ap.totalPages > 1) list.appendChild(railPager(ap.page, ap.totalPages, (pg) => { railAppsPage = pg; renderRailApps(); }));
  if (!apps.length) railEmpty(list, q, "App", "apps");
}

function renderRailLayouts(): void {
  const list = el<HTMLDivElement>("recent-layouts-list");
  if (!list) return;
  const q = (el<HTMLInputElement>("recent-layouts-search")?.value || "").trim().toLowerCase();
  list.textContent = "";

  // Mini icon stacks; same open (into the workbench) as the Layouts page.
  const layouts = railLayouts
    .filter((l) => !q || (l.name || "").toLowerCase().includes(q))
    .sort((a, b) => {
      const ta = railRecentTs[`layout:${a.name}`] || 0;
      const tb = railRecentTs[`layout:${b.name}`] || 0;
      return ta !== tb ? tb - ta : (a.name || "").localeCompare(b.name || "");
    });
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
    // A render function must never throw on a missing field: `splits` can be absent
    // for layouts from the web bridge / a malformed row — guard before mapping.
    const ids = (l.splits || [])
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
    tile.addEventListener("click", () => { openCommandCenter(); void openLayoutInWorkbench(l.name); });
    list.appendChild(tile);
  }
  if (lp.totalPages > 1) list.appendChild(railPager(lp.page, lp.totalPages, (pg) => { railLayoutsPage = pg; renderRailLayouts(); }));
  if (!layouts.length) railEmpty(list, q, "Layout", "layouts");
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
    const startTop = hist.getBoundingClientRect().top;
    const startH = hist.getBoundingClientRect().height;
    // The cap is computed against the WHOLE lower stack, not a snapshot of one
    // grid: Recents may grow until the still-open section(s) hit a usable
    // minimum. A collapsed section reserves nothing, so Recents reclaims its
    // space. This is what makes the splitter reach far down when only one
    // section is open (the old cap stopped at the apps grid's 96px).
    const MIN_BODY = 110;
    const userTop = el("app-rail-user")?.getBoundingClientRect().top ?? window.innerHeight;
    const available = userTop - startTop;
    const move = (ev: MouseEvent) => {
      let reserve = vs.offsetHeight;
      document.querySelectorAll<HTMLElement>(".app-rail-section-head").forEach((h) => { reserve += h.offsetHeight; });
      const openBodies = RAIL_SECTIONS.filter((d) => !el(d.body)?.classList.contains("hidden")).length;
      reserve += openBodies * MIN_BODY;
      const maxH = Math.max(60, available - reserve);
      const h = Math.max(60, Math.min(maxH, startH + (ev.clientY - startY)));
      hist.style.flex = `0 1 ${h}px`;
      railRecentsH = h;
    };
    const up = () => {
      document.removeEventListener("mousemove", move);
      document.removeEventListener("mouseup", up);
      document.body.classList.remove("code-vdragging");
      if (railRecentsH > 0) void window.glyphh.setPreference?.("codeRecentsH", railRecentsH);
    };
    document.addEventListener("mousemove", move);
    document.addEventListener("mouseup", up);
  });
}

/** Wire the rail's Apps grid: restore its height, load, and bind search. */
function initRailApps(): void {
  void (async () => {
    const recentsH = Number(await window.glyphh.getPreference?.("codeRecentsH", 0)) || 0;
    if (recentsH > 0) railRecentsH = recentsH;
    syncRailLayout();
  })();
  void loadRecentApps();
  // The Apps + Layouts rail open-page buttons were removed (A2/A5); their
  // sections open via the rail nav / settings modal now, and the trays below
  // are pure quick-launch grids.
  // Live updates: Apps/Layouts CRUD announces itself (same renderer).
  document.addEventListener("glyphh:apps-changed", () => { void loadRecentApps(); });
  initRecentsVsplit();
  initRailSections();

  // Apps search — its own page; Enter runs the text as a command (palette parity).
  wireRailSearch(el<HTMLInputElement>("recent-apps-search"), () => { railAppsPage = 0; renderRailApps(); });
  el<HTMLInputElement>("recent-apps-search")?.addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    const text = (e.target as HTMLInputElement).value.trim();
    if (text) void window.glyphh.execCommand(text.replace(/^\./, ""));
  });
  // Layouts search — its own page + list.
  wireRailSearch(el<HTMLInputElement>("recent-layouts-search"), () => { railLayoutsPage = 0; renderRailLayouts(); });
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
      if (w > 0) void window.glyphh.setPreference?.("codeRailWidth", w);
    };
    document.addEventListener("mousemove", move);
    document.addEventListener("mouseup", up);
  });
}

async function applyPanelPrefs(): Promise<void> {
  const railCollapsed = ((await window.glyphh.getPreference?.("codeRailCollapsed", false)) as boolean) || false;
  el("app-rail")?.classList.toggle("collapsed", railCollapsed);
  document.body.classList.toggle("rail-collapsed", railCollapsed);
  const railW = Number(await window.glyphh.getPreference?.("codeRailWidth", 0)) || 0;
  const rail = el("app-rail");
  if (rail && railW > 0) { rail.style.width = `${railW}px`; rail.style.minWidth = `${railW}px`; }
  const recentsOpen = (await window.glyphh.getPreference?.("codeRecentsOpen", true)) as boolean;
  setRecentsOpen(recentsOpen !== false, false);
}

// ── Entry points ─────────────────────────────────────────────────────────
export function loadCode(): void {
  void applyPanelPrefs();
  void (async () => {
    await loadStore();
    // Don't auto-select a session on load — a fresh open highlights no Recent
    // (the composer opens ready; typing starts a new session). A saved
    // currentId still resumes, and only highlights while on the agent.
    renderHistory();
    renderThread();
    refreshCtxMeter();
    void checkWorkdirGate();
  })();
  // Boot the ported workbench engine (idempotent) — it owns the workdir
  // controls, the view toggles, and everything inside #code-workbench.
  (window as unknown as { __initCodeWorkbench?: () => void }).__initCodeWorkbench?.();
}

/** Open an arbitrary URL as a WORKBENCH browser panel (beside the agent) — the
 *  same mechanics Settings → Manage Account uses. Cold-safe: flips to Code,
 *  boots the workbench (async init), then drives __wbOpenApp once it exists. */
export function openUrlInWorkbench(name: string, url: string): void {
  showWorkspaceSurface();
  const w = window as unknown as {
    __initCodeWorkbench?: () => void;
    __wbOpenApp?: (a: { slug: string; name: string; url: string; glyphh?: boolean }, newPanel?: boolean) => void;
  };
  w.__initCodeWorkbench?.();
  const app = { slug: (name.toLowerCase().replace(/[^a-z0-9]+/g, "-") || "page"), name, url };
  let tries = 0;
  const open = (): void => {
    if (w.__wbOpenApp) { w.__wbOpenApp(app); return; }
    if (tries++ < 40) setTimeout(open, 50);
  };
  open();
}

/** Open the command center (app/layout launcher) from ANY section — even before
 *  the Code workbench has ever mounted. Flips to the agent surface, boots the
 *  workbench (idempotent async init), then retries the toggle over rAF because
 *  __wbToggleAppSwitcher isn't assigned until that init() resolves. */
/** Every launcher entry point (⌘⇧Space, ⌘., the Glyphh rail, boot) opens
 *  ECHO — the command center is gone; Echo is the launcher AND the layout
 *  manager. (opts kept for caller compatibility; there is no overlay mode.) */
export function openCommandCenter(_opts: { forceInline?: boolean } = {}): void {
  const w = window as unknown as { __initCodeWorkbench?: () => void; __wbToggleAppSwitcher?: () => void };
  w.__initCodeWorkbench?.();
  let tries = 0;
  const go = (): void => {
    if (w.__wbToggleAppSwitcher) w.__wbToggleAppSwitcher();   // → openEchoSurface
    else if (tries++ < 40) requestAnimationFrame(go);
  };
  go();
}

export function initCode(): void {
  syncSpaceAttrs();   // styled from the first frame, tab click or not
  if (inited) return;
  inited = true;
  // "/" in the composer pops the installed-skill menu at the caret.
  const composerTa = input();
  if (composerTa) { attachSlashMenu(composerTa); watchComposerWidth(composerTa); }
  // Cmd+. / Ctrl+. opens the command center from any section. Registered in
  // the home-panel document (owns gotoSection + the switcher overlay), NOT
  // renderer.ts (the index shell — different webContents, no overlay reach).
  document.addEventListener("keydown", (e) => {
    if (e.key === "." && (e.metaKey || e.ctrlKey)) { e.preventDefault(); openCommandCenter(); }
    // ⌘⇧Space — same launcher (mirrors the OS-wide global shortcut).
    if (e.code === "Space" && e.shiftKey && (e.metaKey || e.ctrlKey)) { e.preventDefault(); openCommandCenter(); }
  });
  // The OS-wide ⌘⇧Space lands here from main once the window is fronted.
  (window.glyphh as unknown as { onOpenCommandCenter?: (cb: () => void) => void }).onOpenCommandCenter?.(() => openCommandCenter());
  // Header launcher button — bound here (home-panel startup) through the
  // cold-safe path, so it works even before the Code workbench first mounts.
  syncDragStripOffset();
  // Apps open as workbench panels beside the agent (the OS-window
  // replacement). Every main-side opener — Glyphh's open_app, the relay's
  // panels_*, the Apps/Layouts pages — lands here: flip to Code, make sure
  // the workbench booted, then drive the wb bridge.
  window.glyphh.onWbAppCommand?.((cmd) => {
    showWorkspaceSurface();
    (window as unknown as { __initCodeWorkbench?: () => void }).__initCodeWorkbench?.();
    const w = window as unknown as {
      __wbOpenApp?: (app: { slug: string; name: string; url: string; glyphh?: boolean }, newPanel?: boolean) => void;
      __wbOpenApps?: (apps: Array<{ slug: string; name: string; url: string; glyphh?: boolean }>, layoutName?: string) => void;
      __wbOpenLayoutByName?: (name: string) => Promise<boolean>;
      __wbCloseApp?: (slug: string) => boolean;
      __wbFocusApp?: (slug: string) => boolean;
      __wbToggleAppSwitcher?: () => void;
    };
    if (cmd.action === "open" && cmd.app) w.__wbOpenApp?.(cmd.app);
    else if (cmd.action === "terminal") (window as unknown as { __wbOpenTerminal?: () => void }).__wbOpenTerminal?.();
    else if (cmd.action === "tool" && (cmd as { tool?: string }).tool) (window as unknown as { __wbOpenTool?: (v: string) => void }).__wbOpenTool?.((cmd as { tool?: string }).tool!);
    else if (cmd.action === "popup" && (cmd as { url?: string }).url) (window as unknown as { __wbOpenPopup?: (u: string) => void }).__wbOpenPopup?.((cmd as { url?: string }).url!);
    else if (cmd.action === "open-many" && cmd.apps) {
      // A NAMED layout goes through the one true layout-open (the switcher's
      // grid path); only anonymous multi-open falls back to flat panels.
      const layoutName = (cmd as { layoutName?: string }).layoutName;
      if (layoutName) {
        void (async () => {
          for (let i = 0; i < 40 && !w.__wbOpenLayoutByName; i++) await new Promise((r) => requestAnimationFrame(r));
          if (!(await w.__wbOpenLayoutByName?.(layoutName))) w.__wbOpenApps?.(cmd.apps!, layoutName);
        })();
      } else w.__wbOpenApps?.(cmd.apps);
    }
    else if (cmd.action === "close" && cmd.slug) w.__wbCloseApp?.(cmd.slug);
    else if (cmd.action === "focus" && cmd.slug) w.__wbFocusApp?.(cmd.slug);
    else if (cmd.action === "clear-panels") (window as unknown as { __wbClearPanels?: () => void }).__wbClearPanels?.();
    else if (cmd.action === "grid-panels") (window as unknown as { __wbGridPanels?: () => boolean }).__wbGridPanels?.();
    else if (cmd.action === "switcher") openCommandCenter();
  });
  // One delegated handler for everything interactive inside the thread —
  // survives every re-render: code-block copy buttons, file cards (→ Monaco),
  // run cards (→ terminal).
  el("code-thread")?.addEventListener("click", (e) => {
    const t = e.target as HTMLElement;
    const copyBtn = t.closest<HTMLElement>(".yo-md-copy-btn");
    if (copyBtn) {
      const block = copyBtn.closest(".yo-md-codeblock");
      const code = block?.querySelector("pre code")?.textContent ?? "";
      void navigator.clipboard.writeText(code).then(() => {
        copyBtn.textContent = "Copied ✓";
        setTimeout(() => { copyBtn.textContent = "Copy"; }, 1500);
      });
      return;
    }
    const fileCard = t.closest<HTMLElement>(".code-file-card");
    if (fileCard?.dataset.path) {
      (window as unknown as { __wbOpenFile?: (p: string) => void }).__wbOpenFile?.(fileCard.dataset.path);
      return;
    }
    if (t.closest(".code-run-card")) {
      (window as unknown as { __wbOpenTerminal?: () => void }).__wbOpenTerminal?.();
    }
  });
  el("recents-toggle")?.addEventListener("click", () => {
    const open = el("recents-toggle")!.classList.contains("closed");
    setRecentsOpen(open, true);
    renderHistory();   // the search box follows the disclosure
  });
  wireRailSearch(el<HTMLInputElement>("recents-search"), (v) => { recentsQuery = v; renderHistory(); });
  initRailApps();
  /** NEW creates NOTHING — the record is born on the first send. Clears the
   *  selection and shows the space's landing. Both entry points use this:
   *  the rail's "+ New session" and the agent header's +, which used to call
   *  startNew() and leave an empty "New session" row behind. */
  /** The AGENT's own + — a generic new session OF THIS AGENT'S TYPE, in place.
   *  A layout-hosted agent stays in its slot with its arrangement intact; the
   *  thread empties to the bare mascot state and the composer keeps its chips. */
  const newSessionInPlace = (): void => {
    currentId = "";
    void saveStore();
    renderHistory();
    renderThread();
    void checkWorkdirGate();
    const hosted = !!document.querySelector(".echo-card .code-agent, .ws-rail-slot .code-agent");
    if (hosted) return;
    gotoSection("dashboard");
  };

  /** The RAIL's "+ New session" — the FULL reset: every panel closes, the
   *  layout clears, and the new-session screen loads. */
  const newSessionLanding = (): void => {
    currentId = "";
    void saveStore();
    syncSpaceAttrs();
    // CLOSE EVERYTHING FIRST: every open card, panel and layout goes, then the
    // landing mounts. (Ordering matters — a reset AFTER the section opens tore
    // down the landing's own card and left the surface with no composer.)
    (window as unknown as { __wbCloseAllForNewSession?: () => void }).__wbCloseAllForNewSession?.();
    renderHistory();
    renderThread();
    void checkWorkdirGate();
    gotoSection("agent");
  };
  // The rail's + starts a new Code session, straight to the agent.
  el("code-new-chat")?.addEventListener("click", () => newSessionLanding());
  // HOME — the rail's mark and the wall's first tile. Home IS the new-session
  // screen now (the dashboard is no longer the landing), so the rail's Home
  // button runs the exact same full-reset landing as the rail's + New Session.
  el("rail-home-btn")?.addEventListener("click", () => newSessionLanding());
  // The GLYPHH icon (command-center tile + rail home tile) opens the NEW SESSION
  // screen — same as the rail's + New Session — not the dashboard.
  (window as unknown as { __glyphhNewSession?: () => void }).__glyphhNewSession = newSessionLanding;
  // Reset (rail section headers): back to the agent, full screen.
  // The Apps/Layouts rail resets do EXACTLY what Echo's ⟲ does: close every
  // panel and return to the bare wall.
  document.querySelectorAll(".rail-reset-btn").forEach((b) => b.addEventListener("click", () => {
    const w = window as unknown as { __initCodeWorkbench?: () => void; __wbEchoReset?: () => void };
    w.__initCodeWorkbench?.();
    let tries = 0;
    const go = (): void => {
      if (w.__wbEchoReset) w.__wbEchoReset();
      else if (tries++ < 40) requestAnimationFrame(go);
    };
    go();
  }));
  // ── Session-scoped composer chrome. One session type now (Code), so this
  // just keeps the source chip + chips in sync with the open/pending session. ──
  const paintCw = (): void => {
    const cur = current();
    syncSpaceAttrs();
    sourceChip?.setSource(activeSource());
    sourceChip?.setSessionId(cur?.id ?? null);
    paintChips();
  };
  cwPaint = paintCw;
  // Land on the pending-new / resumed session and paint. Used by boot and by
  // the workbench's enter/activate events (spaces are gone — these now just
  // resurface the agent rather than switching between space types).
  const enterAgent = (navigate: boolean): void => {
    syncSpaceAttrs();
    const last = navigate ? chats.find((c) => c.id === lastSession) : undefined;
    currentId = last?.id || "";
    void saveStore();
    renderHistory();
    renderThread();
    refreshCtxMeter();
    void checkWorkdirGate();
    if (!navigate) return;
    if (last) gotoSection("agent");
    else gotoSection("dashboard");
    paintCw();
  };
  // The command centre / workbench used to switch spaces; with one type they
  // just resurface the agent (its last session, else the new-session screen).
  window.addEventListener("glyphh:enter-space", () => enterAgent(true));
  // A layout opening no longer changes the session TYPE (there is one); keep
  // the hook so the agent chrome + lists repaint when a layout mounts.
  window.addEventListener("glyphh:activate-space", () => {
    syncSpaceAttrs();
    renderHistory();
    renderThread();
    paintCw();
    void checkWorkdirGate();
  });
  // Restore the workspace source pick, then mount the chip above the composer.
  void window.glyphh.getPreference?.(SOURCE_PREF, null).then((sc) => {
    const coerce = (v: unknown): Source | null => {
      if (!v || typeof v !== "object") return null;
      const s = v as Source;
      if (s.kind === "cloud-repo" && s.repo) return { kind: "cloud-repo", repo: String(s.repo) };
      if (s.kind === "local" && s.path) return { kind: "local", path: String(s.path), ...(s.machineId ? { machineId: s.machineId } : {}) };
      if (s.kind === "cloud-new") return { kind: "cloud-new" };
      return null;
    };
    const cc = coerce(sc); if (cc) pendingSource = cc;
    // LOCAL machine wins whenever one exists — Chris's rule verbatim:
    // "Default to local machine if available, then to cloud." A stored CLOUD
    // pick applies only when no machine is attached; picking cloud stays a
    // per-visit choice from the chip, never a sticky default that buries the
    // folder picker.
    const ccPinned = cc && cc.kind === "local";
    if (!ccPinned) {
      void (async () => {
        let local: Source | null = null;
        if (!onWebTarget()) local = { kind: "local", path: "" };
        else {
          try {
            const st = await (window as unknown as { glyphhSdk?: { attach?: { status?: () => Promise<{ attached?: boolean }> } } }).glyphhSdk?.attach?.status?.();
            if (st?.attached) local = { kind: "local", path: "" };
          } catch { /* stays cloud */ }
        }
        if (!local) return;
        pendingSource = { ...local };
        sourceChip?.setSource(activeSource());
        paintSourceDependents();
      })();
    }
    mountSourceChip();
    paintSourceDependents();
  });
  void window.glyphh.getPreference?.(LAST_SESSION_PREF, "").then((lco) => {
    lastSession = String(lco || "");
    // boot: paint the agent's state but DON'T navigate (boot lands on Home)
    enterAgent(false);
  });
  el("code-rail-toggle")?.addEventListener("click", () => {
    const collapsed = el("app-rail")!.classList.toggle("collapsed");
    document.body.classList.toggle("rail-collapsed", collapsed);
    void window.glyphh.setPreference?.("codeRailCollapsed", collapsed);
  });
  // The command-center eye beside the rail toggle — the same control as the
  // echo panel's eye button: pin the shadow so the wall shows through the
  // open cards. Cold-safe: mounts echo first, then toggles the pin.
  el("code-cc-btn")?.addEventListener("click", () => {
    openCommandCenter();
    const w = window as unknown as { __wbEchoShadowPin?: () => void };
    let tries = 0;
    const go = (): void => {
      if (w.__wbEchoShadowPin) w.__wbEchoShadowPin();
      else if (tries++ < 40) requestAnimationFrame(go);
    };
    go();
  });
  el("code-send")?.addEventListener("click", send);
  // Session head (SessionHeader port): ‹/name → the space's list view; the
  // kebab → Rename / Pin / Delete.
  // BACK = out to the MAIN landing (there was no way back to it from inside
  // a session). The session survives in history — the head's history
  // dropdown resumes it; the list view stays reachable from there.
  // ‹ ALWAYS opens THIS agent's session list (scoped to its type by
  // renderHistory) — never the global landing.
  // ‹ — back to this tab's + New Session screen. (It used to open the session
  // LIST, which is reachable from the rail's recents.)
  el("code-session-back")?.addEventListener("click", () => { if (current()) forgetCurrentSession(); });
  el("code-session-kebab")?.addEventListener("click", (ev) => {
    ev.stopPropagation();
    if (headKebabEl) { closeHeadKebab(); return; }
    openHeadKebab(ev.currentTarget as HTMLElement);
  });
  document.addEventListener("click", (ev) => {
    if (headKebabEl && !(ev.target as HTMLElement).closest?.(".session-head-menu, #code-session-kebab")) closeHeadKebab();
  });
  // Session controls in the agent head (the coding panel's own header row is
  // hidden): + starts a new session, the clock drops the history list.
  type HeadSessionsApi = { list(): Array<{ id: string; title: string }>; currentId(): string | null; switch(id: string): void; startNew(): void };
  const sessApi = (): HeadSessionsApi | undefined => (window as unknown as { __agentSessions?: HeadSessionsApi }).__agentSessions;
  el("code-session-new")?.addEventListener("click", newSessionInPlace);
  el("code-session-history")?.addEventListener("click", (ev) => {
    ev.stopPropagation();
    const anchor = ev.currentTarget as HTMLElement;
    document.querySelector(".wb-session-menu")?.remove();
    const sess = sessApi();
    if (!sess) return;
    const menu = document.createElement("div");
    menu.className = "code-drop wb-session-menu";
    const PIN_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 17v5"/><path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7h1a2 2 0 0 0 0-4H8a2 2 0 0 0 0 4h1z"/></svg>`;
    const TRASH_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/></svg>`;
    const paint = (): void => {
      menu.innerHTML = "";
      const cur = currentId;
      // Pinned first (stable — recency holds within each group). One session
      // type now, so every session is eligible.
      const rows = [...chats]
        .sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0)).slice(0, 20);
      for (const c of rows) {
        const row = document.createElement("div");
        row.className = "wb-session-row" + (c.id === cur ? " selected" : "");
        const title = document.createElement("button");
        title.type = "button";
        title.className = "code-drop-item wb-session-title";
        title.textContent = c.title;
        title.addEventListener("click", () => { menu.remove(); sessApi()?.switch(c.id); });
        const pin = document.createElement("button");
        pin.type = "button";
        pin.className = "code-icon-btn wb-session-pin" + (c.pinned ? " on" : "");
        pin.title = c.pinned ? "Unpin" : "Pin to top";
        pin.innerHTML = PIN_SVG;
        pin.addEventListener("click", (e) => {
          e.stopPropagation();
          c.pinned = !c.pinned;
          void saveStore();
          renderHistory();
          paint();
        });
        const del = document.createElement("button");
        del.type = "button";
        del.className = "code-icon-btn wb-session-del";
        del.title = "Delete session";
        del.innerHTML = TRASH_SVG;
        del.addEventListener("click", (e) => {
          e.stopPropagation();
          void (async () => {
            const sure = await confirmAction({
              title: `Delete "${c.title}"?`,
              body: "This session's history is gone for good.",
              confirmLabel: "Delete",
              danger: true,
            });
            if (!sure) return;
            chats = chats.filter((x) => x.id !== c.id);
            if (currentId === c.id) {
              currentId = chats[0]?.id || "";
              renderThread();
            }
            void saveStore();
            renderHistory();
            if (!chats.length) { menu.remove(); return; }
            paint();
          })();
        });
        row.append(title, pin, del);
        menu.appendChild(row);
      }
      if (!rows.length) {
        const empty = document.createElement("div");
        empty.className = "wb-session-empty";
        empty.textContent = "No sessions yet.";
        menu.appendChild(empty);
      }
    };
    paint();
    const r = anchor.getBoundingClientRect();
    menu.style.position = "fixed";
    menu.style.visibility = "hidden";   // measure before showing
    document.body.appendChild(menu);
    // Clamp inside the viewport: right-align to the anchor, but never off
    // either edge; below the anchor, but flip up if the bottom would clip.
    const mw = menu.offsetWidth;
    const mh = menu.offsetHeight;
    const left = Math.max(8, Math.min(r.right - mw, window.innerWidth - mw - 8));
    const top = r.bottom + 6 + mh > window.innerHeight - 8
      ? Math.max(8, r.top - mh - 6)
      : r.bottom + 6;
    menu.style.left = `${left}px`;
    menu.style.top = `${top}px`;
    menu.style.visibility = "";
    const dismiss = (e: MouseEvent): void => {
      if (!menu.contains(e.target as Node)) { menu.remove(); document.removeEventListener("mousedown", dismiss, true); }
    };
    document.addEventListener("mousedown", dismiss, true);
  });
  wireComposerAttachments();
  initGlyphhAgentEvents();
  initWorkdirGate();
  initComposerControls();
  void (async () => {
    const m = String((await window.glyphh.getPreference?.("glyphhMode", "ask")) || "ask");
    if (MODES.some((x) => x.id === m)) glyphhMode = m as typeof glyphhMode;
    const lp = String((await window.glyphh.getPreference?.("glyphhLoop", "default")) || "default");
    glyphhLoop = lp;
    void refreshLoops();
    paintChips();
    // The model chip renders from the STORED loop's slots — the early refresh
    // at menu creation ran before this preference loaded, so without this the
    // chip shows the fallback until the menu is first opened.
    await refreshModelList();
    // Cold start can race auth: no slots yet → one quiet retry.
    if (!picker.currentRoles().length) setTimeout(() => void refreshModelList(), 2500);
  })();
  // Opening a layout can switch the active loop (+ its slot models) out from
  // under the composer. Re-sync the chip from the stored preference so it shows
  // the loop that will actually run. (The turn itself already resolves the loop
  // live main-side, so this is display-consistency, not correctness.)
  document.addEventListener("glyphh:loop-applied", () => {
    void (async () => {
      const lp = String((await window.glyphh.getPreference?.("glyphhLoop", "default")) || "default");
      if (lp === glyphhLoop) { await refreshModelList(true); return; }
      glyphhLoop = lp;
      await refreshLoops();
      paintChips();
      renderLoopMenu();
      await refreshModelList(true);
    })();
  });
  const ta = input();
  ta?.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      // Mid-run, Enter QUEUES the note rather than doing nothing — the button
      // beside it is the stop control while thinking, and stopping flushes.
      if (thinking) queueNote();
      else send();
    } else if (e.key === "Tab" && e.shiftKey) {
      // Shift+Tab cycles the permission mode from the composer.
      e.preventDefault();
      cycleMode();
    }
  });
  ta?.addEventListener("input", () => autoGrow(ta!));
  // Session-row ⋯ menu dismisses on any click away from it.
  document.addEventListener("mousedown", (e) => {
    if (menuEl && !menuEl.contains(e.target as Node)) closeMenu();
  });
  initRailSplitter();
  // loadStore is ASYNC: sessions arrive before the first history paint — the
  // rail's Recents AND the agent head's dropdown read the same store.
  void (async () => {
    await loadStore();
    // Don't auto-select a session on load — a fresh open highlights no Recent
    // (the composer opens ready; typing starts a new session). A saved
    // currentId still resumes, and only highlights while on the agent.
    renderHistory();
  })();
  // A folder change while a session is current binds THAT session to it —
  // its runs keep working there even after another layout moves the global.
  (window as unknown as { wb?: { onCwdChanged?: (cb: (dir: string | null) => void) => void } }).wb?.onCwdChanged?.((dir) => {
    const c = current();
    if (c && dir) { c.workdir = dir; void saveStore(); }
  });
  // Another window (the ghost overlay) saved the shared store — adopt its
  // list so a ghost-created session appears in the history dropdown immediately. The
  // CURRENT chat keeps its local object: it may be mid-stream, and the disk
  // copy of it is never newer than this window's memory.
  (window.glyphh as unknown as { onGlyphhSessionsUpdated?: (cb: () => void) => void }).onGlyphhSessionsUpdated?.(() => {
    void (async () => {
      try {
        const s = await window.glyphh.glyphhSessionsLoad?.();
        const disk = ((s?.chats as CodeChat[]) || []);
        if (!disk.length || !storeLoaded) return;
        const cur = current();
        chats = disk.map((d) => (cur && d.id === cur.id ? cur : d));
        if (cur && !chats.some((c) => c.id === cur.id)) chats.unshift(cur);
        renderHistory();
      } catch { /* stale repaint only — next save syncs */ }
    })();
  });
}

/**
 * Seed the agent's composer and jump to it — the "Create with AI" path from
 * the library editors. Rides the CURRENT session (the seed is a prompt, not a
 * context wipe); a first-ever visit simply lands on the fresh composer.
 */
/** A task RUN opened as a chat session — the binding as the user turn, the
 *  run's output (or error) as the assistant turn. Everything the run built or
 *  wrote renders exactly like a live turn (markdown, code blocks, links).
 *  Reopening the same run switches to its existing session. */
export function openRunSession(run: {
  runId: string; agentName: string; taskName: string; target: string;
  startedAt: string; durationMs: number | null; status: string; error: string | null; output: string | null;
}): void {
  gotoSection("code");
  const id = `run-${run.runId}`;
  const existing = chats.find((c) => c.id === id);
  if (existing) {
    currentId = existing.id;
    renderHistory();
    renderThread();
    return;
  }
  const when = new Date(run.startedAt).toLocaleString();
  const dur = run.durationMs != null ? ` · ${(run.durationMs / 1000).toFixed(1)}s` : "";
  const c: CodeChat = {
    id,
    title: `▶ ${run.taskName} · ${when}`,
    mode: "code",   // agent runs live in the CODE space
    createdAt: Date.parse(run.startedAt) || Date.now(),
    messages: [
      { role: "user", text: `▶ ${run.taskName} — ${run.agentName} ran \`${run.target}\` (${when}${dur})`, at: Date.parse(run.startedAt) || Date.now() },
      run.status === "error"
        ? { role: "assistant", text: `⚠ ${run.error || "The run failed."}`, at: Date.now() }
        : { role: "assistant", text: run.output || "*(no output recorded)*", at: Date.now() },
    ],
  };
  chats.unshift(c);
  currentId = c.id;
  void saveStore();
  renderHistory();
  renderThread();
}

/** A NEW session with `text` ready in the composer — the dashboard's
 *  "Recommended for you" entries land here. (The legacy `space` arg is
 *  ignored: every session is the Code agent now.) */
export function seedNewSession(text: string, _space?: "chat" | "cowork" | "code"): void {
  // No record until the user actually SENDS — the seed just fills the
  // composer on a cleared selection.
  currentId = "";
  void saveStore();
  renderHistory();
  renderThread();
  seedComposer(text);
  void checkWorkdirGate();
}

/** The composer's ORIGINAL home (inside .code-agent) — remembered on the
 *  first adoption so it can always return. */
let composerHome: { parent: HTMLElement; next: Node | null } | null = null;
/** Move the ENTIRE agent footer (input + chips row) into a host (the Home
 *  page's slot), or back home with null. The elements travel with their
 *  bindings — sends, chips, menus all keep working wherever it sits. */
export function adoptComposer(host: HTMLElement | null): void {
  const comp = document.querySelector<HTMLElement>(".code-composer");
  if (!comp) return;
  const chipEl = sourceChip?.el;
  if (host) {
    if (!composerHome && comp.parentElement) composerHome = { parent: comp.parentElement, next: comp.nextSibling };
    if (comp.parentElement !== host) host.appendChild(comp);
    // The source chip leads the landing's chips row ([source][folder][git][+])
    // rather than sitting alone above the input.
    const dashSlot = document.getElementById("dash-source-slot");
    if (chipEl && dashSlot && chipEl.parentElement !== dashSlot) dashSlot.appendChild(chipEl);
    document.body.classList.add("composer-on-home");
  } else {
    if (composerHome && comp.parentElement !== composerHome.parent) composerHome.parent.insertBefore(comp, composerHome.next);
    const homeSlot = el("code-source-slot");
    if (chipEl && homeSlot && chipEl.parentElement !== homeSlot) homeSlot.appendChild(chipEl);
    document.body.classList.remove("composer-on-home");
  }
  cwPaint?.();   // the Chat/Co-work toggle exists only on the Home composer
}

// The workbench bundle can't import this module — openAgentCard calls the
// bridge so an agent adoption NEVER runs while the footer sits on Home.
(window as unknown as { __adoptComposerHome?: () => void }).__adoptComposerHome = () => adoptComposer(null);
// The workbench calls this when the HOME card mounts: pull the live composer
// into the landing's slot (the bundle can't import this module).
(window as unknown as { __adoptComposerToHome?: () => void }).__adoptComposerToHome = () => {
  let tries = 0;
  const go = (): void => {
    const slot = document.getElementById("dash-composer-slot");
    if (slot && document.querySelector(".code-composer")) { adoptComposer(slot); return; }
    if (tries++ < 60) setTimeout(go, 50);
  };
  go();
};

export function seedComposer(text: string): void {
  gotoSection("agent");
  const ta = input();
  if (!ta) return;
  ta.value = text;
  ta.dispatchEvent(new Event("input", { bubbles: true }));
  ta.focus();
  ta.setSelectionRange(ta.value.length, ta.value.length);
  // Clicking a prompt IS the intent to start — if no working folder is set
  // yet, ask for it right now instead of leaving a dead composer.
  if (!workdirReady) {
    void wb()?.pickCwd?.({ nullOnCancel: true }).then(() => checkWorkdirGate());
  }
}
