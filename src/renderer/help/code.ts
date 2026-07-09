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
import { formatMarkdown } from "../format-markdown.js";

interface AttachRef { kind: "image" | "file" | "folder"; path: string; name: string }
interface CodeMsg { role: "user" | "assistant"; text: string; at: number; kind?: "tool"; attachments?: AttachRef[] }
interface CodeChat { id: string; title: string; createdAt: number; messages: CodeMsg[] }

const STORE_KEY = "codeChats";
const CURRENT_KEY = "codeCurrentChat";


// ── Permission modes + effort (composer controls) ────────────────────────
// Mode: a drop-UP menu (checkmark marks the selection; Shift+Tab cycles).
// Effort: far right — a drop-up slider Low→Med→High→Superfly; superfly
// turns the track into a particle matrix and maxes the reply budget.
const MODES = [
  { id: "ask", label: "Ask mode", hint: "Every action needs your approval" },
  { id: "plan", label: "Plan mode", hint: "Read-only — William plans, changes nothing" },
  { id: "acceptEdits", label: "Accept edits", hint: "File edits auto-approved; commands still ask" },
  { id: "auto", label: "Auto mode", hint: "Workspace actions auto-approved; risky ones ask" },
  { id: "bypass", label: "Bypass permissions", hint: "Everything auto-approved — trusted sessions only" },
] as const;
const EFFORTS = [
  { id: "low", label: "Local", hint: "Everything on-device — never escalates, never burns credits" },
  { id: "medium", label: "Assist", hint: "Local first; hard turns escalate to Claude" },
  { id: "high", label: "Boost", hint: "Escalates readily — Claude takes the heavy turns" },
  { id: "superfly", label: "Superfly", hint: "All Claude, every turn — max capability, credits burn" },
] as const;
let williamMode: (typeof MODES)[number]["id"] = "ask";
let williamEffort: (typeof EFFORTS)[number]["id"] = "medium";
// Approval cards awaiting a decision (rendered inline in the thread).
// Ask dock queue — approvals and agent questions render one at a time in a
// card docked just above the composer (never inline in the thread).
type AskDockItem =
  | { type: "approval"; id: string; kind: string; title: string; detail: string }
  | { type: "ask"; id: string; questions: Array<{ question: string; options?: string[] }>; answers: string[]; step: number };
let askQueue: AskDockItem[] = [];

function paintChips(): void {
  const mc = el("code-mode-chip");
  if (mc) {
    const m = MODES.find((x) => x.id === williamMode) ?? MODES[0];
    mc.textContent = m.label;
    mc.title = `${m.hint} — Shift+Tab cycles`;
    mc.className = `code-chip mode-${m.id}`;
  }
  const ec = el("code-effort-chip");
  if (ec) {
    const ef = EFFORTS.find((x) => x.id === williamEffort) ?? EFFORTS[1];
    ec.textContent = ef.id === "superfly" ? "Superfly" : `Effort: ${ef.label}`;
    ec.title = ef.hint;
    ec.className = `code-chip effort-${ef.id}`;
  }
  syncEffortPop();
}

function setMode(id: (typeof MODES)[number]["id"]): void {
  williamMode = id;
  void window.yo.setPreference?.("williamMode", id);
  paintChips();
  renderModeMenu();
}

function cycleMode(): void {
  const i = MODES.findIndex((m) => m.id === williamMode);
  setMode(MODES[(i + 1) % MODES.length].id);
}

function setEffort(id: (typeof EFFORTS)[number]["id"]): void {
  williamEffort = id;
  void window.yo.setPreference?.("williamEffort", id);
  paintChips();
}

// ── Model selector (drop-up) — Will (will-7b-mini) / William (william-14b-base) ──
let modelList: Array<{ id: string; name: string; minRamGB: number; size?: number; status?: string; usage?: string; downloaded: boolean }> = [];
let modelSelected = "auto";
let modelResolved: string | null = null;
// Escalation (Claude) models — org-allowed list; the pick is per-user.
let gwModels: Array<{ model: string; display_name: string; input_credits_per_mtok: number | null; output_credits_per_mtok: number | null }> = [];
let gwDefault: string | null = null;
let gwEffective = "";

function paintModelChip(): void {
  const mc = el("code-model-chip");
  if (!mc) return;
  // Model ids ARE the display names (will-7b-mini / william-14b-base).
  if (modelSelected === "auto") {
    mc.textContent = modelResolved ? `Auto · ${modelResolved}` : "Auto";
    mc.title = "Model — picked by hardware; click to choose";
  } else {
    mc.textContent = modelSelected;
    mc.title = `Model: ${modelSelected} — click to change`;
  }
  mc.className = "code-chip";
}

async function refreshModelList(): Promise<void> {
  try {
    const r = await window.yo.williamModelsList?.();
    if (r) {
      modelList = r.models;
      modelSelected = r.selected;
      modelResolved = r.resolved;
      paintModelChip();
    }
    const g = await window.yo.gatewayModelsList?.();
    if (g) {
      gwModels = g.models;
      gwDefault = g.default;
      gwEffective = g.effective;
    }
  } catch { /* main not ready */ }
}

function renderModelMenu(): void {
  const menu = el("code-model-menu");
  if (!menu) return;
  menu.textContent = "";
  const check = `<svg class="drop-check" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`;
  const closeTips = () => menu.querySelectorAll(".model-info-tip").forEach((t) => t.classList.add("hidden"));
  const mk = (id: string, label: string, sub: string, opts?: { extra?: string; info?: string; selected?: boolean; onClick?: () => void }) => {
    const isSelected = opts?.selected ?? (id === modelSelected);
    const item = document.createElement("button");
    item.className = "code-drop-item drop-item-2line" + (isSelected ? " selected" : "");
    item.type = "button";
    const main = document.createElement("div");
    main.className = "drop-main";
    const span = document.createElement("span");
    span.textContent = label + (opts?.extra ? ` ${opts.extra}` : "");
    main.appendChild(span);
    if (isSelected) main.insertAdjacentHTML("beforeend", check);
    if (opts?.info) {
      // ⓘ — the one-line sub stays scannable; the full story lives in a
      // themed tooltip that never triggers a model switch.
      const btn = document.createElement("button");
      btn.className = "model-info-btn";
      btn.type = "button";
      btn.title = "About this model";
      btn.textContent = "i";
      const tip = document.createElement("div");
      tip.className = "model-info-tip hidden";
      tip.textContent = opts.info;
      tip.addEventListener("click", (ev) => ev.stopPropagation());
      btn.addEventListener("click", (ev) => {
        ev.stopPropagation();
        const wasHidden = tip.classList.contains("hidden");
        closeTips();
        if (wasHidden) tip.classList.remove("hidden");
      });
      main.appendChild(btn);
      item.appendChild(tip);
    }
    item.appendChild(main);
    if (sub) {
      const subEl = document.createElement("span");
      subEl.className = "drop-sub";
      subEl.textContent = sub;
      item.appendChild(subEl);
    }
    item.addEventListener("click", () => {
      if (opts?.onClick) {
        opts.onClick();
      } else {
        modelSelected = id;
        void window.yo.setPreference?.("williamModel", id);
        paintModelChip();
        // A different model spawns on the next send (downloading first if
        // needed — the spinner narrates).
      }
      closeTips();
      el("code-model-menu")?.classList.add("hidden");
    });
    menu.appendChild(item);
  };
  const header = (text: string) => {
    const h = document.createElement("div");
    h.className = "yo-model-section-header";
    h.textContent = text;
    menu.appendChild(h);
  };

  if (gwModels.length) header("On this machine");
  mk("auto", "Auto", "Picks the best model for this machine.");
  for (const m of modelList) {
    // Only released models list — future tiers appear when they exist.
    if ((m.status || "available") !== "available") continue;
    const oneLine = (m.usage || "").split(" — ")[0] || m.name;
    const sizeGB = m.size ? ` · ${(m.size / 1e9).toFixed(1)} GB download` : "";
    const info = [
      m.usage || "",
      `${m.minRamGB} GB+ RAM${sizeGB}`,
      m.downloaded ? "On this machine." : "Downloads on first use.",
    ].filter(Boolean).join("\n");
    // Ids ARE the canonical display names (will-7b-mini / william-14b-base) —
    // render the id so stale cached manifests can't show retired names.
    mk(m.id, m.id, oneLine, { extra: m.downloaded ? "" : "↓", info });
  }

  // Escalation pick — which Claude model hard turns go to. Org-governed
  // list, per-user choice; separate from the local-model selection above.
  if (gwModels.length) {
    header("Escalates to Model");
    const cr = (v: number | null) => (v == null ? "—" : String(Math.round(v / 1e6)));
    const gwDesc = (id: string) =>
      id.includes("opus") ? "Deep reasoning — the heavy hitter"
        : id.includes("haiku") ? "Quick and light for easy turns"
          : "Balanced coder — fast and capable";
    for (const m of gwModels) {
      const isDefault = gwDefault === m.model;
      const info = [
        `${m.display_name} — ${gwDesc(m.model)}.`,
        `${cr(m.input_credits_per_mtok)}/${cr(m.output_credits_per_mtok)} credits per 1M tokens.`,
        isDefault ? "Org default." : "",
      ].filter(Boolean).join("\n");
      mk(m.model, m.display_name + (isDefault ? " (org default)" : ""), gwDesc(m.model), {
        info,
        selected: m.model === gwEffective,
        onClick: () => {
          gwEffective = m.model;
          void window.yo.setPreference?.("frontierModel", m.model);
        },
      });
    }
  }
}

// ── Mode drop-up ──
function renderModeMenu(): void {
  const menu = el("code-mode-menu");
  if (!menu) return;
  menu.textContent = "";
  for (const m of MODES) {
    const item = document.createElement("button");
    item.className = "code-drop-item";
    item.type = "button";
    item.title = m.hint;
    const label = document.createElement("span");
    label.textContent = m.label;
    item.appendChild(label);
    if (m.id === williamMode) {
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

// ── Effort drop-up: labels over a 4-stop slider; superfly = matrix ──
let matrixRaf = 0;

function syncEffortPop(): void {
  const pop = el("code-effort-pop");
  if (!pop || pop.classList.contains("hidden")) return;
  const idx = EFFORTS.findIndex((x) => x.id === williamEffort);
  const range = pop.querySelector<HTMLInputElement>("input[type=range]");
  if (range) range.value = String(idx);
  pop.querySelectorAll(".effort-label").forEach((n, i) => n.classList.toggle("active", i === idx));
  const superfly = williamEffort === "superfly";
  pop.classList.toggle("superfly", superfly);
  if (superfly) startMatrix();
}

/** The superfly matrix — vertical particle dashes streaming right→left:
 *  hot/dense at the right edge, thinning to sparse at the left. White with
 *  purple flashes (theme-read live). Runs only while visible. */
function startMatrix(): void {
  const canvas = el<HTMLCanvasElement>("effort-matrix");
  if (!canvas || matrixRaf) return;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const W = canvas.clientWidth || 200;
  const H = canvas.clientHeight || 26;
  canvas.width = W * dpr;
  canvas.height = H * dpr;
  const ctx = canvas.getContext("2d")!;
  const accent = getComputedStyle(document.documentElement).getPropertyValue("--accent").trim() || "#8c3bf2";
  const wire = getComputedStyle(canvas).color || "#fff";
  const parts: Array<{ x: number; y: number; vx: number; h: number; purple: boolean }> = [];
  const tick = () => {
    const pop = el("code-effort-pop");
    if (!canvas.isConnected || !pop || pop.classList.contains("hidden") || !pop.classList.contains("superfly")) {
      matrixRaf = 0;
      return;
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    // Spawn skewed hard toward the hot right edge.
    for (let i = 0; i < 3; i++) {
      const bias = Math.pow(Math.random(), 0.3);
      parts.push({
        x: W * (0.2 + 0.8 * bias),
        y: 2 + Math.random() * (H - 8),
        vx: -(0.45 + Math.random()),
        h: 3 + Math.random() * 3.5,
        purple: Math.random() < 0.3,
      });
    }
    for (let i = parts.length - 1; i >= 0; i--) {
      const p = parts[i];
      p.x += p.vx;
      if (p.x < 0) { parts.splice(i, 1); continue; }
      ctx.globalAlpha = Math.pow(p.x / W, 1.5) * 0.92;
      ctx.fillStyle = p.purple ? accent : wire;
      ctx.fillRect(p.x, p.y, 1.3, p.h);
    }
    if (parts.length > 260) parts.splice(0, parts.length - 260);
    ctx.globalAlpha = 1;
    matrixRaf = requestAnimationFrame(tick);
  };
  matrixRaf = requestAnimationFrame(tick);
}

/** Manual compaction (meter click / .compact) — steers the fold with an
 *  optional one-shot focus, reports the outcome into the thread. */
async function runManualCompact(focus: string): Promise<void> {
  const c = current();
  if (!c || thinking) return;
  const meter = el("code-ctx-meter");
  meter?.classList.add("compacting");
  try {
    const r = await window.yo.williamCompact?.(c.id, focus);
    const u = await window.yo.williamContextUsage?.(c.id).catch(() => null);
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
  const u = await window.yo.williamContextUsage?.(currentId).catch(() => null);
  if (!u) { pop.innerHTML = `<div class="ctx-pop-empty">Context unavailable.</div>`; return; }
  const lanes = u.lanes?.length
    ? u.lanes
    : [{ id: "local", kind: "local" as const, tokens: u.tokens, budget: u.budget, ratio: u.ratio, foldAt: u.foldAt }];
  const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));
  const fmt = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k` : String(n));
  pop.innerHTML = `
    <div class="effort-head">
      <span class="effort-title">Compaction</span>
      <button id="ctx-info-btn" class="model-info-btn" type="button" title="How compaction works">i</button>
    </div>
    <div id="ctx-info-tip" class="model-info-tip hidden"></div>
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
    </div>`;
  const ctxTip = pop.querySelector<HTMLElement>("#ctx-info-tip");
  if (ctxTip) {
    ctxTip.textContent = [
      "One shared history, measured against every model that can serve it.",
      "",
      "The local lane is the binding one — declined escalations fall back to the local model, so the history must always fit it. When it crosses the tick, older turns fold into a summary and every lane shrinks together.",
      "",
      "Compact now folds immediately; the optional focus tells the summary what it must keep.",
    ].join("\n");
    ctxTip.addEventListener("click", (ev) => ev.stopPropagation());
    pop.querySelector<HTMLButtonElement>("#ctx-info-btn")?.addEventListener("click", (ev) => {
      ev.stopPropagation();
      ctxTip.classList.toggle("hidden");
    });
  }
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
    if (!meter || !currentId) return;
    void window.yo.williamContextUsage?.(currentId).then((u) => {
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
      void refreshModelList().then(() => renderModelMenu());
      renderModelMenu();
      mmenu.classList.toggle("hidden");
    });
    void refreshModelList();
  }
  // Menus are built once; rows re-render on open/select.
  const menu = document.createElement("div");
  menu.id = "code-mode-menu";
  menu.className = "code-drop-up hidden";
  modeWrap.appendChild(menu);
  const pop = document.createElement("div");
  pop.id = "code-effort-pop";
  pop.className = "code-drop-up code-effort-pop hidden";
  pop.innerHTML = `
    <div class="effort-head">
      <span class="effort-title">Effort</span>
      <button id="effort-info-btn" class="model-info-btn" type="button" title="How effort works">i</button>
    </div>
    <div id="effort-info-tip" class="model-info-tip hidden"></div>
    <div class="effort-desc">How eagerly turns escalate from the free local model to your escalation model.</div>
    <div class="effort-labels">${EFFORTS.map((x) => `<span class="effort-label${x.id === "superfly" ? " sf" : ""}">${x.label}</span>`).join("")}</div>
    <div class="effort-track">
      <canvas id="effort-matrix"></canvas>
      <input type="range" min="0" max="3" step="1" value="1" aria-label="Effort" />
    </div>`;
  effortWrap.appendChild(pop);
  const effortTip = pop.querySelector<HTMLElement>("#effort-info-tip")!;
  effortTip.textContent = [
    "Effort sets how eagerly each turn escalates from the free local model to your escalation model.",
    "",
    "Local — everything on-device. Free and private; never escalates.",
    "Assist — local first; turns the local model can't handle escalate.",
    "Boost — escalates readily; the escalation model takes the heavy turns.",
    "Superfly — every turn escalates. Max capability; credits burn.",
    "",
    "Credits burn only on escalated turns. If escalation is declined — credit cap, rate limit, offline — the turn runs locally instead of failing.",
  ].join("\n");
  effortTip.addEventListener("click", (ev) => ev.stopPropagation());
  pop.querySelector<HTMLButtonElement>("#effort-info-btn")!.addEventListener("click", (ev) => {
    ev.stopPropagation();
    effortTip.classList.toggle("hidden");
  });
  pop.querySelector<HTMLInputElement>("input[type=range]")!.addEventListener("input", (e) => {
    const idx = Math.max(0, Math.min(3, Number((e.target as HTMLInputElement).value) || 0));
    setEffort(EFFORTS[idx].id);
  });
  el("code-mode-chip")?.addEventListener("click", (e) => {
    e.stopPropagation();
    el("code-effort-pop")?.classList.add("hidden");
    el("code-ctx-pop")?.classList.add("hidden");
    renderModeMenu();
    el("code-mode-menu")?.classList.toggle("hidden");
  });
  el("code-effort-chip")?.addEventListener("click", (e) => {
    e.stopPropagation();
    el("code-mode-menu")?.classList.add("hidden");
    el("code-ctx-pop")?.classList.add("hidden");
    el("effort-info-tip")?.classList.add("hidden"); // fresh open = tip closed
    el("code-effort-pop")?.classList.toggle("hidden");
    syncEffortPop();
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
    if (opening) void renderCtxPop();
  });
  document.addEventListener("click", (e) => {
    const t = e.target as Node;
    if (!modeWrap.contains(t)) el("code-mode-menu")?.classList.add("hidden");
    if (!effortWrap.contains(t)) el("code-effort-pop")?.classList.add("hidden");
    if (modelWrap && !modelWrap.contains(t)) el("code-model-menu")?.classList.add("hidden");
    if (ctxWrap && !ctxWrap.contains(t)) el("code-ctx-pop")?.classList.add("hidden");
    const plusWrap = el("code-plus-wrap");
    if (plusWrap && !plusWrap.contains(t)) el("code-plus-menu")?.classList.add("hidden");
  });
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
// Run progress — elapsed · tokens painted onto the spinner every second.
let runStartAt = 0;
let runTokens = 0;
let runTicker: ReturnType<typeof setInterval> | null = null;
// This run's step lines, mirrored to the workbench Plan rail's timeline.
let runSteps: string[] = [];

function broadcastTimeline(running: boolean): void {
  try {
    document.dispatchEvent(new CustomEvent("william:timeline", { detail: { steps: [...runSteps], running } }));
  } catch { /* no listeners */ }
}

function fmtElapsed(ms: number): string {
  const s = Math.floor(ms / 1000);
  return s >= 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s}s`;
}

// While William sets himself up (first-run model download), the setup
// line owns the spinner meta; the token meter takes over once ready.
let setupMeta = "";

function paintRunMeta(): void {
  if (!runStartAt) return;
  if (setupMeta) { spinner?.setMeta(setupMeta); return; }
  spinner?.setMeta(`${fmtElapsed(Date.now() - runStartAt)} · ${runTokens.toLocaleString()} token${runTokens === 1 ? "" : "s"}`);
}

function startRunTicker(): void {
  runStartAt = Date.now();
  runTokens = 0;
  runSteps = [];
  broadcastTimeline(true);
  if (runTicker) clearInterval(runTicker);
  runTicker = setInterval(paintRunMeta, 1000);
}

function stopRunTicker(): void {
  if (runTicker) { clearInterval(runTicker); runTicker = null; }
  runStartAt = 0;
  runTokens = 0;
}
let menuEl: HTMLDivElement | null = null;

function el<T extends HTMLElement = HTMLElement>(id: string): T | null {
  return document.getElementById(id) as T | null;
}
const input = () => el<HTMLTextAreaElement>("code-input");

// ── Session store ────────────────────────────────────────────────────────
let storeLoaded = false;
/** Sessions live in main's disk store (userData/william/sessions.json) —
 *  localStorage's 5MB cap can't hold real coding sessions. First load
 *  migrates any legacy localStorage sessions up, then clears them. */
async function loadStore(): Promise<void> {
  if (storeLoaded) return;
  try {
    const s = await window.yo.williamSessionsLoad?.();
    chats = ((s?.chats as CodeChat[]) || []);
    currentId = String(s?.currentId || "");
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
  storeLoaded = true;
}
function saveStore(): Promise<void> {
  return Promise.resolve(window.yo.williamSessionsSave?.(chats, currentId)).then(() => undefined);
}
const current = (): CodeChat | null => chats.find((c) => c.id === currentId) ?? null;

function ensureCodeSection(): void {
  if (!document.querySelector('.help-section[data-section="code"].active')) gotoSection("code");
}

function newChat(): void {
  const c: CodeChat = { id: `c${Date.now().toString(36)}`, title: "New session", createdAt: Date.now(), messages: [] };
  chats.unshift(c);
  currentId = c.id;
  void saveStore();
  ensureCodeSection();
  // Fresh sessions start clean: all workbench rails closed, folder reset.
  (window as unknown as { __codeWorkbenchNewSession?: () => void }).__codeWorkbenchNewSession?.();
  renderHistory();
  renderThread();
  input()?.focus();  void checkWorkdirGate();
}

async function deleteChat(chat: CodeChat): Promise<void> {
  if (!(await confirmAction({
    title: `Delete “${chat.title}”?`,
    body: "This session's history is gone for good.",
    confirmLabel: "Delete session",
    danger: true,
  }))) return;
  chats = chats.filter((x) => x.id !== chat.id);
  if (currentId === chat.id) currentId = chats[0]?.id || "";
  void saveStore();
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
      void saveStore();
      ensureCodeSection();
      renderHistory();
      renderThread();
      refreshCtxMeter();
      void checkWorkdirGate();
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
  const liveRun = thinking && workingChatId === c.id;
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
      } else {
        el.className = "code-agent-text";
        el.innerHTML = formatMarkdown(b.msg.text);
      }
      inner.appendChild(el);
      return;
    }
    // The trailing group of an active run renders expanded (live progress).
    if (liveRun && i === blocks.length - 1) {
      for (const m of b.msgs) inner.appendChild(toolLineEl(m.text));
      return;
    }
    inner.appendChild(toolGroupEl(c.id, b.msgs));
  });
  // Working state — the streamed reply renders as plain agent text, and a
  // working spinner ALWAYS sits at the bottom while thinking (through tool
  // execution and inter-turn waits, not just before the first token).
  spinner?.destroy();
  spinner = null;
  streamBubble = null;
  if (thinking && workingChatId === c.id) {
    if (streamText && streamChatId === c.id) {
      streamBubble = document.createElement("div");
      streamBubble.className = "code-agent-text";
      streamBubble.innerHTML = formatMarkdown(streamText);
      inner.appendChild(streamBubble);
    }
    spinner = createGlyphhSpinner();
    paintRunMeta();
    const row = document.createElement("div");
    row.className = "code-working";
    row.appendChild(spinner.el);
    inner.appendChild(row);
  }
  thread.scrollTop = thread.scrollHeight;
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

  // "✓ Write /abs/path" → file card, click opens the file in Monaco.
  const write = /^([✓✕⚙]) Write (\/\S.*?)\s*$/.exec(rest);
  if (write && write[1] === "✓") {
    const path = write[2];
    const base = path.split("/").pop() || path;
    const dir = path.slice(0, path.length - base.length).replace(/\/$/, "");
    const card = document.createElement("button");
    card.type = "button";
    card.className = "code-file-card";
    card.dataset.path = path;
    card.title = "Open in the workbench editor";
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

function toolGroupEl(chatId: string, msgs: CodeMsg[]): HTMLElement {
  const key = `${chatId}:${msgs[0]?.at ?? 0}`;
  const open = expandedToolGroups.has(key);
  const wrap = document.createElement("div");
  wrap.className = "code-tool-group";
  const failed = msgs.filter((m) => m.text.startsWith("✕")).length;
  const head = document.createElement("button");
  head.type = "button";
  head.className = "code-tool-summary" + (open ? " open" : "");
  head.innerHTML = `<span></span><svg class="tg-chev" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>`;
  (head.firstChild as HTMLElement).textContent =
    `Ran ${msgs.length} tool call${msgs.length === 1 ? "" : "s"}${failed ? ` · ${failed} failed` : ""}`;
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

function paintComposerGate(): void {
  const ta = input();
  if (!ta) return;
  ta.disabled = !workdirReady;
  ta.placeholder = workdirReady
    ? "Describe the app to build…"
    : "Pick a working folder to start — click here to choose";
  el("code-send")?.toggleAttribute("disabled", !workdirReady);
  document.querySelector(".code-input-wrap")?.classList.toggle("gated", !workdirReady);
}

async function checkWorkdirGate(): Promise<void> {
  try {
    workdirReady = !!(await wb()?.getCwdExplicit?.());
  } catch { workdirReady = true; /* bridge missing — never brick the composer */ }
  paintComposerGate();
}

function initWorkdirGate(): void {
  void checkWorkdirGate();
  wb()?.onCwdChanged?.(() => { void checkWorkdirGate(); });
  // A click on the sleeping composer IS the ask — pop the picker (cancel
  // keeps the gate honest).
  document.querySelector(".code-input-wrap")?.addEventListener("click", () => {
    if (workdirReady) return;
    void wb()?.pickCwd?.({ nullOnCancel: true }).then(() => checkWorkdirGate());
  });
}

// ── Composer attachments ─────────────────────────────────────────────────
// Images (pasted screenshots, picked files), files, and folders queue as
// chips and ride the next send. Pasted image DATA saves to the user-scoped
// attachments dir in main; everything else is a path reference.
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
    const p = window.yo.getPathForFile(f);
    if (p) { paths.push(p); continue; }
    if (!f.type.startsWith("image/")) continue;
    try { refs.push(await window.yo.williamSaveClipboardImage(await f.arrayBuffer())); }
    catch { /* oversized/empty clipboard image — skip */ }
  }
  if (paths.length) refs.push(...await window.yo.williamClassifyPaths(paths));
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
        void window.yo.williamPickAttachments("files").then((refs) => { if (refs.length) queueAttachments(refs); });
      }),
      mkItem("Add folder…", "Give William read access to another directory", () => {
        void window.yo.williamPickAttachments("folder").then((refs) => { if (refs.length) queueAttachments(refs); });
      }),
    );
    plusWrap.appendChild(menu);
    el("code-plus-chip")?.addEventListener("click", (e) => {
      e.stopPropagation();
      el("code-mode-menu")?.classList.add("hidden");
      el("code-effort-pop")?.classList.add("hidden");
      el("code-model-menu")?.classList.add("hidden");
      el("code-ctx-pop")?.classList.add("hidden");
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
    const paths = Array.from(e.dataTransfer?.files ?? []).map((f) => window.yo.getPathForFile(f)).filter(Boolean);
    if (!paths.length) return;
    void window.yo.williamClassifyPaths(paths).then((refs) => { if (refs.length) queueAttachments(refs); });
  });
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
  if (!text && !pendingAttach.length) return;
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
  // `.remember <fact>` → William's persistent memory (memory.md), loaded
  // into every session's prompt prefix.
  const rem = /^\.remember\s+(.+)/is.exec(text);
  if (rem) {
    if (!current()) newChat();
    const cc = current()!;
    cc.messages.push({ role: "user", text, at: Date.now() });
    ta.value = "";
    autoGrow(ta);
    void window.yo.williamRemember?.(rem[1].trim())
      .then(() => cc.messages.push({ role: "assistant", text: "✓ Remembered — it rides along in every session now.", at: Date.now() }))
      .catch((err) => cc.messages.push({ role: "assistant", text: `⚠ ${err instanceof Error ? err.message : String(err)}`, at: Date.now() }))
      .then(() => { void saveStore(); renderHistory(); renderThread(); });
    return;
  }
  if (text.startsWith(".") && text.length > 1) {
    if (!current()) newChat();
    const cc = current()!;
    cc.messages.push({ role: "user", text, at: Date.now() });
    if (cc.title === "New session") cc.title = text.length > 42 ? text.slice(0, 42) + "…" : text;
    ta.value = "";
    autoGrow(ta);
    void window.yo.execCommand(text.slice(1).trim());
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
  // Working state first so the spinner row + rail dot paint immediately.
  startRunTicker();
  setThinking(true);
  renderHistory();
  renderThread();
  streamChatId = c.id;
  streamText = "";
  refreshCtxMeter();
  // Main assembles the prompt from the store — the save must land first.
  // A session must run inside a folder the user chose: the first send on a
  // fresh setup pops the OS folder picker, then the run proceeds.
  const launch = (retried: boolean): Promise<void> =>
    window.yo.williamRun({ chatId: c.id, attachments })
      .then((r) => { activeRunId = r.runId; })
      .catch(async (err) => {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes("NO_WORKDIR") && !retried) {
          await (window as unknown as { wb?: { pickCwd?: () => Promise<string | null> } }).wb?.pickCwd?.();
          return launch(true);
        }
        if (msg.includes("NO_WORKDIR")) {
          finishRun("⚠ Pick a working folder to start — William works inside the folder you choose (folder button at the top of this pane).");
          return;
        }
        finishRun(`⚠ ${msg}`);
      });
  void saveStore().then(() => launch(false));
}

// Stopping isn't failure — it's a choice. All peace, no violence.
const STOP_LINES = [
  "You paused the vibe — William set his tools down gently.",
  "Peace restored. Everything finished so far stays yours.",
  "The loop rests — happy to pick this back up whenever.",
  "Gently stopped. William tucked the work away, mid-glyph.",
  "You called it — William bowed out with grace.",
  "Stillness. The trail so far is saved.",
];

/** Land the run's outcome in its chat (found by id — the user may have
 *  switched sessions mid-stream) and reset the working state. */
function finishRun(text: string, stopped = false): void {
  const chat = chats.find((ch) => ch.id === streamChatId);
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
  activeRunId = null;
  streamChatId = null;
  streamText = "";
  streamBubble = null;
  askQueue = [];
  paintAskDock();
  broadcastTimeline(false);
  stopRunTicker();
  setThinking(false);
  renderThread();
  refreshCtxMeter();
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
  if (!item) return;

  if (item.type === "approval") {
    dock.appendChild(dockHead(item.kind, "warn", item));
    const title = document.createElement("div");
    title.className = "cad-title";
    title.textContent = item.title;
    dock.appendChild(title);
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
        void window.yo.williamApprovalRespond?.(item.id, allow);
        askDockShift();
      });
      return b;
    };
    actions.append(mk("Deny", false, "secondary"), mk("Approve", true, "primary"));
    dock.appendChild(actions);
    return;
  }

  // Agent question — options as one-click answers plus a custom input.
  const q = item.questions[item.step];
  dock.appendChild(dockHead("William asks", "ask", item));
  const title = document.createElement("div");
  title.className = "cad-title";
  title.textContent = q.question;
  dock.appendChild(title);
  const answer = (value: string) => {
    item.answers[item.step] = value;
    item.step += 1;
    if (item.step >= item.questions.length) {
      void window.yo.williamAskRespond?.(item.id, item.questions.map((_x, i) => item.answers[i] ?? ""));
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
  skip.title = "Answer nothing — William proceeds on his best judgment";
  skip.addEventListener("click", () => answer(""));
  custom.append(inp, sendBtn, skip);
  dock.appendChild(custom);
  if (!q.options?.length) inp.focus();
}

/** Wire the stream events once — deltas paint the live bubble (or just
 *  accumulate when another session is in view). */
function initWilliamEvents(): void {
  window.yo.onWilliamSetup?.((d) => {
    if (d.phase === "downloading") {
      setupMeta = `Downloading ${d.model || "William"} — ${d.pct ?? 0}%${d.totalGB ? ` (${d.receivedGB ?? 0}/${d.totalGB}GB)` : ""}`;
    } else if (d.phase === "manifest") {
      setupMeta = "Fetching model manifest…";
    } else if (d.phase === "building") {
      setupMeta = String((d as { text?: string }).text || "");
    } else if (d.phase === "preview") {
      const { html, label } = d as { html?: string; label?: string };
      if (html) {
        const stub = `<script>window.glyphh={call:async()=>({ok:false,error:"preview"}),app:{slug:"preview"}};</script>`;
        const doc = html.includes("<head>") ? html.replace("<head>", `<head>${stub}`) : stub + html;
        (window as unknown as { __wbPreviewHtml?: (h: string, l?: string) => void }).__wbPreviewHtml?.(doc, label);
      }
    } else {
      setupMeta = "";
    }
    paintRunMeta();
  });
  window.yo.onWilliamProgress?.((d) => {
    if (activeRunId && d.runId !== activeRunId) return;
    runTokens = d.tokens;
    paintRunMeta();
  });
  window.yo.onWilliamApproval?.((a) => {
    askQueue.push({ type: "approval", ...a });
    paintAskDock();
  });
  window.yo.onWilliamAsk?.((d) => {
    askQueue.push({ type: "ask", id: d.id, questions: d.questions, answers: [], step: 0 });
    paintAskDock();
  });
  // Agent-loop activity → compact breadcrumb rows in the thread (persisted,
  // so a re-render or restart keeps the run's story).
  window.yo.onWilliamTool?.((d) => {
    if (activeRunId && d.runId !== activeRunId) return;
    const chat = chats.find((ch) => ch.id === streamChatId);
    if (!chat) return;
    if (d.phase === "start") runSteps.push(`⚙ ${d.name}${d.thought ? ` — ${d.thought}` : ""}`);
    else if (d.phase === "done" && runSteps.length) {
      runSteps[runSteps.length - 1] = `${d.denied || d.failed ? "✕" : "✓"} ${d.title || d.name}`;
    }
    broadcastTimeline(true);
    if (d.phase === "start") {
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
    if (currentId === streamChatId) renderThread();
  });
  // Streamed tokens re-render the live block as MARKDOWN, throttled to one
  // paint per animation frame — smooth at token rate, code fences and lists
  // take shape as they arrive.
  let streamPaintQueued = false;
  const paintStream = () => {
    streamPaintQueued = false;
    const thread = el<HTMLDivElement>("code-thread");
    if (streamBubble && streamBubble.isConnected) {
      streamBubble.innerHTML = formatMarkdown(streamText);
      if (thread) thread.scrollTop = thread.scrollHeight;
    } else {
      renderThread(); // first token — adds the live block under the spinner
    }
  };
  window.yo.onWilliamDelta?.((d) => {
    if (activeRunId && d.runId !== activeRunId) return;
    streamText += d.delta;
    if (currentId === streamChatId && !streamPaintQueued) {
      streamPaintQueued = true;
      requestAnimationFrame(paintStream);
    }
  });
  window.yo.onWilliamDone?.((d) => {
    if (activeRunId && d.runId !== activeRunId) return;
    finishRun(streamText, d.stopped);
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
    if (q) {
      renderAdaFallback(list, q);
    } else {
      const empty = document.createElement("div");
      empty.className = "code-empty";
      empty.style.margin = "10px auto";
      empty.textContent = "Your apps land here.";
      list.appendChild(empty);
    }
  }
}

// ── Ada fallback — nothing matched by name, so ask fact memory by
//    meaning ("email" finds gmail; "purple effect" finds the drip). A hit
//    that carries an open_app/open_layout handle opens on click;
//    everything else drops into the composer as context. ──
let adaSearchSeq = 0;
function renderAdaFallback(list: HTMLElement, q: string): void {
  const seq = ++adaSearchSeq;
  const empty = document.createElement("div");
  empty.className = "code-empty";
  empty.style.margin = "10px auto";
  empty.textContent = "No matches.";
  list.appendChild(empty);
  void window.yo.adaRecall?.(q, 5).then((hits) => {
    if (seq !== adaSearchSeq || !hits?.length || !empty.isConnected) return;
    empty.textContent = "From Ada:";
    for (const h of hits) {
      const row = document.createElement("button");
      row.type = "button";
      row.className = "ada-hit";
      row.textContent = h.content.length > 90 ? `${h.content.slice(0, 90)}…` : h.content;
      row.title = h.content;
      row.addEventListener("click", () => {
        const m = /open_(?:app|layout)\("([^"]+)"\)/.exec(h.content);
        if (m) {
          void window.yo.execCommand(`dip ${m[1]}`);
        } else {
          const ta = input();
          if (ta) { ta.value = h.content; ta.focus(); autoGrow(ta); }
        }
      });
      list.appendChild(row);
    }
  }).catch(() => { /* Ada quiet — plain empty state stands */ });
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
  void (async () => {
    await loadStore();
    if (!currentId && chats.length) currentId = chats[0].id;
    renderHistory();
    renderThread();
    refreshCtxMeter();
    void checkWorkdirGate();
  })();
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
  wireComposerAttachments();
  initWilliamEvents();
  initWorkdirGate();
  initComposerControls();
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
  // loadStore is ASYNC: render only after the sessions actually arrive, or
  // boot paints an empty Recents that never refreshes until the Code tab
  // re-runs loadCode().
  void (async () => {
    await loadStore();
    if (!currentId && chats.length) currentId = chats[0].id;
    renderHistory();
  })();
  void loadRecentApps();
  void applyPanelPrefs();
}
