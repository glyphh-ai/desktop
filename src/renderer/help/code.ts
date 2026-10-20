/**
 * Code — the Glyphh agent surface: agent | workbench rails (sessions live
 * in the Coding Agent panel's history dropdown).
 *
 * Sessions persist in main's chat file via help/thread-store.ts. Replies stream from the local Glyphh model (llama-server,
 * glyphh-agent.ts bridge) — prompt → thinking spinner → streamed response. The right side is the REAL old
 * workbench (code-workbench-bundle.js — Files / Terminal / Diff / Preview /
 * Plan rails with insert/drag/maximize + per-folder layout persistence); the
 * center header carries its workdir controls and view toggles.
 */

import { threadLocus } from "./thread-locus.js";
import {
  LOCUS_FILTER_PREF, LOCUS_OPTIONS, LOCUS_SVG, LOCUS_TITLE, LOCK_SVG, GRANT_CARD,
  locusFilterOf, recentsKeeps, recentsFilterActive, sourceLocus, LOOP_FILTER_PREF, loopFilterOf,
  type Locus, type LocusFilter, type RecentsFilter, type RecentsRowLike, newSessionSource,
  folderAfterPick, sessionIsBlank,
} from "./session-locus.js";
import { placeFixedMenu } from "./menu-place.js";
import { yoConfirm } from "../yo-modal.js";
import { showDropDetail, confirmAction, confirmChoice, placeDropup } from "./shared.js";
import { appIconInner, primeNativeIcons, GLYPHH_MASCOT_SRC } from "./app-icon.js";
import { visibleAppRows } from "./app-list.js";
import { gotoSection, closeSettingsModal, openSettingsModal, openGroupTab } from "./navigation.js";
import { turnError } from "./turn-errors.js";
import { createGlyphhSpinner, type GlyphhSpinner } from "../glyphh-spinner.js";
import { formatMarkdown, streamStableCut } from "../format-markdown.js";
import { artifactCardEl, artifactFromTool, openArtifactModal, type ArtifactRef } from "./artifacts.js";
import { stepEl, summaryOf, trimForStore, type ToolDetail, type ToolRec } from "./tool-view.js";
import { initVoiceMic, registerComposerSubmit, renderMicMenu, onTurnComplete, maybeSpeakFirstLine, briefSteer, voiceState, onVoiceState, cancelRecording, acceptRecording, stopHandsFree, refreshMicChip } from "./voice-mic.js";
import { composerSlot, composerListening, LISTENING_PLACEHOLDER } from "./composer-state.js";
import { onSpeaking, stopReply, isSpeaking } from "./voice-out.js";
import { attachSlashMenu } from "./slash-menu.js";
import { initAnchor, initAnchorEvents, isPeeking, togglePeek, closePeek } from "./code-anchor.js";
// The chat ⇄ CLI-session binding rules — pure, shared, and under test.
import { applyCliBinding, chatForCliSession, cliSidFor, forgetCliSession, sessionCliOf, type CliBound } from "./cli-session-binding.js";
import {
  CLI_DEFAULT_MODEL_LABEL, CLI_GATEWAY_PREF, DEFAULT_LOOP_PREF, LOOP_BLURBS, LOOP_IDS, LOOP_NAMES, ROUTE_HINTS, ROUTE_LABELS, cliModelChoices, coerceMode,
  defaultLoopOf, gatewayBlockedWhy, isVendorLoop, modelLaneOf, modelSlotOf, modesOf, resolveRoute, settle, type ModelLane, type RouteLoop,
} from "./cli-loops.js";
import type { CliAgentRow, CliRoute, CliRouteHints } from "./cli-types.js";
import { CLI_MARK_URLS } from "./cli-marks.js";
import { sessionDisplayTitle, placeholderTitle, mayGenerateTitle, titleRequestBody, fetchSessionTitle } from "./session-title.js";
import { pickUtilityModel } from "./utility-model.js";
import { toastOk, toastError } from "./toast.js";
import { RAIL_SHOW_LAYOUTS_PREF, RAIL_SHOW_DEFAULT, RAIL_SECTIONS_CHANGED_EVENT, railTrayShown, RAIL_LAYOUTS_H_PREF, RAIL_LAYOUTS_MIN_H, clampRailLayoutsH } from "./wall-prefs.js";
import { openCreateWorkspaceModal, openEditWorkspaceModal } from "./workspace-create.js";
import { hostHas, onWeb } from "./web-surface.js";
import { mountAgentMenu } from "./agent-menu-ui.js";
import { mountComposerPlus, manageTargetOf, PLUS_CHECK, type ManageTarget, type PlusApi, type PlusController } from "./composer-plus.js";
import { createSourceChip, type Source, openFolderLocusPicker, openNewFolderDrop, closeAllDrops, gitStateFor, probeSources, drillItem, CHECK } from "./code-source-chip.js";
import { picksOf, environmentIdOf } from "./cloud-source.js";
import { groupByDate } from "./recents-groups.js";
import { APPROVAL_TIMEOUT_MS, ASK_TIMEOUT_MS, parseOpenRef } from "./run-frames.js";
import * as threadStore from "./thread-store.js";
import { uiSound } from "./ui-sounds.js";
import { startNavBadges } from "./nav-badges.js";
import { greeting } from "./dashboard.js";
import { pickGreeting, firstNameOf } from "./landing-greeting.js";
import { artifactStandingLine } from "./artifact-rules.js";

interface AttachRef { kind: "image" | "file" | "folder"; path: string; name: string }
/** `kind` "connect" and "app" are rows an older build stored (an account to
 *  connect, a cloud app card); they hold nothing to draw and are skipped. */
interface CodeMsg { role: "user" | "assistant"; text: string; at: number; /** The turn's timing line (ready · first token · tok/s · total), kept with the answer. */ timing?: string; kind?: "tool" | "decline" | "connect" | "artifact" | "app"; attachments?: AttachRef[]; /** The model's thinking before this answer, folded above it. */ thinking?: string; decline?: { kind: string; url: string; cli?: string; command?: string }; artifact?: ArtifactRef; /** A step's own record — what it did, drawn by tool-view.ts. */ tool?: ToolRec }
interface CodeChat {
  id: string; title: string; createdAt: number; messages: CodeMsg[];
  /** The folder THIS session works in — stamped by its layout or by the pick
   *  made while it was current. Absent → the global workspace folder. */
  workdir?: string;
  /** Pinned sessions float to the top of the history dropdown. */
  pinned?: boolean;
  /** LEGACY flag (pre-mode) — kept for back-compat with old stored sessions. */
  chat?: boolean;
  /** THIS SESSION'S TYPE (his order, 2026-09-29: "bring the two types back…
   *  Each chat should carry a type"). Two of them now — Chat and Code — and the
   *  type decides the toolbelt the turn carries, which is the whole point: a
   *  simple question should not haul fifty tool definitions into the prompt.
   *  "cowork" is the retired third space; it reads as Code (it was the
   *  tool-using one). Written at birth from the rail's active tab, never
   *  flipped on an existing thread. */
  mode?: "work" | "code" | /** legacy stamps, read as Work */ "chat" | "cowork";
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
  /** The session's PERMISSION MODE (ask/plan/acceptEdits/auto/bypass) — bound to
   *  the SESSION, not the device, so every surface viewing this session agrees and
   *  a mid-run flip is pushed to the running turn. Absent → the device default
   *  (last-used, `defaultMode`). Cached locally per session; a live change also
   *  rides the run-stream so observers repaint the chip. */
  permission?: (typeof MODES)[number]["id"];
  /** The merge clock of main's chat file — stamped by thread-store on every
   *  content change (epoch ms). */
  updatedAt?: number;
  /** THIS session's model bindings (slot name → model id) — stamped by the
   *  layout that opened it or by a pick made while it was current. Sessions
   *  run their bindings independently: changing the model here never touches
   *  another session (his rule, 2026-08-20). Absent → the ambient loop pick. */
  models?: Record<string, string>;
  /** THIS session's agent LOOP (rotor id) — same per-session contract as
   *  `models`: the workspace that opened it (or a pick made while current)
   *  binds it; other sessions run their own loops untouched. */
  loop?: string;
  /** The CLI's own session for each CLI lane this chat ran on — what a turn
   *  resumes and the >_ hop opens (help/cli-session-binding.ts). */
  cliSessionIds?: Record<string, string>;
  /** Legacy single slot, the claude lane only. */
  cliSessionId?: string;
  /** THIS session's route pick on a CLI loop (the composer's route chip);
   *  absent leaves it to the workspace, then the member's default. */
  route?: CliRoute;
  /** The route the workspace that opened this session asked for: its agent
   *  cell's, then its own; null = no opinion at that level. */
  routeHints?: { cell?: boolean | null; layout?: boolean | null };
  /** GENERATED TITLES (his order, 2026-10-05: do the same as Claude's titles).
   *  `titleLocked`: the member renamed it by hand — never overwritten.
   *  `titleGenerated`: the one side request was made (in flight or done).
   *  Both kept with the session in main's chat file. */
  titleLocked?: boolean;
  titleGenerated?: boolean;
  /** THE ARTIFACT IN HAND (his order, 2026-10-05): set by the artifact
   *  viewer's "Start chat" / "Send to Glyphh"; its id rides the hidden steer
   *  (artifact-rules.ts artifactStandingLine), never the visible message. */
  artifactRef?: { id: string; name: string };
}

/** The head's session glyph — one type, one mark. */
const SESSION_GLYPH = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 6 4 12 9 18"/><polyline points="15 6 20 12 15 18"/></svg>`;
/** ONE TYPE (his order, 2026-10-08: "just code that is it"): every thread
 *  carries the one toolbelt; the stored `mode` is written "code" for the
 *  thread contract and never read for a decision. */
const SESSION_MODE = "code" as const;

const STORE_KEY = "codeChats";
const CURRENT_KEY = "codeCurrentChat";


// ── Permission modes + effort (composer controls) ────────────────────────
// Mode: a drop-UP menu (checkmark marks the selection; Shift+Tab cycles).
// Effort: far right — a drop-up dial, Faster → Smarter (renderLevelPop).
const MODES = [
  { id: "ask", label: "Ask mode", hint: "Every action needs your approval" },
  { id: "plan", label: "Plan mode", hint: "Read-only — Glyphh plans, changes nothing" },
  { id: "acceptEdits", label: "Accept edits", hint: "File edits auto-approved; commands still ask" },
  { id: "auto", label: "Auto mode", hint: "Everything runs without asking — full auto" },
] as const;
// The ⓘ explainer — what each mode ACTUALLY gates (mirrors the enforcement
// in glyphh-agent-permissions.ts: reads are always free; the mode decides the rest).
const MODE_DETAILS: Record<(typeof MODES)[number]["id"], string> = {
  ask: "The safest mode. Glyphh can read files freely, but every change — file edits, shell commands, and calls to your connected accounts — pops an approval card above the composer before it runs. Nothing happens without your explicit yes.",
  plan: "Strictly read-only. Glyphh can explore the folder, search, and reason, but every edit, command, or account call is refused outright — it tells you what it WOULD do instead. Use it to get a plan or a review you can act on in another mode.",
  acceptEdits: "File edits inside the working folder run without asking, so refactors flow uninterrupted. Everything else — shell commands, and anything that leaves your machine (connected-account calls, network) — still stops for approval.",
  auto: "Full auto — no gates at all. Every action runs without asking: edits, shell commands, connected-account calls, and dangerous commands alike. Use it for sessions you trust to run unattended end to end.",
};
// ── Effort (his order, 2026-09-20; restored 2026-10-04): the dial Claude's app
// has, at the right end of the composer bar. Five steps, Faster → Smarter; the
// top step is Ultra and the track lights up. ONE preference (`effort`, default
// medium) for every turn — there is one loop — sent as the turn's effort; the
// chip stays visible and dims when the model on the chip takes one effort.
const EFFORTS = [
  { id: "low", label: "Low" },
  { id: "medium", label: "Medium" },
  { id: "high", label: "High" },
  { id: "xhigh", label: "Extra high" },
  { id: "max", label: "Ultra" },
] as const;
type EffortId = (typeof EFFORTS)[number]["id"];
const EFFORT_PREF = "effort";
const EFFORT_HELP = "Higher effort means more thorough responses, but takes longer and uses your limits faster.";
const isEffort = (v: unknown): v is EffortId => EFFORTS.some((e) => e.id === v);
let effort: EffortId = "medium";
let effortLoaded = false;
async function loadEffort(): Promise<void> {
  if (effortLoaded) return;
  effortLoaded = true;
  try {
    const v = await window.glyphh.getPreference?.(EFFORT_PREF, "medium");
    if (isEffort(v)) effort = v;
  } catch { /* the default */ }
}
/** The effort the NEXT turn sends. */
function currentEffort(): EffortId { return effort; }
function setEffort(id: EffortId): void {
  effort = id;
  void window.glyphh.setPreference?.(EFFORT_PREF, id);
  paintLevelChip();
}
/** The model the chip names: the session's pick, else what Default resolves to. */
function chipModel(): AvailModel | null { return selectedModel() ?? rowForPick(resolvedDefaultModel()); }
/** Does that model take an effort? The server flags it; an older server (no
 *  flag) is read as yes, so the dial is never hidden by a missing field. */
function modelTakesEffort(): boolean {
  // On its own login a CLI takes the dial only where it has one (claude --effort, codex model_reasoning_effort).
  if (activeLane() === "cli") return activeCli() === "claude" || activeCli() === "codex";
  return chipModel()?.reasoning !== false;
}
function paintLevelChip(): void {
  const chip = el("code-level-chip");
  if (!chip) return;
  const e = EFFORTS.find((x) => x.id === currentEffort()) ?? EFFORTS[1];
  const takes = modelTakesEffort();
  chip.textContent = e.label;
  chip.classList.toggle("ultra", takes && e.id === "max");
  chip.classList.toggle("dim", !takes);
  chip.setAttribute("aria-disabled", takes ? "false" : "true");
  chip.title = takes ? "Effort" : "This model has one effort";
}
function renderLevelPop(): void {
  const pop = el("code-level-pop");
  if (!pop) return;
  pop.textContent = "";
  const idx = Math.max(0, EFFORTS.findIndex((e) => e.id === currentEffort()));
  const head = document.createElement("div");
  head.className = "code-drop-head level-head";
  const headLabel = document.createElement("span");
  headLabel.innerHTML = `Effort <b class="level-name"></b>`;
  const info = document.createElement("button");
  info.className = "drop-info-btn";
  info.type = "button";
  info.title = "About effort";
  info.textContent = "i";
  head.append(headLabel, info);
  pop.appendChild(head);
  const help = document.createElement("div");
  help.className = "drop-detail-body level-help hidden";
  help.textContent = EFFORT_HELP;
  pop.appendChild(help);
  info.addEventListener("click", (ev) => { ev.stopPropagation(); help.classList.toggle("hidden"); });
  const scale = document.createElement("div");
  scale.className = "level-scale";
  scale.innerHTML = `<span>Faster</span><span>Smarter</span>`;
  pop.appendChild(scale);
  const track = document.createElement("div");
  track.className = "level-track";
  track.tabIndex = 0;
  track.setAttribute("role", "slider");
  track.setAttribute("aria-valuemin", "0");
  track.setAttribute("aria-valuemax", String(EFFORTS.length - 1));
  const fill = document.createElement("span"); fill.className = "level-fill"; track.appendChild(fill);
  EFFORTS.forEach((e, i) => {
    const dot = document.createElement("span");
    dot.className = "level-dot";
    dot.style.left = `${(i / (EFFORTS.length - 1)) * 100}%`;
    dot.title = e.label;
    track.appendChild(dot);
  });
  const thumb = document.createElement("span"); thumb.className = "level-thumb"; track.appendChild(thumb);
  pop.appendChild(track);
  const paint = (i: number): void => {
    const e = EFFORTS[i];
    (head.querySelector(".level-name") as HTMLElement).textContent = e.label;
    head.classList.toggle("ultra", e.id === "max");
    track.classList.toggle("ultra", e.id === "max");
    track.setAttribute("aria-valuenow", String(i));
    const pct = (i / (EFFORTS.length - 1)) * 100;
    thumb.style.left = `${pct}%`;
    fill.style.width = `${pct}%`;
    track.querySelectorAll<HTMLElement>(".level-dot").forEach((d, j) => d.classList.toggle("on", j <= i));
  };
  const choose = (i: number): void => {
    const e = EFFORTS[Math.max(0, Math.min(EFFORTS.length - 1, i))];
    setEffort(e.id);
    paint(EFFORTS.indexOf(e));
  };
  const stepAt = (clientX: number): number => {
    const r = track.getBoundingClientRect();
    const x = Math.max(0, Math.min(1, (clientX - r.left) / Math.max(1, r.width)));
    return Math.round(x * (EFFORTS.length - 1));
  };
  let dragging = false;
  track.addEventListener("pointerdown", (ev) => { ev.stopPropagation(); dragging = true; track.setPointerCapture(ev.pointerId); choose(stepAt(ev.clientX)); });
  track.addEventListener("pointermove", (ev) => { if (dragging) choose(stepAt(ev.clientX)); });
  const stop = (): void => { dragging = false; };
  track.addEventListener("pointerup", stop);
  track.addEventListener("pointercancel", stop);
  track.addEventListener("keydown", (ev) => {
    const cur = Math.max(0, EFFORTS.findIndex((e) => e.id === currentEffort()));
    if (ev.key === "ArrowRight" || ev.key === "ArrowUp") { ev.preventDefault(); choose(cur + 1); }
    else if (ev.key === "ArrowLeft" || ev.key === "ArrowDown") { ev.preventDefault(); choose(cur - 1); }
  });
  pop.addEventListener("mousedown", (ev) => ev.stopPropagation());
  paint(idx);
}
// THE ONE LOOP (his order, 2026-09-28: "no cli switching etc"). A session used
// to carry the id of the CLI pre-config that ran it, and the composer had a
// chip to change it. There is one loop now — ours — so the id is a constant and
// the chip is gone; a stored `loop` on an old chat is simply ignored.
const GLYPHH_LOOP = "glyphh";

// ── The loop: which engine runs the session ──────────────────────────────
// Glyphh's own loop, or a vendor CLI the user signed in to (main's
// cli-agents.ts serves the roster). A session is bound to its loop for life:
// a CLI's context cannot move to another CLI, so picking another loop on a
// session with turns opens a new session instead (setLoop).

/** The loops as `cli-agents-list` serves them; Glyphh alone until it answers. */
let loopRows: CliAgentRow[] = [];
/** A chat model the local router can call exists — the gateway route can run. */
let gatewayReady = false;
/** Settings › General: route the CLIs through the user's providers by default. */
let gatewayDefault = false;
/** Settings › General: the loop a new session opens on ("" = Glyphh). */
let defaultLoopPref = "";
/** A loop, route or workspace route asked for while no session existed (a
 *  workspace open, a pick on the landing): the session the next send creates
 *  is born with them. */
let pendingLoop = "";
let pendingRoute: CliRoute | null = null;
let pendingRouteHints: { cell?: boolean | null; layout?: boolean | null } | null = null;

/** The loops the member has on; Glyphh is always one of them. */
function enabledLoopIds(): string[] {
  const on = loopRows.filter((r) => r.enabled).map((r) => r.id as string);
  return on.length ? on : [GLYPHH_LOOP];
}
/** The loop a session with none of its own opens on. */
function ambientLoop(): string { return defaultLoopOf(defaultLoopPref, enabledLoopIds()); }
/** The loop THIS session runs: its own binding, then a pending ask, then the default. */
function activeLoop(): string { return current()?.loop || pendingLoop || ambientLoop(); }
function loopRowOf(id: string): CliAgentRow | undefined { return loopRows.find((r) => r.id === id); }
function loopName(id: string): string { return loopRowOf(id)?.name || LOOP_NAMES[id as keyof typeof LOOP_NAMES] || id; }
/** The CLI a loop runs (the binding's lane key, the model list's vocabulary). */
function cliOfLoop(id: string): string { return sessionCliOf(id, loopRows); }
/** The CLI of the session on screen. */
function activeCli(): string { return cliOfLoop(activeLoop()); }
/** A loop as the route rules read it; before the roster loads, Claude is the one the router carries. */
function routeLoopOf(id: string): RouteLoop | undefined {
  const r = loopRowOf(id);
  if (r) return { cli: r.cli, name: r.name, gatewayCapable: r.gatewayCapable };
  const cli = cliOfLoop(id);
  return isVendorLoop(cli) ? { cli, name: loopName(id), gatewayCapable: cli === "claude" } : undefined;
}
/** Where a session's route was chosen: its own pick, then its workspace's. */
function routeHintsOf(c: CodeChat | null | undefined): CliRouteHints {
  const own = c ? c.route : pendingRoute;
  const ws = c ? c.routeHints : pendingRouteHints;
  return { session: own ? own === "gateway" : null, cell: ws?.cell ?? null, layout: ws?.layout ?? null };
}
/** The route a turn of this chat takes — the same rule main applies at launch. */
function routeOf(c: CodeChat | null | undefined): CliRoute {
  const loop = c?.loop || (c ? GLYPHH_LOOP : activeLoop());
  return resolveRoute(routeLoopOf(loop), routeHintsOf(c), gatewayDefault, gatewayReady);
}
/** Whose model names the picker lists for this chat: the router's, or the CLI's own. */
function laneOf(c: CodeChat | null | undefined): ModelLane {
  const loop = c?.loop || (c ? GLYPHH_LOOP : activeLoop());
  return modelLaneOf(cliOfLoop(loop), routeOf(c));
}
function activeLane(): ModelLane { return laneOf(current()); }

/** The roster, the gateway's readiness and the member's defaults, re-read. */
async function refreshLoops(): Promise<void> {
  try {
    const [r, pref] = await Promise.all([
      settle(window.glyphh.cliAgentsList?.(), null),
      settle(window.glyphh.getPreference?.(DEFAULT_LOOP_PREF, ""), ""),
    ]);
    defaultLoopPref = typeof pref === "string" ? pref : "";
    if (r?.ok) {
      loopRows = r.agents;
      gatewayReady = !!r.gatewayReady;
      gatewayDefault = !!r.gatewayDefault;
    }
  } catch { /* offline: Glyphh alone stands */ }
  paintChips();
  paintModelChip();
}

/** Another loop on a session that already has turns is a new session — the
 *  old one stays in recents on its own loop. */
function loopSwitchStartsNewSession(id: string): boolean {
  const c = current();
  return !!c && c.messages.length > 0 && (c.loop || GLYPHH_LOOP) !== id;
}

function setLoop(id: string): void {
  if (loopSwitchStartsNewSession(id)) {
    // The new session is born on the next send, on this loop; the panel and
    // every panel around it stay as they are.
    currentId = "";
    lastSession = "";
    void window.glyphh.setPreference?.(LAST_SESSION_PREF, "");
    void saveStore();
    syncSpaceAttrs();
    renderHistory();
    renderThread();
    pendingLoop = id;
  } else {
    const c = current();
    if (c) { c.loop = id; void saveStore(); } else pendingLoop = id;
  }
  // A loop declares its own modes, route and model vocabulary: every chip follows.
  paintChips();
  renderModeMenu();
  void refreshModelList();
}

/** The session's own route pick on a CLI loop. */
function setRoute(route: CliRoute): void {
  const c = current();
  if (c) { c.route = route; void saveStore(); } else pendingRoute = route;
  paintChips();
  void refreshModelList();
}
// The DEVICE default mode — the last mode the user picked, seeded onto a NEW
// session so a fresh chat opens in the mode they habitually use. Persisted as the
// `glyphhMode` preference (kept for back-compat with older builds). The EFFECTIVE
// mode is per-SESSION: `currentMode()` reads the current chat's `permission`,
// falling back to this default. `glyphhMode` mirrors the effective mode of the
// chat on screen so the many read sites (chip paint, run launch) stay a plain read.
let defaultMode: (typeof MODES)[number]["id"] = "ask";
let glyphhMode: (typeof MODES)[number]["id"] = "ask";

/** The current session's mode, or the device default when there is no session /
 *  the session never set one. */
function currentMode(): (typeof MODES)[number]["id"] {
  const c = current();
  // Legacy sessions stamped "bypass" (the retired fifth mode) read as auto —
  // auto IS full auto now.
  const m = (c?.permission as string) === "bypass" ? "auto" : c?.permission;
  return m && MODES.some((x) => x.id === m) ? m : defaultMode;
}

/** Re-sync `glyphhMode` (the on-screen mirror) to the current session and repaint
 *  the chip. Call after any session switch or an external mode change. */
function syncModeChip(): void {
  glyphhMode = currentMode();
  paintChips();
  renderModeMenu();
}
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
    // Mirror the on-screen mode to the current session before painting, so the
    // chip always reflects the session in view (not the last one touched).
    glyphhMode = currentMode();
    // A mode this loop cannot honor is not a mode: the session moves to the
    // nearest one it can, so the chip never says one thing while the turn
    // sends another.
    const fixed = coerceMode(glyphhMode, modesOf(loopRowOf(activeLoop())));
    if (fixed !== glyphhMode) {
      glyphhMode = fixed;
      const c = current();
      if (c && c.permission !== fixed) { c.permission = fixed; void saveStore(); }
    }
    const m = MODES.find((x) => x.id === glyphhMode) ?? MODES[0];
    mc.textContent = m.label;
    mc.title = `${m.hint} — Shift+Tab cycles`;
    mc.className = `code-chip mode-${m.id}`;
  }
}

const DROP_CHECK = `<svg class="drop-check" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`;

/** What the + menu's Loop section shows: the session's loop, and on a CLI
 *  loop its route. Null on the web, where Glyphh's own loop runs alone. */
function loopSectionState(): { name: string; route: string | null } | null {
  if (onWebTarget()) return null;
  const id = activeLoop();
  return { name: loopName(id), route: isVendorLoop(activeCli()) ? ROUTE_LABELS[routeOf(current())] : null };
}

/** The Loop pane: every loop the member has on (its mark, its name beside it,
 *  one line under), and on a session with turns the note that another loop
 *  starts a new session. */
function fillLoopList(menu: HTMLElement, done: () => void): void {
  const ids = enabledLoopIds();
  for (const id of LOOP_IDS.filter((x) => ids.includes(x))) {
    const item = document.createElement("button");
    item.type = "button";
    const on = id === activeLoop();
    item.className = "code-drop-item drop-item-2line loop-drop-item" + (on ? " selected" : "");
    const main = document.createElement("div");
    main.className = "drop-main loop-drop-main";
    main.appendChild(loopMarkEl(cliOfLoop(id)));
    const name = document.createElement("span");
    name.textContent = loopName(id);
    main.appendChild(name);
    if (on) appendMarkup(main, DROP_CHECK);
    const sub = document.createElement("span");
    sub.className = "drop-sub loop-drop-sub";
    const boundary = !on && loopSwitchStartsNewSession(id);
    sub.textContent = boundary ? "Starts a new session — this one stays in Recents" : LOOP_BLURBS[id];
    if (boundary) item.classList.add("loop-drop-boundary");
    item.append(main, sub);
    item.addEventListener("click", (e) => {
      e.stopPropagation();
      done();
      if (!on) setLoop(id);
    });
    menu.appendChild(item);
  }
  const manage = document.createElement("button");
  manage.type = "button";
  manage.className = "code-drop-item loop-drop-manage";
  manage.textContent = "Manage loops…";
  manage.addEventListener("click", (e) => { e.stopPropagation(); done(); openSettingsModal("loops"); });
  menu.appendChild(manage);
}

/** The Route pane: Direct and Gateway, the gateway greyed with the reason
 *  when the loop or the setup cannot take it. */
function fillRouteList(menu: HTMLElement, done: () => void): void {
  const now = routeOf(current());
  const why = gatewayBlockedWhy(routeLoopOf(activeLoop()), gatewayReady);
  for (const r of ["direct", "gateway"] as const) {
    const blocked = r === "gateway" && !!why;
    const item = document.createElement("button");
    item.type = "button";
    item.className = "code-drop-item drop-item-2line" + (r === now ? " selected" : "") + (blocked ? " disabled" : "");
    item.disabled = blocked;
    const main = document.createElement("div");
    main.className = "drop-main";
    const name = document.createElement("span");
    name.textContent = ROUTE_LABELS[r];
    main.appendChild(name);
    if (r === now) appendMarkup(main, DROP_CHECK);
    const sub = document.createElement("span");
    sub.className = "drop-sub";
    sub.textContent = blocked ? why! : ROUTE_HINTS[r];
    item.append(main, sub);
    if (!blocked) item.addEventListener("click", (e) => { e.stopPropagation(); done(); setRoute(r); });
    menu.appendChild(item);
  }
}

/** THE ARTIFACT IN HAND picked before the session exists (the lazy Work
 *  landing has no chat until the first send): newChat stamps it on the
 *  session it creates — the send that follows carries the id in its steer.
 *  Without this the agent was handed the artifact's NAME and tried it as an
 *  id (his report, 2026-10-05). */
let pendingArtifactRef: { id: string; name: string } | null = null;

/** Keyboard on an open chip menu: arrows move, Enter picks, Esc closes
 *  (focus back on the chip). The Output and Folder chips share it. */
function chipMenuKeys(menu: HTMLElement, chipId: string, e: KeyboardEvent): void {
  const rows = Array.from(menu.querySelectorAll<HTMLButtonElement>(".code-drop-item"));
  if (!rows.length) return;
  const at = rows.findIndex((r) => r === document.activeElement);
  if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); menu.classList.add("hidden"); el(chipId)?.focus(); }
  else if (e.key === "ArrowDown") { e.preventDefault(); rows[(at + 1 + rows.length) % rows.length].focus(); }
  else if (e.key === "ArrowUp") { e.preventDefault(); rows[(at - 1 + rows.length) % rows.length].focus(); }
  else if (e.key === "Enter" && at >= 0) { e.preventDefault(); rows[at].click(); }
}

function setMode(id: (typeof MODES)[number]["id"]): void {
  glyphhMode = id;
  // The device default follows the user's latest pick (seeds the NEXT new session).
  defaultMode = id;
  void window.glyphh.setPreference?.("glyphhMode", id);
  // Bind the mode to the SESSION so it's the same on every surface and survives a
  // session switch. persist() stamps updatedAt + syncs through the thread-store,
  // so another surface adopts it on reconcile even with no run in flight.
  const c = current();
  if (c) {
    c.permission = id;
    void saveStore();
    // In-flight: push the change to the running turn so its gate re-evaluates the
    // NEXT action under the new mode — local (main → local pod) or remote (SDK
    // handle → pod). No live run → a harmless no-op.
    pushPermissionToRun(c.id, id);
  }
  paintChips();
  renderModeMenu();
}

/** Push a mid-run mode change to the run executing this chat's turn: main
 *  maps the chat to its live runId. Best-effort and idempotent. */
function pushPermissionToRun(chatId: string, mode: (typeof MODES)[number]["id"]): void {
  void window.glyphh.glyphhSetPermission?.(chatId, mode).catch(() => { /* no live run */ });
}

function cycleMode(): void {
  const modes = modesForLoop();
  const i = modes.findIndex((m) => m.id === currentMode());
  setMode(modes[(i + 1) % modes.length].id);
}

/** Adopt a mode change that ORIGINATED ELSEWHERE (a run frame from another surface,
 *  or the local pod echoing one) — update the session + chip WITHOUT re-pushing to
 *  the run (that would loop). Persists so the change survives a reload. */
function adoptSessionMode(chatId: string, mode: string): void {
  if (mode === "bypass") mode = "auto";  // retired mode off other surfaces
  if (!MODES.some((x) => x.id === mode)) return;
  const c = chats.find((ch) => ch.id === chatId);
  if (!c || c.permission === mode) return;
  c.permission = mode as (typeof MODES)[number]["id"];
  void saveStore();
  if (chatId === currentId) { glyphhMode = c.permission; paintChips(); renderModeMenu(); }
}

// ── Model selector (drop-up) ──
// The picker's shape comes from the LOOP: it declares model slots, and each one
// renders a dropdown. Resolution and rendering live in model-picker.ts; this file
// only owns the chip and when to refresh.

// ── Model selector — WHATEVER THE GATEWAY SERVES (his ruling, 2026-09-15):
// the list is asked of the base URL the turn will hit, with the key in hand.
// One lane since the CLI era ended (2026-09-28): the org's gateway, the
// member's key, the org's allow-list. No seeded catalog, no plan gate here —
// the server decided when it minted the key.
interface AvailModel {
  id: string; name: string; providerSlug: string; /** Takes an effort (the dial); absent = yes. */ reasoning?: boolean;
  /** The utility-model rule reads these (help/utility-model.ts): the console's
   *  Utility flag, else the cheapest chat row by price. Carried from the
   *  server's available row by main (loop-models.ts) and the web contract. */
  modality?: string; utility?: boolean; inputUsdPerMTok?: number; outputUsdPerMTok?: number;
}
let availModels: AvailModel[] = [];
let modelSource: "gateway" | "none" = "none";
function modelsForLoop(): AvailModel[] {
  return availModels;
}

/** THE CATALOG'S ID IS NOT THE MODEL'S NAME (his report, 2026-09-18: the chip
 *  read "anthropic::claude-haiku-4-5" and never changed with the loop).
 *  Settings stores the catalog id, `provider::name`; a loop's list and every
 *  CLI's --model flag take the bare name. Main strips the same prefix before
 *  it spawns (bareModel in cli-agents.ts); the renderer must never import from
 *  src/shared, so the one rule lives on both sides of the wire. */
const bareModelId = (id: string | null | undefined): string | null => {
  const s = String(id ?? "").trim();
  if (!s) return null;
  const cut = s.lastIndexOf("::");
  return cut >= 0 ? s.slice(cut + 2) : s;
};

/** WHAT THE CHIP SHOWS IS WHAT THE TURN SENDS (his report, 2026-09-17: the
 *  composer said one model while another was asked for). The chip used to read
 *  the session's own pick only, while a turn falls back to Settings' default
 *  model — so a chat with no pick of its own displayed one thing and ran
 *  another. Both resolve here. */
/** AUTO MEANS AUTO (his order, 2026-09-18). When the org runs Auto only, its
 *  auto-router is the whole list, so it IS the selection: "Default — the loop
 *  decides" is not a choice anyone has, and offering it sends a turn with no
 *  model at all. The server marks the row; the renderer never guesses. */
const autoModel = (): AvailModel | null => availModels.find((m) => m.providerSlug === "auto") ?? null;
/** AUTO ONLY: the org's router is the only row on offer, so every turn takes it. */
const autoOnly = (): boolean => availModels.length === 1 && !!autoModel();
const autoPins = (raw: string | null | undefined): boolean => { void raw; return autoOnly(); };

/** The stored pick, as stored. */
function pickedRawId(): string | null {
  const raw = current()?.models?.["default"] ?? pendingModels?.["default"] ?? defaultModelPref;
  return raw ? String(raw) : null;
}
/** A CLI's own model pick for this session ("" = the CLI's default, or the loop's model from Settings). */
function cliPick(c: CodeChat | null | undefined, cli: string): string {
  const slot = modelSlotOf("cli", cli);
  return String((c ? c.models?.[slot] : pendingModels?.[slot]) ?? "");
}
/** Write one lane's pick, leaving the other lanes' picks alone. */
function setModelPick(slot: string, id: string | null): void {
  const c = current();
  const next = { ...((c ? c.models : pendingModels) ?? {}) };
  if (id) next[slot] = id; else delete next[slot];
  if (c) { c.models = next; void saveStore(); }
  else pendingModels = Object.keys(next).length ? next : null;
}
/** The row a pick names, by its bare name. */
function rowForPick(raw: string | null): AvailModel | null {
  const bare = bareModelId(raw);
  if (!bare) return null;
  return availModels.find((m) => bareModelId(m.id) === bare) ?? null;
}
function effectiveModelId(): string | null {
  const raw0 = pickedRawId();
  if (autoPins(raw0)) return autoModel()!.id;
  const raw = raw0;
  const picked = bareModelId(raw);
  if (!picked) return null;
  // ONLY A MODEL ON THE LIST IS A MODEL (his order, 2026-09-29: "the picker
  // should not show another model name that isn't in the list above — where is
  // that coming from?"). It came from an old stored pick: a name from a lane
  // that no longer exists, kept on the thread and named on the chip because
  // the rule used to be "a stale pick still runs, so say it". It does not run,
  // and a name nobody can find in the list reads as a bug. Unresolvable = the
  // org's default.
  return rowForPick(raw) ? picked : null;
}
function selectedModel(): AvailModel | null {
  const raw = pickedRawId();
  if (autoPins(raw)) return autoModel();
  return rowForPick(raw);
}

/** What "Default" runs on: the org's answer (desktop.pick_default on the
 *  server) while the team still carries it, else the team's router, else its
 *  first chat model by name — never nothing while the list has a model. */
function resolvedDefaultModel(): string {
  if (orgDefaultModel && availModels.some((m) => m.id === orgDefaultModel || m.name === orgDefaultModel)) return orgDefaultModel;
  const router = availModels.find((m) => m.providerSlug === "auto");
  if (router) return router.id;
  return [...availModels].map((m) => m.id).sort()[0] ?? "";
}

function paintModelChip(): void {
  paintSourceMascot();
  const mc = el("code-model-chip");
  if (!mc) return;
  if (activeLane() === "cli") {
    // A CLI on its own login: its own model names, its own default.
    const cli = activeCli();
    const pick = cliPick(current(), cli);
    const own = loopRowOf(activeLoop())?.model || "";
    const hit = cliModelChoices(cli).find((m) => m.id === pick);
    mc.textContent = pick ? (hit?.name ?? pick) : own ? `Default · ${own}` : "Default";
    mc.title = pick ? `${hit?.name ?? pick} on your ${loopName(activeLoop())} login` : own ? `The loop's model from Settings › Loops` : CLI_DEFAULT_MODEL_LABEL;
    mc.className = "code-chip";
    paintComposerGate();
    paintLevelChip();
    return;
  }
  const sel = selectedModel();
  // NO MODELS IS ITS OWN ANSWER (his order, 2026-09-18): an org that allows
  // none leaves nothing to run, and naming some leftover pick would invite a
  // turn that can only be refused.
  const none = modelSource === "gateway" && availModels.length === 0;
  // With the gateway on, "Default" is the ORG'S default (his order, 2026-09-20),
  // so the chip names it: the turn runs on that, never on some older pick.
  const orgDef = modelSource === "gateway" && !sel ? resolvedDefaultModel() : "";
  // Plain words under the box (his order, 2026-10-07): the name alone, the
  // way Claude's composer names its model — the title says what it is.
  mc.textContent = none ? "No model" : sel?.name ?? (orgDef ? `Default · ${orgDef}` : "Default");
  mc.title = none ? "Your organization hasn't allowed any model yet. An org admin turns them on in the console."
    : sel ? `${sel.name} — ${sel.providerSlug}`
    : "Your organization's default model";
  mc.className = "code-chip" + (none ? " warn" : "");
  paintComposerGate();
  paintLevelChip();   // the dial dims when this model takes one effort
}

/** THE ORG'S LIST CAN CHANGE WHILE THE APP IS OPEN (his report, 2026-09-18:
 *  an admin limiting models did not reach the agent). The picker already
 *  forces past the cache when it opens; this catches the other half, coming
 *  back to the app after changing something in the console. */
let lastFocusRefresh = 0;
window.addEventListener("focus", () => {
  if (Date.now() - lastFocusRefresh < 15_000) return;
  lastFocusRefresh = Date.now();
  void refreshModelList(true);
});

async function refreshModelList(force?: boolean): Promise<void> {
  try {
    const r = await window.glyphh.loopModels?.(GLYPHH_LOOP, force);
    if (r?.ok) { availModels = r.models; modelSource = r.source === "gateway" ? "gateway" : "none"; }
  } catch { /* offline — the last list stands */ }
  paintModelChip();
}

function renderModelMenu(): void {
  const menu = el("code-model-menu");
  if (!menu) return;
  menu.textContent = "";
  if (activeLane() === "cli") { renderCliModelMenu(menu); return; }
  const pane = document.createElement("div");
  pane.className = "drop-pane";
  const search = document.createElement("input");
  search.type = "text";
  search.className = "loop-drop-search";
  search.placeholder = "Search models…";
  search.spellcheck = false;
  search.autocomplete = "off";
  search.addEventListener("mousedown", (ev) => ev.stopPropagation());
  const list = document.createElement("div");
  list.className = "loop-drop-list";
  pane.append(search, list);
  menu.appendChild(pane);
  const check = `<svg class="drop-check" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`;
  const choose = async (id: string | null): Promise<void> => {
    const c = current();
    menu.classList.add("hidden");
    // SWITCHING MID-CHAT COSTS (his order, 2026-09-20, as Claude's app warns):
    // the new model has none of this conversation in its cache, so the whole
    // context is sent again on the next turn. Ask before a live chat moves.
    const before = effectiveModelId() || "";
    const after = bareModelId(id || "") || "";
    if (c && c.messages.length && before !== after) {
      const ok = await yoConfirm({
        title: "Switch models?",
        message: "Switching models mid-conversation re-sends the whole conversation to the new model, which can increase token usage. New chats start fresh.",
        confirmText: "Switch",
        cancelText: "Keep current",
      });
      if (!ok) return;
    }
    setModelPick("default", id);
    paintModelChip();
  };
  const paint = (): void => {
    list.textContent = "";
    const q = search.value.trim().toLowerCase();
    const rows = modelsForLoop().filter((m) => !q || m.name.toLowerCase().includes(q) || m.providerSlug.includes(q));
    if (!autoOnly()) {
      // THE CURRENT CHOICE CARRIES THE CHECK (his report, 2026-09-29: "there is
      // no check mark by the current selected model"), and Default names the
      // model it resolves to, the same words as the chip.
      const def = document.createElement("button");
      def.type = "button";
      def.className = "code-drop-item" + (selectedModel() ? "" : " selected");
      const defMain = document.createElement("div");
      defMain.className = "drop-main";
      const defName = document.createElement("span");
      const resolved = resolvedDefaultModel();
      defName.textContent = resolved ? `Default · ${resolved}` : "Default";
      defMain.appendChild(defName);
      if (!selectedModel()) appendMarkup(defMain, check);
      def.appendChild(defMain);
      def.addEventListener("click", () => { void choose(null); });
      list.appendChild(def);
    }
    if (!rows.length) {
      const empty = document.createElement("div");
      empty.className = "drop-empty";
      empty.textContent = q ? `No models matching "${q}"`
        : "No models reachable — check your organization's gateway.";
      list.appendChild(empty);
      return;
    }
    const groups: Array<{ label: string | null; rows: AvailModel[] }> = [{ label: null, rows }];
    for (const g of groups) {
      if (!g.rows.length) continue;
      if (g.label) {
        const head = document.createElement("div");
        head.className = "code-drop-head";
        head.textContent = g.label;
        list.appendChild(head);
      }
      for (const m of g.rows.slice(0, 200)) {
        const item = document.createElement("button");
        item.type = "button";
        item.className = "code-drop-item drop-item-2line" + (selectedModel()?.id === m.id ? " selected" : "");
        const main = document.createElement("div");
        main.className = "drop-main";
        const span = document.createElement("span");
        span.textContent = m.name;
        main.appendChild(span);
        if (selectedModel()?.id === m.id) appendMarkup(main, check);
        const sub = document.createElement("div");
        sub.className = "drop-sub";
        sub.textContent = m.providerSlug;
        item.append(main, sub);
        item.addEventListener("click", () => { void choose(m.id); });
        list.appendChild(item);
      }
    }
  };
  search.addEventListener("input", paint);
  paint();
  requestAnimationFrame(() => search.focus());
}

/** The model drop-up for a CLI on its own login: the names that CLI's
 *  --model takes, its own default first. The pick is kept in the CLI's own
 *  slot, so the router's pick is still there when the route flips back. */
function renderCliModelMenu(menu: HTMLElement): void {
  const cli = activeCli();
  const head = document.createElement("div");
  head.className = "code-drop-head";
  head.textContent = `${loopName(activeLoop())} models`;
  menu.appendChild(head);
  const pick = cliPick(current(), cli);
  const own = loopRowOf(activeLoop())?.model || "";
  for (const m of cliModelChoices(cli)) {
    const on = m.id === pick;
    const item = document.createElement("button");
    item.type = "button";
    item.className = "code-drop-item drop-item-2line" + (on ? " selected" : "");
    const main = document.createElement("div");
    main.className = "drop-main";
    const name = document.createElement("span");
    name.textContent = m.id ? m.name : own ? `Default · ${own}` : m.name;
    main.appendChild(name);
    if (on) appendMarkup(main, DROP_CHECK);
    item.appendChild(main);
    if (m.id) {
      const sub = document.createElement("div");
      sub.className = "drop-sub";
      sub.textContent = m.id;
      item.appendChild(sub);
    }
    item.addEventListener("click", () => {
      menu.classList.add("hidden");
      setModelPick(modelSlotOf("cli", cli), m.id || null);
      paintModelChip();
    });
    menu.appendChild(item);
  }
}

// ── Mode drop-up ──
/** The modes this loop can honor (its roster row's `modes`): a CLI that cannot ask mid-turn offers no Ask. */
function modesForLoop(): typeof MODES[number][] {
  const ids = modesOf(loopRowOf(activeLoop()));
  return MODES.filter((m) => ids.includes(m.id));
}

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

  // ONLY WHAT THIS LOOP HONORS (his report, 2026-09-17: four chips where the
  // CLI has three). Each loop publishes its own set; an unknown loop keeps all
  // four rather than hiding a mode we simply have not asked about.
  for (const m of modesForLoop()) {
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
  const modelWrap = el("code-model-wrap");
  if (!modeWrap) return;
  if (modelWrap) {
    const mmenu = document.createElement("div");
    mmenu.id = "code-model-menu";
    mmenu.className = "code-drop-up hidden";
    modelWrap.appendChild(mmenu);
    // NOTHING inside the menu should reach the document dismiss handler. The
    // multi-slot menu re-renders (paint) on header toggles and picks, which
    // DETACHES the clicked node — the dismiss check `modelWrap.contains(target)`
    // then reads false and wrongly closes it. Swallow clicks at the container so
    // it only closes via the X, the chip toggle, or a genuine outside click.
    mmenu.addEventListener("click", (e) => e.stopPropagation());
    el("code-model-chip")?.addEventListener("click", (e) => {
      e.stopPropagation();
      el("code-mode-menu")?.classList.add("hidden");
      el("code-level-pop")?.classList.add("hidden");
      el("code-ctx-pop")?.classList.add("hidden");
      renderModelMenu();
      const opening = mmenu.classList.contains("hidden");
      mmenu.classList.toggle("hidden");
      if (opening) {
        openChipDropUp(mmenu);
        mmenu.querySelector("input")?.focus();
        // Re-resolve behind the open menu, FORCING past the cache — so a model
        // an admin just added/removed on the platform shows on the next open,
        // no app restart. The rows repaint if the server disagrees.
        void refreshModelList(true).then(() => {
          if (!mmenu.classList.contains("hidden")) { renderModelMenu(); mmenu.querySelector("input")?.focus(); }
        });
      }
    });
    void refreshModelList();
  }
  void refreshLoops();
  // The effort dial, right of the model chip: a drop-up with the track.
  const levelWrap = el("code-level-wrap");
  if (levelWrap) {
    const lpop = document.createElement("div");
    lpop.id = "code-level-pop";
    lpop.className = "code-drop-up code-level-pop hidden";
    levelWrap.appendChild(lpop);
    el("code-level-chip")?.addEventListener("click", (e) => {
      e.stopPropagation();
      el("code-mode-menu")?.classList.add("hidden");
      el("code-model-menu")?.classList.add("hidden");
      el("code-ctx-pop")?.classList.add("hidden");
      // One effort on this model: the chip says so (its title), the dial stays shut.
      if (!modelTakesEffort()) { lpop.classList.add("hidden"); return; }
      const opening = lpop.classList.contains("hidden");
      if (opening) { renderLevelPop(); lpop.classList.remove("hidden"); openChipDropUp(lpop); }
      else lpop.classList.add("hidden");
    });
    void loadEffort().then(paintLevelChip);
  }
  // Menus are built once; rows re-render on open/select.
  const menu = document.createElement("div");
  menu.id = "code-mode-menu";
  menu.className = "code-drop-up hidden";
  modeWrap.appendChild(menu);
  el("code-mode-chip")?.addEventListener("click", (e) => {
    e.stopPropagation();
    el("code-level-pop")?.classList.add("hidden");
    el("code-ctx-pop")?.classList.add("hidden");
    renderModeMenu();
    const mm = el("code-mode-menu");
    mm?.classList.toggle("hidden");
    if (mm && !mm.classList.contains("hidden")) openChipDropUp(mm);
  });
  const ctxWrap = el("code-ctx-wrap");
  if (ctxWrap) {
    const cpop = document.createElement("div");
    cpop.id = "code-ctx-pop";
    cpop.className = "code-drop-up code-ctx-pop hidden";
    ctxWrap.appendChild(cpop);
  }
  // The mic's device/mode drop-up (restored 2026-08-26 — the pill-composer
  // rewrite dropped the caret, and with it the only way to pick a microphone
  // or flip hold-to-record from the composer).
  {
    const micWrap = el("code-mic-wrap");
    if (micWrap) {
      const mpop = document.createElement("div");
      mpop.id = "code-mic-menu";
      mpop.className = "code-drop-up hidden";
      micWrap.appendChild(mpop);
      el("code-mic-caret")?.addEventListener("click", (e) => {
        e.stopPropagation();
        el("code-mode-menu")?.classList.add("hidden");
        el("code-model-menu")?.classList.add("hidden");
        el("code-level-pop")?.classList.add("hidden");
        el("code-ctx-pop")?.classList.add("hidden");
        const opening = mpop.classList.contains("hidden");
        mpop.classList.toggle("hidden");
        if (opening) void renderMicMenu(mpop).then(() => { if (!mpop.classList.contains("hidden")) openChipDropUp(mpop); });
      });
    }
  }
  // THE SLOT'S DOORS (his order, 2026-10-07): ✕ drops the take, ✓ keeps it,
  // the ▮▮▮ Stop pill ends hands-free listening with the text left in the box.
  el("code-voice-cancel")?.addEventListener("click", (e) => { e.stopPropagation(); cancelRecording(); });
  el("code-voice-accept")?.addEventListener("click", (e) => { e.stopPropagation(); acceptRecording(); });
  onVoiceState(() => paintComposerSlot());
  paintComposerSlot();
  // "Stop" chip — visible only while the agent is speaking a reply aloud.
  onSpeaking((on) => el("code-speak-wrap")?.classList.toggle("hidden", !on));
  el("code-speak-stop")?.addEventListener("click", (e) => { e.stopPropagation(); stopReply(); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && isSpeaking()) { e.stopPropagation(); stopReply(); } }, true);
  document.addEventListener("click", (e) => {
    const t = e.target as Node;
    if (!modeWrap.contains(t)) el("code-mode-menu")?.classList.add("hidden");
    if (modelWrap && !modelWrap.contains(t)) el("code-model-menu")?.classList.add("hidden");
    if (levelWrap && !levelWrap.contains(t)) el("code-level-pop")?.classList.add("hidden");
    if (ctxWrap && !ctxWrap.contains(t)) el("code-ctx-pop")?.classList.add("hidden");
    const plusWrap = el("code-plus-wrap");
    if (plusWrap && !plusWrap.contains(t)) el("code-plus-menu")?.classList.add("hidden");
    // Source-family drops (source/folder/git/+) fall to an outside click too —
    // their own away-handlers cover most paths; this catches the rest.
    // Judged on the event's PATH, not on where the target is NOW (his report,
    // 2026-10-05: "the web agent file choose will not let the user change
    // directories"): the picker's Browse and back rows repaint their menu in
    // the click itself, so the row was already detached when the click
    // reached here, `contains` said "outside", and the picker closed before
    // a single folder could be walked.
    const path = e.composedPath();
    document.querySelectorAll<HTMLElement>(".ws-source-drop").forEach((m) => {
      const holder = m.parentElement;
      if (holder && !path.includes(holder)) m.remove();
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
// The Work landing's greeting seed before a session is born (his order,
// 2026-10-05): one per document, so the lazy landing greets the same way
// on every repaint until its first send gives it a session id.
const landingSeed = `landing-${Date.now().toString(36)}`;
let ghostTimer: ReturnType<typeof setInterval> | null = null;

// The new-session landing's title mirrors the HOME hero greeting exactly:
// the same time-of-day bucket + the same user name. The name is the local
// account's first name, fetched once and cached here; the FIRST paint uses
// whatever's cached (possibly empty → "Welcome back"), then this backfills
// the on-screen title once the name resolves. `greeting()` is re-evaluated on
// every landing paint so the morning/afternoon/evening bucket stays current.
let ghostName = "";
let ghostNameFetched = false;
function ensureGhostName(): void {
  if (ghostNameFetched) return;
  ghostNameFetched = true;
  void window.glyphh.getAccountInfo().then((d) => {
    const n = (d?.firstName || "").trim();
    if (!n) return;
    ghostName = n;
    // Backfill the title in place if the landing is still on screen.
    const t = document.querySelector<HTMLElement>(".code-ghost-title");
    if (!t) return;
    // The WORK landing's line carries the first name (landing-greeting.ts);
    // the Code landing keeps its own greeting.
    if (t.classList.contains("code-ghost-greeting")) t.textContent = pickGreeting(t.dataset.seed || landingSeed, undefined, firstNameOf(ghostName));
    else t.textContent = greeting(ghostName);
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
// The collapsed bar's own instance of the SAME glyphh spinner the thread uses —
// the thread (and its spinner) are hidden when docked-bottom, so the status line
// shows this cube while the agent works instead of a bare "Working…".
let statusSpinner: GlyphhSpinner | null = null;
// One live run PER SESSION — sessions are independent in main (concurrent
// runs) and independent streams here: each chat accumulates its own run
// (chat-keyed, not DOM-keyed), and the panel paints only the CURRENT chat's.
interface LiveRun {
  runId: string | null;        // stamped by glyphhRun's ack, or the first event
  text: string;                // streamed text since the last commit
  bubble: HTMLElement | null;  // live DOM block (current chat only)
  thinking?: string;           // the model's thinking so far (the loop's `thinking` deltas)
  thinkEl?: HTMLElement | null; // its live fold (current chat only)
  startAt: number;
  readyAt?: number;            // the loop said ready (tools + prompt built; the model call begins)
  firstAt?: number;            // the first text delta
  inTok: number;
  outTok: number;
  usd: number;                 // the turn's running spend as the loop reports it, in dollars
  steps: string[];             // timeline breadcrumbs for the Plan rail
  setupMeta: string;           // first-run model-download status
  /** Open steps by tool key → their indexes in `steps`, oldest first. Tools
   *  run IN PARALLEL now (his order, 2026-09-29), so "the last step" is no
   *  longer the one that just finished. */
  openSteps?: Map<string, number[]>;
}
const liveRuns = new Map<string, LiveRun>();
let runTicker: ReturnType<typeof setInterval> | null = null;
/** Runs finishRun has already settled. A stopped or finished run can still
 *  emit — a CLI we killed exits a moment later — and those frames must not be
 *  adopted by the NEXT launch (his report, 2026-09-23: interrupt, then the
 *  message typed during the run was sent and instantly died with "⚠ the run
 *  failed" — the dead run's exit had claimed it). Bounded: only the recent
 *  ones can still be in flight. */
const settledRuns = new Set<string>();
function markSettled(runId: string | null): void {
  if (!runId) return;
  settledRuns.add(runId);
  if (settledRuns.size > 64) settledRuns.delete(settledRuns.values().next().value as string);
}

/** The chat entry that owns a runId. Events can beat the IPC ack that stamps
 *  the id, so an unmatched runId claims the OLDEST launch still waiting —
 *  unless that runId is one we already settled, which is a late frame from a
 *  run that is over, not an early frame from the one just launched. */
function runEntry(runId: string): [string, LiveRun] | null {
  for (const e of liveRuns) { if (e[1].runId === runId) return e; }
  if (settledRuns.has(runId)) return null;
  for (const e of liveRuns) { if (e[1].runId === null) { e[1].runId = runId; return e; } }
  return null;
}
const currentRun = (): LiveRun | null => liveRuns.get(currentId) ?? null;

// ── Tool breadcrumb labels — ONE grammar for every producer path ────────────
// The frame's `title` carries the call's key input, preformatted by whoever
// ran the tool ("Run: npm test", "Write /abs/path", "Grep \"x\" in src/") —
// glyph + title is then exactly the text toolLineEl upgrades into terminal /
// file cards. No title (an old producer, a stored row) falls back to the bare
// name + thought, which is the previous behavior verbatim.
function toolStartLabel(d: { name: string; title?: string; thought?: string }): string {
  return `⚙ ${d.title || (d.thought ? `${d.name} — ${d.thought}` : d.name)}`;
}
function toolDoneLabel(d: { name: string; title?: string; bad: boolean; reason?: string; diff?: string }): string {
  return `${d.bad ? "✕" : "✓"} ${d.title || d.name}${d.reason ? ` — ${d.reason}` : ""}${d.diff ? ` ${d.diff}` : ""}`;
}

// A tool's ⚙ start row, awaiting its ✓/✕ done rewrite. FIFO per chat+tool so
// parallel same-name calls settle in order (a done always follows ITS start on
// the frame stream). Keyed `${chatId}:${name}`; cleared when the run finishes
// so a lost done can never strand a stale row reference.
const pendingToolRows = new Map<string, CodeMsg[]>();
/** A TOOL ROW'S IDENTITY is its name and its input's title: the engine runs a
 *  turn's tool calls together now, so two reads can be open at once and finish
 *  in either order. Keyed by name alone, the first read's row took the second
 *  one's result. Two calls with the SAME title are the same call twice, and
 *  either order is right for them. */
const toolKey = (chatId: string, name: string, title?: string): string => `${chatId}:${name}:${title ?? ""}`;
/** ONE CARD PER FILE PER TURN: a file written and then edited three times in a
 *  turn is one thing the agent made, not four. Within the turn (back to the
 *  person's last message) the card is updated in place; a file the turn
 *  CREATED stays "Created" however often it was edited after. */
function noteArtifact(chat: CodeChat, art: ArtifactRef): void {
  for (let i = chat.messages.length - 1; i >= 0; i--) {
    const m = chat.messages[i]!;
    if (m.role === "user") break;
    if (m.kind === "artifact" && m.artifact?.path === art.path) {
      m.artifact = { path: art.path, verb: m.artifact.verb === "Created" ? "Created" : art.verb };
      m.at = Date.now();
      return;
    }
  }
  chat.messages.push({ role: "assistant", kind: "artifact", text: "", artifact: art, at: Date.now() });
}

/** A frame a SUB-AGENT sent: it carries the child's ref (run-frames.ts SubAgentRef). */
const isChildFrame = (d: unknown): boolean => !!(d as { agent?: unknown } | null)?.agent;
function pushToolRow(chat: CodeChat, name: string, label: string, title?: string): CodeMsg {
  const msg: CodeMsg = { role: "assistant", kind: "tool", text: label, at: Date.now() };
  chat.messages.push(msg);
  const k = toolKey(chat.id, name, title);
  const q = pendingToolRows.get(k);
  if (q) q.push(msg);
  else pendingToolRows.set(k, [msg]);
  return msg;
}
function settleToolRow(chat: CodeChat, name: string, label: string, title?: string): CodeMsg {
  const k = toolKey(chat.id, name, title);
  const q = pendingToolRows.get(k);
  const msg = q?.shift();
  if (q && !q.length) pendingToolRows.delete(k);
  if (msg) { msg.text = label; return msg; }   // rewrite the ⚙ row in place
  const orphan: CodeMsg = { role: "assistant", kind: "tool", text: label, at: Date.now() };
  chat.messages.push(orphan);
  return orphan;
}
function clearToolRows(chatId: string): void {
  for (const k of [...pendingToolRows.keys()]) if (k.startsWith(`${chatId}:`)) pendingToolRows.delete(k);
}

// Streamed tokens re-render the CURRENT chat's live block as MARKDOWN, throttled
// to one paint per animation frame — smooth at token rate, code fences and lists
// take shape as they arrive. Module-scoped so BOTH run paths share it: the local
// glyphhRun deltas (onGlyphhAgentDelta) and the web remote turn (remote-run.ts).
let streamPaintQueued = false;
/**
 * STREAMING THAT DOES NOT FLICKER (his order, 2026-09-29: "world class"). The
 * live reply used to be re-rendered WHOLE every frame, so every image in it
 * was rebuilt (a visible flash), every code block re-highlighted from the top,
 * and any text the person had selected was taken away.
 *
 * Now a reply is two parts: everything up to its last finished block — a blank
 * line outside a code fence — is rendered ONCE and kept, and only the block
 * still being written is re-rendered. The finished message is rendered whole
 * when the turn lands, so a construct that spans a blank line (a loose list)
 * is exact in the transcript even if it streams in two pieces.
 */
const streamParts = new WeakMap<HTMLElement, { frozenLen: number; frozen: HTMLElement; tail: HTMLElement }>();
function paintBubble(bubble: HTMLElement, text: string): void {
  let st = streamParts.get(bubble);
  if (!st || text.length < st.frozenLen) {
    bubble.textContent = "";
    const frozen = document.createElement("div");
    frozen.className = "stream-frozen";
    const tail = document.createElement("div");
    tail.className = "stream-tail";
    bubble.append(frozen, tail);
    st = { frozenLen: 0, frozen, tail };
    streamParts.set(bubble, st);
  }
  const cut = streamStableCut(text);
  if (cut > st.frozenLen) {
    // Appended, never re-rendered: a finished block keeps its nodes (and any
    // selection in them) while the reply streams on.
    const block = document.createElement("template");
    block.innerHTML = formatMarkdown(text.slice(st.frozenLen, cut));
    st.frozen.append(block.content);
    st.frozenLen = cut;
  }
  st.tail.innerHTML = formatMarkdown(text.slice(st.frozenLen));
}

/** THE MODEL'S THINKING (his order, 2026-10-04): a folded, dim "Thinking" line
 *  above the answer, the same quiet summary a tool group wears; a click opens
 *  the text. Plain text, never markdown: it is the model's notes, not a reply. */
function thinkingEl(text: string): HTMLElement {
  const box = document.createElement("div");
  box.className = "code-thinking";
  const head = document.createElement("button");
  head.type = "button";
  head.className = "code-tool-summary code-thinking-head";
  head.innerHTML = `<svg class="tg-chev" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg><span>Thinking</span>`;
  const body = document.createElement("div");
  body.className = "code-thinking-body hidden";
  body.textContent = text;
  head.addEventListener("click", () => {
    const open = body.classList.toggle("hidden");
    head.classList.toggle("open", !open);
  });
  box.append(head, body);
  return box;
}

/** Markup this file built itself (escaped, or a fixed icon), appended as nodes. */
function appendMarkup(parent: Element, html: string): void {
  const t = document.createElement("template");
  t.innerHTML = html;
  parent.append(t.content);
}

function paintStream(): void {
  streamPaintQueued = false;
  const run = currentRun();
  const thread = el<HTMLDivElement>("code-thread");
  // Thinking still streaming: only the fold's text moves, the thread stands.
  const fold = run?.thinkEl?.isConnected ? run.thinkEl.querySelector<HTMLElement>(".code-thinking-body") : null;
  if (fold && fold.textContent !== (run?.thinking ?? "")) fold.textContent = run?.thinking ?? "";
  if (run?.bubble && run.bubble.isConnected) {
    paintBubble(run.bubble, run.text);
    if (thread && threadPinned) thread.scrollTop = thread.scrollHeight;
  } else if (run?.text || !fold) {
    renderThread(); // first token (or first thinking) — adds the live block under the spinner
  }
}
/** Coalesce a stream repaint to the next frame (only when the run is current). */
function queueStreamPaint(chatId: string): void {
  if (currentId === chatId && !streamPaintQueued) {
    streamPaintQueued = true;
    requestAnimationFrame(paintStream);
  }
}

/** Coalesce live-run repaints: tool frames arrive many times a second and
 *  renderThread rebuilds the whole thread DOM — per-event sync repaints made
 *  the composer drop keystrokes during busy runs. At most one paint a frame. */
let threadPaintQueued = false;
function scheduleRenderThread(): void {
  if (threadPaintQueued) return;
  threadPaintQueued = true;
  requestAnimationFrame(() => { threadPaintQueued = false; renderThread(); });
}

function broadcastTimeline(running: boolean): void {
  try {
    document.dispatchEvent(new CustomEvent("glyphh-agent:timeline", { detail: { steps: [...(currentRun()?.steps ?? [])], running } }));
  } catch { /* no listeners */ }
}

/**
 * The collapsed bar's single status line — the whole conversation reduced to
 * one row. Derived from state this module already holds, so there is no second
 * subscription onto the frame stream; `initCode` just repaints it whenever the
 * timeline broadcasts. Failure is the existing "✕" convention (the Plan slot
 * uses the same predicate), so the two never disagree about what failed.
 */
function paintStatusLine(running = !!currentRun()): void {
  const line = el("code-status-line");
  const text = el("code-status-text");
  if (!line || !text) return;
  const run = currentRun();
  const steps = run?.steps ?? [];
  const last = steps.length ? steps[steps.length - 1]! : "";
  const blocked = !!document.querySelector("#code-ask-dock .ask-card, #code-ask-dock .approval-card");
  const failed = !running && last.startsWith("✕");

  line.classList.toggle("is-running", running && !blocked);
  line.classList.toggle("is-blocked", blocked);
  line.classList.toggle("is-error", failed);

  // The SAME glyphh spinner the thread uses — mount a cube-only instance at the
  // head of the bar while working, tear it down when the run ends.
  if (running && !blocked) {
    if (!statusSpinner) {
      statusSpinner = createGlyphhSpinner({ size: 15, phrases: false });
      line.insertBefore(statusSpinner.el, line.firstChild);
    }
  } else if (statusSpinner) {
    statusSpinner.destroy();
    statusSpinner.el.remove();
    statusSpinner = null;
  }

  if (blocked) text.textContent = "Waiting on you — approve to continue";
  else if (running) text.textContent = last || "Working…";
  else if (failed) text.textContent = last;
  else {
    const c = current();
    const msgs = c?.messages ?? [];
    const lastAgent = [...msgs].reverse().find((m) => m.role === "assistant" && (m.text ?? "").trim());
    const summary = (lastAgent?.text ?? "").trim().split("\n").find((l) => l.trim()) ?? "";
    text.textContent = summary || "Ask Glyphh anything";
  }
  // A message that landed while collapsed and unpeeked is unread.
  if (!isPeekingNow() && (running || last)) line.classList.add("has-unread");
}

/** Local read of the peek state without importing a cycle back into code.ts. */
function isPeekingNow(): boolean {
  return document.querySelector(".code-root")?.classList.contains("peeking") ?? false;
}

/** Dollars → the footer's headline — what the turn's calls through Glyphh cost.
 *  Small runs keep sub-cent precision, big ones stay to the cent. */
function fmtUsd(usd: number): string {
  const n = usd >= 100 ? Math.round(usd).toLocaleString()
    : usd >= 1 ? usd.toFixed(2)
    : usd.toFixed(4).replace(/0+$/, "").replace(/\.$/, "");
  return `$${n}`;
}

/** 1_234 → "1.2k", so the footer stays tight as a run grows into six figures. */
function fmtTok(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

/** WHERE A TURN'S TIME WENT (his report, 2026-10-04: "very slow to and from"):
 *  ready = the loop's preamble (tools, prompt, memory), first = the model's
 *  first word, then the output rate. Kept with the answer so a slow turn can
 *  be named, not guessed at. */
function turnTiming(run: LiveRun): string {
  const now = Date.now();
  const sec = (ms: number): string => `${(Math.max(0, ms) / 1000).toFixed(1)}s`;
  const parts: string[] = [];
  if (run.readyAt) parts.push(`ready ${sec(run.readyAt - run.startAt)}`);
  if (run.firstAt) parts.push(`first token ${sec(run.firstAt - run.startAt)}`);
  if (run.firstAt && run.outTok > 0 && now - run.firstAt > 500) parts.push(`${Math.round(run.outTok / ((now - run.firstAt) / 1000))} tok/s`);
  parts.push(`${sec(now - run.startAt)} total`);
  return parts.join(" · ");
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
  const cr = run.usd > 0 ? ` · ${fmtUsd(run.usd)}` : "";
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
/** Sessions live in main's chat file (thread-store.ts). First load also
 *  migrates any legacy localStorage sessions, then clears them.
 *  Single-flight: both boot paths (loadCode + initCode) land here. */
async function loadStore(): Promise<void> {
  if (storeLoaded) return;
  if (storeLoading) return storeLoading;
  storeLoading = (async () => {
    try {
      const s = await threadStore.hydrate();
      chats = s.chats as CodeChat[];
      // A PANEL ALWAYS OPENS ON A NEW SESSION (his order, 2026-09-29: "it
      // should ALWAYS load a new agent with a new session no matter what 100%
      // of the time. However… it is loading a previous state and the ui gets
      // stuck this way"). `currentId` is ONE pointer shared by every surface,
      // so a panel that adopted it came up on whatever thread was last
      // touched — and with several panels open they would all claim the same
      // one. A panel is TOLD which thread to show (the rail's open-session
      // command); told nothing, it starts clean. The shell keeps the pointer,
      // so the main window still reopens where the user left off.
      // …and since 2026-10-07 the main window does NOT either: every launch
      // lands on Work → New (his order); the last thread waits in Recents.
      // The store keeps its pointer for the surfaces that read it.
      void s.currentId;
      currentId = "";
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
  })();
  return storeLoading;
}
function saveStore(): Promise<void> {
  return threadStore.persist(chats, currentId);
}
const current = (): CodeChat | null => chats.find((c) => c.id === currentId) ?? null;

/** The rail's session interactions (New session, clicking a message row)
 *  land on the AGENT PANEL — but they must not blow away an open layout.
 *  Agent already visible → nothing to do (the session loads in place).
 *  Workspace has panels (a layout or apps) → the agent JOINS it ("code"
 *  guarantees a coding slot without clearing). Empty workspace → the full
 *  Glyphh-mark move: agent full screen ("agent"). */
function ensureCodeSection(): void {
  // The agent is the PERMANENT bottom composer — always visible, nothing to
  // surface. (The old rail-seat/section bounce died with the anchor system.)
}

/** The session surface the Coding Agent workspace panel drives — same
 *  sessions, same store, exposed across the bundle boundary via window.
 *  Every history repaint also fires "agent-sessions-changed" so the panel's
 *  header title/dropdown stay current. */
/** The app-standard confirm modal, exposed for the workbench bundle (it
 *  can't import help modules; #confirm-modal lives in this document). */
(window as unknown as { __appConfirm?: unknown }).__appConfirm = confirmAction;
/** …and the three-way one (delete / the softer thing / nothing). */
(window as unknown as { __appChoice?: unknown }).__appChoice = confirmChoice;

(window as unknown as { __agentSessions?: unknown }).__agentSessions = {
  /** Resolves once the persisted sessions are in memory (boot races the
   *  workspace reopen; a "last" resume must not read an empty list). */
  ready: (): Promise<void> => loadStore(),
  list: (): Array<{ id: string; title: string; createdAt: number; mode: "code" }> =>
    chats.map((c) => ({ id: c.id, title: c.title, createdAt: c.createdAt, mode: SESSION_MODE })),
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
    // A turn running in another (or a closed) document comes along with the
    // thread — the workspace Session setting lands here, and used to leave the
    // seat dormant while main streamed to a panel that no longer existed.
    adoptRunIfElsewhere(target);
    // The switched-to session's OWN source drives the chip/locus/run.
    repaintSourceUi();
    applySessionFolder(target);   // the workbench follows the thread's folder
    paintChips();
    void refreshModelList();
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
    // The source chip must repaint too: a layout opening on "new session"
    // lands here with the PREVIOUS (born) session's cl-chip-static lock still
    // painted — pointer-events:none — so the picker never opened on a fresh
    // session hosted in a layout. Recompute from the now-empty selection.
    repaintSourceUi();
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
  stampWorkdir: (dir: string, weak = false): void => {
    if (!dir) return;
    const c = current();
    if (!c) { if (!weak || !pendingWorkdir) pendingWorkdir = dir; return; }
    // WEAK (a workspace's folder): only fills a blank — an existing thread's
    // own folder ALWAYS wins (his rule, 2026-08-30).
    if (weak && c.workdir) return;
    setThreadFolder(dir);
  },
  /** A WORKSPACE's loop binds to the session it opens with — this session
   *  only, and only a loop the member has on. With turns on another loop the
   *  workspace gets a new session on its loop (setLoop's rule). */
  stampLoop: (loop: string): void => {
    // Before the roster answers, any loop the app knows is taken; main refuses one that is off.
    const known = loopRows.length ? enabledLoopIds().includes(loop) : (LOOP_IDS as readonly string[]).includes(loop);
    if (!loop || !known || loop === activeLoop()) return;
    setLoop(loop);
  },
  /** A WORKSPACE's route for its CLI agents: its agent cell's, then its own.
   *  The session's own pick, when it made one, still wins. */
  stampRoute: (hints: { cell?: boolean | null; layout?: boolean | null }): void => {
    const c = current();
    if (c) { c.routeHints = { ...hints }; void saveStore(); } else pendingRouteHints = { ...hints };
    paintChips();
    void refreshModelList();
  },
  /** A LAYOUT's model slots bind to the session it opens with — this session
   *  only; other sessions keep running their own casts untouched. */
  stampModels: (models: Record<string, string>): void => {
    if (!models || !Object.keys(models).length) return;
    const c = current();
    if (!c) { pendingModels = { ...models }; return; }
    c.models = { ...c.models, ...models };
    void saveStore();
    void refreshModelList();
  },
};

// The @-mention summon ("@an-fable …") sets the model on the CURRENT loop's
// primary role and repaints the chip — the ghost overlay calls this after boot.
(window as unknown as { __agentUseModel?: (modelId: string) => Promise<boolean> }).__agentUseModel =
  async (modelId: string): Promise<boolean> => {
    try {
      setModelPick("default", modelId);
      await refreshModelList(true);
      return true;
    } catch { return false; }
  };

/** A folder a layout asked for while no session existed — applied to the
 *  session the next send creates. */
let pendingWorkdir = "";
/** While set (a short window), cwd changes are PROGRAMMATIC — a workspace or
 *  a thread open re-rooting the workbench — and must not be stamped onto the
 *  current session as if the user picked a folder. Only real picks stamp. */
let cwdStampSuppressedUntil = 0;
(window as unknown as { __glyphhSuppressCwdStamp?: () => void }).__glyphhSuppressCwdStamp = () => {
  cwdStampSuppressedUntil = Date.now() + 1500;
};

/** Re-root the WORKBENCH to an opened thread's own folder — Files, Diff,
 *  terminals, everything follows the thread (his report, 2026-08-30: opening
 *  a thread left the previous folder up). Local sources only; cloud sources
 *  re-root through the source chip's own machinery. */
/** A REAL file URL for a local path on any OS (his report, 2026-09-27: on
 *  Windows `file://` + `C:\\…` loaded nothing). Backslashes become slashes, a
 *  drive letter gets its leading slash, every segment is encoded. */
function localFileUrl(p: string): string {
  let s = String(p || "").replace(/\\/g, "/");
  if (!s.startsWith("/")) s = "/" + s;
  return "file://" + s.split("/").map(encodeURIComponent).join("/");
}

/**
 * A THREAD'S FOLDER — ONE TRUTH (his rule, 2026-09-29: "no matter where it
 * starts its context is set initially by where the thread started but if it is
 * changed the folder is stored as what it was updated to… The ui lets the user
 * pick the new folder but it doesn't keep that folder"; and "The agent should
 * work from the selected folder period… it is sandboxed to that folder").
 *
 * The chip used to read the SOURCE's path while the run sent `workdir`, two
 * fields that drifted apart, so the chip could name the folder you picked while
 * the turn ran in the one the thread was born with. Now `threadFolder()` is what
 * the chip shows AND what the run sends, and `setThreadFolder()` is the only
 * way a thread's folder changes — both fields together.
 */
/**
 * A CLOUD source needs NO folder (his order, 2026-10-04: the worker's workspace
 * IS the folder): threadFolder() is "" for it and that is a complete answer —
 * the turn runs in the workspace root (or the chip's picked sub-folder, which
 * rides the run as `subdir`, not as a workdir). Only a LOCAL (machine) source
 * can lack a folder it needs, and only the DESKTOP's local run path asks for
 * one (main's NO_WORKDIR gate in `launch` below); a cloud turn never reaches it.
 */
function threadFolder(c: CodeChat | null | undefined = current()): string {
  if (c) return c.workdir || (c.source?.kind === "local" ? c.source.path || "" : "");
  return pendingWorkdir || (pendingSource.kind === "local" ? pendingSource.path || "" : "");
}
/** THE SHELL FOLLOWS THE THREAD'S FOLDER (his report, 2026-10-08: "the
 *  folder selector isn't triggering the re-render on the files, diff, etc
 *  view"). The Files, Diff and Plan cards live in the shell and re-root on
 *  main's working-dir-changed — which only fires when main is told. The
 *  recent-folder rows, the folder chip and the run-place pick wrote the
 *  thread's folder and told nobody; only the OS picker went through main.
 *  Every thread-folder change now tells main, the stamp suppressed so the
 *  echo does not re-stamp this session. */
function rootShellTo(dir: string): void {
  if (!dir || !dir.startsWith("/")) return;
  cwdStampSuppressedUntil = Date.now() + 1500;
  void (window as unknown as { wb?: { setCwd?: (d: string) => Promise<unknown> } }).wb?.setCwd?.(dir)?.catch?.(() => undefined);
}
function setThreadFolder(dir: string): void {
  if (!dir) return;
  const c = current();
  if (c) {
    c.workdir = dir;
    if (c.source?.kind === "local") c.source = { ...c.source, path: dir };
    void saveStore();
  } else {
    pendingWorkdir = dir;
    if (pendingSource.kind === "local") {
      pendingSource = { ...pendingSource, path: dir };
      void window.glyphh.setPreference?.(SOURCE_PREF, pendingSource);
    }
  }
  console.warn("[folder] thread folder set", JSON.stringify({ chatId: c?.id ?? null, dir }));
  rootShellTo(dir);
  sourceChip?.setSource(activeSource());
  paintSourceDependents();
}

function applySessionFolder(c: CodeChat | null | undefined): void {
  const dir = c?.workdir || (c?.source?.kind === "local" ? c.source.path || "" : "");
  if (!dir) return;
  cwdStampSuppressedUntil = Date.now() + 1500;   // this change IS the thread's folder
  void (window as unknown as { wb?: { setCwd?: (d: string) => Promise<string> } }).wb?.setCwd?.(dir);
}
/** Model bindings a LAYOUT asked for while no session existed — applied to
 *  the session the next send creates (same lazy contract as pendingWorkdir). */
let pendingModels: Record<string, string> | null = null;

/** Keep body[data-session-space] in lockstep with the active space. The CSS for
 *  the chips row, the view toggles and the session kebab all key off it, and it
 *  was ONLY written by paintCw — which doesn't run on boot or when the landing
 *  mounts, so the + New Session screen came up unstyled until the user clicked
 *  a tab (which called paintCw and "fixed" it). */
function syncSpaceAttrs(): void {
  // TWO TYPES AGAIN (his order, 2026-09-29): the open thread's own type styles
  // the surface, and the rail's tab styles the lists. A Chat thread hides the
  // dev chrome the CSS keys off this attribute.
  document.body.dataset.sessionSpace = SESSION_MODE;
  document.body.dataset.railSpace = SESSION_MODE;
  sourceChip?.setSource(activeSource());
  paintSourceDependents();
  // The composer's chips take the seats this type gives them (seatMic).
  (window as unknown as { __glyphhSeatMic?: () => void }).__glyphhSeatMic?.();
}
(window as unknown as { __syncSpaceAttrs?: () => void }).__syncSpaceAttrs = syncSpaceAttrs;
// The workbench's web FS gate reads this to tell a CLOUD-pending landing (no
// pod yet — quiet empty state) apart from a desktop source that's offline.
(window as unknown as { __glyphhActiveSource?: () => Source }).__glyphhActiveSource = () => activeSource();
// VIEW TOGGLES carry the conversation (his report, 2026-09-11): adopting a
// CLI session backfills its transcript as the chat history and binds the
// bridge to --resume it. Fresh opens never call this — the one-opener law
// (zero state writes) applies to DOORS, not to session-preserving toggles.
(window as unknown as { __glyphhCurrentChatId?: () => string | null }).__glyphhCurrentChatId = () => currentId;
/** The current chat's OWN folder — its workdir, else its local source's path —
 *  for the terminal hop (the pty starts where the agent works). */
(window as unknown as { __glyphhCurrentFolder?: () => string | null }).__glyphhCurrentFolder = () => {
  const c = current();
  const dir = c?.workdir || (c?.source?.kind === "local" ? c.source.path || "" : "");
  return dir || null;
};
/** THE CHAT IS THE SESSION (2026-09-28): the loop keeps no transcript of its
 *  own, so a thread's id is the only session id there is — the >_ hop into
 *  `glyphh --resume <id>` and the run ledger both key off it. */
(window as unknown as { __glyphhHasSession?: (id: string) => boolean }).__glyphhHasSession = (id) => chats.some((c) => c.id === id);
(window as unknown as { __glyphhOpenLocalSession?: (id: string) => void }).__glyphhOpenLocalSession = (id) => openLocalSession(id);
// The loop the session on screen rides — what the >_ hop opens a terminal on.
(window as unknown as { __glyphhActiveLoop?: () => string }).__glyphhActiveLoop = () => activeLoop();
// A panel opened FOR a loop (a workspace cell, a recent, "New agent panel"):
// the session takes it — or, with turns on another loop, a new session does.
(window as unknown as { __glyphhSetLoop?: (id: string) => void }).__glyphhSetLoop = (id) => { if (id && id !== activeLoop()) setLoop(id); };
// The chat's persisted CLI session for ONE CLI — the hop's fallback when
// main's resume map has not been primed yet (a fresh boot).
(window as unknown as { __glyphhCurrentCliSessionId?: (cli?: string) => string | null }).__glyphhCurrentCliSessionId =
  (cli?: string) => { const c = current(); return c ? cliSidFor(c as CliBound, cli || sessionCliOf(c.loop, loopRows)) : null; };
(window as unknown as { __glyphhAdoptCliSession?: (a: AdoptCliSession) => void }).__glyphhAdoptCliSession = (a) => { void adoptCliSession(a); };

/** ONE WRITER for a chat's CLI binding — the row (per CLI, the legacy slot for
 *  claude) and main's resume map — so no surface holds half a binding.
 *  True when the row changed and a save is owed. */
function bindCliSession(c: CodeChat, cli: string, sid: string): boolean {
  const changed = applyCliBinding(c as CliBound, cli, sid);
  if (sid && cli !== GLYPHH_LOOP) void window.glyphh.glyphhBindCliSession?.(c.id, sid, cli);
  return changed;
}

interface AdoptCliSession { sessionId: string; cli: string; agentId?: string; agentName?: string; chatId?: string }
/**
 * A CLI SESSION BECOMES A CHAT: its transcript is the thread, and the chat
 * binds to it, so the next turn resumes that exact conversation on its own
 * CLI. The chat the >_ hop came from takes it; otherwise the chat already
 * bound to it on any lane; otherwise a new chat. The transcript is the truth
 * every time — except while a turn streams into the chat, which owns the
 * thread until it lands.
 */
async function adoptCliSession(a: AdoptCliSession): Promise<void> {
  const t = await window.glyphh.glyphhCliTranscript?.(a.sessionId).catch((e: unknown) => ({ ok: false as const, error: e instanceof Error ? e.message : String(e) }));
  if (!t?.ok) {
    console.warn("[agent] adopt: transcript unavailable", JSON.stringify({ sessionId: a.sessionId, error: t?.error ?? "no bridge" }));
    toastError("That session could not be opened.");
    return;
  }
  await loadStore().catch(() => { /* the cache answers */ });
  const name = a.agentName || loopName(a.agentId || a.cli);
  let c: CodeChat | undefined = (a.chatId ? chats.find((x) => x.id === a.chatId) : undefined) ?? chatForCliSession(chats, a.sessionId);
  const fresh = !c;
  if (!c) {
    c = { id: `c${Date.now().toString(36)}`, title: t.title || name, createdAt: Date.now(), messages: [], mode: SESSION_MODE, permission: defaultMode };
    if (t.cwd) { c.workdir = t.cwd; c.source = { kind: "local", path: t.cwd }; }
    chats.unshift(c);
  }
  if (!liveRuns.has(c.id)) {
    // Cursor keeps its turns in a database we do not read: its chat starts
    // from the title, and the CLI still holds the whole conversation.
    if (t.turns.length || fresh) c.messages = t.turns.map((m) => ({ role: m.role, text: m.text, at: Date.now() }));
    if (fresh || c.title === "New session") c.title = t.title || c.title || name;
    if (t.cwd && !c.workdir) { c.workdir = t.cwd; c.source = { kind: "local", path: t.cwd }; }
  }
  // The adopted session RUNS ON ITS OWN CLI: the loop is stamped, or the
  // next turn would name none and run on Glyphh.
  c.loop = a.agentId || a.cli;
  bindCliSession(c, a.cli, a.sessionId);
  selectChat(c);
  paintChips();
  void refreshModelList();
}
  // Space labels: the source chip's "Your spaces" list names a workspace by
  // the session that made it, when that session still exists here.
  (window as unknown as { __glyphhSessionTitleFor?: (id: string) => string }).__glyphhSessionTitleFor = (id: string) =>
    chats.find((c) => c.id === id || (c.source as { space?: string } | undefined)?.space === id)?.title || "";

function newChat(): void {
  // Every session is a Code session (the most-capable toolset). The mode field
  // is retained only for the pod/thread-store contract and is always "code".
  // BORN IN THE ACTIVE TYPE (his order, 2026-09-29) — a birth property, never
  // flipped afterwards: a thread's transcript was written with its toolbelt.
  const c: CodeChat = { id: `c${Date.now().toString(36)}`, title: "New session", createdAt: Date.now(), messages: [], mode: SESSION_MODE, permission: defaultMode };
  if (pendingWorkdir) { c.workdir = pendingWorkdir; pendingWorkdir = ""; }
  if (pendingModels) { c.models = pendingModels; pendingModels = null; }
  // BORN ON ITS LOOP: a workspace's or the picker's ask, else the member's
  // default. The loop never changes afterwards (setLoop opens a new session).
  c.loop = pendingLoop || ambientLoop();
  pendingLoop = "";
  if (pendingRoute) { c.route = pendingRoute; pendingRoute = null; }
  if (pendingRouteHints) { c.routeHints = pendingRouteHints; pendingRouteHints = null; }
  if (pendingArtifactRef) { c.artifactRef = pendingArtifactRef; pendingArtifactRef = null; }
  // Stamp the pending source — a local source seeds the session's own workdir
  // so the run targets that folder.
  c.source = newSessionSource(onWebTarget() ? "web" : "desktop", pendingSource, resolvedDefaultSource, sameSource, { kind: "cloud-new" });
  if (c.source.kind === "local" && c.source.path && !c.workdir) c.workdir = c.source.path;
  // Still nothing? Adopt the workbench's LIVE folder — a thread is tied to
  // its folder from birth (his rule, 2026-08-30), never left floating on
  // whatever the global folder later becomes.
  if (c.source.kind === "local" && !c.workdir) {
    void (window as unknown as { wb?: { getCwd?: () => Promise<string> } }).wb?.getCwd?.().then((d) => {
      if (d && !c.workdir) { c.workdir = d; void saveStore(); }
    });
  }
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
  // A NEW SESSION SEES TODAY'S LIST (his report, 2026-09-29): the models and
  // the default are re-read, never the last cached answer.
  void loadDefaultModelPref().then(() => refreshModelList(true));
}

// ── Rendering ────────────────────────────────────────────────────────────


/**
 * Leave the open session — land on the COMMAND CENTER, not the agent.
 * Backing out of a session and closing one both mean "I am done here".
 * CRITICAL: this must NOT call gotoSection("agent") — that routes to
 * openSectionInWorkbench("agent") → echoCtl.openChat() and RE-OPENS the
 * agent card. Closing a layout whose agent cell held the current session
 * fires __glyphhForgetSession → here mid-teardown, which is exactly how the
 * agent "got stuck" on screen after the layout was dropped.
 */
function leaveSessionToLanding(): void {
  currentId = "";
  void saveStore();
  renderHistory();
  renderThread();
  void checkWorkdirGate();
  syncSpaceAttrs();
  // IN A LAYOUT (his report, 2026-09-11): ‹ goes back to the panel's OWN
  // landing IN PLACE — summoning the command center here tore the whole
  // layout down. Outside a layout the wall is the landing, as before.
  if (!document.body.classList.contains("echo-layout-active")) ensureWorkbench();
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
function forgetCurrentSession(): void {
  const cur = current();
  // BOTH the in-memory resume target and its persisted twin — clearing only
  // the first let the session come back on the next launch.
  lastSession = "";
  void window.glyphh.setPreference?.(LAST_SESSION_PREF, "");
  // ...AND the workspace state that belonged to it: a closed session must not
  // leave its folder behind for the next new session to inherit. Falls back to
  // the RESOLVED default (local on desktop), not raw cloud.
  pendingSource = { ...resolvedDefaultSource };
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
  dropSessions([chat.id], true);
}

/** Take sessions out of this document. `tombstone`: THIS document deleted them
 *  (server + shared file); without it another document already did, and this
 *  one only follows. Deleting the session on screen lands on a new session in
 *  place, never a surprise jump into some other session (his report,
 *  2026-09-29: a panel kept showing a session the rail had deleted). */
function dropSessions(ids: readonly string[], tombstone: boolean): void {
  const gone = new Set(ids);
  if (!tombstone && !chats.some((c) => gone.has(c.id))) return;
  chats = chats.filter((x) => !gone.has(x.id));
  // A deleted session can never be the resume target again.
  if (gone.has(lastSession)) forgetCurrentSession();
  const wasCurrent = gone.has(currentId);
  if (wasCurrent) currentId = "";
  if (tombstone) {
    for (const id of ids) threadStore.remove(id); // server tombstone (offline-safe)
    void saveStore();
  }
  renderHistory();
  renderThread();
  if (wasCurrent) (window as unknown as { __glyphhNewSession?: () => void }).__glyphhNewSession?.();
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
      chat.titleLocked = true;   // a hand name is never overwritten by a generated one
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
  m.style.left = `${Math.max(8, r.right - 120)}px`;
  document.body.appendChild(m);
  // A row near the page bottom flips the menu UP — measured, not guessed, so
  // it holds if the menu ever grows an item.
  const h = m.offsetHeight;
  m.style.top = r.bottom + 4 + h > window.innerHeight - 8
    ? `${Math.max(8, r.top - 4 - h)}px`
    : `${r.bottom + 4}px`;
  menuEl = m;
}

// ── In-thread session header (SessionHeader port) ──────────────────────────
// The head's LEFT is `‹ <locus> <name>` (‹ opens the space's list view); the
// RIGHT carries a ⋮ kebab (Rename / Pin / Delete). The head is sticky and
// fades in as the thread scrolls (data-scrolled on the head). Rename edits the
// LOCAL title; Pin toggles chat.pinned; Delete runs the app's confirm+delete.
/** THE HEAD SAYS WHAT THIS THREAD IS (his order, 2026-09-29: "remove the arrow
 *  and link from the left top of the agent, also this should be the new icon
 *  aligned to the work above"). The ‹ arrow used to hop into the loop's own
 *  CLI, which no longer exists, and the locus icon (a monitor / a cloud) said
 *  where the turn ran — true of every thread, so it distinguished nothing. The
 *  glyph is the thread's TYPE, the same one the rail rows and + New wear.
 *  Hidden when there is no open session. */
function paintSessionHeadLocus(): void {
  const locus = el("code-session-locus");
  const back = el("code-session-back");
  if (!locus || !back) return;
  const c = current();
  // No open session (a landing) → the head is a plain title, no type glyph,
  // and no kebab (the platform renders SessionHeader only for an open session).
  back.classList.toggle("headless", !c);
  back.closest(".code-agent-head")?.classList.toggle("head-landing", !c);
  if (!c) { locus.innerHTML = ""; return; }
  locus.innerHTML = SESSION_GLYPH;
  locus.title = "Session";
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
      c.title = t; c.titleLocked = true; void saveStore();
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


// The head's session actions (Rename / Pin / New agent panel / Delete) live
// in the agent's ONE ⋮ menu now (help/agent-menu.ts, Session section) — the
// separate session kebab painted a second ⋮ on Work and did nothing on a
// fresh session (his report, 2026-10-05).

function renderHistory(): void {
  window.dispatchEvent(new CustomEvent("agent-sessions-changed"));
  // The rail's recents ride every history change (debounced disk re-read).
  scheduleRailSessionsRefresh();
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
  const visible = chats
    .filter((c) => !loopFilter.length || loopFilter.includes(c.loop || GLYPHH_LOOP))
    .filter((c) => !q || c.title.toLowerCase().includes(q));
  // All sessions, not just rows surviving the filter — a search that matches
  // nothing must keep its own box on screen to be cleared.
  paintRecentsSearch(chats.length);

  // SORT (his rule, 2026-08-19): pinned first, then most recently TOUCHED
  // down. Touched = the LWW stamp when present, else the last message, else
  // birth — array order alone went stale the moment an old session got a new
  // message without moving.
  const byTouch = byTouchDesc;
  // Pinned sessions leave their normal group and sit at the top under one
  // heading. Nothing pinned, no heading: an empty "Pinned" would be a permanent
  // reminder of a feature you aren't using.
  const pinned = visible.filter((c) => c.pinned).sort(byTouch);
  const rest = visible.filter((c) => !c.pinned).sort(byTouch);
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

/** Most-recently-touched ordering: the LWW stamp when present, else the last
 *  message, else birth. Shared by the rail list and the recents popup. */
function touchedAtOf(c: CodeChat): number {
  const stamp = (c as { updatedAt?: number }).updatedAt ?? 0;
  const lastMsg = c.messages.length ? c.messages[c.messages.length - 1]!.at : 0;
  return Math.max(stamp, lastMsg, c.createdAt);
}
function byTouchDesc(a: CodeChat, b: CodeChat): number { return touchedAtOf(b) - touchedAtOf(a); }

/** Where a session runs, as a grouping key. Anything not explicitly local is
 *  cloud — a session born before the source chip existed has no `source`. */
function locusKey(c: CodeChat): string {
  const src = c.source;
  // ONE "Cloud" group (his report, 2026-10-04: every cloud session carries its
  // own folder called "workspace", and a heading per folder made a hundred
  // "WORKSPACE" labels with one thread under each). Only a desktop session
  // groups by its folder.
  if (src && src.kind === "local" && (src as { locus?: string }).locus !== "cloud") return `local:${src.path || c.workdir || ""}`;
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
  // Leading slot: the STATE dot (his order, 2026-09-29) — green working,
  // yellow waiting on you, red the last turn failed, grey idle. It used to be
  // a locus glyph (a monitor or a cloud), which was the same on every row.
  // It still TOGGLES THE PIN on click.
  const dot = sessDot(c.id);
  dot.classList.toggle("pinned", !!c.pinned);
  dot.title = `${dot.title} — click to ${c.pinned ? "unpin" : "pin"}`;
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
  row.addEventListener("click", () => selectChat(c));
  return row;
}

/** Make a stored session the current one, on screen — the recents row's
 *  click, also the path a Glyphh-loop session takes from the rail. */
function selectChat(c: CodeChat): void {
  // A RAIL SESSION CLICK ON THE WEB dumps whatever screen is open — the
  // full-screen page, every work panel — and shows the session (his order,
  // 2026-10-05). The workbench owns the panels; code-workbench.ts binds the
  // door and it is a no-op on the desktop.
  (window as unknown as { __wbWebShowAgentOnly?: () => void }).__wbWebShowAgentOnly?.();
  // A loop or route picked on the landing belonged to the session that was
  // not born; an opened session runs on its own.
  pendingLoop = "";
  pendingRoute = null;
  currentId = c.id;
  lastSession = c.id;
  void window.glyphh.setPreference?.(LAST_SESSION_PREF, c.id);
  threadPinned = true;
  void saveStore();
  ensureCodeSection();
  // THE THREAD'S OWN TYPE DRESSES THE PANEL (his report, 2026-09-29: "selecting
  // a recent work is not respecting the type in terms of hiding features on the
  // agent panel — it loads the full agent regardless"). Opening a thread is the
  // one moment the type on screen changes without a tab click, and nothing here
  // was writing it: the attribute the CSS keys off kept the previous session's
  // type, and the composer kept its dev chrome.
  syncSpaceAttrs();
  paintComposerGate();
  renderHistory();
  renderThread();
  adoptRunIfElsewhere(c);
  broadcastTimeline(!!currentRun());   // the Plan timeline follows the thread on screen
  void checkWorkdirGate();
  applySessionFolder(c);   // the workbench follows the thread's folder
  // The opened session's OWN source drives the chip, the head locus and the
  // run — without this the chip stays on the previous (pending) source and
  // every rail-opened session looked like it ran in the cloud.
  repaintSourceUi();
  // ONLY navigate to the agent when one isn't already showing. If an agent is
  // on screen, the session was just swapped into it (renderThread above) — never
  // reset the workbench layout or spawn a second agent for a rail click.
  const agent = document.querySelector<HTMLElement>(".code-agent");
  const agentShowing = !!agent && agent.offsetParent !== null;
  if (!agentShowing) gotoSection("agent");
}

const DECLINE_WARN_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>`;
/** What to type once the CLI is open, when signing in is not automatic. */
const SIGNIN_HINT: Record<string, string> = { claude: "(type /login)", copilot: "(type /login)", gemini: "(type /auth)" };

/** The sign-in card: a CLI whose login ran out says which CLI and what
 *  command fixes it (main's glyphh-agent:error `fix`), instead of the raw
 *  error echo. */
function declineCardEl(d: { kind: string; url: string; cli?: string; command?: string }): HTMLElement {
  const card = document.createElement("div");
  card.className = `decline-card decline-card--${d.kind}`;
  card.innerHTML = `
    <div class="decline-card-icon">${DECLINE_WARN_SVG}</div>
    <div class="decline-card-main">
      <div class="decline-card-title"></div>
      <div class="decline-card-body"></div>
      <div class="decline-card-actions">
        <button class="decline-card-cta" type="button"></button>
      </div>
    </div>`;
  const name = d.cli ? LOOP_NAMES[d.cli as keyof typeof LOOP_NAMES] ?? d.cli : "";
  (card.querySelector(".decline-card-title") as HTMLElement).textContent = "Sign in to continue";
  const cli = d.cli && isVendorLoop(d.cli) ? d.cli : "";
  // THE PANEL'S OWN TERMINAL VIEW (his report, 2026-10-19: the button opened
  // an outside terminal while he had already signed in in the panel's): the
  // CLI opens interactive right here, on this conversation, to sign in.
  const termView = (): HTMLElement | null => document.getElementById("code-term-toggle");
  const hint = SIGNIN_HINT[cli] ? ` ${SIGNIN_HINT[cli]}` : "";
  (card.querySelector(".decline-card-body") as HTMLElement).textContent = !d.command
    ? "The agent needs you to sign in again before a turn can run. Then send this message once more."
    : termView()
      ? `${name || "The CLI"} needs you to sign in again. Sign in from the terminal view${hint}, then come back to chat and send this message once more.`
      : `${name || "The CLI"} needs you to sign in again — run \`${d.command}\` in a terminal${hint}, then send this message once more.`;
  const cta = card.querySelector<HTMLButtonElement>(".decline-card-cta")!;
  cta.textContent = cli ? `Sign in to ${name}` : "Open settings";
  cta.addEventListener("click", () => {
    if (cli) {
      const toggle = termView();
      if (toggle) { toggle.click(); return; }
      // No terminal view here: the CLI's login runs in the system terminal (main's cli-login).
      void window.glyphh.cliLogin?.(cli).then((r) => { if (r && !r.ok) toastError(r.error || "The terminal could not be opened."); });
      return;
    }
    (window as unknown as { __glyphhOpenSettings?: (sub?: string) => void }).__glyphhOpenSettings?.("general");
  });
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
/** RE-PIN AFTER LAYOUT (his report, 2026-10-08: an agent loading with a prior
 *  session in a workspace sat at the top of its thread). The synchronous pin
 *  in renderThread lands before the thread has its height — the card is still
 *  being seated, the history has just painted — and re-seating the agent into
 *  a card detaches and re-attaches its scroller, which drops scrollTop to 0.
 *  So the pin is applied again on the next two frames, ONLY while the thread
 *  is pinned: a member who scrolled up is never dragged down. */
function repinThreadSoon(): void {
  const again = (): void => {
    if (!threadPinned) return;
    const thread = el<HTMLDivElement>("code-thread");
    if (thread) thread.scrollTop = thread.scrollHeight;
  };
  requestAnimationFrame(() => { again(); requestAnimationFrame(again); });
}
(window as unknown as { __glyphhThreadRepin?: () => void }).__glyphhThreadRepin = repinThreadSoon;

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
  applySessionFolder(c);   // the workbench follows the thread's folder
  threadPinned = true;
  void saveStore();
  ensureCodeSection();
  renderHistory();
  renderThread();
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
  paintAskDock();          // re-bind the approval dock to the session now on screen
  paintChips();            // the mode chip reflects the SESSION on screen (per-session mode)
  // The one-line status is CURRENT-SESSION state: without this, switching
  // away from a running session left ITS "Working…"/steps painted above a
  // session that isn't running (every live update is currentId-guarded, so
  // nothing else ever corrected it).
  paintStatusLine();
  const thread = el<HTMLDivElement>("code-thread");
  if (!thread) return;
  wireThreadScroll(thread);
  thread.textContent = "";
  const inner = document.createElement("div");
  inner.className = "code-thread-inner";
  thread.appendChild(inner);
  stopGhostRotation();
  const c = current();
  document.querySelector(".code-agent")?.classList.remove("work-landing");
  // EVERY agent's empty thread is the SAME: the mascot + a line. Code used to
  // render its own two-column landing here, so the coding agent looked like a
  // different product from Chat and Work — the + New Session screen is where
  // suggestions and session lists belong, not inside an agent.
  if (!c || (!c.messages.length && !liveRuns.has(c.id))) {
    const ghost = document.createElement("div");
    ghost.className = "code-ghost";
    // MASCOT = the standard Glyphh mark, black & white (the time-of-day
    // cousins read as purple cats — retired from the landing).
    const mark = document.createElement("div");
    mark.className = "code-ghost-mark";
    mark.innerHTML = `<img src="brand/glyphh-mark.png" alt="" draggable="false" />`;
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
          // Images render as previews in the thread (his order, 2026-09-20), not
          // as file chips; a click opens the lightbox. Files and folders keep the chip.
          for (const a of b.msg.attachments) atts.appendChild(a.kind === "image" ? attachPreviewEl(a) : attachChipEl(a));
          if (b.msg.text) inner.appendChild(el);
          inner.appendChild(atts);
          return;
        }
      } else if (b.msg.kind === "connect" || b.msg.kind === "app") {
        return;
      } else if (b.msg.kind === "decline" && b.msg.decline) {
        el.className = "code-decline-wrap";
        el.appendChild(declineCardEl(b.msg.decline));
      } else if (b.msg.kind === "artifact" && b.msg.artifact) {
        // WHAT THE TURN MADE (his order, 2026-09-29): a card with a look at it.
        el.className = "code-artifact-wrap";
        el.appendChild(artifactCardEl(b.msg.artifact, openImageLightbox));
      } else if (b.msg.role === "assistant" && turnError(b.msg.text)) {
        // A REFUSAL IS A CARD, NOT A SENTENCE (his reports, 2026-09-29: "still
        // no fucking card i asked for"): no plan, out of budget, no model, a
        // model its provider will not answer for — each with the door that
        // fixes it, and the raw words folded away.
        inner.appendChild(turnErrorCardEl(b.msg.text));
        return;
      } else {
        if (b.msg.thinking && b.msg.thinking.trim()) inner.appendChild(thinkingEl(b.msg.thinking));
        el.className = "code-agent-text";
        el.innerHTML = formatMarkdown(b.msg.text);
        inner.appendChild(el);
        if (b.msg.timing) {
          const timing = document.createElement("div");
          timing.className = "code-msg-timing";
          timing.textContent = b.msg.timing;
          inner.appendChild(timing);
        }
        // COPY THE WHOLE REPLY (his order, 2026-09-29: "inline copy… theme
        // aligned"): the markdown as written, so pasting it anywhere keeps the
        // code fences and lists intact.
        if (b.msg.text.trim()) inner.appendChild(msgActionsEl(b.msg.text));
        return;
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
  // THE SPINNER OUTLIVES THE REPAINT (his report, 2026-10-06: on the web it
  // flickered and its words changed on every tool call above it). renderThread
  // runs on every streamed event; destroying and recreating the cube here
  // restarted its tumble and its phrase each time. One spinner per live run:
  // made when the run starts, moved into each fresh row, destroyed when the
  // run ends (below, and setThinking(false)).
  if (!liveRun) { spinner?.destroy(); spinner = null; }
  if (liveRun) {
    liveRun.bubble = null;
    liveRun.thinkEl = null;
    if (liveRun.thinking) {
      liveRun.thinkEl = thinkingEl(liveRun.thinking);
      inner.appendChild(liveRun.thinkEl);
    }
    if (liveRun.text) {
      liveRun.bubble = document.createElement("div");
      liveRun.bubble.className = "code-agent-text";
      paintBubble(liveRun.bubble, liveRun.text);
      inner.appendChild(liveRun.bubble);
    }
    if (!spinner) spinner = createGlyphhSpinner();
    paintRunMeta();
    const row = document.createElement("div");
    row.className = "code-working";
    row.appendChild(spinner.el);
    inner.appendChild(row);
  }
  if (threadPinned) { thread.scrollTop = thread.scrollHeight; repinThreadSoon(); }
}

/** The model picker, opened from a card. */
function openModelPicker(): void {
  const chip = el("code-model-chip");
  const menu = el("code-model-menu");
  if (chip && menu?.classList.contains("hidden")) chip.click();
}

/** A failed turn as a card (help/turn-errors.ts reads which kind): a title,
 *  a line, the model picker when a model is the fix, and the raw words folded. */
function turnErrorCardEl(text: string): HTMLElement {
  const e = turnError(text)!;
  const card = document.createElement("div");
  card.className = "code-money-card warn";
  card.setAttribute("role", "alert");
  const body = document.createElement("div");
  body.className = "code-money-text";
  const t = document.createElement("div");
  t.className = "code-money-title";
  t.textContent = e.title;
  const d = document.createElement("div");
  d.className = "code-money-body";
  d.textContent = e.body;
  body.append(t, d);
  card.appendChild(body);
  if (e.action === "models") {
    const go = document.createElement("button");
    go.type = "button";
    go.className = "action-btn primary";
    go.textContent = "Pick a model";
    go.addEventListener("click", openModelPicker);
    card.appendChild(go);
  }
  if (e.raw && e.kind !== "no-model") {
    const more = document.createElement("details");
    more.className = "code-money-details";
    const sum = document.createElement("summary");
    sum.textContent = "Details";
    const pre = document.createElement("pre");
    pre.textContent = e.raw;
    more.append(sum, pre);
    body.appendChild(more);
  }
  return card;
}

const MSG_COPY_SVG = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></svg>`;
const MSG_CHECK_SVG = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>`;
/** The row under an agent reply: copy, for now. It shows on hover and on
 *  keyboard focus, so it never competes with the reading. */
function msgActionsEl(text: string): HTMLElement {
  const row = document.createElement("div");
  row.className = "code-msg-actions";
  const copy = document.createElement("button");
  copy.type = "button";
  copy.className = "code-msg-action";
  copy.title = "Copy";
  copy.setAttribute("aria-label", "Copy reply");
  copy.innerHTML = MSG_COPY_SVG;
  copy.addEventListener("click", (e) => {
    e.stopPropagation();
    void navigator.clipboard.writeText(text).then(() => {
      copy.innerHTML = MSG_CHECK_SVG;
      copy.classList.add("copied");
      copy.title = "Copied";
      setTimeout(() => { copy.innerHTML = MSG_COPY_SVG; copy.classList.remove("copied"); copy.title = "Copy"; }, 1500);
    }).catch(() => { /* clipboard refused: the reply is still selectable */ });
  });
  row.appendChild(copy);
  return row;
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

  // "✓ Write /abs/path" (and Read/Edit) → file card; click routes through the
  // workbench's smart opener (editor / Browser panel / native viewer by
  // type). Unix and Windows absolute paths both match.
  const write = /^([✓✕⚙]) (?:Write|Read|Edit) ((?:\/|[A-Za-z]:[\\/])\S.*?)\s*$/.exec(rest);
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
    appendMarkup(line, badge);
  } else {
    line.textContent = text;
  }
  return line;
}

// Expanded tool groups (keyed chatId:firstMsgTimestamp) — transient UI state.
const expandedToolGroups = new Set<string>();

/** A person's own open/closed choice, per group and per step — it outranks
 *  the defaults (a live group shows its steps, a failed step shows its output). */
const toolGroupOpen = new Map<string, boolean>();
const toolStepOpen = new Map<string, boolean>();

/** THE STEPS OF A TURN, drawn (help/tool-view.ts): one foldable group, every
 *  step foldable inside it — a diff, a command and its output, a tool's I/O. */
function richToolGroupEl(chatId: string, msgs: CodeMsg[], live: boolean): HTMLElement {
  const key = `${chatId}:${msgs[0]?.at ?? 0}`;
  const open = toolGroupOpen.get(key) ?? live;
  const recs = msgs.map((m) => m.tool).filter((r): r is ToolRec => !!r);
  const wrap = document.createElement("div");
  wrap.className = `tv-group${live ? " live" : ""}${open ? " open" : ""}`;
  const head = document.createElement("button");
  head.type = "button";
  head.className = "tv-group-head";
  head.setAttribute("aria-expanded", open ? "true" : "false");
  const label = document.createElement("span");
  label.className = "tv-group-label";
  label.innerHTML = (live ? `<span class="tv-spin" aria-hidden="true"></span>` : "") + summaryOf(recs, live).html;
  head.appendChild(label);
  head.insertAdjacentHTML("beforeend", `<svg class="tv-chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="9 18 15 12 9 6"/></svg>`);
  head.addEventListener("click", () => { toolGroupOpen.set(key, !open); renderThread(); });
  wrap.appendChild(head);
  if (!open) return wrap;
  const list = document.createElement("div");
  list.className = "tv-steps";
  msgs.forEach((m, i) => {
    if (!m.tool) { list.appendChild(toolLineEl(m.text)); return; }
    const stepKey = `${key}:${i}`;
    const stepOpen = toolStepOpen.get(stepKey) ?? m.tool.state === "failed";
    list.appendChild(stepEl(m.tool, stepOpen, () => { toolStepOpen.set(stepKey, !stepOpen); renderThread(); }));
  });
  wrap.appendChild(list);
  return wrap;
}

function toolGroupEl(chatId: string, msgs: CodeMsg[], live = false): HTMLElement {
  // A turn recorded with step records draws them; an older transcript keeps
  // its one-line rows.
  if (msgs.some((m) => m.tool)) return richToolGroupEl(chatId, msgs, live);
  const key = `${chatId}:${msgs[0]?.at ?? 0}`;
  const open = expandedToolGroups.has(key);
  const wrap = document.createElement("div");
  wrap.className = "code-tool-group" + (live ? " live" : "");
  const failed = msgs.filter((m) => m.text.startsWith("✕")).length;
  const head = document.createElement("button");
  head.type = "button";
  head.className = "code-tool-summary" + (open ? " open" : "");
  head.innerHTML = `<span></span><svg class="tg-chev" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>`;
  // Live = present-tense "Working" tray (the count updates as tools stream in);
  // settled = the CC-style recap: "Ran 17 commands, edited 2 files +22 -2" —
  // commands counted from Run: lines, DISTINCT files from Write/Edit lines,
  // and the net diff summed from their [+N -M] suffixes.
  if (live) {
    (head.firstChild as HTMLElement).textContent =
      `Working — ${msgs.length} tool call${msgs.length === 1 ? "" : "s"}…`;
  } else {
    const cmds = msgs.filter((m) => /^[✓✕] Run: /.test(m.text)).length;
    const editPaths = new Set<string>();
    let added = 0;
    let removed = 0;
    for (const m of msgs) {
      const w = /^[✓⚙] (?:Write|Edit) (.*?)(?:\s\[\+(\d+) -(\d+)\])?\s*$/.exec(m.text);
      if (!w) continue;
      editPaths.add(w[1]);
      added += Number(w[2] || 0);
      removed += Number(w[3] || 0);
    }
    const editCalls = msgs.filter((m) => /^[✓⚙] (?:Write|Edit) /.test(m.text)).length;
    const nonEdit = msgs.length - editCalls;
    // The non-edit half reads "commands" when that's all it is, else "tool calls".
    const ranLabel = nonEdit
      ? (cmds === nonEdit ? `${cmds} command${cmds === 1 ? "" : "s"}` : `${nonEdit} tool call${nonEdit === 1 ? "" : "s"}`)
      : "";
    const editLabel = editPaths.size ? `edited ${editPaths.size} file${editPaths.size === 1 ? "" : "s"}` : "";
    let label: string;
    if (ranLabel && editLabel) label = `Ran ${ranLabel}, ${editLabel}`;
    else if (editLabel) label = `Edited ${editLabel.slice("edited ".length)}`;
    else label = `Ran ${ranLabel}`;
    if (failed) label += ` · ${failed} failed`;
    const badge = (added || removed)
      ? ` <span class="code-diff-badge"><span class="diff-add">+${added}</span> <span class="diff-del">-${removed}</span></span>`
      : "";
    (head.firstChild as HTMLElement).innerHTML = escAttr(label) + badge;
  }
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
  gitBranches?: (root: string) => Promise<GitBranchesView>;
  gitSwitch?: (root: string, branch: string) => Promise<GitBranchesView>;
  gitCreateBranch?: (root: string, name: string) => Promise<GitBranchesView>;
  gitInit?: (root: string) => Promise<GitBranchesView>;
};
type GitBranchesView = { isRepo: boolean; current?: string; branches: string[]; error?: string };
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
// Where the next session runs: a folder on this machine. One pending pick
// (spaces are gone), stamped onto the record the first send creates.
const DEFAULT_SOURCE: Source = { kind: "local", path: "" };
/** The RESOLVED default — this machine's last-used working folder. Computed
 *  once at boot by the SOURCE_PREF restore below; closing a session falls
 *  back to THIS. */
let resolvedDefaultSource: Source = { ...DEFAULT_SOURCE };
let pendingSource: Source = { ...DEFAULT_SOURCE };

const SOURCE_PREF = "workspaceSourceCode";
let sourceChip: ReturnType<typeof createSourceChip> | null = null;

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
  // A cloud source is its repos, their base branches and its environment
  // (his report, 2026-10-05): a branch or environment change is a change.
  if (a.kind === "cloud-repo" && b.kind === "cloud-repo") {
    return a.repo === b.repo && (a.branch ?? "") === (b.branch ?? "") && environmentIdOf(a) === environmentIdOf(b)
      && JSON.stringify(picksOf(a)) === JSON.stringify(picksOf(b));
  }
  if (a.kind === "cloud-space" && b.kind === "cloud-space") return a.space === b.space;
  if (a.kind === "local" && b.kind === "local") return a.path === b.path && (a.machineId ?? "") === (b.machineId ?? "");
  return environmentIdOf(a) === environmentIdOf(b); // cloud-new === cloud-new, same environment
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

  // A BORN session's source is IMMUTABLE — but a DIFFERENT pick on a born
  // session means "work on THIS now", so it starts a NEW session lazily (the
  // header comment's contract; the code used to silently ignore the pick,
  // which read as "selecting the repo doesn't select it"). The born session
  // keeps its source; currentId clears and the next send births a session
  // carrying the pick — layout panels stay up, same seat.
  if (cur && cur.messages.length > 0 && !onHome) {
    if (sameSource(cur.source ?? pendingSource, next)) { repaintSourceUi(); return; }
    // Leaving the born session re-roots the shell: a programmatic re-root,
    // not a pick — the same window applySessionFolder arms for an open.
    cwdStampSuppressedUntil = Date.now() + 1500;
    currentId = "";
    lastSession = "";
    void window.glyphh.setPreference?.(LAST_SESSION_PREF, "");
    void saveStore();
    renderHistory();
    renderThread();
  }

  // No session / Home / an UNBORN current session — set the pending pick and,
  // for an unborn current session, re-stamp its source (still cheap to change).
  // THE PICK IS THE FOLDER (his report, 2026-10-05): threadFolder() reads the
  // workdir first, so the pick writes BOTH fields — as setThreadFolder does —
  // or the chip keeps naming the old folder and the run keeps using it.
  pendingSource = next;
  if (cur && cur.messages.length === 0) {
    cur.source = next;
    cur.workdir = folderAfterPick(next, cur.workdir ?? "") || undefined;
    if (next.kind === "local" && cur.workdir) rootShellTo(cur.workdir);
    void saveStore();
  } else {
    pendingWorkdir = folderAfterPick(next, pendingWorkdir);
    if (next.kind === "local" && pendingWorkdir) rootShellTo(pendingWorkdir);
  }
  paintSourceDependents();
  void window.glyphh.setPreference?.(SOURCE_PREF, next);
  sourceChip?.setSource(next);
  void refreshModelList();
}

/** The composer's resting prompt. */
function readyPlaceholder(): string {
  // The prompt names what the type is FOR (his choice, 2026-09-29): Work drives
  // apps and accounts, Code builds and fixes.
  const c = current();
  return "Describe what to build or fix…";
}

/** Nothing to run with: the org allows no model on the gateway lane. Kept
 *  narrow on purpose — a login or BYOK loop asks its own endpoint and an empty
 *  answer there means offline, not forbidden. */
function noModelAllowed(): boolean {
  // A CLI on its own login brings its own models; only the router's lane can run out.
  return activeLane() === "router" && modelSource === "gateway" && availModels.length === 0;
}

function paintComposerGate(): void {
  const ta = input();
  if (!ta) return;
  const open = workdirReady && !noModelAllowed();
  ta.disabled = !open;
  ta.placeholder = open
    ? readyPlaceholder()
    : noModelAllowed()
      ? "Your organization hasn't allowed any model yet"
      : "Pick a working folder to start — click here to choose";
  const sendBtn = el("code-send");
  sendBtn?.toggleAttribute("disabled", !open);
  if (sendBtn) sendBtn.title = thinking ? "Stop" : "Send";
  const wrap = document.querySelector(".code-input-wrap");
  wrap?.classList.toggle("gated", !open);
  // With TEXT in the composer (a seeded prompt) the placeholder is
  // invisible — the gate needs its own voice, or the chat just looks dead.
  // (The cloud gate wears no note: the box stays typeable, the placeholder
  // and the disabled send carry the line, as on the phone.)
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
  initFolderLocusChips();
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
 * Move the source chip into whichever composer row is on screen.
 *
 * There is ONE, and it used to be appended to whichever row existed when
 * prefs finished loading — so the AGENT view could come up with no source
 * chip while the landing held it. The composer moves between Home and the
 * thread; its chip has to move with it.
 */
function homeChips(): void {
  const onHome = document.body.classList.contains("composer-on-home");
  const host = document.getElementById(onHome ? "dash-source-slot" : "code-source-slot");
  // FIRST in the row, always — `<source> <folder> <git> <+>`. Checking only
  // the parent left it wherever it was appended, which put the source chip
  // last in the agent row.
  if (host && sourceChip && host.firstElementChild !== sourceChip.el) host.prepend(sourceChip.el);
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
  const seq = ++gitStateSeq;
  const paint = (git: { isRepo: boolean; branch?: string } | null): void => {
    if (seq !== gitStateSeq) return;   // a newer pick landed while we asked
    if (!git) { hide(); return; }
    (wrap as HTMLElement).style.display = "";
    wrap.classList.toggle("no-git", !git.isRepo);
    label.textContent = git.isRepo ? (git.branch || "git") : "No git";
    wrap.setAttribute("title", git.isRepo
      ? `Git repository${git.branch ? ` on ${git.branch}` : ""}`
      : "No git repository in this folder yet");
  };
  if (src.kind !== "local") { hide(); return; }
  wireBranchChip(wrap as HTMLElement);
  void gitDir().then((dir) => (dir ? gitStateFor(dir) : null)).then(paint);
}

/** The folder the branch chip speaks for. The DESKTOP's local source carries
 *  no path — the machine's own working directory is the folder in play there. */
async function gitDir(): Promise<string> {
  const src = activeSource();
  if (src.kind !== "local") return "";
  return src.path || (await wb()?.getCwdExplicit?.().catch(() => null)) || "";
}

const BRANCH_CHECK = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="m5 12 5 5L20 7"/></svg>`;
const BRANCH_IC = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="6" cy="6" r="2"/><circle cx="6" cy="18" r="2"/><circle cx="18" cy="8" r="2"/><path d="M6 8v8"/><path d="M18 10v1a4 4 0 0 1-4 4H8"/></svg>`;
let branchMenu: HTMLElement | null = null;
const closeBranchMenu = (): void => { branchMenu?.remove(); branchMenu = null; };

/** THE BRANCH CHIP IS A PICKER: click → the folder's branches (switch), New
 *  branch…, or — on a folder without git — Turn on git. Wired once per chip. */
function wireBranchChip(wrap: HTMLElement): void {
  if (wrap.dataset.picker) return;
  wrap.dataset.picker = "1";
  wrap.classList.add("clickable");
  wrap.setAttribute("role", "button");
  wrap.addEventListener("click", (e) => {
    e.stopPropagation();
    if (branchMenu) { closeBranchMenu(); return; }
    void openBranchMenu(wrap);
  });
}

async function openBranchMenu(anchor: HTMLElement): Promise<void> {
  const bridge = wb();
  const dir = await gitDir();
  if (!bridge?.gitBranches || !dir) return;
  const state = await bridge.gitBranches(dir).catch((err: unknown) => ({ isRepo: false, branches: [], error: err instanceof Error ? err.message : String(err) }) as GitBranchesView);
  closeBranchMenu();
  const menu = document.createElement("div");
  menu.className = "yo-workdir-menu open code-branch-menu";
  menu.setAttribute("role", "menu");
  const item = (label: string, opts: { check?: boolean; icon?: string; onClick: () => void }): void => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "yo-workdir-menu-item";
    b.innerHTML = `<span class="check">${opts.check ? BRANCH_CHECK : ""}</span><span class="ic">${opts.icon ?? ""}</span><span class="nm"></span>`;
    (b.querySelector(".nm") as HTMLElement).textContent = label;
    b.title = label;
    b.addEventListener("click", () => { closeBranchMenu(); opts.onClick(); });
    menu.appendChild(b);
  };
  const after = (p: Promise<GitBranchesView>): void => {
    void p.then(() => paintGitState(), (err: unknown) => { toastError(err instanceof Error ? err.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, "") : String(err)); paintGitState(); });
  };
  if (!state.isRepo) {
    item("Turn on git for this folder", { onClick: () => { if (bridge.gitInit) after(bridge.gitInit(dir)); } });
  } else {
    for (const name of state.branches) {
      item(name, { check: name === state.current, icon: BRANCH_IC, onClick: () => { if (name !== state.current && bridge.gitSwitch) after(bridge.gitSwitch(dir, name)); } });
    }
    const sep = document.createElement("div");
    sep.className = "yo-workdir-menu-sep";
    menu.appendChild(sep);
    item("New branch…", { onClick: () => void newBranch(dir) });
  }
  document.body.appendChild(menu);
  branchMenu = menu;
  // Open UP from the composer row, the folder chip's direction.
  const r = anchor.getBoundingClientRect();
  menu.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - menu.offsetWidth - 8))}px`;
  if (r.top > window.innerHeight / 2) { menu.style.top = "auto"; menu.style.bottom = `${window.innerHeight - r.top + 4}px`; }
  else { menu.style.bottom = "auto"; menu.style.top = `${r.bottom + 4}px`; }
  const dismiss = (ev: MouseEvent): void => {
    if (branchMenu && branchMenu.contains(ev.target as Node)) return;
    document.removeEventListener("mousedown", dismiss, true);
    closeBranchMenu();
  };
  setTimeout(() => document.addEventListener("mousedown", dismiss, true), 0);
}

async function newBranch(dir: string): Promise<void> {
  const bridge = wb();
  if (!bridge?.gitCreateBranch) return;
  const { formModal } = await import("./settings-list-page.js");
  await formModal({
    title: "New branch",
    submitLabel: "Create & switch",
    fields: [{ key: "name", label: "Branch name", required: true, placeholder: "feature/my-change" }],
    onSubmit: async (v) => {
      try { await bridge.gitCreateBranch!(dir, v.name.trim()); }
      catch (err) { return { ok: false as const, error: err instanceof Error ? err.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, "") : String(err) }; }
      paintGitState();
      return { ok: true as const };
    },
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
  // A CLOUD source browses the POD workspace with the folder chip (his ask,
  // 2026-08-20) — only the + (a machine mkdir) has nothing to do there.
  const FOLDER_CHIPS = new Set(["dash-wd-add", "code-workdir-add"]);
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
  // WEB: the folder chip shows the SESSION source's folder (the machine's cwd
  // concept doesn't reach a browser) — Home until a pick lands.
  // The folder chip names the folder the session is IN — the last segment of
  // the picked path, not the root it was browsed from. Painted on BOTH rows and
  // both surfaces from the SOURCE, so a machine's cwd can't overwrite the pick.
  {
    const src = activeSource();
    // THE CHIP SHOWS THE LOCUS (his order, 2026-10-04): a monitor or a cloud
    // before the folder's name, on both rows and both surfaces.
    for (const id of ["dash-wd-btn", "code-workdir-btn"]) {
      const svg = document.getElementById(id)?.querySelector(":scope > svg");
      const want = LOCUS_SVG[sourceLocus(src)];
      if (svg && svg.getAttribute("data-locus") !== sourceLocus(src)) {
        const tpl = document.createElement("template");
        tpl.innerHTML = want;
        const next = tpl.content.firstElementChild as SVGElement | null;
        if (next) { next.setAttribute("data-locus", sourceLocus(src)); svg.replaceWith(next); }
      }
    }
    if (src.kind !== "local") {
      const dir = (src as { dir?: string }).dir || "";
      const leaf = dir ? (dir.split("/").filter(Boolean).pop() || dir) : "workspace";
      for (const id of ["dash-wd-name", "code-workdir-name"]) {
        const nameEl = document.getElementById(id);
        if (nameEl) nameEl.textContent = leaf;
      }
      for (const id of ["dash-wd-btn", "code-workdir-btn"]) {
        document.getElementById(id)?.setAttribute("title", dir ? `cloud workspace folder: ${dir}` : "Pick a folder in the cloud workspace");
      }
    }
    // THE CHIP IS THE RUN'S FOLDER (his report, 2026-09-29): what it names is
    // exactly what the next turn works in — threadFolder(), never a second field.
    const folder = src.kind === "local" ? threadFolder() : "";
    if (src.kind === "local" && folder) {
      const leaf = folder.replace(/\/+$/, "").split("/").filter(Boolean).pop() || folder;
      for (const id of ["dash-wd-name", "code-workdir-name"]) {
        const nameEl = document.getElementById(id);
        if (nameEl) nameEl.textContent = leaf;
      }
      for (const id of ["dash-wd-btn", "code-workdir-btn"]) {
        document.getElementById(id)?.setAttribute("title", `This session works in ${folder} — and only there`);
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
/** The workspace scope a cloud folder pick browses: an existing SPACE, else a
 *  BORN session's thread (its workspace exists after the first send). */
function cloudBrowseScope(): string | null {
  const src = activeSource();
  if (src.kind === "cloud-space") return src.space;
  const c = current();
  if (c && c.source && c.source.kind !== "local" && c.messages.length > 0) return c.id;
  return null;
}

/** Stamp a picked cloud folder onto the live source: the current cloud
 *  session's own source when there is one, else the pending pick. `""` means
 *  the workspace root (clears the dir). */
function setCloudDir(rel: string): void {
  const dir = rel.replace(/^\/+|\/+$/g, "");
  const c = current();
  if (c && c.source && c.source.kind !== "local") {
    (c.source as { dir?: string }).dir = dir || undefined;
    void saveStore();
  } else if (pendingSource.kind !== "local") {
    (pendingSource as { dir?: string }).dir = dir || undefined;
    void window.glyphh.setPreference?.(SOURCE_PREF, pendingSource);
  }
  repaintSourceUi();
}

/** THE FOLDER CHIP OPENS THE LOCUS PICKER on BOTH surfaces (his order,
 *  2026-10-04): "On this desktop" / "On <machine>" and "In the cloud", in one
 *  drop (code-source-chip.ts openFolderLocusPicker). Registered in CAPTURE so
 *  the workbench's own handler on the same button (the desktop's recents
 *  menu + OS picker) never runs — the picker offers both inside. The + chip
 *  keeps its one job: a new folder (the OS picker on the desktop, fs.mkdir
 *  over the relay on web). */
function initFolderLocusChips(): void {
  for (const id of ["dash-wd-btn", "code-workdir-btn"]) {
    const chip = document.getElementById(id);
    chip?.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopImmediatePropagation();
      const c = current();
      const onHome = document.body.classList.contains("composer-on-home");
      // A BORN session's locus is fixed (cloud stays cloud): the picker shows
      // the other place but will not pick it.
      const bornLocus = c && c.messages.length > 0 && !onHome ? sourceLocus(c.source ?? pendingSource) : null;
      openFolderLocusPicker(chip, {
        getSource: activeSource,
        onPick: pickSource,
        bornLocus,
        cloudScope: cloudBrowseScope(),
        onPickCloudDir: (rel) => setCloudDir(rel),
      });
    }, true);
  }
  if (!onWebTarget()) return;
  for (const id of ["dash-wd-add", "code-workdir-add"]) {
    const chip = document.getElementById(id);
    chip?.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopImmediatePropagation();   // the workbench's native-picker handler must not run
      openNewFolderDrop(chip, { getSource: activeSource, onPick: pickSource });
    }, true);
  }
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
/** The composer's `+` menu (composer-plus.ts), once mounted — ⌘U goes through it. */
let plusMenu: PlusController | null = null;

/** An image attachment inside the thread: a real preview with the name under
 *  it; clicking it opens the lightbox. */
function attachPreviewEl(a: AttachRef): HTMLElement {
  const fig = document.createElement("figure");
  fig.className = "code-attach-preview";
  fig.title = a.path;
  const img = document.createElement("img");
  img.src = localFileUrl(a.path);
  img.alt = a.name;
  img.loading = "lazy";
  img.onerror = () => { fig.replaceWith(attachChipEl(a)); };
  img.addEventListener("click", (e) => { e.stopPropagation(); openImageLightbox(img.src, a.name); });
  const cap = document.createElement("figcaption");
  cap.textContent = a.name;
  fig.append(img, cap);
  return fig;
}

/** THE LIGHTBOX (his order, 2026-09-20): a clicked image fills the window on a
 *  dark backdrop with an × top-right; the wheel, the +/− buttons and a
 *  double-click zoom, dragging pans while zoomed, Esc / the backdrop / the ×
 *  close it. One element, made on first use. */
// The doors format-markdown's image and file-link handlers knock on: a
// picture in any reply opens the lightbox, a file link opens the preview modal.
(window as unknown as { __glyphhLightbox?: (src: string, alt: string) => void }).__glyphhLightbox = (src, alt) => openImageLightbox(src, alt);
(window as unknown as { __glyphhOpenArtifact?: (path: string) => void }).__glyphhOpenArtifact = (path) => openArtifactModal(path, openImageLightbox);

function openImageLightbox(src: string, name: string): void {
  document.getElementById("code-lightbox")?.remove();
  const box = document.createElement("div");
  box.id = "code-lightbox";
  box.className = "code-lightbox";
  box.innerHTML = `
    <div class="code-lightbox-stage"><img class="code-lightbox-img" alt="" draggable="false" /></div>
    <button type="button" class="code-lightbox-x" title="Close (Esc)">&times;</button>
    <div class="code-lightbox-bar">
      <button type="button" class="code-lightbox-btn" data-zoom="out" title="Zoom out">−</button>
      <span class="code-lightbox-pct">100%</span>
      <button type="button" class="code-lightbox-btn" data-zoom="in" title="Zoom in">+</button>
      <button type="button" class="code-lightbox-btn" data-zoom="reset" title="Fit">Fit</button>
      <span class="code-lightbox-name"></span>
    </div>`;
  const stage = box.querySelector(".code-lightbox-stage") as HTMLElement;
  const img = box.querySelector(".code-lightbox-img") as HTMLImageElement;
  const pct = box.querySelector(".code-lightbox-pct") as HTMLElement;
  (box.querySelector(".code-lightbox-name") as HTMLElement).textContent = name;
  let scale = 1, tx = 0, ty = 0;
  const apply = (): void => {
    img.style.transform = `translate(${tx}px, ${ty}px) scale(${scale})`;
    pct.textContent = `${Math.round(scale * 100)}%`;
    stage.classList.toggle("zoomed", scale > 1.001);
  };
  /** Zoom around a point (the cursor) so what is under it stays put. */
  const zoom = (next: number, cx?: number, cy?: number): void => {
    const s = Math.max(0.25, Math.min(8, next));
    if (cx != null && cy != null) {
      const r = stage.getBoundingClientRect();
      const px = cx - r.left - r.width / 2 - tx;
      const py = cy - r.top - r.height / 2 - ty;
      tx -= px * (s / scale - 1);
      ty -= py * (s / scale - 1);
    }
    scale = s;
    if (scale <= 1.001) { tx = 0; ty = 0; }
    apply();
  };
  const close = (): void => { box.remove(); document.removeEventListener("keydown", onKey, true); };
  const onKey = (e: KeyboardEvent): void => {
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(); }
    else if (e.key === "+" || e.key === "=") zoom(scale * 1.25);
    else if (e.key === "-") zoom(scale / 1.25);
    else if (e.key === "0") zoom(1);
  };
  (box.querySelector(".code-lightbox-x") as HTMLButtonElement).addEventListener("click", close);
  box.querySelectorAll<HTMLButtonElement>(".code-lightbox-btn").forEach((b) => b.addEventListener("click", (e) => {
    e.stopPropagation();
    if (b.dataset.zoom === "in") zoom(scale * 1.25); else if (b.dataset.zoom === "out") zoom(scale / 1.25); else zoom(1);
  }));
  stage.addEventListener("click", (e) => { if (e.target === stage) close(); });
  stage.addEventListener("wheel", (e) => { e.preventDefault(); zoom(scale * (e.deltaY < 0 ? 1.12 : 1 / 1.12), e.clientX, e.clientY); }, { passive: false });
  img.addEventListener("dblclick", (e) => { e.stopPropagation(); zoom(scale > 1.001 ? 1 : 2.5, e.clientX, e.clientY); });
  let drag: { x: number; y: number; tx: number; ty: number } | null = null;
  img.addEventListener("pointerdown", (e) => { if (scale <= 1.001) return; drag = { x: e.clientX, y: e.clientY, tx, ty }; img.setPointerCapture(e.pointerId); e.preventDefault(); });
  img.addEventListener("pointermove", (e) => { if (!drag) return; tx = drag.tx + (e.clientX - drag.x); ty = drag.ty + (e.clientY - drag.y); apply(); });
  const endDrag = (): void => { drag = null; };
  img.addEventListener("pointerup", endDrag);
  img.addEventListener("pointercancel", endDrag);
  img.src = src;
  apply();
  document.body.appendChild(box);
  document.addEventListener("keydown", onKey, true);
}

function attachChipEl(a: AttachRef, onRemove?: () => void): HTMLElement {
  const chip = document.createElement("div");
  chip.className = `code-attach-chip ${a.kind}`;
  chip.title = a.path;
  if (a.kind === "image") {
    const img = document.createElement("img");
    img.src = localFileUrl(a.path);
    img.alt = "";
    // Unloadable thumb (moved file, odd format) degrades to the file glyph.
    img.onerror = () => {
      const ic = document.createElement("span");
      ic.className = "cac-ic";
      ic.innerHTML = FILE_ICON;
      img.replaceWith(ic);
    };
    img.addEventListener("click", (e) => { e.stopPropagation(); openImageLightbox(img.src, a.name); });
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

    // BOTTOM-RIGHT of the note (his spec, 2026-08-28): stop the agent and let
    // it read this now. The run ends, flushPendingNotes sends every waiting
    // note as the next turn, and the agent carries on from there — the same
    // path as stopping by hand, one click instead of two.
    const act = document.createElement("div");
    act.className = "cpn-actions";
    const interrupt = document.createElement("button");
    interrupt.className = "cpn-act";
    interrupt.type = "button";
    interrupt.textContent = "Interrupt";
    interrupt.title = "Stop the agent now — it reads what's waiting, then continues";
    interrupt.addEventListener("click", () => { if (thinking) stopThinking(); });
    act.appendChild(interrupt);

    row.append(text, del, act);
    wrap.appendChild(row);
  }
}

/** Mid-run Enter. Dot-commands are LOCAL and must still run here — ".drip rain"
 *  typed during a run played nothing and confused the model when it went in as
 *  prose. Everything else becomes a VISIBLE queued note (his spec, 2026-08-28):
 *  it shows on the card with an × to take it back and an Interrupt to have the
 *  agent read it now. Nothing is injected into the live turn behind the user's
 *  back — if it is on screen, they can still change their mind about it. */
function queueMidRun(): void {
  const ta = input();
  const text = ta?.value.trim();
  if (!ta || !text) return;
  const drip = /^\.drip(?:\s+(.+))?$/is.exec(text);
  if (drip) {
    ta.value = "";
    autoGrow(ta);
    void (window.glyphh as unknown as { dripsPreview?: (r: string) => Promise<string> })
      .dripsPreview?.((drip[1] || "fireworks").trim());
    return;
  }
  const dip = /^\.dip\s+(.+)$/is.exec(text);
  if (dip) {
    ta.value = "";
    autoGrow(ta);
    runDip(dip[1].trim());
    return;
  }
  queueNote();
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
function flushPendingNotes(tries = 0): void {
  if (!pendingNotes.length) return;
  const ta = input();
  // NO COMPOSER YET IS NOT "NEVER SEND" (his report, 2026-09-23: a message
  // typed during a run was not sent automatically when the turn ended). The
  // agent panel may be mid-mount, or the CLI view may hold the surface — the
  // composer arrives a beat later. Wait for it rather than dropping the turn;
  // the notes stay on their cards the whole time, so nothing is ever lost.
  if (!ta) {
    if (tries < 40) window.setTimeout(() => flushPendingNotes(tries + 1), 250);
    return;
  }
  const text = pendingNotes.map((n) => n.text).join("\n\n");
  pendingNotes = [];
  paintPendingNotes();
  ta.value = ta.value.trim() ? `${text}\n\n${ta.value.trim()}` : text;
  autoGrow(ta);
  // THE NOTES GO; THE ATTACHMENTS STAY (his report: images attached AFTER a
  // note was queued rode out with the auto-send before he was ready). A queued
  // note was written without them, so the flush sends only words — anything
  // sitting in the attach tray is still his to send, with his next message.
  const held = pendingAttach;
  pendingAttach = [];
  paintAttachChips();
  // After the finishRun paint settles, so the new turn lands under the old one.
  setTimeout(() => {
    send();
    if (held.length) {
      // send() emptied the tray for its own turn; restore his pending files
      // (minus any that somehow left in the meantime) so the chips come back.
      for (const a of held) if (!pendingAttach.some((p) => p.path === a.path)) pendingAttach.push(a);
      paintAttachChips();
    }
  }, 0);
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
  // THE + MENU (his order, 2026-10-06, Claude's composer as the reference):
  // ONE component on both surfaces (composer-plus.ts), right of the mode
  // chip — attach, Skills ›, Connectors ›, Devices ›, Memory ✓, and the
  // desktop's folder rows behind capability checks. Paste and drag-drop stay
  // as shortcuts to the same attach tray.
  const plusWrap = el("code-plus-wrap");
  if (plusWrap) {
    const toTarget = (t: ManageTarget): void => {
      if (t.kind === "group") openGroupTab(t.group, t.sub);
      else openSettingsModal(t.sub);
    };
    plusMenu = mountComposerPlus(plusWrap, el("code-plus-chip") as HTMLButtonElement | null, {
      surface: onWeb() ? "web" : "desktop",
      has: hostHas,
      api: window.glyphh as unknown as PlusApi,
      space: () => SESSION_MODE,
      attachFiles: () => { void window.glyphh.glyphhPickAttachments("files").then((refs) => { if (refs.length) queueAttachments(refs); }); },
      // "Add folder…" hands the loop READ ACCESS to a directory — a Code idea
      // (Work has no tool to walk one with; the row is Code-only).
      attachFolder: () => { void window.glyphh.glyphhPickAttachments("folder").then((refs) => { if (refs.length) queueAttachments(refs); }); },
      workingFolder: async () => { const d = await wb()?.getCwdExplicit?.(); return d ? String(d) : null; },
      pickWorkingFolder: () => { void wb()?.pickCwd?.({ nullOnCancel: true }).then(() => checkWorkdirGate()); },
      openTarget: toTarget,
      addConnector: () => { toTarget(manageTargetOf(onWeb() ? "web" : "desktop", "connectors")); },
      toast: toastOk,
      place: openChipDropUp,
      // The Loop section: the roster is re-read first, so a loop turned on in
      // Settings shows at once.
      loop: {
        state: loopSectionState,
        fillLoops: async (pane, done) => { await refreshLoops().catch(() => undefined); fillLoopList(pane, done); },
        fillRoutes: fillRouteList,
      },
    });
  }
  input()?.addEventListener("paste", (e) => { void handleComposerPaste(e); });
  // TINY FOCUS SOUND (his ask, 2026-08-19): a soft low thunk when the mouse
  // clicks INTO the input — only on entry (already-focused clicks stay
  // silent), and only for pointer clicks, never keyboard/programmatic focus.
  input()?.addEventListener("mousedown", (e) => {
    if (document.activeElement !== e.currentTarget) uiSound("focus");
  });
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
  paintComposerSlot();   // the typed state decides the slot (send ↑ / the voice pair)
  // Grow with input up to ~10 lines, then scroll internally. Skip while the
  // textarea has no real width (the agent card mid-entrance): scrollHeight
  // wraps into a tower and the height sticks tall after the card widens.
  if (ta.clientWidth < 60) return;
  ta.style.height = "auto";
  const h = Math.min(ta.scrollHeight, 220);
  ta.style.height = h + "px";
  // PAST ONE LINE the pill MUST become the expanded input (his rule,
  // 2026-08-19) — a multi-line capsule at 999px radius is a blimp. The
  // auto-open is tracked separately so shrinking back to one line only
  // collapses what IT opened, never a caret-opened card.
  const card = ta.closest(".code-input-card");
  if (!card) return;
  // STICKY expansion (his rule, 2026-08-19): expanding used to reseat the
  // +/mic chips, which CHANGED the wrap width — closing on "back under one
  // line" re-wrapped the text and re-opened it, flickering at the breakpoint.
  // So auto-open latches: it only releases when the input is EMPTY (sent or
  // cleared). Definitive, no oscillation. (The seats follow the TYPE now,
  // not the fold — seatMic — but the latch stays: it is the calmer rule.)
  const tall = h > 44;
  if (tall && !card.classList.contains("options-open")) card.classList.add("options-open", "auto-open");
  else if (!ta.value.trim() && card.classList.contains("auto-open")) card.classList.remove("options-open", "auto-open");
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
  paintComposerSlot();
  renderHistory(); // the panel header tracks the loop state
}

// ── THE SLOT (his order, 2026-10-07, Claude's composer as the reference):
// the wrap's data-slot says what sits at the input's right — the voice pair
// on an empty idle box, the accent ↑ once text is typed, the Stop pill while
// a turn runs, the ✕ ✓ + meter while dictation listens, the mic + ▮▮▮ Stop
// while hands-free listens. composer-state.ts decides; the stylesheet shows.
let listeningPainted = false;
function paintComposerSlot(): void {
  const ta = input();
  const wrap = document.querySelector<HTMLElement>(".code-input-wrap");
  if (!ta || !wrap) return;
  const st = { text: ta.value, running: thinking, voice: voiceState() };
  wrap.dataset.slot = composerSlot(st);
  const listening = composerListening(st);
  if (listening) { ta.placeholder = LISTENING_PLACEHOLDER; listeningPainted = true; }
  else if (listeningPainted) { listeningPainted = false; paintComposerGate(); }
}

/** `thinking` is VIEW state: whether the CURRENT chat is running. Re-derive
 *  on session switches so each session shows its own spinner and composer. */
function syncThinking(): void {
  setThinking(!!currentRun());
}

/** THIS session's bound model, or null (the loop's own default). */
/** The model a session runs on: its own pick, else the member's Settings →
 *  General default. Read lazily (defaultModelPref) so a chat that never
 *  chose one still opens on the configured default rather than "whatever
 *  the CLI feels like". */
function sessionModel(c: CodeChat | null | undefined): string | null {
  const loop = c?.loop || GLYPHH_LOOP;
  const cli = cliOfLoop(loop);
  // A CLI on its own login takes its own names; none = the loop's model, else the CLI's default (main decides).
  if (laneOf(c) === "cli") return cliPick(c, cli) || null;
  const raw = c?.models?.["default"] ?? defaultModelPref;
  if (autoPins(raw)) return autoModel()!.id;
  // A CLI on the gateway sends the router's id whole: main checks it against the user's chat models.
  if (isVendorLoop(cli)) return raw ? String(raw) : null;
  return bareModelId(raw);
}

/** Settings → General's default model, memoised for the session. Empty
 *  string means "inherit" — the loop's own, or the role's default for it. */
let defaultModelPref: string | null = null;
/** The default model main's model-watch reports ("" = the loop decides). */
let orgDefaultModel = "";
/** THE SERVER MOVED THE LIST (main's model-watch.ts, his report 2026-09-29:
 *  "server side changes to the model list are not automatically updating").
 *  Every open panel repaints its chip, and an open picker its rows. */
(window.glyphh as unknown as { onModelsChanged?: (cb: (c: { models: { ok: boolean; source: string; models: AvailModel[] }; defaultModel: string; gatewayOn: boolean }) => void) => void })
  .onModelsChanged?.((c) => {
    if (c.models?.ok) { availModels = c.models.models; modelSource = c.models.source === "gateway" ? "gateway" : "none"; }
    orgDefaultModel = c.gatewayOn ? String(c.defaultModel || "") : "";
    try {
      paintModelChip();
      const menu = el("code-model-menu");
      if (menu && !menu.classList.contains("hidden")) renderModelMenu();
    } catch { /* not mounted yet */ }
    // A transcription or speech model added or removed shows or hides the voice controls.
    void refreshMicChip(true);
  });
async function loadDefaultModelPref(): Promise<void> {
  try {
    const v = String((await (window.glyphh as unknown as { getPreference?: (k: string, d: unknown) => Promise<unknown> })
      .getPreference?.("defaultModel", "")) ?? "");
    defaultModelPref = v || null;
  } catch {
    defaultModelPref = null;
  }
}

function stopThinking(): void {
  // Abort the CURRENT chat's stream — main answers with glyphh-agent:done
  // { stopped: true } for that run; other sessions keep working.
  void window.glyphh.glyphhStop?.(currentId);
  // STOP MUST STOP (his report, 2026-08-30: "the user cannot stop the agent").
  // A run whose backend already died — an auth failure at turn start, a
  // crashed subprocess, a retry burst — never answers the stop above, and
  // the view spun forever with Stop wired to a corpse. Watchdog: if THIS run
  // is still live shortly after a stop was asked, settle it locally as
  // stopped. The real done{stopped} arriving first deletes the run, so the
  // identity check makes the watchdog a no-op on every healthy path.
  const chatId = currentId;
  const runAtStop = liveRuns.get(chatId);
  if (runAtStop) {
    window.setTimeout(() => {
      if (liveRuns.get(chatId) === runAtStop) finishRun(chatId, runAtStop.text || "", true);
    }, 2500);
  }
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

/** The panel/app/layout a bare ref resolves to. Tool views first (they are
 *  exact names), then a saved workspace, then an app, then a URL. */
async function dipOpenRef(ref: string): Promise<boolean> {
  const w = window as unknown as {
    __wbOpenLayoutByName?: (name: string) => Promise<boolean>;
    __wbOpenTool?: (v: string) => void;
    __wbOpenPopup?: (url: string) => void;
  };
  const key = ref.trim().toLowerCase();
  if (!key) return false;
  // A URL opens in a Browser panel — ".dip https://…" is navigation too.
  if (/^https?:\/\//i.test(ref) || /^[\w-]+(\.[\w-]+)+(\/|$)/.test(ref)) {
    w.__wbOpenPopup?.(/^https?:/i.test(ref) ? ref : `https://${ref}`);
    return true;
  }
  const TOOLS = new Set(["files", "terminal", "diff", "preview", "browser", "plan", "monaco", "editor",
    "gpoint", "slides", "gdrive", "drive", "gdesign", "design", "gimage", "image", "gvideo", "video", "gsound", "sound"]);
  if (TOOLS.has(key)) {
    const ALIAS: Record<string, string> = { browser: "preview", editor: "monaco", slides: "gpoint", drive: "gdrive", design: "gdesign",
      image: "gimage", video: "gvideo", sound: "gsound" };
    w.__wbOpenTool?.(ALIAS[key] ?? key);
    return true;
  }
  if (await w.__wbOpenLayoutByName?.(ref).catch(() => false)) return true;
  const yo2 = window.glyphh as unknown as { appLaunch?: (s: { slug: string; name: string }) => Promise<{ ok: boolean; error?: string }> };
  const asApp = await yo2.appLaunch?.({ slug: ref, name: ref }).catch(() => ({ ok: false }) as { ok: boolean });
  return !!asApp?.ok;
}

/** Say something back in the thread — a command that did nothing silently is
 *  indistinguishable from a broken one. */
function dipSay(text: string): void {
  if (!current()) newChat();
  current()!.messages.push({ role: "assistant", text, at: Date.now() });
  void saveStore(); renderHistory(); renderThread();
}

/**
 * `.dip` — THE navigation verb (docs/COMMANDS.md). A bare ref opens a panel,
 * workspace, app or URL; the verbs below arrange what is open.
 *
 *   .dip <panel|workspace|app|url>   open it
 *   .dip split <a> <b> …             open each, side by side
 *   .dip grid [<a> <b> …]            open each (if given), then even grid
 *   .dip add <url>                   open a URL as a panel
 *   .dip close <name>                close one panel
 *   .dip clear                       close every panel
 *   .dip list                        what is open, and what can be opened
 *   .dip refresh                     reload the focused panel
 *   .dip reset                       the open workspace back to its saved design (⌘⇧Esc)
 *   .dip back                        the command center (where you came from)
 */
/** RESET THE OPEN WORKSPACE to its saved design, on the spot, keeping the
 *  conversation (his ask, 2026-10-07). Reached by ⌘⇧Esc, the Workspace menu
 *  and `.dip reset`; says what happened either way. */
export async function resetWorkspace(): Promise<void> {
  const w = window as unknown as { __wbResetLayout?: () => Promise<boolean> };
  const ok = await (w.__wbResetLayout?.() ?? Promise.resolve(false));
  toastOk(ok ? "Workspace reset to its saved design." : "No workspace is open to reset.");
}

export function runDip(ref: string): void {
  showWorkspaceSurface();
  const w = window as unknown as {
    __initCodeWorkbench?: () => void;
    __wbOpenLayoutByName?: (name: string) => Promise<boolean>;
    __wbResetLayout?: () => Promise<boolean>;
    __wbClearPanels?: () => void;
    __wbGridPanels?: () => boolean;
    __wbListApps?: () => Array<{ slug: string; name: string }>;
    __wbCloseApp?: (slug: string) => boolean;
    __wbOpenEchoHome?: () => void;
  };
  w.__initCodeWorkbench?.();
  void (async () => {
    // The workbench boots async — wait for the hook like the launcher does.
    for (let i = 0; i < 40 && !w.__wbOpenLayoutByName; i++) {
      await new Promise((r) => requestAnimationFrame(r));
    }
    const parts = ref.trim().split(/\s+/);
    const verb = (parts[0] || "").toLowerCase();
    const rest = parts.slice(1);

    if (verb === "clear") { w.__wbClearPanels?.(); return; }
    if (verb === "back") { w.__wbOpenEchoHome?.(); return; }
    if (verb === "list") {
      const open = w.__wbListApps?.() ?? [];
      const layouts = await window.glyphh.layoutsList?.().then((ls) => ls.map((l) => l.name)).catch(() => [] as string[]);
      dipSay([
        open.length ? `Open: ${open.map((a) => a.name || a.slug).join(", ")}` : "Nothing open.",
        layouts?.length ? `Workspaces: ${layouts.join(", ")}` : "",
      ].filter(Boolean).join("\n"));
      return;
    }
    if (verb === "reset") { void resetWorkspace(); return; }
    if (verb === "refresh") {
      // The focused panel reloads itself; no ref = whatever is on top.
      (window as unknown as { __wbReloadFocused?: () => void }).__wbReloadFocused?.();
      return;
    }
    if (verb === "close") {
      const name = rest.join(" ").trim();
      if (!name) { dipSay("⚠ .dip close: name a panel."); return; }
      if (!w.__wbCloseApp?.(name.toLowerCase())) dipSay(`⚠ .dip close: nothing open named "${name}".`);
      return;
    }
    if (verb === "add") {
      const url = rest.join(" ").trim();
      if (!url) { dipSay("⚠ .dip add: give a URL."); return; }
      if (!(await dipOpenRef(url))) dipSay(`⚠ .dip add: could not open "${url}".`);
      return;
    }
    // SPLIT / GRID — open every ref, then lay them out. Split and grid differ
    // only in intent today: the workbench flows panels into an even grid, which
    // IS the side-by-side arrangement for two.
    if (verb === "split" || verb === "grid") {
      const refs = rest.filter(Boolean);
      const missed: string[] = [];
      for (const r of refs) if (!(await dipOpenRef(r))) missed.push(r);
      w.__wbGridPanels?.();
      if (missed.length) dipSay(`⚠ .dip ${verb}: couldn't open ${missed.join(", ")}.`);
      return;
    }

    // No verb — the whole ref is a thing to open.
    if (await dipOpenRef(ref)) return;
    if (!current()) newChat();
    // Name the workspaces the resolver actually sees — "not found" with no
    // context turns into a support question; this answers it in place.
    const known = await window.glyphh.layoutsList?.().then((ls) => ls.map((l) => l.name)).catch(() => [] as string[]);
    const hint = known?.length ? ` Workspaces: ${known.join(", ")}.` : "";
    dipSay(`⚠ .dip: no panel, app or workspace named "${ref}".${hint}`);
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
  // While thinking the same control is the stop button, but ONLY with nothing
  // typed. Text mid-run is a follow-up and queues like Enter does: the
  // artifact-comment send (__wbSendToAgent clicks this button), panel prompts
  // and build-and-run all reach send() mid-turn, and each one used to KILL the
  // live run (the ☮ line) and leave its text in the box. Stopping with words
  // waiting is the queued note's Interrupt.
  if (thinking) {
    if (input()?.value.trim()) queueMidRun();
    else stopThinking();
    return;
  }
  const ta = input();
  if (!ta) return;
  const text = ta.value.trim();
  if (!text && !pendingAttach.length) return;
  const fromHome = document.body.classList.contains("composer-on-home");
  const instanced = !!(window as unknown as { __wbAgentInstanced?: () => boolean }).__wbAgentInstanced?.();
  // Sending from the HOME-adopted composer: the footer goes back to the
  // agent and the chat opens alone — the stream lands where the user is.
  if (fromHome && !instanced) {
    adoptComposer(null);
    gotoSection("agent");
  }
  // Dot-commands (.dip slack, .drip rain, …) run through the command parser —
  // the composer doubles as the command input.
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
    if (cc.title === "New session") cc.title = placeholderTitle(text);
    ta.value = "";
    autoGrow(ta);
    void window.glyphh.execCommand(text.slice(1).trim());
    cc.messages.push({ role: "assistant", text: `→ ran ${text}`, at: Date.now() });
    void saveStore();
    renderHistory();
    renderThread();
    return;
  }
  // THE HOME COMPOSER OPENS AN AGENT PANEL (his ruling, 2026-09-26: agent
  // panels are independent instances): the text and its attachments ride into
  // a fresh panel, which sends them; Home keeps its own composer.
  if (fromHome && instanced) {
    const attach = pendingAttach.slice();
    pendingAttach = [];
    paintAttachChips();
    ta.value = "";
    autoGrow(ta);
    const folder = (window as unknown as { __glyphhCurrentFolder?: () => string | null }).__glyphhCurrentFolder?.() ?? null;
    (window as unknown as { __wbOpenAgentInstanceWith?: (loop: string | undefined, cmd: { type: "prompt"; text: string; attach?: AttachRef[]; cwd?: string; send?: boolean }) => void })
      .__wbOpenAgentInstanceWith?.(GLYPHH_LOOP, { type: "prompt", text, attach, ...(folder ? { cwd: folder } : {}), send: true });
    return;
  }
  // `/compact [focus]` compacts THIS session's conversation. A CLI compacts
  // its own (main answers with where to do it); the answer is said in the thread.
  const compact = /^\/compact(?:\s+([\s\S]*))?$/i.exec(text);
  if (compact && current()?.messages.length) {
    const cc = current()!;
    ta.value = "";
    autoGrow(ta);
    void window.glyphh.glyphhCompact?.(cc.id, (compact[1] || "").trim(), cc.loop || GLYPHH_LOOP)
      .then((r) => cc.messages.push({ role: "assistant", text: r?.ok ? "Compacted — the conversation so far is summarized for the next turn." : `⚠ ${r?.reason || "The conversation could not be compacted."}`, at: Date.now() }))
      .catch((err) => cc.messages.push({ role: "assistant", text: `⚠ ${err instanceof Error ? err.message : String(err)}`, at: Date.now() }))
      .then(() => { void saveStore(); renderThread(); });
    return;
  }
  if (!current()) newChat();
  const c = current()!;
  const attachments = pendingAttach.slice();
  pendingAttach = [];
  paintAttachChips();
  c.messages.push({ role: "user", text, at: Date.now(), ...(attachments.length ? { attachments } : {}) });
  if (c.title === "New session") {
    // The instant placeholder; the generated title replaces it after the
    // first reply (finishRun → generateSessionTitle).
    const t = text || attachments.map((a) => a.name).join(", ");
    c.title = placeholderTitle(t);
  }
  ta.value = "";
  autoGrow(ta);
  void saveStore();
  // Sending re-engages following: the user's own turn always comes into view.
  pinThreadToBottom();
  // Working state first so the spinner row + rail dot paint immediately.
  liveRuns.set(c.id, {
    runId: null, text: "", bubble: null, startAt: Date.now(),
    inTok: 0, outTok: 0, usd: 0, steps: [], setupMeta: "",
  });
  ensureRunTicker();
  broadcastTimeline(true);
  setThinking(true);
  renderHistory();
  renderThread();
  paintComposerGate();
  // Main assembles the prompt from the store — the save must land first.
  // A session must run inside a folder the user chose: the first send on a
  // fresh setup pops the OS folder picker, then the run proceeds. The
  // session's SOURCE (its folder) rides the run and is also the workdir.
  const src = c.source ?? pendingSource;
  // Speech mode (Settings › Voice): a hidden preamble steering the agent to a
  // short, spoken-style answer. THE OUTPUT PICK (his order, 2026-10-05): an
  // Artifact pick adds its one standing line beside it. Both ride main's
  // glyphhRun `steer`, never the message shown in the thread (already pushed
  // clean above). Auto adds nothing.
  const steer = [briefSteer(), artifactStandingLine(c.artifactRef)].filter(Boolean).join("\n\n");
  // THE TURN RUNS IN THE THREAD'S FOLDER, and says so every time (his rule,
  // 2026-09-29: "sandboxed to that folder"). A thread born before its folder
  // resolved asks main for this panel's folder once and keeps it.
  const withFolder = async (): Promise<string> => {
    const have = threadFolder(c);
    if (have) { if (!c.workdir) { c.workdir = have; void saveStore(); } return have; }
    const live = await (window as unknown as { wb?: { getCwd?: () => Promise<string | null> } }).wb?.getCwd?.().catch(() => null);
    if (live && current()?.id === c.id) setThreadFolder(live);
    else if (live) { c.workdir = live; void saveStore(); }
    return live || "";
  };
  const launch = async (retried: boolean): Promise<void> => {
    const folder = await withFolder();
    // The dial rides every turn on a model that takes one (his order, 2026-10-04).
    // THE LOOP RIDES EVERY TURN, with the CLI session to resume (per CLI lane)
    // and where the route was chosen; main resolves the route again at launch.
    const loop = c.loop || GLYPHH_LOOP;
    const cli = cliOfLoop(loop);
    const sid = isVendorLoop(cli) ? cliSidFor(c as CliBound, cli) : null;
    const permission = coerceMode(c.permission ?? defaultMode, modesOf(loopRowOf(loop)));
    return window.glyphh.glyphhRun({ chatId: c.id, attachments, ...(folder ? { workdir: folder } : {}), mode: SESSION_MODE, permission, ...(src ? { source: src } : {}), ...(steer ? { steer } : {}), ...(sessionModel(c) ? { model: sessionModel(c)! } : {}), ...(modelTakesEffort() ? { effort: currentEffort() } : {}), loop, ...(sid ? { cliSessionId: sid } : {}), ...(isVendorLoop(cli) ? { route: routeHintsOf(c) } : {}) })
      .then((r) => { const run = liveRuns.get(c.id); if (run && !run.runId) run.runId = r?.runId ?? `r-local-${c.id}`; })
      .catch(async (err) => {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes("NO_WORKDIR") && !retried) {
          // The pick IS the thread's folder — stamped here, not left to an
          // event that could land after the retry.
          const picked = await (window as unknown as { wb?: { pickCwd?: (o?: { nullOnCancel?: boolean }) => Promise<string | null> } }).wb?.pickCwd?.({ nullOnCancel: true });
          if (picked) { if (current()?.id === c.id) setThreadFolder(picked); else { c.workdir = picked; void saveStore(); } }
          return launch(true);
        }
        if (msg.includes("NO_WORKDIR")) {
          finishRun(c.id, "⚠ Pick a working folder to start — Glyphh works inside the folder you choose, and only there (folder button at the top of this pane).");
          return;
        }
        finishRun(c.id, `⚠ ${msg}`);
      });
  };
  void saveStore().then(() => launch(false));
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

/** THE GENERATED TITLE (his order, 2026-10-05: do the same as Claude's
 *  titles). After the FIRST reply of a thread lands, ONE small side request
 *  through the router asks the utility model (help/utility-model.ts: the
 *  cheapest chat row — never the session's own) for a 3–6 word title, and it
 *  replaces the truncated-prompt placeholder on the thread record, so the
 *  rail and the recents show it (saveStore writes the title; renderHistory
 *  repaints). Every rule is pure (session-title.ts); this is the one impure
 *  seam. It never throws and never touches the transcript or the run ledger. */
async function generateSessionTitle(chat: CodeChat): Promise<void> {
  try {
    const may = mayGenerateTitle(chat);
    if (!may.ok) return;
    const model = pickUtilityModel(availModels);
    const ask = window.glyphh.sessionTitleGenerate;
    if (!model || !ask) return;   // nothing configured → the placeholder stands
    chat.titleGenerated = true;   // once per thread, in flight or done
    const before = chat.title;
    const title = await fetchSessionTitle({ body: titleRequestBody(model, may.prompt, may.reply), ask });
    // Still the placeholder? A rename wins.
    if (!title || chat.titleLocked || chat.title !== before) return;
    chat.title = title;
    void saveStore();
    renderHistory();
  } catch (err) {
    console.warn("[title] generation skipped:", err instanceof Error ? err.message : String(err));
  }
}

function finishRun(chatId: string, text: string, stopped = false): void {
  const run = liveRuns.get(chatId);
  const chat = chats.find((ch) => ch.id === chatId);
  const timing = run ? turnTiming(run) : "";
  if (timing) console.info(`[turn] ${chatId} ${timing}`);
  if (chat && text) chat.messages.push({ role: "assistant", text, at: Date.now(), ...(run?.thinking ? { thinking: run.thinking } : {}), ...(timing ? { timing } : {}) });
  if (chat && stopped) {
    chat.messages.push({
      role: "assistant",
      kind: "tool",
      text: `☮ ${STOP_LINES[Math.floor(Math.random() * STOP_LINES.length)]}`,
      at: Date.now(),
    });
  }
  void saveStore();
  // The first reply landed: ask for the session's title (never blocks the turn).
  if (chat && text && !stopped) void generateSessionTitle(chat);
  markSettled(run?.runId ?? null);   // its late frames belong to nobody
  liveRuns.delete(chatId);
  // THE TURN'S END IS AN EVENT (his order, 2026-10-05): the artifact viewer's
  // comment pane runs a mini exchange with the agent without leaving the
  // artifact — it sends through the seated agent and paints the reply from
  // here. Detail: the session, the reply text, whether it was stopped.
  document.dispatchEvent(new CustomEvent("glyphh-agent:turn-finished", { detail: { chatId, text, stopped } }));
  clearToolRows(chatId);   // any ⚙ row whose done never arrived stays as-is
  // This run's pending cards vanish; other runs' stay queued. (paintAskDock
  // restarts the countdown for whatever card is now on top, or stops it.)
  askQueue = askQueue.filter((q) => q.chatId !== chatId && (!run?.runId || q.runId !== run.runId));
  paintAskDock();
  stopRunTickerIfIdle();
  renderHistory();   // the panel header goes idle even for a background session
  if (chatId === currentId) {
    broadcastTimeline(false);
    setThinking(false);
    renderThread();
    // Anything typed while this run was in flight goes now, as its own turn.
    flushPendingNotes();
    // Speak the reply (if Voice autoplay is on) and, in hands-free mode, start
    // listening again for the next thing the user says. Fire on EVERY completed
    // turn (not only ones that end with text) — a tool-only turn still needs to
    // hand the mic back, or hands-free dies after one exchange.
    if (!stopped) void onTurnComplete(text || "");
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

/** Answer the dock's card: main's loop holds the parked id. */
function respondToDock(item: AskDockItem, reply: { allow?: boolean; answers?: string[] }): void {
  if (reply.answers) void window.glyphh.glyphhAskRespond?.(item.id, reply.answers);
  else void window.glyphh.glyphhApprovalRespond?.(item.id, !!reply.allow);
}

// The dock's countdown ticks once a second while a card with a deadline is up.
// Both gates decide FOR the user when it runs out (approval → denied, ask →
// answered empty), so the card says so rather than sitting there implying the
// run waits forever.
let dockTicker: number | null = null;

function stopDockTicker(): void {
  if (dockTicker !== null) { clearInterval(dockTicker); dockTicker = null; }
}

/** The approval card's view of a tool input: `description` → headline,
 *  `command` → code block, everything else → rows. null when the detail is
 *  not a JSON object (a producer's own prose, or JSON cut at the 2000-char cap). */
type ToolInputView = { headline: string | null; command: string | null; rows: Array<[string, string]> };
function parseToolInput(detail: string): ToolInputView | null {
  if (!detail || detail[0] !== "{") return null;
  let v: unknown;
  try { v = JSON.parse(detail); } catch { return null; }
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const str = (k: string): string | null => (typeof o[k] === "string" && (o[k] as string).trim() ? (o[k] as string) : null);
  const headline = str("description");
  const command = str("command") ?? str("cmd");
  const rows: Array<[string, string]> = [];
  for (const [k, val] of Object.entries(o)) {
    if (k === "description" || k === "command" || k === "cmd" || val === undefined || val === null) continue;
    rows.push([k, typeof val === "string" ? val : JSON.stringify(val)]);
  }
  return { headline, command, rows };
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
  const mine = askQueue.filter((q) => q.chatId === item.chatId).length;
  if (mine > 1) {
    const count = document.createElement("span");
    count.className = "cad-count";
    count.textContent = `1 of ${mine} waiting`;
    head.appendChild(count);
  }
  return head;
}

function paintAskDock(): void {
  const dock = el<HTMLDivElement>("code-ask-dock");
  if (!dock) return;
  // The dock is bound to the AGENT WINDOW in view — only show the approval/ask
  // for the CURRENT session. A background session's approval waits (and pings via
  // pushDockNote) instead of bleeding into whatever session is on screen.
  const item = askQueue.find((q) => q.chatId === currentId);
  dock.hidden = !item;
  dock.textContent = "";
  stopDockTicker();
  // An approval DEMANDS the stage (his rule, 2026-08-19): the composer
  // un-tucks (body class beats the wall-covered slide), the thread panel
  // opens so the card sits in context, and the card layers ON TOP of the
  // panel at full opacity — never behind the glass.
  document.body.classList.toggle("glyphh-ask-pending", !!item);
  if (item && !isPeeking()) togglePeek();
  if (!item) return;

  if (item.type === "approval") {
    // Human labels — a raw kind ("dangerous") says the class, not the ask.
    const KIND_LABEL: Record<string, string> = {
      dangerous: "Dangerous — needs your OK",
      command: "Run a command",
      edit: "Make a change",
      network: "Network access",
      read: "Read",
      tool: "Use a tool",
    };
    // The detail is the tool's INPUT as pretty-printed JSON, from both
    // producers (the SDK loop, the Claude Code harness). Shown raw it was a
    // wall of \" escapes with the command's head scrolled away (his report,
    // 2026-09-23). Read it back: the tool's own `description` is the
    // headline, a `command` is a code block with its quotes intact, the rest
    // is one `key: value` line each. Detail that is not JSON renders as it was.
    const input = parseToolInput(item.detail);
    const toolName = (item.title || "").split(/\s+/)[0] || item.title;
    const kindLabel = input?.command ? KIND_LABEL.command : (KIND_LABEL[item.kind] ?? item.kind);
    dock.appendChild(dockHead(input?.headline ? `${kindLabel} · ${toolName}` : kindLabel, "warn", item));
    const title = document.createElement("div");
    title.className = "cad-title";
    title.textContent = input?.headline ?? (input && (input.command || input.rows.length) ? toolName : item.title);
    dock.appendChild(title);
    if (item.kind === "dangerous" && !item.detail) {
      const why = document.createElement("div");
      why.className = "cad-why";
      why.textContent = "Outside auto mode's safe bounds — these always ask.";
      dock.appendChild(why);
    }
    if (input && (input.command || input.rows.length)) {
      if (input.command) {
        const cmd = document.createElement("pre");
        cmd.className = "cad-detail cad-cmd";
        cmd.textContent = input.command;
        dock.appendChild(cmd);
      }
      if (input.rows.length) {
        const rows = document.createElement("div");
        rows.className = "cad-rows";
        for (const [k, v] of input.rows) {
          const row = document.createElement("div");
          row.className = "cad-row";
          const key = document.createElement("span");
          key.className = "cad-key";
          key.textContent = k;
          // A long or multi-line value (a file's content, an edit's strings)
          // gets its own block; a short one sits on the key's line.
          const long = v.length > 80 || v.includes("\n");
          const val = document.createElement(long ? "pre" : "span");
          val.className = long ? "cad-detail cad-val-block" : "cad-val";
          val.textContent = v;
          row.append(key, val);
          rows.appendChild(row);
        }
        dock.appendChild(rows);
      }
    } else if (item.detail) {
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
    // The CLI's session id PERSISTS on the chat row, per CLI: main's resume
    // map forgets on restart, and the row is what the next turn and the >_
    // hop read back. The frame names its chat; an older main's does not, and
    // then the one chat running here is the one it means.
    if (d.cliSessionId && d.cli && d.cli !== GLYPHH_LOOP) {
      const live = chats.filter((ch) => liveRuns.has(ch.id));
      const chat = (d.chatId ? chats.find((ch) => ch.id === d.chatId) : undefined) ?? (live.length === 1 ? live[0] : undefined);
      if (chat && bindCliSession(chat, d.cli, d.cliSessionId)) void saveStore();
    }
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
      for (const r of liveRuns.values()) { r.setupMeta = ""; r.readyAt ??= Date.now(); }
    }
    paintRunMeta();
  });
  window.glyphh.onGlyphhAgentCredits?.((d) => {
    const e = runEntry(d.runId);
    if (!e) return;
    e[1].usd = d.usd;
    if (e[0] === currentId) paintRunMeta();
  });
  window.glyphh.onGlyphhAgentProgress?.((d) => {
    const e = runEntry(d.runId);
    if (!e) return;
    e[1].inTok = d.inTokens;
    e[1].outTok = d.outTokens;
    if (e[0] === currentId) paintRunMeta();
  });
  // A live run's permission mode changed (this desktop's local run echoing the
  // pod, or a run on this machine driven from another surface over attach) —
  // adopt it onto the run's session so the chip agrees. runId → chat via runEntry.
  window.glyphh.onGlyphhAgentPermission?.((d) => {
    const e = runEntry(d.runId);
    if (e) adoptSessionMode(e[0], d.permission);
  });
  // A LOCAL gate parks in main with the same deadlines the pod uses
  // (glyphh-agent-permissions.ts), so the card counts down identically.
  // A LOCAL gate parks in main with the same deadlines the pod uses
  // (glyphh-agent-permissions.ts), so the card counts down identically.
  // The dock renders ONLY cards stamped with the on-screen session's chatId
  // (paintAskDock) — but the LOCAL gate's IPC carries no chat context, so these
  // pushes went in unstamped and never painted (the ask sat invisible until its
  // timeout). Stamp them here: runId → chat when the payload has one, else the
  // session with the live local run, else whatever is on screen.
  const dockChatFor = (runId?: string): string => {
    if (runId) {
      const e = runEntry(runId);
      if (e) return e[0];
    }
    const live = chats.filter((c) => liveRuns.has(c.id));
    return live.length === 1 ? live[0].id : currentId;
  };
  window.glyphh.onGlyphhAgentApproval?.((a) => {
    // A SUB-AGENT'S ASK STILL COMES HERE — the person is the only one who can
    // answer it — but it says who is asking, or "run npm test" reads as the
    // main agent's step.
    const who = (a as { agent?: { name?: string } }).agent?.name;
    const titled = who ? { ...a, title: `${who}: ${a.title}` } : a;
    askQueue.push({ type: "approval", ...titled, chatId: dockChatFor((a as { runId?: string }).runId), deadline: Date.now() + APPROVAL_TIMEOUT_MS });
    paintAskDock();
  });
  window.glyphh.onGlyphhAgentAsk?.((d) => {
    askQueue.push({ type: "ask", id: d.id, questions: d.questions, answers: [], step: 0, runId: (d as { runId?: string }).runId, chatId: dockChatFor((d as { runId?: string }).runId), deadline: Date.now() + ASK_TIMEOUT_MS });
    paintAskDock();
  });
  // Agent-loop activity → compact breadcrumb rows in the thread (persisted,
  // so a re-render or restart keeps the run's story).
  window.glyphh.onGlyphhAgentTool?.((d) => {
    // A SUB-AGENT'S STEP is its own (his order, 2026-09-29): in this transcript
    // the main agent's own spawn_agent row already says who took the work.
    if (isChildFrame(d)) return;
    const e = runEntry(d.runId);
    if (!e) return;
    const [runChatId, run] = e;
    const chat = chats.find((ch) => ch.id === runChatId);
    if (!chat) return;
    const name = d.name ?? "tool";
    const key = toolKey(runChatId, name, d.title);
    if (d.phase === "start") {
      // The start label SHOWS THE WORK: the frame's title carries the tool's
      // key input (`⚙ Run: <cmd>`, `⚙ Write /path`); thought (the gate's card
      // title) is the fallback, the bare name the last resort.
      const label = toolStartLabel({ name, ...(d.title ? { title: d.title } : {}), ...(d.thought ? { thought: d.thought } : {}) });
      run.steps.push(label);
      const open = (run.openSteps ??= new Map());
      open.set(key, [...(open.get(key) ?? []), run.steps.length - 1]);
      if (runChatId === currentId) broadcastTimeline(true);
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
      const row = pushToolRow(chat, name, label, d.title);
      row.tool = { name, title: d.title || name, state: "running", startedAt: Date.now() };
    } else if (d.phase === "done") {
      const bad = Boolean(d.denied || d.failed);
      // Failures surface the tool's own first line — the model can gloss,
      // the breadcrumb doesn't. Successful edits keep their "+N -M" diff badge.
      const reason = d.denied ? "denied" : d.failed ? String(d.preview || "").split("\n")[0].slice(0, 90) : "";
      const diff = !bad ? (/\[\+\d+ -\d+\]/.exec(String(d.preview || ""))?.[0] ?? "") : "";
      const text = toolDoneLabel({
        name,
        ...(d.title ? { title: d.title } : {}),
        bad,
        ...(reason ? { reason } : {}),
        ...(diff ? { diff } : {}),
      });
      const idx = run.openSteps?.get(key)?.shift();
      if (idx !== undefined) run.steps[idx] = text;
      else if (run.steps.length) run.steps[run.steps.length - 1] = text;
      if (runChatId === currentId) broadcastTimeline(true);
      const row = settleToolRow(chat, name, text, d.title);
      // THE STEP'S OWN RECORD (his order, 2026-09-29: "way more robust viewing of
      // the tool calls"): the engine's diff, command output or tool I/O, kept on
      // the row — bounded, because the transcript is saved on every event.
      const extra = d as { detail?: ToolDetail; input?: string; output?: string };
      row.tool = trimForStore({
        name, title: d.title || name, state: bad ? "failed" : "done",
        startedAt: row.tool?.startedAt ?? Date.now(), endedAt: Date.now(),
        ...(extra.detail ? { detail: extra.detail } : {}),
        ...(extra.input ? { input: extra.input } : {}),
        ...(extra.output ? { output: extra.output } : {}),
        ...(d.preview ? { preview: String(d.preview) } : {}),
      });
      // A relative path resolves where the loop resolved it: the thread's own
      // folder, else the workspace folder the turn ran in.
      const folder = chat.workdir || (window as unknown as { __glyphhCurrentFolder?: () => string | null }).__glyphhCurrentFolder?.() || undefined;
      const art = artifactFromTool(name, d.title, folder, bad);
      if (art) noteArtifact(chat, art);
    }
    void saveStore();
    if (currentId === runChatId) scheduleRenderThread();
  });
  window.glyphh.onGlyphhAgentDelta?.((d) => {
    // A sub-agent's words ride the parent's run tagged with the child. Spliced
    // into this bubble they would read as the main agent's answer.
    if (isChildFrame(d)) return;
    const e = runEntry(d.runId);
    if (!e) return;
    e[1].text += d.delta;
    e[1].firstAt ??= Date.now();
    queueStreamPaint(e[0]);
  });
  window.glyphh.onGlyphhAgentThinking?.((d) => {
    if (isChildFrame(d)) return;
    const e = runEntry(d.runId);
    if (!e) return;
    e[1].thinking = (e[1].thinking ?? "") + d.text;
    queueStreamPaint(e[0]);
  });
  window.glyphh.onGlyphhAgentDone?.((d) => {
    const e = runEntry(d.runId);
    if (!e) return;
    finishRun(e[0], e[1].text, d.stopped);
  });
  // ANOTHER PANEL TOOK THIS RUN OVER: let go without writing a message — the
  // adopting panel lands the turn in the shared store, and this one re-reads it.
  (window.glyphh as unknown as { onGlyphhAgentHandoff?: (cb: (d: { runId: string; chatId: string }) => void) => void }).onGlyphhAgentHandoff?.((d) => {
    const hit = [...liveRuns].find(([id, r]) => r.runId === d.runId || id === d.chatId);
    if (!hit) return;
    const chatId = hit[0];
    liveRuns.delete(chatId);
    clearToolRows(chatId);
    stopRunTickerIfIdle();
    renderHistory();
    if (chatId === currentId) { broadcastTimeline(false); setThinking(false); renderThread(); }
  });
  window.glyphh.onGlyphhAgentError?.((d) => {
    const e = runEntry(d.runId);
    if (!e) return;
    const [runChatId, run] = e;
    // A LOGIN THAT RAN OUT IS NOT A CHAT MESSAGE (his report, 2026-09-17): the
    // bridge says which CLI and what command fixes it, and the card runs it.
    if (d.fix?.kind === "signin") {
      const chat = chats.find((ch) => ch.id === runChatId);
      if (chat) chat.messages.push({ role: "assistant", kind: "decline", text: "", decline: { kind: "signin", url: "", cli: d.fix.cli, command: d.fix.command }, at: Date.now() });
      finishRun(runChatId, run.text || "");
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

// ── Rail tray sections (Apps, Workspaces) ────────────────────────────────
// The trays are back for the RAIL PANEL (the shell's own rail stays hidden).
// Each header is a disclosure whose open/closed state is remembered; the pref
// keys are new — the v1/v2 keys were swept by migration 0034 and honoring a
// stale value would decide the panel's shape for him.
/** `head` + `showPref`: a tray the member turns on in Appearance (Tabs and
 *  Workspaces — gone 2026-09-16, BACK as options on his order, 2026-10-08);
 *  Recents has neither and always shows. */
interface RailSectionDef { toggle: string; body: string; pref: string; head?: string; showPref?: string }
const RAIL_SECTIONS: RailSectionDef[] = [
  { toggle: "rail-recents-toggle", body: "rail-recents-body", pref: "railPanelRecentsOpen" },
  { toggle: "rail-layouts-toggle", body: "rail-layouts-body", pref: "railPanelLayoutsOpen", head: "rail-layouts-head", showPref: RAIL_SHOW_LAYOUTS_PREF },
];
// Enabled (the Appearance option) and open (the disclosure) are separate
// axes: a tray's body shows only when BOTH hold, so flipping the option
// keeps the member's collapsed/expanded choice.
const railSectionEnabled: Record<string, boolean> = {};
const railSectionOpen: Record<string, boolean> = {};

function setRailSectionOpen(def: RailSectionDef, open: boolean, persist: boolean): void {
  railSectionOpen[def.toggle] = open;
  el(def.toggle)?.classList.toggle("closed", !open);
  const enabled = !def.showPref || railSectionEnabled[def.toggle] === true;
  el(def.body)?.classList.toggle("hidden", !(open && enabled));
  if (def.toggle === "rail-layouts-toggle") el("rail-layouts-vsplit")?.classList.toggle("closed", !open);
  if (persist) void window.glyphh.setPreference?.(def.pref, open);
  syncRailLayout();
}

/** Show or hide the optional trays per the Appearance options. Settings
 *  dispatches `glyphh:rail-sections-changed` after a flip; this re-reads. */
async function applyRailSectionsVisibility(): Promise<void> {
  if (onWebTarget()) return;   // the trays are the desktop's (help/surface.ts WEB_HIDDEN_RAIL)
  for (const def of RAIL_SECTIONS) {
    if (!def.showPref || !def.head) continue;
    const on = railTrayShown(await window.glyphh.getPreference?.(def.showPref, RAIL_SHOW_DEFAULT));
    railSectionEnabled[def.toggle] = on;
    el(def.head)?.classList.toggle("hidden", !on);
    el(def.body)?.classList.toggle("hidden", !(on && railSectionOpen[def.toggle] === true));
    if (def.toggle === "rail-layouts-toggle") el("rail-layouts-vsplit")?.classList.toggle("hidden", !on);
  }
  syncRailLayout();
}

/** Bind each tray's disclosure + restore its remembered state (default open). */
function initRailSections(): void {
  for (const def of RAIL_SECTIONS) {
    const toggle = el(def.toggle);
    if (!toggle) continue;
    toggle.addEventListener("click", () => {
      setRailSectionOpen(def, toggle.classList.contains("closed"), true);
    });
    void window.glyphh.getPreference?.(def.pref, true).then((v) => setRailSectionOpen(def, v !== false, false));
  }
  void applyRailSectionsVisibility();
  document.addEventListener(RAIL_SECTIONS_CHANGED_EVENT, () => { void applyRailSectionsVisibility(); });
}

/** One authority over the rail stack's vertical share: with a tray open,
 *  Recents keeps its capped height and the trays take the rest; with every
 *  tray closed (or absent, as in the hidden shell rail) Recents fills. */

function syncRailLayout(): void {
  // TODAY'S list id (the old #code-history died with the shell rail — this
  // targeted a ghost, leaving the CSS cap absolute; his report 2026-09-14).
  // The CSS owns the default shape (content-hugging, 44vh cap, own scroll);
  // only a DRAGGED height writes inline.
  // The sidebar scrolls as one column now (his order, 2026-09-16): no per-section height.
  const hist = el("recent-sessions-list");
  if (hist) { hist.style.flex = ""; hist.style.maxHeight = ""; }
}

// ── THE WORKSPACES DRAG LINE (his order, 2026-10-08: "a horizontal line
//    above workspace that allows it to be draggable up and down. When
//    collapsed it moves to the bottom of the left rail"). Recents fills the
//    rail; the line and the Workspaces tray sit at its foot. Dragging the
//    line sizes the tray (railLayoutsH); collapsed, the head rests at the
//    bottom and the line is only a rule. ──
function initWorkspacesVsplit(): void {
  const vs = el("rail-layouts-vsplit");
  const body = el("rail-layouts-body");
  const rail = el("app-rail-scroll");
  if (!vs || !body) return;
  const apply = (h: number): void => { if (h > 0) body.style.flex = `0 0 ${h}px`; };
  // REMEMBERED THROUGH A RESTART (his report, 2026-10-09): the saved height
  // is applied as it was dragged. Clamping it against the rail at boot cut it
  // down while the rail was still laying out; the CSS cap (max-height 75%)
  // keeps it inside the rail at any window size instead.
  void window.glyphh.getPreference?.(RAIL_LAYOUTS_H_PREF, 0).then((v) => {
    const n = Math.round(Number(v));
    if (Number.isFinite(n) && n > 0) apply(Math.max(RAIL_LAYOUTS_MIN_H, n));
  });
  vs.addEventListener("mousedown", (e) => {
    if (body.classList.contains("hidden")) return;   // collapsed: nothing to size
    e.preventDefault();
    document.body.classList.add("code-vdragging");
    const startY = e.clientY;
    const startH = body.getBoundingClientRect().height;
    const railH = rail?.clientHeight || window.innerHeight;
    let h = startH;
    const move = (ev: MouseEvent): void => {
      h = clampRailLayoutsH(startH - (ev.clientY - startY), railH) || startH;
      apply(h);
    };
    const up = (): void => {
      document.removeEventListener("mousemove", move);
      document.removeEventListener("mouseup", up);
      document.body.classList.remove("code-vdragging");
      void window.glyphh.setPreference?.(RAIL_LAYOUTS_H_PREF, Math.round(h));
    };
    document.addEventListener("mousemove", move);
    document.addEventListener("mouseup", up);
  });
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
// THE AGENT TRAY (the build, 2026-09-10) — painted with the exact grammar
// Workspaces uses (tiles, search, pager). It listed the user's CLI
// pre-configs; since the cut (2026-09-28) there is one agent, ours.
interface RailCliAgent { id: string; name: string; cli?: string; icon?: string; cwd?: string }
const railAgents: RailCliAgent[] = [{ id: GLYPHH_LOOP, name: "Glyphh", cli: GLYPHH_LOOP }];
/** The loop wears the brand mascot every other surface wears. */
// Glyphh's own loop wears the Glyphh mascot (the cat mark the composer shows).
const railCliMarks: Record<string, string> = { glyphh: GLYPHH_MASCOT_SRC };
// THE LOOP MARKS ARE BACK ON THE RAIL (his order, 2026-09-30: "the left rail
// recents needs the 'loop' icon back and the icon for cli vs desktop"). The
// vendor CLIs wear their public marks, fetched once through main on the
// desktop and through the front door's /webicon proxy on the web (the ONE
// table in help/cli-marks.ts is also that proxy's allowlist).
const vendorMarks: Record<string, string> = {};
function primeVendorMarks(): void {
  for (const [cli, url] of Object.entries(CLI_MARK_URLS)) {
    if (vendorMarks[cli] !== undefined) continue;
    vendorMarks[cli] = "";
    // On the web the bridge makes every name a function; a desktop-only one
    // answers undefined, so the call is wrapped before `.then`.
    const fetchIcon = (window.glyphh as unknown as { webIconFetch?: (u: string) => Promise<string> | undefined }).webIconFetch;
    void Promise.resolve(fetchIcon?.(url)).then((d) => {
      if (!d) return;
      vendorMarks[cli] = d;
      renderRailSessions();
      paintSourceMascot();
    }).catch(() => {});
  }
}
/** THE MARK AT THE INPUT'S TOP RIGHT: the loop this session runs on (the
 *  Glyphh cat, or the CLI's own mark), badged when the turn goes through the
 *  user's providers — our loop always, a CLI on its gateway route. The tooltip
 *  names the loop, the model and the route in words. */
function paintSourceMascot(): void {
  const host = el("code-source-mascot");
  if (!host) return;
  const loop = activeLoop();
  const cli = cliOfLoop(loop);
  const viaGateway = activeLane() !== "cli";
  let modelName: string;
  if (viaGateway) {
    const sel = selectedModel();
    modelName = sel?.name ?? (resolvedDefaultModel() || "no model yet");
  } else {
    const pick = cliPick(current(), cli);
    modelName = pick ? (cliModelChoices(cli).find((m) => m.id === pick)?.name ?? pick) : (loopRowOf(loop)?.model || "its default model");
  }
  host.textContent = "";
  host.appendChild(loopMarkEl(cli));
  host.classList.toggle("via-gateway", viaGateway);
  host.title = viaGateway
    ? `${loopName(loop)} · ${modelName} · through your providers`
    : `${loopName(loop)} · ${modelName} · on your ${loopName(loop)} login`;
  host.removeAttribute("aria-hidden");
  host.setAttribute("aria-label", host.title);
}

/** A loop's mark: the brand mascot for Glyphh, the vendor's own for a CLI
 *  (its first letter until the mark has loaded, or when it cannot). */
function loopMarkEl(cli: string): HTMLSpanElement {
  const mark = document.createElement("span");
  mark.className = `loop-mark cli-mark-${cli}`;
  const src = cli === GLYPHH_LOOP ? railCliMarks[GLYPHH_LOOP] : vendorMarks[cli];
  if (src) {
    const img = document.createElement("img");
    img.src = src;
    img.alt = "";
    mark.appendChild(img);
  } else {
    mark.classList.add("loop-mark-letter");
    mark.textContent = (LOOP_NAMES[cli as keyof typeof LOOP_NAMES] ?? cli).slice(0, 1);
  }
  if (cli !== GLYPHH_LOOP) primeVendorMarks();
  return mark;
}
/** THE LOOP FILTER: the loops picked in the funnel (empty = every loop),
 *  kept on its own pref beside the place. */
let loopFilter: string[] = [];
/** THE PLACE FILTER (his order, 2026-10-04): the same funnel gains a second
 *  group — All places / This desktop / Cloud — persisted on its own pref and
 *  applied by the ONE filter function below, in the rail and the dropdown. */
let locusFilter: LocusFilter = "";
const filterActive = (): boolean => recentsFilterActive({ loops: loopFilter, locus: locusFilter });
/** The rail's and the dropdown's one filter. */
function sessFilter(opts: { query?: string }): RecentsFilter {
  return { loops: loopFilter, locus: locusFilter, ...(opts.query ? { query: opts.query } : {}) };
}
function sessFilterRow(sess: RailSession): RecentsRowLike {
  return { title: sess.title, cwd: sess.cwd, loopKey: sess.loop || sess.cli || GLYPHH_LOOP, locus: sess.locus ?? "local" };
}
function sessFilterKeeps(sess: RailSession, f: RecentsFilter): boolean {
  return recentsKeeps(sessFilterRow(sess), f);
}
/** Every list re-renders on either change: the rail and the panel's own list
 *  here, the dropdown off the event. */
function filtersChanged(): void {
  el("recent-sessions-filter")?.classList.toggle("active", filterActive());
  renderRailSessions();
  renderHistory();
  document.dispatchEvent(new CustomEvent("glyphh:loop-filter-changed"));
}
function setLocusFilter(place: LocusFilter): void {
  locusFilter = place;
  void window.glyphh.setPreference?.(LOCUS_FILTER_PREF, place);
  filtersChanged();
}
function setLoopFilter(ids: string[]): void {
  loopFilter = ids;
  void window.glyphh.setPreference?.(LOOP_FILTER_PREF, ids);
  filtersChanged();
}
const FILTER_SVG = `<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 5h18l-7 8v6l-4-2v-4z"/></svg>`;
let loopFilterMenu: HTMLDivElement | null = null;
/** THE FUNNEL's menu: the loops (any number of them, "All loops" clears) and
 *  the places (one pick) — the rail, the panel's list and the dropdown all
 *  narrow to it. */
function openPlaceFilterMenu(anchor: HTMLElement): void {
  loopFilterMenu?.remove();
  const m = document.createElement("div");
  m.className = "code-menu loop-filter-menu";
  const row = (label: string, on: boolean, mark: HTMLElement | null, onClick: () => void): void => {
    const b = document.createElement("button");
    b.className = "code-menu-item" + (on ? " on" : "");
    if (mark) b.appendChild(mark);
    const span = document.createElement("span");
    span.className = "loop-label";
    span.textContent = label;
    b.appendChild(span);
    if (on) {
      const check = document.createElement("span");
      check.className = "menu-check";
      check.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="m5 12 5 5L20 7"/></svg>`;
      b.appendChild(check);
    }
    b.addEventListener("click", (e) => { e.stopPropagation(); onClick(); openPlaceFilterMenu(anchor); });
    m.appendChild(b);
  };
  // THE LOOPS: the ones the member has on, each wearing its mark.
  row("All loops", loopFilter.length === 0, null, () => setLoopFilter([]));
  const ids = enabledLoopIds();
  for (const id of LOOP_IDS.filter((x) => ids.includes(x) || loopFilter.includes(x))) {
    const on = loopFilter.includes(id);
    row(loopName(id), on, loopMarkEl(cliOfLoop(id)), () => setLoopFilter(on ? loopFilter.filter((x) => x !== id) : [...loopFilter, id]));
  }
  const sep = document.createElement("div");
  sep.className = "code-menu-sep";
  m.appendChild(sep);
  // THE PLACES (his order, 2026-10-04): one pick, the rail and the dropdown
  // both narrow to it. The mark is the row's own locus glyph.
  row("All places", locusFilter === "", null, () => setLocusFilter(""));
  for (const o of LOCUS_OPTIONS) {
    const mark = document.createElement("span");
    mark.className = "code-sess-locus loop-mark";
    mark.innerHTML = LOCUS_SVG[o.key];
    row(o.name, locusFilter === o.key, mark, () => setLocusFilter(locusFilter === o.key ? "" : o.key));
  }
  // Placed by the one rule (menu-place.ts): below the funnel, hanging from
  // its left edge, flipped to its right edge / above it when the viewport has
  // no room there (his report, 2026-10-04: cut off with the agent on the right).
  placeFixedMenu(anchor, m, { align: "left", side: "auto" });
  loopFilterMenu = m;
  const close = (ev: MouseEvent): void => { if (!m.contains(ev.target as Node) && ev.target !== anchor) { m.remove(); loopFilterMenu = null; document.removeEventListener("mousedown", close, true); } };
  document.addEventListener("mousedown", close, true);
}
void Promise.all([
  window.glyphh.getPreference?.(LOCUS_FILTER_PREF, "") ?? Promise.resolve(""),
  window.glyphh.getPreference?.(LOOP_FILTER_PREF, []) ?? Promise.resolve([]),
]).then(([place, loops]) => {
  locusFilter = locusFilterOf(place);
  loopFilter = loopFilterOf(loops);
  el("recent-sessions-filter")?.classList.toggle("active", filterActive());
  renderRailSessions();
  renderHistory();
}).catch(() => {});

/** A rail row's loop mark: the vendor's, Sage for the Glyphh CLI, the brand mark for the Glyphh agent. */
function sessMarkEl(sess: RailSession): HTMLSpanElement {
  const mark = document.createElement("span");
  mark.className = "code-sess-mark";
  // A session on a CLI wears that CLI's mark, whichever store it came from.
  const cli = cliOfLoop(sess.loop || sess.cli || GLYPHH_LOOP);
  if (isVendorLoop(cli)) {
    const own = loopMarkEl(cli);
    own.classList.add("code-sess-mark");
    own.title = loopName(cli);
    return own;
  }
  {
    const img = document.createElement("img");
    img.src = GLYPHH_MASCOT_SRC;
    img.alt = "";
    mark.appendChild(img);
  }
  mark.title = "Glyphh";
  return mark;
}
let railRecentTs: Record<string, number> = {};
// Both rail grids page at 9 — the same 3×3 block, so Apps and Layouts read
// as one system rather than two differently-sized lists.
const RAIL_APPS_PER_PAGE = 15;
const RAIL_LAYOUTS_PER_PAGE = 15;

// ── Rail grid HOSTS — every surface showing one of these grids ─────────────
// The left rail registers its (list, search) pair once at init; the collapsed
// bar's mini-tray popovers register on open and are dropped by the
// isConnected sweep once their popover leaves the DOM. Every render loops the
// live hosts, so data refreshes (recents, cc-order, icon priming) repaint the
// tray and the rail from the same code path.
interface RailGridHost { list: HTMLElement; search: HTMLInputElement | null; page: number }
const railLayoutsHosts = new Set<RailGridHost>();
const railAgentsHosts = new Set<RailGridHost>();
// ── Rail Recents — the CLI agents' own session stores (his order,
//    2026-09-10): Claude first; a click resumes that exact conversation on
//    its agent (matching cwd wins, then matching CLI, then the first agent).
//    UX is the MAIN-era recents wholesale: Pinned first, then one group per
//    folder; rows carry the pin icon + a trailing ⋮ (Pin / Delete); the same
//    grouping powers the agent-card dropdown (__glyphhSessionsMenu below).
interface RailSession {
  /** `cli` is the store the row came from: "glyphh" for one of our chats
   *  (whatever loop it runs on, `loop`), a vendor CLI for a session in that
   *  CLI's own store. */
  id: string; cli: string; title: string; cwd: string; mtime: number;
  /** The loop a chat runs on (absent on a CLI's own row: its cli is its loop). */
  loop?: string;
  /** Where the thread runs (his rule, 2026-10-04): the desktop, or the cloud. */
  locus?: Locus;
  /** WEB ONLY: a desktop session whose folder the attached desktop has not
   *  granted — listed with a lock; opening it shows the grant card. */
  locked?: boolean;
}
let railSessions: RailSession[] = [];

// ── THE LIVE LEDGER (main's agent-live.ts) — which sessions have a turn
//    running ANYWHERE in the app: this document, another agent panel, the CLI.
//    The rail's rows pulse by it (his report, 2026-09-26: the blinking icon
//    on a running thread died with the CLI approach), and a click on a
//    running row fronts the panel that hosts it. ──
interface LiveAgentRun { chatId: string; cliSessionId: string | null; cli: string; runId: string; senderId: number; startedAt: number; status?: "working" | "waiting" | "error" }
let liveElsewhere: LiveAgentRun[] = [];
/** The ledger's entry for a rail row: the Glyphh loop's sessions ARE chats
 *  (chatId); a CLI's rows carry the CLI's own session id. */
function sessLiveEntry(sess: RailSession): LiveAgentRun | null {
  return liveElsewhere.find((r) => r.chatId === sess.id || (!!r.cliSessionId && r.cliSessionId === sess.id)) ?? null;
}
/** WHAT A ROW'S DOT SAYS (his order, 2026-09-29): green working, yellow
 *  waiting on the person, red the last turn failed, grey idle. A run in THIS
 *  document is working by definition; everything else comes off the ledger,
 *  which is the only thing that knows about the other panels' threads. */
type DotState = "working" | "waiting" | "failed" | "idle";
function sessDotState(id: string): DotState {
  if (liveRuns.has(id)) return "working";
  const e = liveElsewhere.find((r) => r.chatId === id || (!!r.cliSessionId && r.cliSessionId === id));
  return e?.status === "waiting" ? "waiting" : e?.status === "error" ? "failed" : e?.status === "working" ? "working" : "idle";
}
const DOT_TITLE: Record<DotState, string> = {
  working: "Working", waiting: "Waiting for you", failed: "Last turn failed", idle: "Idle",
};
/** One dot, four states — the same element in the rail, the panel's own list
 *  and the recents dropdown, so the three can never tell different stories. */
function sessDot(id: string): HTMLSpanElement {
  const state = sessDotState(id);
  const dot = document.createElement("span");
  dot.className = `code-chat-dot${state === "idle" ? "" : ` ${state}`}`;
  dot.title = DOT_TITLE[state];
  return dot;
}

/** OPENING A RUNNING THREAD RE-CONNECTS TO ITS STREAM (his report, 2026-09-27).
 *  A run's frames go to the panel that started it; when THIS panel opens a
 *  chat the ledger says is running elsewhere, main re-points the frames here,
 *  hands over the turn's text so far, and the old panel lets go. Seeded like
 *  a local turn, so the spinner, the rail pulse and the stream paint at once. */
function adoptRunIfElsewhere(c: CodeChat, opts: { orphanOnly?: boolean } = {}): void {
  if (liveRuns.has(c.id)) return;
  const r = liveElsewhere.find((x) => x.chatId === c.id || x.cliSessionId === c.id);
  if (!r) return;
  const adopt = (window.glyphh as unknown as { glyphhRunAdopt?: (chatId: string, o?: { orphanOnly?: boolean }) => Promise<{ ok: false } | { ok: true; runId: string; startedAt: number; text: string }> }).glyphhRunAdopt;
  if (!adopt) return;
  void adopt(r.chatId, opts).then((res) => {
    if (!res?.ok || liveRuns.has(c.id) || !chats.some((x) => x.id === c.id)) return;
    liveRuns.set(c.id, { runId: res.runId, text: res.text || "", bubble: null, startAt: res.startedAt || Date.now(), inTok: 0, outTok: 0, usd: 0, steps: [], setupMeta: "" });
    ensureRunTicker();
    renderHistory();
    if (c.id === currentId) { broadcastTimeline(true); setThinking(true); renderThread(); queueStreamPaint(c.id); }
  }).catch(() => { /* the ledger announces again if it is still running */ });
}

// ── STEERING FROM THE SHELL (agent-panel:command) — a solo agent panel takes
//    orders from the host document: the rail's session click, the Home
//    composer's send, "New agent panel". Registered at module load so an early
//    command is queued, never lost; the shell sends each one on every readiness
//    signal, so ids de-duplicate. ──
type PanelCommand =
  | { id: string; type: "open-session"; sess: RailSession }
  | { id: string; type: "prompt"; text: string; attach?: AttachRef[]; cwd?: string; loop?: string; send?: boolean }
  | { id: string; type: "new-session" };
const seenPanelCommands = new Set<string>();
const queuedPanelCommands: PanelCommand[] = [];
let panelCommandHandler: ((cmd: PanelCommand) => void) | null = null;
(window as unknown as { glyphh?: { onAgentPanelCommand?: (cb: (cmd: unknown) => void) => void } }).glyphh?.onAgentPanelCommand?.((raw) => {
  const cmd = raw as PanelCommand | null;
  if (!cmd || typeof cmd !== "object" || typeof cmd.id !== "string" || seenPanelCommands.has(cmd.id)) return;
  seenPanelCommands.add(cmd.id);
  if (panelCommandHandler) panelCommandHandler(cmd);
  else queuedPanelCommands.push(cmd);
});
/** The panel is ready for an order once the store and the loop roster are in
 *  (a send before loadStore lands would be overwritten by the disk). */
function whenPanelReady(fn: () => void, tries = 0): void {
  if ((storeLoaded && railAgents.length > 0) || tries >= 80) { fn(); return; }
  window.setTimeout(() => whenPanelReady(fn, tries + 1), 100);
}
let railSessionPins: string[] = [];
const SESS_PINS_PREF = "railSessionPins";

/** ONE TITLE GRAMMAR for a rail row, whatever store it came from (his report,
 *  2026-09-25: "the left rail session names are way too long"). The rule is
 *  help/session-title.ts; the full text stays on the row's tooltip. */
const sessDisplayTitle = sessionDisplayTitle;

/** WHAT A ROW IS (his order, 2026-09-29: "the icons on the left rail need to be
 *  updated to make sense for what each is now… we need a way to know the types
 *  — aka code, chat, work"). The rows used to wear the vendor CLI's favicon;
 *  with one loop that mark said nothing, and the Glyphh mascot it fell back to
 *  is a data-URL image that renders as a broken tile outside the panel (his
 *  screenshot). A session's own SPACE is the useful fact, so it rides as a
 *  glyph drawn in currentColor — nothing to load, nothing to break. */
const SESS_LOCAL_SVG = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>`;
const SESS_PIN_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 17v5"/><path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7h1a2 2 0 0 0 0-4H8a2 2 0 0 0 0 4h1z"/></svg>`;
const SESS_TRASH_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/></svg>`;

// The rail follows the history LIVE (his report, 2026-09-14: the rail and
// the dropdown disagreed — the rail only refreshed at boot): every history
// change schedules one debounced re-read of the CLI stores.
let railSessionsTimer: ReturnType<typeof setTimeout> | null = null;
let railRefreshedLog = "";
let railPaintedLog = "";
function scheduleRailSessionsRefresh(): void {
  if (railSessionsTimer) clearTimeout(railSessionsTimer);
  railSessionsTimer = setTimeout(() => { railSessionsTimer = null; void loadRailSessions(); }, 800);
}

async function loadRailSessions(): Promise<void> {
  const [snap, pins, cliRes] = await Promise.all([
    (window.glyphh.glyphhSessionsLoad?.().catch(() => null) ?? Promise.resolve(null)),
    (window.glyphh.getPreference?.(SESS_PINS_PREF, []).catch(() => []) ?? Promise.resolve([])),
    settle(window.glyphh.cliSessionsList?.(40), null),
  ]);
  // THE THREAD STORE IS THE ONLY STORE (his order, 2026-09-28): the vendor
  // CLIs kept their own transcripts on disk and the rail merged them in. The
  // loop keeps none — its sessions ARE our chats.
  //
  // THE SHARED FILE, NOT THIS DOCUMENT'S COPY (his report, 2026-09-29: the
  // left rail said "No recent sessions yet" beside a dropdown listing eight).
  // The rail is hosted in the SHELL document, which never hydrates the thread
  // store — only the agent panel does — so reading the local `chats` array
  // painted nothing there while the panel's own copy was full. main's store is
  // what every surface writes through, so it is what the rail reads; the
  // hydrated array wins when this document has one, because a turn lands in it
  // a moment before the write-through resolves.
  const rows: CodeChat[] = storeLoaded && chats.length ? chats : ((snap?.chats as CodeChat[]) ?? []);
  railSessions = rows
    .filter((c) => (c.messages?.length ?? 0) > 0)
    .map((c) => {
      const locus = threadLocus(c);
      // THE FOLDER IS THE THREAD'S (his rule): a thread adopted from the
      // server or the relay carries it on its source, not as a workdir — read
      // both, so the web groups a desktop session under its folder too.
      const cwd = c.workdir || (c.source?.kind === "local" ? c.source.path || "" : "");
      return {
        id: c.id, cli: GLYPHH_LOOP, loop: c.loop || GLYPHH_LOOP, title: c.title, cwd, mtime: touchedAtOf(c),
        // A thread's own space. Every NEW session is born in Code (modeOf); the
        // older Chat and Work threads keep theirs, which is what makes the glyph
        // worth reading.
        mode: SESSION_MODE,
        locus,
      };
    })
    .sort((a, b) => b.mtime - a.mtime);
  // THE CLIs' OWN STORES join the list (the loops the member has on): a
  // session typed in the CLI itself is a recent like any other. One a chat
  // already holds is that chat's row, never a second one.
  const held = new Set(rows.flatMap((c) => [...Object.values(c.cliSessionIds ?? {}), ...(c.cliSessionId ? [c.cliSessionId] : [])]));
  const cliRows: RailSession[] = (cliRes?.ok ? cliRes.sessions : [])
    .filter((x) => !held.has(x.id))
    .map((x) => ({ id: x.id, cli: x.cli, title: x.title, cwd: x.cwd, mtime: x.mtime, locus: "local" as const }));
  railSessions = [...railSessions, ...cliRows].sort((a, b) => b.mtime - a.mtime);
  railSessionPins = Array.isArray(pins) ? pins.map(String) : [];
  // NEVER silent (the rail disagreed with the dropdown all day, 2026-09-14):
  // a line pins what this surface actually read — but only when it CHANGED
  // (his report, 2026-10-01: every panel save printed the same pair again).
  const refreshed = JSON.stringify({ count: railSessions.length, newest: railSessions[0]?.title?.slice(0, 40) ?? null });
  if (refreshed !== railRefreshedLog) { railRefreshedLog = refreshed; console.warn("[rail] sessions refreshed", refreshed); }
  renderRailSessions();
}

function sessPinned(id: string): boolean { return railSessionPins.includes(id); }

function sessTogglePin(id: string): void {
  railSessionPins = sessPinned(id) ? railSessionPins.filter((x) => x !== id) : [...railSessionPins, id];
  void window.glyphh.setPreference?.(SESS_PINS_PREF, railSessionPins);
  renderRailSessions();
}

async function sessDelete(sess: RailSession): Promise<boolean> {
  const sure = await confirmAction({
    title: `Delete "${sessDisplayTitle(sess.title)}"?`,
    body: "This session's history is gone for good.",
    confirmLabel: "Delete",
    danger: true,
  });
  if (!sure) return false;
  // A CLI's own session is deleted from that CLI's store, and every chat
  // bound to it lets go — the next turn there starts a fresh CLI session.
  if (sess.cli !== GLYPHH_LOOP) {
    const r = await window.glyphh.cliSessionDelete?.(sess.id).catch((e: unknown) => ({ ok: false, error: e instanceof Error ? e.message : String(e) }));
    if (r && !r.ok) { toastError(r.error || "That session could not be deleted."); return false; }
    let touched = false;
    for (const c of chats) if (forgetCliSession(c as CliBound, sess.id)) touched = true;
    if (touched) void saveStore();
    railSessions = railSessions.filter((x) => x.id !== sess.id);
    renderRailSessions();
    return true;
  }
  // A session lives in the thread store.
  if (!chats.some((x) => x.id === sess.id)) return false;
  railSessions = railSessions.filter((x) => x.id !== sess.id);
  renderRailSessions();
  dropSessions([sess.id], true);
  return true;
}
/** The last path segment, for a heading (main's folderName, verbatim). */
function sessFolderName(pathStr: string): string {
  const trimmed = pathStr.replace(/[\\/]+$/, "");
  const cut = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  return (cut === -1 ? trimmed : trimmed.slice(cut + 1)) || pathStr;
}

interface SessGroup { label: string; title: string; rows: RailSession[] }

/** THE RAIL'S PARADIGM (main, 2026-08-20): Pinned first (only when any
 *  exist), then one group per folder, each most-recently-touched down. */
function sessSections(items: RailSession[]): SessGroup[] {
  const byTouch = (a: RailSession, b: RailSession): number => b.mtime - a.mtime;
  const pinned = items.filter((x) => sessPinned(x.id)).sort(byTouch);
  const rest = items.filter((x) => !sessPinned(x.id)).sort(byTouch);
  const out: SessGroup[] = [];
  if (pinned.length) out.push({ label: "Pinned", title: "Pinned sessions", rows: pinned });
  const byKey = new Map<string, SessGroup>();
  for (const c of rest) {
    // Cloud sessions share ONE group: each has its own folder named "workspace",
    // so a heading per folder said nothing (his report, 2026-10-04).
    const key = (c.locus ?? "local") === "cloud" ? "\u0000cloud" : (c.cwd || "");
    let g = byKey.get(key);
    if (!g) {
      g = key === "\u0000cloud"
        ? { label: "Cloud", title: "Runs in the cloud", rows: [] }
        : key ? { label: sessFolderName(key), title: key, rows: [] } : { label: "Local", title: "On this machine", rows: [] };
      byKey.set(key, g);
    }
    g.rows.push(c);
  }
  const groups = [...byKey.values()];
  const cloud = groups.filter((g) => g.label === "Cloud");
  return [...out, ...cloud, ...groups.filter((g) => g.label !== "Cloud")];
}

function sessSectionHead(label: string, title: string): HTMLDivElement {
  const head = document.createElement("div");
  head.className = "code-history-sec";
  head.textContent = label;
  head.title = title;
  return head;
}

/** The loop a rail row resumes on: a chat's own loop, a CLI row's CLI. */
function agentForSess(sess: RailSession): RailCliAgent | undefined {
  const id = sess.cli === GLYPHH_LOOP ? (sess.loop || GLYPHH_LOOP) : (loopRows.find((r) => r.cli === sess.cli)?.id ?? sess.cli);
  return { id, name: loopName(id), cli: cliOfLoop(id) };
}

/**
 * OPEN THE THREAD, WHATEVER STORE THE ROW CAME FROM (his report, 2026-09-29:
 * "clicking on a recent now, left rail or recents in top right, doesn't load it
 * into the selected glyphh agent. The agent highlights but no history").
 *
 * The lists and the open path were reading DIFFERENT stores. A row is painted
 * from main's shared snapshot when this document's own array is thin (the rail
 * lives in the shell, which is not the document that hydrates the thread
 * store), while opening looked the thread up in the local array only — and
 * returned silently when it was not there. So a row could be listed and
 * un-openable at the same time.
 *
 * The store is awaited first, then the shared file is the fallback: a thread
 * another surface wrote is adopted into this document before it is selected.
 * It never fails quietly — that silence is what made this look like a dead
 * click.
 */
async function openGlyphhSession(id: string): Promise<void> {
  await loadStore().catch(() => { /* the cache still answers below */ });
  let chat = chats.find((x) => x.id === id);
  if (!chat) {
    const snap = await (window.glyphh.glyphhSessionsLoad?.().catch(() => null) ?? Promise.resolve(null));
    const row = ((snap?.chats as CodeChat[]) ?? []).find((c) => c.id === id);
    if (row) { chats.push(row); chat = row; }
  }
  if (!chat) {
    console.warn("[sess] open failed — no such thread in the store or the shared file", JSON.stringify({ id, chats: chats.length }));
    toastOk("That session could not be opened.");
    return;
  }
  console.warn("[sess] open", JSON.stringify({ id, mode: SESSION_MODE, turns: chat.messages?.length ?? 0 }));
  selectChat(chat);
  // A WORKSPACE'S SEAT already shows this document's agent — selectChat above
  // put the thread in it. Seating the loop again would go through
  // openAgentForLoop, which in the instanced shell mints ANOTHER panel (his
  // report: a recent "loads correctly in the agent panel BUT it also opens
  // another instance of the agent"). Front the seat and stop.
  if ((window as unknown as { __wbFrontAgentSeat?: () => boolean }).__wbFrontAgentSeat?.()) return;
  const loop = agentForSess({ id, cli: GLYPHH_LOOP, loop: chat.loop || GLYPHH_LOOP, title: chat.title, cwd: chat.workdir || "", mtime: touchedAtOf(chat) });
  if (loop) (window as unknown as { __wbOpenAgentChat?: (id: string) => void }).__wbOpenAgentChat?.(loop.id);
}

/** The locus glyph a session row wears — a monitor or a cloud — the SAME
 *  element in the rail and the recents dropdown (his order, 2026-10-04). A
 *  locked row (web: the desktop has not granted its folder) wears the lock
 *  beside it and says what to do. */
function sessLocusEl(sess: RailSession): HTMLSpanElement {
  const locus: Locus = sess.locus ?? "local";
  const wrap = document.createElement("span");
  wrap.className = `code-sess-locus code-sess-locus-${locus}`;
  wrap.innerHTML = LOCUS_SVG[locus];
  wrap.title = LOCUS_TITLE[locus];
  if (sess.locked) {
    const lock = document.createElement("span");
    lock.className = "code-sess-lock";
    lock.innerHTML = LOCK_SVG;
    lock.title = GRANT_CARD.title;
    wrap.appendChild(lock);
  }
  return wrap;
}

/** THE GRANT APPLIES ON OPEN (his order, 2026-10-04): a desktop session the
 *  web lists but the desktop has not granted shows the card instead of running. */
function sessGrantCard(sess: RailSession): void {
  void confirmAction({ title: GRANT_CARD.title, body: GRANT_CARD.body(sess.cwd), confirmLabel: "OK", cancelLabel: "Close" });
}

function sessOpen(sess: RailSession): void {
  if (sess.locked) { sessGrantCard(sess); return; }
  // AGENT PANELS ARE INSTANCES in the shell (his ruling, 2026-09-26): a
  // running session fronts the panel that runs it; any other lands in the
  // panel the user touched last, else in a fresh one. The shell's own
  // in-document agent (a workspace's seat) keeps the old behaviour below.
  const shell = window as unknown as {
    __wbAgentInstanced?: () => boolean;
    __wbFocusLiveHost?: (senderId: number, cmd?: { type: "open-session"; sess: RailSession }) => boolean;
    __wbAgentRoute?: (cmd: { type: "open-session"; sess: RailSession }) => boolean;
    __wbAgentFocused?: () => boolean;
    __wbHasAgentSeat?: () => boolean;
    __wbOpenAgentInstanceWith?: (loop: string | undefined, cmd: { type: "open-session"; sess: RailSession }) => void;
    __wbHasAgentPanel?: () => boolean;
  };
  if (shell.__wbAgentInstanced?.()) {
    const cmd = { type: "open-session" as const, sess };
    // WHERE THE CLICK LANDS, in order (his rule, 2026-09-27; his report,
    // 2026-10-08: a Work session clicked on the rail "doesn't open in the
    // open agent window, it just flashes" — it was handed to the first solo
    // panel instance while the member was looking at a workspace's seat):
    //   1. a RUNNING thread → the panel that runs it;
    //   2. the panel the member touched last;
    //   3. the workspace's own seat, when one is on screen (the thread is
    //      selected into this document below);
    //   4. the first open instance, else a fresh one.
    const live = sessLiveEntry(sess);
    if (live && shell.__wbFocusLiveHost?.(live.senderId, cmd)) return;
    if (shell.__wbAgentFocused?.() && shell.__wbAgentRoute?.(cmd)) return;
    if (!shell.__wbHasAgentSeat?.()) {
      if (shell.__wbAgentRoute?.(cmd)) return;
      if (!shell.__wbHasAgentPanel?.()) { shell.__wbOpenAgentInstanceWith?.(agentForSess(sess)?.id, cmd); return; }
    }
  }
  // A Glyphh-loop session is one of OUR chats: select it, then seat the loop
  // (select first — seating a different loop stamps the CURRENT chat).
  if (sess.cli === "glyphh") { void openGlyphhSession(sess.id); return; }
  // ONE SURFACE (his order, 2026-09-14: "make them all one thing") — a
  // recent opens in the agent CHAT panel, adopted with its transcript and
  // bound to run on ITS OWN CLI. The terminal stays one >_ hop away.
  const agent = agentForSess(sess);
  if (!agent) return;
  // Same rule as openGlyphhSession: a seated agent adopts in place, no new panel.
  if (!(window as unknown as { __wbFrontAgentSeat?: () => boolean }).__wbFrontAgentSeat?.()) {
    (window as unknown as { __wbOpenAgentChat?: (id: string) => void }).__wbOpenAgentChat?.(agent.id);
  }
  void adoptCliSession({ agentName: agent.name, sessionId: sess.id, agentId: agent.id, cli: sess.cli });
}

let sessMenuEl: HTMLDivElement | null = null;
function closeSessMenu(): void { sessMenuEl?.remove(); sessMenuEl = null; }

/** The row's ⋮ menu — Pin / Delete, positioned like main's openChatMenu. */
function openSessRowMenu(anchor: HTMLElement, sess: RailSession): void {
  closeSessMenu();
  const m = document.createElement("div");
  m.className = "code-menu";
  const pin = document.createElement("button");
  pin.className = "code-menu-item";
  pin.textContent = sessPinned(sess.id) ? "Unpin" : "Pin";
  pin.addEventListener("click", () => { closeSessMenu(); sessTogglePin(sess.id); });
  m.appendChild(pin);
  const del = document.createElement("button");
  del.className = "code-menu-item danger";
  del.textContent = "Delete";
  del.addEventListener("click", () => { closeSessMenu(); void sessDelete(sess); });
  m.appendChild(del);
  const r = anchor.getBoundingClientRect();
  m.style.left = `${Math.max(8, r.right - 120)}px`;
  document.body.appendChild(m);
  const h = m.offsetHeight;
  m.style.top = r.bottom + 4 + h > window.innerHeight - 8
    ? `${Math.max(8, r.top - 4 - h)}px`
    : `${r.bottom + 4}px`;
  sessMenuEl = m;
}
document.addEventListener("mousedown", (ev) => {
  if (sessMenuEl && !(ev.target as HTMLElement).closest?.(".code-menu, .code-chat-menu-btn")) closeSessMenu();
}, true);

/** ONE COMBINED LIST, everywhere, always (his order, 2026-09-14, reversing
 *  the same-day agent scoping): "the user's history IS the history" — every
 *  CLI's sessions merge into one mtime-ordered list, and a click routes the
 *  resume to the session's own CLI (sessOpen). */
function renderRailSessions(): void {
  const host = el<HTMLDivElement>("recent-sessions-list");
  if (!host) return;
  const q = (el<HTMLInputElement>("recent-sessions-search")?.value ?? "").trim().toLowerCase();
  // THE TAB IS THE FILTER HERE TOO (his report, 2026-09-29: "changing the tabs
  // doesn't change the left rail's recents list in any way"). The panel's own
  // list and the dropdown were filtered; this one, the one he was looking at,
  // was not.
  // ONE FILTER with the dropdown (his order, 2026-10-04): type, loop, place, search.
  const railFilter = sessFilter({ query: q });
  const items = railSessions.filter((x) => sessFilterKeeps(x, railFilter));
  const painted = JSON.stringify({ items: items.length, q: q || null, hostInDoc: host.isConnected, hostParent: host.parentElement?.className || null });
  if (painted !== railPaintedLog) { railPaintedLog = painted; console.warn("[rail] painted", painted); }
  host.textContent = "";
  if (!items.length) {
    const empty = document.createElement("div");
    empty.className = "wb-session-empty";
    empty.textContent = q ? "No sessions match." : "No sessions yet.";
    host.appendChild(empty);
    return;
  }
  for (const sec of sessSections(items)) {
    host.appendChild(sessSectionHead(sec.label, sec.title));
    for (const sess of sec.rows) {
      const row = document.createElement("div");
      row.className = "code-history-item";
      // Leading slot: the RUNNING pulse while the session has a live turn —
      // here, in another agent panel, or in the CLI — else the locus icon.
      // Either way it toggles the pin.
      // Leading slot: the state dot while a turn is live, else WHERE the session
      // runs — the desktop's Glyphh agent or a CLI (his order, 2026-09-30).
      const idle = sessDotState(sess.id) === "idle";
      const dot = idle ? document.createElement("span") : sessDot(sess.id);
      if (idle) {
        dot.className = "code-sess-ic";
        // The one place glyph a row wears: the cloud, or this desktop.
        const cloud = (sess.locus ?? "local") === "cloud";
        dot.innerHTML = cloud ? LOCUS_SVG.cloud : SESS_LOCAL_SVG;
        dot.title = cloud ? LOCUS_TITLE.cloud : "Desktop";
      }
      dot.classList.toggle("pinned", sessPinned(sess.id));
      dot.title = `${dot.title} — click to ${sessPinned(sess.id) ? "unpin" : "pin"}`;
      dot.addEventListener("click", (e) => { e.stopPropagation(); sessTogglePin(sess.id); });
      const markEl = sessMarkEl(sess);
      const label = document.createElement("span");
      label.className = "code-history-title";
      label.textContent = sessDisplayTitle(sess.title);
      label.title = sess.title;   // the FULL name stays one hover away
      const menuBtn = document.createElement("button");
      menuBtn.className = "code-chat-menu-btn";
      menuBtn.title = "More";
      menuBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" stroke="none"><circle cx="12" cy="5" r="1.7"/><circle cx="12" cy="12" r="1.7"/><circle cx="12" cy="19" r="1.7"/></svg>`;
      menuBtn.addEventListener("click", (e) => { e.stopPropagation(); openSessRowMenu(menuBtn, sess); });
      // WHERE IT RUNS (his rule, 2026-10-04): the rail lists the desktop's
      // threads and the cloud's side by side, each wearing its locus — the
      // same element the recents dropdown wears (sessLocusEl).
      // The leading glyph already says where it runs; a trailing one only
      // when the row is locked (the lock and its grant card).
      if (sess.locked) row.append(dot, markEl, label, sessLocusEl(sess), menuBtn);
      else row.append(dot, markEl, label, menuBtn);
      if (sess.locked) row.classList.add("locked");
      row.addEventListener("click", () => sessOpen(sess));
      host.appendChild(row);
    }
  }
}

/** The agent card's recents DROPDOWN — main's wb-session-menu wholesale:
 *  search on top, the rail's grouping, rows with pin + delete icons. */
/** The recents dropdown's one width (help/menu-place.ts caps it to the room). */
export const SESSION_MENU_WIDTH = 360;
function openSessionsDropdown(anchor: HTMLElement, opts: { onPick: (sess: RailSession) => void }): void {
  document.querySelector(".wb-session-menu")?.remove();
  const menu = document.createElement("div");
  menu.className = "code-drop wb-session-menu";
  let menuQuery = "";
  const searchWrap = document.createElement("div");
  searchWrap.className = "wb-session-search";
  const search = document.createElement("input");
  search.type = "text";
  search.className = "loop-drop-search repo-drop-search";
  search.placeholder = "Search sessions…";
  search.spellcheck = false;
  search.autocomplete = "off";
  search.addEventListener("mousedown", (e) => e.stopPropagation());
  searchWrap.appendChild(search);
  // The same place filter the rail has, to the right of the search (his order,
  // 2026-09-16, restored 2026-09-30) — in every agent window's recents.
  const filterBtn = document.createElement("button");
  filterBtn.type = "button";
  filterBtn.className = "rail-filter-btn" + (filterActive() ? " active" : "");
  filterBtn.title = "Filter by place";
  filterBtn.innerHTML = FILTER_SVG;
  filterBtn.addEventListener("mousedown", (e) => e.stopPropagation());
  filterBtn.addEventListener("click", (e) => { e.stopPropagation(); openPlaceFilterMenu(filterBtn); });
  searchWrap.appendChild(filterBtn);
  const onFilter = (): void => {
    if (!menu.isConnected) { document.removeEventListener("glyphh:loop-filter-changed", onFilter); return; }
    filterBtn.classList.toggle("active", filterActive());
    paint();
  };
  document.addEventListener("glyphh:loop-filter-changed", onFilter);
  menu.appendChild(searchWrap);
  const listHost = document.createElement("div");
  listHost.className = "wb-session-list";
  menu.appendChild(listHost);
  search.addEventListener("input", () => { menuQuery = search.value; paint(); });
  let pool = railSessions;
  const paint = (): void => {
    listHost.innerHTML = "";
    const q = menuQuery.trim().toLowerCase();
    // THE RAIL'S FILTER, verbatim (his order, 2026-10-04): the same function, the same prefs.
    const menuFilter = sessFilter({ query: q });
    const visible = pool.filter((x) => sessFilterKeeps(x, menuFilter));
    const mkRow = (sess: RailSession): HTMLElement => {
      const row = document.createElement("div");
      row.className = "wb-session-row" + (sess.locked ? " locked" : "");
      row.appendChild(sessDot(sess.id));
      row.appendChild(sessLocusEl(sess));
      const title = document.createElement("button");
      title.type = "button";
      title.className = "code-drop-item wb-session-title";
      title.textContent = sessDisplayTitle(sess.title);
      title.title = sess.title;
      title.addEventListener("click", () => { menu.remove(); opts.onPick(sess); });
      const pin = document.createElement("button");
      pin.type = "button";
      pin.className = "code-icon-btn wb-session-pin" + (sessPinned(sess.id) ? " on" : "");
      pin.title = sessPinned(sess.id) ? "Unpin" : "Pin to top";
      pin.innerHTML = SESS_PIN_SVG;
      pin.addEventListener("click", (e) => { e.stopPropagation(); sessTogglePin(sess.id); paint(); });
      const del = document.createElement("button");
      del.type = "button";
      del.className = "code-icon-btn wb-session-del";
      del.title = "Delete session";
      del.innerHTML = SESS_TRASH_SVG;
      del.addEventListener("click", (e) => {
        e.stopPropagation();
        void sessDelete(sess).then((gone) => {
          if (gone) pool = pool.filter((x) => x.id !== sess.id);
          if (gone && menu.isConnected) paint();
        });
      });
      row.append(title, pin, del);
      return row;
    };
    for (const sec of sessSections(visible)) {
      listHost.appendChild(sessSectionHead(sec.label, sec.title));
      for (const c of sec.rows) listHost.appendChild(mkRow(c));
    }
    if (!visible.length) {
      const empty = document.createElement("div");
      empty.className = "wb-session-empty";
      empty.textContent = q ? "No sessions match." : "No sessions yet.";
      listHost.appendChild(empty);
    }
  };
  paint();
  // ONE FIXED WIDTH on every open, whatever the rows say (they ellipsize);
  // the height is the room's and the LIST scrolls under the pinned search
  // and type switch (his report, 2026-10-05: the recents ran past the
  // menu's bottom clipped, and the menu re-sized with its content).
  placeDropup(anchor, menu, { width: SESSION_MENU_WIDTH, scrollEl: listHost });
  const dismiss = (e: MouseEvent): void => {
    if (!menu.contains(e.target as Node)) { menu.remove(); document.removeEventListener("mousedown", dismiss, true); }
  };
  document.addEventListener("mousedown", dismiss, true);
}
(window as unknown as { __glyphhSessionsMenu?: typeof openSessionsDropdown }).__glyphhSessionsMenu = openSessionsDropdown;
/** The agent card's recents pick for a Glyphh-loop session — routed here, never into a CLI resume. */
(window as unknown as { __glyphhOpenLoopSession?: (id: string) => void }).__glyphhOpenLoopSession = (id) => {
  // The id is enough: openGlyphhSession finds the thread in this document's
  // array or in main's shared file, and says so when it can find neither.
  void openGlyphhSession(id);
};

function registerRailGridHost(kind: "layouts" | "agents", host: RailGridHost): void {
  (kind === "layouts" ? railLayoutsHosts : railAgentsHosts).add(host);
}

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
    void loadRailSessions();
    // THE SAME LIST the echo wall builds (help/app-list.ts) — his rule,
    // 2026-09-11. The rail used to keep url-less native rows and skip the
    // house defaults, so the two surfaces showed different apps.
    railApps = visibleAppRows((apps || []) as unknown as RailApp[]) as RailApp[];
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
  void primeNativeIcons(railApps as never, renderRecentApps);
}

/** Both rail sections. Apps and Layouts each own a search + pagination and live
 *  under their own collapsible header (see initRailSections). */
let railCcOrder: string[] = [];
function renderRecentApps(): void { renderRailLayouts(); renderRailAgents(); }
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
    window.setTimeout(() => document.getElementById(`${section === "apps" ? "app" : section === "agents" ? "cagent" : "layout"}-new-btn`)?.click(), 60);
  });
  list.appendChild(btn);
}

/** A workspace tile's menu: Edit (how it opens, its agents' loop, face and
 *  route) and Delete (the standard confirm). */
function openWorkspaceTileMenu(x: number, y: number, name: string): void {
  document.querySelector(".ws-tile-menu")?.remove();
  const m = document.createElement("div");
  m.className = "code-menu ws-tile-menu";
  m.style.position = "fixed";
  m.style.left = `${x}px`;
  m.style.top = `${y}px`;
  m.style.zIndex = "10040";
  const edit = document.createElement("button");
  edit.type = "button";
  edit.className = "code-menu-item";
  edit.textContent = "Edit workspace…";
  edit.addEventListener("click", () => { m.remove(); void openEditWorkspaceModal(name); });
  m.appendChild(edit);
  const del = document.createElement("button");
  del.type = "button";
  del.className = "code-menu-item danger";
  del.textContent = "Delete workspace";
  del.addEventListener("click", () => {
    m.remove();
    void confirmAction({ title: `Delete "${name}"?`, body: "The workspace goes; the apps and files in it stay.", confirmLabel: "Delete" }).then(async (ok) => {
      if (!ok) return;
      await (window.glyphh as unknown as { layoutsDelete?: (n: string) => Promise<boolean> }).layoutsDelete?.(name);
      document.dispatchEvent(new CustomEvent("glyphh:apps-changed"));
    });
  });
  m.appendChild(del);
  document.body.appendChild(m);
  const off = (ev: Event): void => {
    if (m.contains(ev.target as Node)) return;
    m.remove();
    document.removeEventListener("mousedown", off, true);
  };
  window.setTimeout(() => document.addEventListener("mousedown", off, true), 0);
}

function renderRailLayouts(): void {
  for (const host of [...railLayoutsHosts]) {
    if (!host.list.isConnected) { railLayoutsHosts.delete(host); continue; }
    paintLayoutsGrid(host);
  }
}

function paintLayoutsGrid(host: RailGridHost): void {
  const list = host.list;
  const q = (host.search?.value || "").trim().toLowerCase();
  list.textContent = "";

  // Mini icon stacks; same open (into the workbench) as the Layouts page.
  const layouts = railLayouts
    .filter((l) => !q || (l.name || "").toLowerCase().includes(q))
    .sort((a, b) => {
      const ta = railRecentTs[`layout:${a.name}`] || 0;
      const tb = railRecentTs[`layout:${b.name}`] || 0;
      return ta !== tb ? tb - ta : (a.name || "").localeCompare(b.name || "");
    });
  const lp = railPaginate(layouts, host.page, RAIL_LAYOUTS_PER_PAGE);
  host.page = lp.page;
  for (const l of lp.items) {
    const tile = document.createElement("button");
    tile.className = "app-rail-tile";
    tile.type = "button";
    tile.title = `${l.name} (workspace)`;
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
    tile.addEventListener("click", () => {
      ensureWorkbench();
      void (window as unknown as { __wbOpenLayoutByName?: (n: string) => Promise<boolean> }).__wbOpenLayoutByName?.(l.name);
    });
    // DELETE lives on the tile now (the Workspaces page left Customize, his
    // order 2026-10-09): right-click → Delete, confirmed.
    tile.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      e.stopPropagation();
      openWorkspaceTileMenu(e.clientX, e.clientY, l.name);
    });
    list.appendChild(tile);
  }
  if (lp.totalPages > 1) list.appendChild(railPager(lp.page, lp.totalPages, (pg) => { host.page = pg; paintLayoutsGrid(host); }));
  if (!layouts.length) {
    if (q) railEmpty(list, q, "Workspace", "layouts");
    else {
      // No workspaces yet: the section's own + is the way to make one, so the
      // empty list only says so.
      const none = document.createElement("div");
      none.className = "code-empty app-rail-empty";
      none.textContent = "No workspaces yet.";
      list.appendChild(none);
    }
  }
}

function renderRailAgents(): void {
  for (const host of [...railAgentsHosts]) {
    if (!host.list.isConnected) { railAgentsHosts.delete(host); continue; }
    paintAgentsGrid(host);
  }
}

const RAIL_AGENT_GLYPH = `<svg viewBox="0 0 24 24" fill="none" style="width:20px;height:20px"><path d="M12 2.2v2.6" style="fill:none;stroke:#a21caf;stroke-width:1.8"/><circle cx="12" cy="2.6" r="1.3" style="fill:#d946ef"/><rect x="2" y="10" width="2" height="4.5" rx="1" style="fill:#a21caf"/><rect x="20" y="10" width="2" height="4.5" rx="1" style="fill:#a21caf"/><rect x="4" y="6" width="16" height="12.5" rx="3.5" style="fill:#d946ef"/><circle cx="9" cy="11.4" r="1.7" style="fill:#ffffff"/><circle cx="15" cy="11.4" r="1.7" style="fill:#ffffff"/><rect x="8.6" y="15" width="6.8" height="1.7" rx="0.85" style="fill:#f5d0fe"/></svg>`;

function paintAgentsGrid(host: RailGridHost): void {
  const list = host.list;
  const q = (host.search?.value || "").trim().toLowerCase();
  list.textContent = "";
  const agents = railAgents
    .filter((a) => !q || (a.name || "").toLowerCase().includes(q))
    .sort((a, b) => (a.name || "").localeCompare(b.name || ""));
  const ap = railPaginate(agents, host.page, RAIL_LAYOUTS_PER_PAGE);
  host.page = ap.page;
  for (const a of ap.items) {
    const tile = document.createElement("button");
    tile.className = "app-rail-tile";
    tile.type = "button";
    tile.title = `${a.name} (agent)`;
    const icon = document.createElement("div");
    icon.className = "tile-icon";
    const mark = railCliMarks.glyphh || "";
    icon.innerHTML = mark
      ? `<img class="cli-mark-glyphh" src="${mark}" alt="" style="width:20px;height:20px;border-radius:5px" />`
      : a.icon ? `<span style="font-size:18px;line-height:1">${a.icon.replace(/&/g, "&amp;").replace(/</g, "&lt;")}</span>` : RAIL_AGENT_GLYPH;
    const nm = document.createElement("span");
    nm.className = "tile-name";
    nm.textContent = a.name;
    tile.append(icon, nm);
    tile.addEventListener("click", () => {
      ensureWorkbench();
      // ONE SURFACE (his order, 2026-09-14): every door opens the SAME agent
      // chat panel, this loop set; the terminal is the >_ hop, never a door.
      (window as unknown as { __wbOpenAgentChat?: (id: string) => void }).__wbOpenAgentChat?.(a.id);
    });
    list.appendChild(tile);
  }
  if (ap.totalPages > 1) list.appendChild(railPager(ap.page, ap.totalPages, (pg) => { host.page = pg; paintAgentsGrid(host); }));
  if (!agents.length) railEmpty(list, q, "Agent", "agents");
}


// (The recents splitter died with the rail tray sections — recents fills
// the stack; see syncRailLayout.)

/** Wire the rail's Apps grid: restore its height, load, and bind search. */
function initRailApps(): void {
  // The left rail's two grids are the FIRST hosts — registered once here,
  // before the initial load, so behavior is exactly as before the registry.
  const leftLayouts: RailGridHost | null = el<HTMLDivElement>("recent-layouts-list")
    ? { list: el<HTMLDivElement>("recent-layouts-list")!, search: el<HTMLInputElement>("recent-layouts-search"), page: 0 }
    : null;
  if (leftLayouts) registerRailGridHost("layouts", leftLayouts);
  // (Loops left the rail — they are SETTINGS now, not a browsable tray.)
  el<HTMLInputElement>("recent-sessions-search")?.addEventListener("input", renderRailSessions);
  el("recent-sessions-filter")?.addEventListener("click", (e) => { e.stopPropagation(); openPlaceFilterMenu(e.currentTarget as HTMLElement); });
  el("recent-sessions-filter")?.classList.toggle("active", filterActive());
  el("rail-recents-toggle")?.addEventListener("click", () => void loadRailSessions());
  initRailSections();
  initWorkspacesVsplit();
  // ONE CREATE DOOR (his order, 2026-10-08): the rail's +, the agent menu's
  // "Create workspace…". A panel is its own document — it asks the shell,
  // which owns the arrangement; the shell opens the modal.
  {
    const solo = (new URLSearchParams(window.location.search).get("solo") || "") === "tool:coding";
    const g = window.glyphh as unknown as { agentPanelCreateWorkspace?: () => Promise<boolean>; onAgentPanelCreateWorkspace?: (cb: () => void) => void };
    (window as unknown as { __glyphhCreateWorkspace?: () => void }).__glyphhCreateWorkspace = () => {
      if (solo && g.agentPanelCreateWorkspace) { void g.agentPanelCreateWorkspace(); return; }
      void openCreateWorkspaceModal();
    };
    if (!solo) g.onAgentPanelCreateWorkspace?.(() => { void openCreateWorkspaceModal(); });
  }
  // The + beside Workspaces: save what is on screen as a workspace.
  el("rail-layouts-add")?.addEventListener("click", (e) => { e.stopPropagation(); void openCreateWorkspaceModal(); });
  syncRailLayout();
  void loadRecentApps();
  // The Apps + Layouts rail open-page buttons were removed (A2/A5); their
  // sections open via the rail nav / settings modal now, and the trays below
  // are pure quick-launch grids.
  // Live updates: Apps/Layouts CRUD announces itself (same renderer).
  document.addEventListener("glyphh:apps-changed", () => { void loadRecentApps(); });
  // A bundle registered its tab in main (install, import, boot): the rail repaints.
  window.glyphh.onPanelAppsChanged?.(() => { void loadRecentApps(); });

  // Layouts search — its own page + list.
  if (leftLayouts) wireRailSearch(leftLayouts.search, () => { leftLayouts.page = 0; paintLayoutsGrid(leftLayouts); });

}

// (The Apps/Workspaces tray chips are GONE — the source/folder/git chips
// live in the card's bottom-left row instead.)

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
  // (The rail collapse/width prefs died with the visible rail — the rail's
  // DOM is display:none'd in styles.css and has no toggle.)
  const recentsOpen = (await window.glyphh.getPreference?.("codeRecentsOpen", true)) as boolean;
  setRecentsOpen(recentsOpen !== false, false);
}

// ── Entry points ─────────────────────────────────────────────────────────
export function loadCode(): void {
  void applyPanelPrefs();
  void initAnchor();
  void (async () => {
    await loadStore();
    // Don't auto-select a session on load — a fresh open highlights no Recent
    // (the composer opens ready; typing starts a new session). A saved
    // currentId still resumes, and only highlights while on the agent.
    renderHistory();
    renderThread();
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

/** Open an app ROW as a workbench panel — Settings → Apps "Open app" and any
 *  other out-of-workbench entry point. Same cold-safe mechanics as
 *  openUrlInWorkbench, but the caller passes the real slug and the glyphh
 *  flag (a glyphh app has no url until deployed; the workbench resolves it). */
export function openAppInWorkbench(app: { slug: string; name: string; url?: string | null; glyphh?: boolean; workbench?: boolean; cloud?: boolean }): void {
  showWorkspaceSurface();
  const w = window as unknown as {
    __initCodeWorkbench?: () => void;
    __wbOpenApp?: (a: { slug: string; name: string; url: string; glyphh?: boolean; workbench?: boolean; cloud?: boolean }, newPanel?: boolean) => void;
  };
  w.__initCodeWorkbench?.();
  const ref = { slug: app.slug, name: app.name, url: app.url || "", glyphh: app.glyphh || undefined, workbench: app.workbench || undefined , ...(app.cloud ? { cloud: true } : {}) };
  let tries = 0;
  const open = (): void => {
    if (w.__wbOpenApp) { w.__wbOpenApp(ref); return; }
    if (tries++ < 40) setTimeout(open, 50);
  };
  open();
}

/** Open a saved WORKSPACE by name — the same door the Echo and `.dip` use
 *  (`__wbOpenLayoutByName` → the switcher's openLayoutRow → grid open, with
 *  surfaceLayoutCells keeping the cells this surface can host). Cold-safe:
 *  flips to the workspace, boots the workbench, waits for the hook. */
export function openLayoutByName(name: string): void {
  showWorkspaceSurface();
  const w = window as unknown as { __initCodeWorkbench?: () => void; __wbOpenLayoutByName?: (n: string) => Promise<boolean> };
  w.__initCodeWorkbench?.();
  void (async () => {
    for (let i = 0; i < 40 && !w.__wbOpenLayoutByName; i++) await new Promise((r) => requestAnimationFrame(r));
    if (!(await w.__wbOpenLayoutByName?.(name).catch(() => false))) console.warn(`[code] no workspace named ${name} to open`);
  })();
}

/** THE PAGE OPENS WHAT THE AGENT ASKED FOR (an `open-app` run frame; his
 *  report, 2026-10-06: a web member's agent opened panels on their DESKTOP).
 *  A url → a browser panel; `layout:<name>` → that workspace; `settings:<page>`
 *  → the Settings modal on that page; a plain ref → the app's panel (a house
 *  slug opens its house panel, as the app lane routes it). Shared by the
 *  initiating and the observing run paths, on the web and on a desktop
 *  watching a cloud run. */
export function openRunRef(t: { ref?: string; url?: string }): void {
  if (t.url) { openUrlInWorkbench(new URL(t.url).hostname, t.url); return; }
  const parsed = t.ref ? parseOpenRef(t.ref) : null;
  if (!parsed) return;
  if (parsed.kind === "layout") openLayoutByName(parsed.name);
  else if (parsed.kind === "settings") openSettingsModal(parsed.page);
  else openAppInWorkbench({ slug: parsed.slug, name: parsed.slug });
}

/** Open a built-in WORK PANEL as a workbench panel — the Apps page's "Work
 *  panels" cards. Same cold-safe mechanics as openAppInWorkbench: flip to the
 *  workspace, boot the workbench, retry until the panel's bridge (__wbOpenGPoint,
 *  __wbOpenMedia, …) is assigned by the workbench init. */
export function openWorkPanelInWorkbench(bridge: string, ...args: unknown[]): void {
  showWorkspaceSurface();
  const w = window as unknown as { __initCodeWorkbench?: () => void } & Record<string, unknown>;
  w.__initCodeWorkbench?.();
  let tries = 0;
  const open = (): void => {
    const fn = w[bridge];
    if (typeof fn === "function") { (fn as (...a: unknown[]) => void)(...args); return; }
    if (tries++ < 40) setTimeout(open, 50);
  };
  open();
}

/** Make sure the workbench — the layout surface the agent and every panel
 *  live on — is mounted, from ANY section, even before it has ever booted
 *  (idempotent async init, then a retry until its door is assigned). The
 *  wall it used to raise is gone (his order, 2026-10-08). */
export function ensureWorkbench(opts: { boot?: boolean } = {}): void {
  const w = window as unknown as { __initCodeWorkbench?: () => void; __wbOpenEchoHome?: () => void };
  w.__initCodeWorkbench?.();
  let tries = 0;
  // The workbench's init is ASYNC and, on web, slow — its first awaits are
  // relay round trips (wb.getCwd → attach status over HTTP). A boot that gave
  // up left the main area EMPTY (his report, 2026-10-04), so the boot waits
  // on a timer as long as the solo panel's mount does (home.ts: 600 × 50 ms).
  const limit = opts.boot ? 600 : 40;
  const go = (): void => {
    const fn = w.__wbOpenEchoHome;
    if (fn) fn();
    else if (tries++ < limit) { if (opts.boot) setTimeout(go, 50); else requestAnimationFrame(go); }
    else console.warn("[code] the workbench never came up");
  };
  go();
}

/** THE THREE WEB SURFACES WEAR THEIR OWN NAMES (his order, 2026-10-07): the
 *  site is "Glyphh — …" (web/app/lib/home-meta.js), the console is "Glyphh
 *  Platform" (server ui layout.tsx), and this document — the app on
 *  app.glyphh.ai — is "Glyphh App"; the desktop window is plain "Glyphh". */
export function surfaceTitle(web: boolean): string {
  return web ? "Glyphh App" : "Glyphh";
}

export function initCode(): void {
  document.title = surfaceTitle(onWebTarget());
  syncSpaceAttrs();   // styled from the first frame, tab click or not
  if (inited) return;
  inited = true;
  initAnchorEvents();
  // The collapsed bar's one-line status rides the SAME timeline event the Plan
  // slot already consumes — no second subscription onto the frame stream.
  document.addEventListener("glyphh-agent:timeline", (ev) => {
    paintStatusLine(!!(ev as CustomEvent<{ running?: boolean }>).detail?.running);
  });
  paintStatusLine();
  // "/" in the composer pops the installed-skill menu at the caret.
  const composerTa = input();
  if (composerTa) { attachSlashMenu(composerTa); watchComposerWidth(composerTa); }
  // TYPING GLOW — the accent halo around the floating composer while keys
  // land (theme-aligned: it's all var(--accent)). The class rides the
  // composer wrap; a short quiet period lets it breathe back out.
  if (composerTa) {
    let glowTimer: number | undefined;
    composerTa.addEventListener("input", () => {
      composerTa.closest(".code-composer")?.classList.add("typing-glow");
      window.clearTimeout(glowTimer);
      glowTimer = window.setTimeout(() => {
        composerTa.closest(".code-composer")?.classList.remove("typing-glow");
      }, 900);
    });
  }
  // Cmd+. / Ctrl+. opens the command center from any section. Registered in
  // the home-panel document (owns gotoSection + the switcher overlay), NOT
  // renderer.ts (the index shell — different webContents, no overlay reach).
  document.addEventListener("keydown", (e) => {
    // ⌘⇧Esc — reset the open workspace to its saved design.
    if (e.code === "Escape" && e.shiftKey && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      void resetWorkspace();
      return;
    }
    // ⌘⇧N — a NEW agent session (the ⌘N "new" convention, shifted clear of
    // the OS new-window accelerator).
    if (e.code === "KeyN" && e.shiftKey && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      (window as unknown as { __glyphhNewSession?: () => void }).__glyphhNewSession?.();
      return;
    }
    // ⌘U — "Add files or photos", the `+` menu's attach door (Claude's chord).
    if (e.code === "KeyU" && !e.shiftKey && !e.altKey && (e.metaKey || e.ctrlKey) && plusMenu) {
      e.preventDefault();
      plusMenu.attachFiles();
      return;
    }
    // ⌘⇧Space — same launcher (mirrors the OS-wide global shortcut).
  });
  // The OS-wide ⌘⇧Space lands here from main once the window is fronted.
  // ⌘⇧Esc via the app menu (fires even when a panel webview holds the keys).
  (window.glyphh as unknown as { onResetWorkspaceGesture?: (cb: () => void) => void }).onResetWorkspaceGesture?.(() => { void resetWorkspace(); });
  // ⌘⇧N via the app menu (fires even when a panel webview holds the keys).
  (window.glyphh as unknown as { onNewSessionGesture?: (cb: () => void) => void }).onNewSessionGesture?.(() => {
    (window as unknown as { __glyphhNewSession?: () => void }).__glyphhNewSession?.();
  });
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
    // The agent's door to Settings (2026-09-17): the same panel the dock opens.
    else if (cmd.action === "settings") openSettingsModal(String((cmd as { sub?: string }).sub || "") || undefined);
    else if (cmd.action === "tool" && (cmd as { tool?: string }).tool) (window as unknown as { __wbOpenTool?: (v: string) => void }).__wbOpenTool?.((cmd as { tool?: string }).tool!);
    else if (cmd.action === "gdesign") (window as unknown as { __wbOpenDesign?: (file?: string, title?: string) => void }).__wbOpenDesign?.((cmd as { file?: string }).file, (cmd as { title?: string }).title);
    else if (cmd.action === "gmedia") (window as unknown as { __wbOpenMedia?: (view: string, assetId?: string, songId?: string) => void }).__wbOpenMedia?.((cmd as unknown as { view: string }).view, (cmd as unknown as { assetId?: string }).assetId, (cmd as unknown as { songId?: string }).songId);
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
    else if (cmd.action === "switcher") ensureWorkbench();
  });
  // One delegated handler for everything interactive inside the thread —
  // survives every re-render: file cards (→ Monaco), run cards (→ terminal).
  // Code-block copy/run live on the document (format-markdown.ts).
  el("code-thread")?.addEventListener("click", (e) => {
    const t = e.target as HTMLElement;
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
  // ONE TYPE (his order, 2026-10-08): the face paints once at boot — there is
  // no tab to follow and nothing another document can switch.
  syncSpaceAttrs();
  paintComposerGate();
  void loadRailSessions();
  (window.glyphh as unknown as { onPreferenceChanged?: (cb: (key: string, value: unknown) => void) => void })
    .onPreferenceChanged?.((key, value) => {
      // Settings → General's default model moved: the next session starts on it.
      if (key === "defaultModel") { defaultModelPref = String(value || "") || null; try { paintModelChip(); } catch { /* */ } return; }
      // Settings › General's default loop and gateway: a session with no loop of its own follows.
      if (key === DEFAULT_LOOP_PREF || key === CLI_GATEWAY_PREF) { void refreshLoops(); return; }
      // Another panel turned the effort dial: this chip follows.
      if (key === EFFORT_PREF) { if (isEffort(value)) { effort = value; try { paintLevelChip(); } catch { /* */ } } }
    });
  // The sidebar's own header: collapse (persisted) and the Echo launcher.
  const setRailCollapsed = (on: boolean, persist: boolean): void => {
    document.body.classList.toggle("rail-collapsed", on);
    document.body.classList.remove("rail-peek");
    el("rail-collapsed-strip")?.classList.toggle("hidden", !on);
    if (persist) void window.glyphh.setPreference?.("railCollapsed", on);
  };
  // Collapsed: the strip's icon peeks the sidebar on hover; leaving the sidebar hides it again; a click expands for good.
  el("rail-expand-btn")?.addEventListener("mouseenter", () => { if (document.body.classList.contains("rail-collapsed")) document.body.classList.add("rail-peek"); });
  el("rail-expand-btn")?.addEventListener("click", () => setRailCollapsed(false, true));
  // The peeked sidebar stays while the pointer is over it OR over any popup it
  // opened (menus land on the body, outside the rail): hide only once the
  // pointer has been off both for a moment.
  const RAIL_POPUPS = ".code-menu, .rail-more-menu, .wb-session-menu, .code-drop, .rail-account-menu, .settings-nav-menu, .confirm-overlay";
  let peekTimer: number | null = null;
  const overRailOrPopup = (x: number, y: number): boolean => {
    const n = document.elementFromPoint(x, y) as HTMLElement | null;
    return !!n && (!!n.closest("#app-rail") || !!n.closest("#rail-collapsed-strip") || !!n.closest(RAIL_POPUPS));
  };
  document.addEventListener("mousemove", (e) => {
    if (!document.body.classList.contains("rail-collapsed") || !document.body.classList.contains("rail-peek")) return;
    if (overRailOrPopup(e.clientX, e.clientY)) { if (peekTimer) { window.clearTimeout(peekTimer); peekTimer = null; } return; }
    if (peekTimer) return;
    peekTimer = window.setTimeout(() => {
      peekTimer = null;
      // A popup that is actually SHOWING keeps the sidebar; hidden dropdowns parked in the DOM don't count.
      const showing = Array.from(document.querySelectorAll<HTMLElement>(RAIL_POPUPS)).some((n) => { const r = n.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(n).visibility !== "hidden"; });
      if (showing) return;
      document.body.classList.remove("rail-peek");
    }, 350);
  });
  // Delegated: the strip is an OS drag region, so the click is caught at the document and logged.
  document.addEventListener("click", (e) => {
    const t = (e.target as HTMLElement | null)?.closest?.("#rail-collapse-btn");
    if (!t) return;
    e.preventDefault(); e.stopPropagation();
    const on = !document.body.classList.contains("rail-collapsed");
    console.warn("[rail] collapse", on);
    setRailCollapsed(on, true);
  }, true);
  // Drag the sidebar's right edge to resize it (persisted); collapse restores the last width.
  const railEl = el("app-rail");
  if (railEl && !el("app-rail-resize")) {
    const grip = document.createElement("div");
    grip.id = "app-rail-resize";
    // On the body, straddling the rail's edge: inside the rail it was clipped by overflow and sat left of the border.
    document.body.appendChild(grip);
    const applyWidth = (w: number): void => { document.body.style.setProperty("--rail-w-open", `${w}px`); };
    void window.glyphh.getPreference?.("railWidth", 264).then((v) => { const w = Number(v); if (w >= 180 && w <= 520) applyWidth(w); }).catch(() => {});
    grip.addEventListener("mousedown", (e) => {
      if (document.body.classList.contains("rail-collapsed")) return;
      e.preventDefault();
      const startX = e.clientX;
      const startW = railEl.getBoundingClientRect().width;
      let w = startW;
      document.body.classList.add("rail-resizing");
      const move = (ev: MouseEvent): void => { w = Math.max(180, Math.min(520, Math.round(startW + (ev.clientX - startX)))); applyWidth(w); };
      const up = (): void => {
        document.removeEventListener("mousemove", move); document.removeEventListener("mouseup", up);
        document.body.classList.remove("rail-resizing");
        void window.glyphh.setPreference?.("railWidth", w);
      };
      document.addEventListener("mousemove", move); document.addEventListener("mouseup", up);
    });
  }
  // The shell starts to the RIGHT of the fixed sidebar and at the very top, inline so no later stylesheet rule can undo it.
  const shell = document.getElementById("help-overlay");
  if (shell) { shell.style.left = "var(--rail-w)"; shell.style.top = "0px"; }
  // The rail leaves the shell's stacking context (#help-overlay is z 100): as a
  // child of #home-root it competes at the body level with the agent/app/dock
  // layers, so it paints above the panels instead of under them.
  const railNode = document.getElementById("app-rail");
  if (railNode && railNode.parentElement !== document.body) document.body.appendChild(railNode);
  // GEOMETRY PROOF (2026-09-16): what actually sits where, so a bleed or a dead
  // button is diagnosed from one pasted line instead of guessed at.
  window.setTimeout(() => {
    const at = (x: number, y: number): string => { const n = document.elementFromPoint(x, y) as HTMLElement | null; return n ? `${n.tagName.toLowerCase()}${n.id ? "#" + n.id : ""}${n.className && typeof n.className === "string" ? "." + n.className.split(" ").slice(0, 2).join(".") : ""}` : "none"; };
    const rail = document.getElementById("app-rail");
    const railR = rail?.getBoundingClientRect();
    const rectOf = (sel: string): string => { const n = document.querySelector<HTMLElement>(sel); if (!n) return "absent"; const r = n.getBoundingClientRect(); return `${Math.round(r.left)},${Math.round(r.top)} ${Math.round(r.width)}x${Math.round(r.height)} in:${n.parentElement?.id || n.parentElement?.className || "?"}`; };
    console.warn("[rail] geometry", JSON.stringify({
      railW: railR ? Math.round(railR.width) : null, railLeft: railR ? Math.round(railR.left) : null,
      shellLeft: shell ? getComputedStyle(shell).left : null, shellTop: shell ? getComputedStyle(shell).top : null,
      railWVar: getComputedStyle(document.body).getPropertyValue("--rail-w").trim(),
      atLights: at(20, 15), atCollapse: at(97, 19), atEcho: at(125, 19), atContent: at((railR?.width ?? 264) + 40, 300), atUnderRail: at(120, 400),
      dockLayer: rectOf("#echo-dock-layer"), topbar: rectOf(".echo-topbar"), echoBody: rectOf(".ws-echo-body"), hotstrip: rectOf(".echo-dock-hotstrip"),
    }));
  }, 2500);
  // DOCK PROOF (his report, 2026-09-16: "the dock is not respected"): what the
  // dock is doing once panels are up — parked or on the stage, tucked or not,
  // visible or not, and the body classes that decide it. Twice, so a panel
  // opened after boot is caught too.
  for (const at of [4000, 12000]) {
    window.setTimeout(() => {
      const bar = document.querySelector<HTMLElement>(".echo-topbar");
      const r = bar?.getBoundingClientRect();
      const cs = bar ? getComputedStyle(bar) : null;
      console.warn("[dock] state", JSON.stringify({
        parked: !!bar?.closest("#echo-dock-layer"), rect: r ? `${Math.round(r.left)},${Math.round(r.top)} ${Math.round(r.width)}x${Math.round(r.height)}` : "absent",
        visibility: cs?.visibility, display: cs?.display, opacity: cs?.opacity, transform: cs?.transform,
        body: Array.from(document.body.classList).filter((c) => c.startsWith("echo") || c.startsWith("wb") || c.startsWith("rail")).join(" "),
        topInset: getComputedStyle(document.body).getPropertyValue("--wb-top-inset").trim() || "unset",
        cards: document.querySelectorAll(".echo-card").length, agentHolder: (() => { const n = document.querySelector<HTMLElement>(".ws-agent-holder"); if (!n) return "absent"; const q = n.getBoundingClientRect(); return `${Math.round(q.left)},${Math.round(q.top)} ${Math.round(q.width)}x${Math.round(q.height)}`; })(),
      }));
    }, at);
  }
  void window.glyphh.getPreference?.("railCollapsed", false).then((v) => setRailCollapsed(v === true, false)).catch(() => {});
  // The content shell sits to the right of the sidebar; inline and !important because the template's own inset rule is !important too.
  { const shellEl = document.getElementById("help-overlay"); if (shellEl) { shellEl.style.setProperty("right", "0px", "important"); shellEl.style.removeProperty("width"); } }
  initRailApps();
  /** NEW creates NOTHING — the record is born on the first send. Clears the
   *  selection and shows the space's landing. Both entry points use this:
   *  the rail's "+ New session" and the agent header's +, which used to call
   *  startNew() and leave an empty "New session" row behind. */
  /** NEW SESSION (his rule, 2026-08-18): everything that is showing closes —
   *  cards, layouts, seats — and the agent comes up ALONE as a regular Echo
   *  panel (its card header carries the title + ✕). The workbench owns the
   *  surface work (__wbNewSessionPanel); this empties the thread state first. */
  const newSessionInPlace = (): void => {
    currentId = "";
    // NEW IS A STATE A RELOAD KEEPS (his report, 2026-10-05: "new isn't
    // resetting the web page state so a reload goes back to the last
    // session"): the persisted resume target must clear with it, or boot's
    // fallback to the last session brings the old thread straight back.
    lastSession = "";
    void window.glyphh.setPreference?.(LAST_SESSION_PREF, "");
    void saveStore();
    // THE SURFACE FOLLOWS THE ACTIVE TYPE AGAIN (his report, 2026-10-05: Work
    // → Code → + New left the folder options hidden). With no thread open the
    // composer styles from the rail's tab — but the attribute was last written
    // for the Work thread that was open, and nothing here re-read it, so the
    // CSS kept the Code chips hidden until some other repaint happened by.
    syncSpaceAttrs();
    renderHistory();
    renderThread();
    void checkWorkdirGate();
    // (No gotoSection("agent") — that path opens its OWN agent card via
    // openSectionInWorkbench; __wbNewSessionPanel below owns the whole
    // surface change, and the code section is the permanent shell.)
    const w = window as unknown as { __initCodeWorkbench?: () => void; __wbNewSessionPanel?: () => void };
    w.__initCodeWorkbench?.();
    let tries = 0;
    const go = (): void => {
      if (w.__wbNewSessionPanel) w.__wbNewSessionPanel();
      else if (tries++ < 40) requestAnimationFrame(go);
    };
    go();
  };

  // The old newSessionLanding "full reset + landing screen" path is DELETED:
  // newSessionInPlace (below, bound as __glyphhNewSession) is the ONE new-
  // session behavior — every entry (the rail's +, Home, the agent header's +,
  // and the workbench's glyphh tiles) calls the same function, so no second
  // copy exists to drift.
  // A new session JUST LOADS THE AGENT in place — no separate "New Session"
  // screen. The rail's +, Home, and the GLYPHH tile all empty the current
  // thread and keep the agent exactly where it is (docked, hosted, or full),
  // the same as the agent header's own + button.
  el("code-new-chat")?.addEventListener("click", () => {
    const w = window as unknown as {
      __initCodeWorkbench?: () => void;
      __wbOpenGlyphhAgent?: () => void;
      __wbAgentInstanced?: () => boolean;
      __wbOpenAgentInstanceWith?: (loop: string | undefined, cmd: { type: "new-session" }) => void;
      __wbAgentFocused?: () => boolean;
      __wbAgentRoute?: (cmd: { type: "new-session" }) => boolean;
      __wbHasAgentSeat?: () => boolean;
      __wbFrontAgentSeat?: () => boolean;
    };
    w.__initCodeWorkbench?.();
    // The workbench boots async — a press before its doors exist waits for
    // them (a bounded poll, the same pattern every other early door uses).
    const go = (tries = 0): void => {
      if (!w.__wbAgentInstanced && !w.__wbOpenGlyphhAgent) { if (tries < 40) requestAnimationFrame(() => go(tries + 1)); return; }
      // NEW TARGETS THE OPEN AGENT (his order, 2026-10-09, reversing
      // 2026-09-29's "always a new agent": "new from the left rail should
      // always just target the open agent... no need for it to open yet
      // another agent window"). Where it lands, the same order a rail
      // session click uses: the panel touched last, else the workspace's
      // seat on screen, else the first open panel — a fresh session in it.
      // Only with no agent open at all does a panel open.
      if (w.__wbAgentInstanced?.()) {
        const cmd = { type: "new-session" as const };
        if (w.__wbAgentFocused?.() && w.__wbAgentRoute?.(cmd)) return;
        if (w.__wbHasAgentSeat?.()) { newSessionInPlace(); w.__wbFrontAgentSeat?.(); return; }
        if (w.__wbAgentRoute?.(cmd)) return;
        w.__wbOpenAgentInstanceWith?.(GLYPHH_LOOP, cmd);
        return;
      }
      w.__wbOpenGlyphhAgent?.();
    };
    go();
  });
  (window as unknown as { __glyphhNewSession?: () => void }).__glyphhNewSession = newSessionInPlace;
  // The artifact viewer names the artifact in hand for the CURRENT session
  // (code-workbench.ts __wbSendToAgent passes it through before it types).
  (window as unknown as { __glyphhSetArtifactRef?: (ref: { id: string; name: string } | null) => void }).__glyphhSetArtifactRef = (ref) => {
    const next = ref && ref.id ? { id: String(ref.id), name: String(ref.name || "") } : null;
    const c = current();
    if (!c) { pendingArtifactRef = next; return; }
    if (next) c.artifactRef = next; else delete c.artifactRef;
    void saveStore();
  };
  // THE SHELL'S ORDERS (agent-panel:command) — this panel is one instance
  // among many; the host document routes rail clicks and Home sends here.
  panelCommandHandler = (cmd) => {
    console.warn("[panel] command", JSON.stringify({ type: cmd.type, id: cmd.id }));   // never silent (the house rule)
    if (cmd.type === "new-session") { newSessionInPlace(); return; }
    if (cmd.type === "open-session") { whenPanelReady(() => sessOpen(cmd.sess)); return; }
    if (cmd.type === "prompt") {
      whenPanelReady(() => {
        newSessionInPlace();
        if (cmd.cwd) { pendingWorkdir = cmd.cwd; applySessionFolder({ workdir: cmd.cwd } as CodeChat); }
        const put = (tries = 0): void => {
          const ta = input();
          if (!ta) { if (tries < 60) requestAnimationFrame(() => put(tries + 1)); return; }
          ta.value = cmd.text;
          ta.dispatchEvent(new Event("input", { bubbles: true }));
          if (Array.isArray(cmd.attach) && cmd.attach.length) { pendingAttach = cmd.attach.slice(); paintAttachChips(); }
          ta.focus();
          ta.setSelectionRange(ta.value.length, ta.value.length);
          if (cmd.send !== false) send();
        };
        put();
      });
    }
  };
  for (const cmd of queuedPanelCommands.splice(0)) panelCommandHandler(cmd);
  // A fresh session on request from elsewhere (Settings → Skills: "Try in chat",
  // "Edit with <loop>"): loop + folder are held for the session the first send
  // creates; the prompt waits in the composer for the user to send.
  (window as unknown as { __glyphhOpenSessionWith?: (o: { loop?: string; cwd?: string; prompt: string }) => void }).__glyphhOpenSessionWith = (o) => {
    // Agent panels are instances: the ask goes to one the way the rail's +
    // does — a fresh session in the open agent, else a new agent panel in the
    // loop asked for (the default, Glyphh's). Starting it on the host
    // document left a blank wall.
    const w = window as unknown as {
      __initCodeWorkbench?: () => void;
      __wbAgentInstanced?: () => boolean;
      __wbAgentRoute?: (cmd: { type: "prompt"; text: string; cwd?: string; send?: boolean }) => boolean;
      __wbOpenAgentInstanceWith?: (loop: string | undefined, cmd: { type: "prompt"; text: string; cwd?: string; send?: boolean }) => void;
    };
    w.__initCodeWorkbench?.();
    const route = (tries = 0): void => {
      if (!w.__wbAgentInstanced) { if (tries < 40) requestAnimationFrame(() => route(tries + 1)); else inPlace(o); return; }
      if (!w.__wbAgentInstanced()) { inPlace(o); return; }
      const cmd = { type: "prompt" as const, text: o.prompt, ...(o.cwd ? { cwd: o.cwd } : {}), send: false };
      if (!o.loop && w.__wbAgentRoute?.(cmd)) return;
      w.__wbOpenAgentInstanceWith?.(o.loop || GLYPHH_LOOP, cmd);
    };
    route();
  };
  // No agent instances (the web's single agent): the session starts here.
  function inPlace(o: { cwd?: string; prompt: string }): void {
    newSessionInPlace();
    if (o.cwd) { pendingWorkdir = o.cwd; applySessionFolder({ workdir: o.cwd } as CodeChat); }
    const put = (tries = 0): void => {
      const ta = input();
      if (ta) { ta.value = o.prompt; ta.dispatchEvent(new Event("input", { bubbles: true })); ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); return; }
      if (tries < 40) requestAnimationFrame(() => put(tries + 1));
    };
    put();
  }
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
    void checkWorkdirGate();
    if (!navigate) return;
    gotoSection("agent");
    // Re-assert the composer's one presentation after the surface flip (the
    // anchor SYSTEM is gone — this is just the bottom-composer mode + the
    // session-button relocation).
    void initAnchor();
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
  // Restore the workspace source pick (a folder on this machine).
  void window.glyphh.getPreference?.(SOURCE_PREF, null).then((sc) => {
    const stored = sc && typeof sc === "object" ? sc as Source : null;
    const cc: Source | null = stored?.kind === "local" && stored.path ? { kind: "local", path: String(stored.path) } : null;
    if (cc) pendingSource = cc;
    // DEFAULT RESOLUTION: this machine's last-used working folder. An explicit
    // stored pick is always respected; the default applies only when the user
    // has never picked. The resolved default also backs forgetCurrentSession.
    void (async () => {
      // None yet → an empty path flows through the workdir gate / home-dir
      // default, exactly like a hand-picked folder-less source.
      const dir = (await wb()?.getCwdExplicit?.().catch(() => null)) || "";
      const local: Source = { kind: "local", path: dir };
      resolvedDefaultSource = { ...local };
      // Apply only where the DEFAULT is in play: no stored pick, and the user
      // hasn't picked something else while we resolved.
      if (!cc && sameSource(pendingSource, DEFAULT_SOURCE)) {
        pendingSource = { ...local };
        sourceChip?.setSource(activeSource());
        paintSourceDependents();
      }
    })();
    paintSourceDependents();
  });
  void window.glyphh.getPreference?.(LAST_SESSION_PREF, "").then((lco) => {
    lastSession = String(lco || "");
    // BOOT = THE COMMAND CENTER + the permanent bottom composer, and that is
    // it (his rule, 2026-08-18): no session resume, no agent panel. NO
    // gotoSection("agent") here — the code section is the permanent shell
    // (initHelp marks it active), so boot asserts the composer's one
    // presentation and raises the wall. lastSession stays loaded so the
    // history dropdown / enter-space can resume it later.
    void initAnchor();
    ensureWorkbench({ boot: true });
  });
  // (The chrome-cluster command button is GONE — ⌘⇧Space / ⌘. open the
  // command center; the wall's own eye button pins the shadow.)
  el("code-send")?.addEventListener("click", send);
  // The PILL composer's side band (his reference, 2026-08-19): the caret
  // expands the full controls (source row + chip bar) above/below the input;
  // CC pins the wall over open cards; reset clears back to the command
  // center. The latter two only show while panels cover the wall (the
  // workbench drives body.echo-cc-needed).
  // THE CHIPS' SEATS (his order, 2026-10-07, one type since 2026-10-08): the
  // box holds the input; the quiet row UNDER it holds the words — + · mic ·
  // mode · Output left, model · effort right. One rule for every host (docked
  // cell, the centre pill, the web's flow card). appendChild moves keep
  // listeners; a node already in its seat is left alone (moving it would blur
  // a focused chip). The workbench calls this global after re-homing the agent.
  const seatMic = (): void => {
    const mic = el("code-mic-wrap");
    const plus = el("code-plus-wrap");
    const agent = document.querySelector(".code-agent");
    if (!mic || !plus || !agent) return;
    const wrap = agent.querySelector(".code-input-wrap");
    const left = agent.querySelector(".code-bar-left");
    const right = agent.querySelector(".code-bar-right");
    const wave = el("code-rec-wave");
    if (!wrap || !left || !right || !wave) return;
    const mode = el("code-mode-wrap");
    const level = el("code-level-wrap");
    const model = el("code-model-wrap");
    const stop = el("code-speak-wrap");
    // Put `nodes` at the head of `parent` in this order, moving only what is
    // out of place (a pass over a settled row touches nothing).
    const order = (parent: Element, nodes: Array<HTMLElement | null>): void => {
      let prev: Element | null = null;
      for (const n of nodes) {
        if (!n) continue;
        const want: Element | null = prev ? prev.nextElementSibling : parent.firstElementChild;
        if (n.parentElement !== parent || want !== n) parent.insertBefore(n, want && want.parentElement === parent ? want : null);
        prev = n;
      }
    };
    void wrap; void wave;
    order(left, [plus, mic, mode]);
    order(right, [model, level, stop]);
  };
  (window as unknown as { __glyphhSeatMic?: () => void }).__glyphhSeatMic = seatMic;
  seatMic();
  el("code-opts-caret")?.addEventListener("click", (ev) => {
    const composer = (ev.currentTarget as HTMLElement).closest(".code-composer");
    const card = composer?.querySelector(".code-input-card");
    if (!card) return;
    // A MULTI-LINE draft can't be minimized (his rule, 2026-08-19): the
    // collapsed pill is a one-line shape. The caret goes inert until the
    // input is back under two lines; auto-grow re-expands regardless.
    const ta = composer?.querySelector<HTMLTextAreaElement>("#code-input");
    if (card.classList.contains("options-open") && ta && ta.clientHeight > 44) return;
    card.classList.toggle("options-open");
    card.classList.remove("auto-open");   // the user took over from auto-grow
  });
  el("code-reset-open")?.addEventListener("click", () => {
    // Destructive-ish (every open panel closes) — the standard confirm first.
    void confirmAction({
      title: "Reset the workspace?",
      body: "Every open panel closes and the agent stands alone. Sessions and their work are untouched.",
      confirmLabel: "Reset",
      danger: true,
    }).then((ok) => {
      if (ok) (window as unknown as { __wbEchoReset?: () => void }).__wbEchoReset?.();
    });
  });
  // Icon hover zoom (Appearance slider) — every icon scales by this on
  // hover. Settings applies it live; this seeds it at boot.
  void window.glyphh.getPreference?.("iconHoverZoom", 1.08).then((v) => {
    const n = Number(v);
    document.documentElement.style.setProperty("--icon-zoom", String(Number.isFinite(n) ? Math.max(1, Math.min(1.5, n)) : 1.08));
  });
  // Echo Agent panel transparency (Appearance slider) — the CSS var the
  // caret panel reads. Settings applies it live; this seeds it at boot.
  void window.glyphh.getPreference?.("echoAgentOpacity", 0.92).then((v) => {
    const n = Number(v);
    document.documentElement.style.setProperty("--echo-agent-opacity", String(Number.isFinite(n) ? Math.max(0.25, Math.min(1, n)) : 0.92));
  });
  // TEXT transparency + max panel height (independent of the panel fade).
  void window.glyphh.getPreference?.("echoAgentTextOpacity", 1).then((v) => {
    const n = Number(v);
    document.documentElement.style.setProperty("--echo-agent-text-opacity", String(Number.isFinite(n) ? Math.max(0.25, Math.min(1, n)) : 1));
  });
  void window.glyphh.getPreference?.("echoAgentMaxH", 76).then((v) => {
    const n = Number(v);
    document.documentElement.style.setProperty("--echo-agent-max-h", `${Number.isFinite(n) ? Math.max(20, Math.min(100, n)) : 76}vh`);
  });
  // ── THE LOCK (left of the drips droplet, his rule 2026-08-20): checked →
  // the agent stays up no matter what opens — the covered-tuck skips it.
  // A LAYOUT loading its own agent still wins (the layout owns the surface).
  {
    const lock = el("code-agent-lock");
    const paintLock = (on: boolean): void => {
      document.body.classList.toggle("echo-agent-locked", on);
      lock?.classList.toggle("active", on);
      if (lock) lock.title = on ? "Agent locked up — click to unlock" : "Lock the agent up (stays visible over open panels)";
    };
    void window.glyphh.getPreference?.("echoAgentLock", false).then((v) => paintLock(v === true));
    lock?.addEventListener("click", () => {
      const on = !document.body.classList.contains("echo-agent-locked");
      paintLock(on);
      void window.glyphh.setPreference?.("echoAgentLock", on);
      // The workbench recomputes the tuck + band NOW — not on the next open.
      window.dispatchEvent(new CustomEvent("glyphh:agent-lock-changed"));
    });
  }
  // ── DRAG GEOMETRY (his rule, 2026-08-20): the top row drags the whole
  // panel LEFT/RIGHT (X only, never Y); the input card's side edges drag its
  // WIDTH; a grip on the thread's top edge drags its height DOWN. All three
  // persist per user and ride CSS vars the centered-agent rules read. ──
  {
    const rootEl = document.documentElement;
    const setX = (px: number): number => {
      const lim = Math.max(0, window.innerWidth / 2 - 220);
      const v = Math.max(-lim, Math.min(lim, px));
      rootEl.style.setProperty("--echo-agent-x", `${Math.round(v)}px`);
      return v;
    };
    const setW = (px: number): number => {
      const v = Math.max(360, Math.min(1600, px));
      rootEl.style.setProperty("--echo-agent-w", `${Math.round(v)}px`);
      return v;
    };
    void window.glyphh.getPreference?.("echoAgentX", 0).then((v) => { const n = Number(v); if (Number.isFinite(n) && n) setX(n); });
    void window.glyphh.getPreference?.("echoAgentW", 920).then((v) => { const n = Number(v); if (Number.isFinite(n) && n !== 920) setW(n); });

    // X-drag on the top row's empty surface (buttons/inputs keep their clicks).
    const toprow = document.querySelector<HTMLElement>(".code-agent-toprow");
    const geometryLocked = (): boolean => document.body.classList.contains("echo-agent-locked");
    toprow?.addEventListener("pointerdown", (ev) => {
      if (ev.button !== 0 || geometryLocked()) return;
      const t = ev.target as HTMLElement;
      if (t.closest("button, input, textarea, select, a, [contenteditable]")) return;
      ev.preventDefault();
      const startX = ev.clientX;
      const base = parseFloat(getComputedStyle(rootEl).getPropertyValue("--echo-agent-x")) || 0;
      let last = base;
      const move = (mv: PointerEvent): void => {
        last = setX(base + (mv.clientX - startX));
        window.dispatchEvent(new CustomEvent("glyphh:agent-geometry"));
      };
      const up = (): void => {
        document.removeEventListener("pointermove", move);
        document.removeEventListener("pointerup", up);
        void window.glyphh.setPreference?.("echoAgentX", Math.round(last));
      };
      document.addEventListener("pointermove", move);
      document.addEventListener("pointerup", up);
    });

    // WIDTH edges on the input card. Centered geometry → symmetric resize
    // (2× the edge's travel), the panel's center staying put.
    const card = document.querySelector<HTMLElement>(".code-input-card");
    if (card) {
      for (const side of ["left", "right"] as const) {
        const edge = document.createElement("div");
        edge.className = `code-agent-edge ${side}`;
        edge.addEventListener("pointerdown", (ev) => {
          if (ev.button !== 0 || geometryLocked()) return;
          ev.preventDefault(); ev.stopPropagation();
          const startX = ev.clientX;
          const base = parseFloat(getComputedStyle(rootEl).getPropertyValue("--echo-agent-w")) || 920;
          let last = base;
          const move = (mv: PointerEvent): void => {
            const dx = mv.clientX - startX;
            last = setW(base + (side === "right" ? dx : -dx) * 2);
            window.dispatchEvent(new CustomEvent("glyphh:agent-geometry"));
          };
          const up = (): void => {
            document.removeEventListener("pointermove", move);
            document.removeEventListener("pointerup", up);
            void window.glyphh.setPreference?.("echoAgentW", Math.round(last));
          };
          document.addEventListener("pointermove", move);
          document.addEventListener("pointerup", up);
        });
        card.appendChild(edge);
      }
    }

    // HEIGHT grip riding the thread's top edge (the thread's own innerHTML is
    // wiped every repaint, so the grip lives on the AGENT and tracks the
    // thread's rect via a ResizeObserver).
    const agent = document.querySelector<HTMLElement>(".code-root > .code-agent");
    const threadEl = el<HTMLDivElement>("code-thread");
    if (agent && threadEl) {
      const grip = document.createElement("div");
      grip.className = "code-thread-grip";
      agent.appendChild(grip);
      // MINIMIZE ✕ riding the peek's top-right (his order, 2026-08-25): tucks
      // the streaming panel back down to the composer — the turn keeps
      // running; the caret (or the status line) reopens it. Lives on the
      // AGENT for the same reason the grip does: the thread repaints.
      const peekClose = document.createElement("button");
      peekClose.type = "button";
      peekClose.className = "code-peek-close";
      peekClose.title = "Minimize";
      peekClose.innerHTML = `<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><line x1="6" y1="6" x2="18" y2="18"/><line x1="18" y1="6" x2="6" y2="18"/></svg>`;
      peekClose.addEventListener("click", (ev) => { ev.stopPropagation(); closePeek(); });
      // INSIDE the panel (his fix, 2026-08-25): the ✕ lives at the thread's
      // own top-right (sticky, so it holds while the transcript scrolls). The
      // thread's innerHTML is wiped every repaint, so a MutationObserver
      // re-seats it after each render.
      const seatPeekClose = (): void => {
        if (threadEl.firstChild !== peekClose) threadEl.prepend(peekClose);
      };
      seatPeekClose();
      new MutationObserver(() => seatPeekClose()).observe(threadEl, { childList: true });
      const place = (): void => {
        const h = threadEl.getBoundingClientRect().height;
        grip.style.bottom = `calc(100% + ${Math.max(0, Math.round(h)) + 2}px)`;
      };
      new ResizeObserver(place).observe(threadEl);
      place();
      grip.addEventListener("pointerdown", (ev) => {
        if (ev.button !== 0 || geometryLocked()) return;
        ev.preventDefault(); ev.stopPropagation();
        const startY = ev.clientY;
        const baseH = threadEl.getBoundingClientRect().height;
        let lastVh = 0;
        const move = (mv: PointerEvent): void => {
          // Dragging DOWN shrinks; UP grows — capped 20..100vh.
          const px = Math.max(120, baseH - (mv.clientY - startY));
          lastVh = Math.max(20, Math.min(100, (px / window.innerHeight) * 100));
          rootEl.style.setProperty("--echo-agent-max-h", `${lastVh}vh`);
        };
        const up = (): void => {
          document.removeEventListener("pointermove", move);
          document.removeEventListener("pointerup", up);
          if (lastVh) void window.glyphh.setPreference?.("echoAgentMaxH", Math.round(lastVh));
        };
        document.addEventListener("pointermove", move);
        document.addEventListener("pointerup", up);
      });
    }
  }
  // Voice input — the mic chip + hands-free convo mode + start/stop cues.
  // (This call was lost in the cc-button removal; without it the chip is
  // wired to NOTHING — "the record button isn't turning on".)
  initVoiceMic();
  // Hands-free submits ride the ENTER path — mid-run it queues instead of
  // hitting a send button that is Stop while thinking (and whose synthetic
  // click a disabled button swallows silently).
  registerComposerSubmit(() => { if (thinking) queueMidRun(); else send(); });
  // ── Drips — the droplet on the agent's top row, RIGHT of the caret. The
  // picker opens UPWARD (.echo-drip-anchor positions it); the typed `.dip`
  // watcher lands on the same opener. ──
  {
    const dripBtn = el("code-drips-btn");
    const dripPop = el("code-drip-pop");
    if (dripBtn && dripPop) {
      const DRIP_EMOJI: Record<string, string> = {
        fireworks: "🎆", hearts: "💖", confetti: "🎉", stars: "⭐", rain: "🌧️",
        bubbles: "🫧", sparkle: "✨", spiral: "🌀", emoji: "😀", wave: "🌊",
        thumbsup: "👍", peace: "✌️", cat: "🐱", snow: "❄️",
        matrix: "🟩", aurora: "🌌", nebula: "💜", plasma: "🔮", fireflies: "🪲", starfield: "🌠",
      };
      // THE POPOVER FOLLOWS THE BUTTON THAT ASKED (his report, 2026-10-07: the
      // drip panel on a CLI card showed nothing — it unhid inside the agent
      // head's anchor, which that card does not show). Opened from another
      // button it portals to the body, fixed under that button; close puts
      // it back in its anchor.
      const dripHome = dripPop.parentElement as HTMLElement;
      const closeDripPop = (): void => {
        dripPop.classList.add("hidden");
        if (dripPop.parentElement !== dripHome) { dripPop.removeAttribute("style"); dripHome.appendChild(dripPop); }
      };
      const placeDripPop = (anchor: HTMLElement | null): void => {
        if (!anchor || dripHome.contains(anchor)) { if (dripPop.parentElement !== dripHome) { dripPop.removeAttribute("style"); dripHome.appendChild(dripPop); } return; }
        if (dripPop.parentElement !== document.body) document.body.appendChild(dripPop);
        const r = anchor.getBoundingClientRect();
        const w = 3 * 96 + 2 * 6 + 20;   // the grid's three columns, gaps and padding
        const left = Math.max(8, Math.min(window.innerWidth - w - 8, r.right - w));
        dripPop.style.cssText = `position:fixed;top:${Math.round(r.bottom + 6)}px;left:${Math.round(left)}px;right:auto;bottom:auto;z-index:1000;`;
      };
      const openDripPop = async (anchor: HTMLElement | null = null): Promise<void> => {
        type BuiltinFx = { name: string; kind: "one-shot" | "loop" };
        const yoD = (window as unknown as { glyphh?: { dripsBuiltinEffects?: () => Promise<Array<BuiltinFx | string>>; dripsList?: () => Promise<Array<{ name: string; recipe: string }>>; dripsPreview?: (recipe: string) => Promise<unknown> } }).glyphh;
        const [builtinsRaw, customsRaw] = await Promise.all([
          yoD?.dripsBuiltinEffects?.().catch(() => [] as Array<BuiltinFx | string>) ?? [],
          yoD?.dripsList?.().catch(() => [] as Array<{ name: string; recipe: string }>) ?? [],
        ]);
        const builtins: BuiltinFx[] = (builtinsRaw || []).map((b) =>
          typeof b === "string" ? { name: b, kind: "one-shot" as const } : b);
        const customs = customsRaw || [];
        dripPop.innerHTML = "";
        const tile = (name: string, recipe: string, emoji: string): void => {
          const b = document.createElement("button");
          b.type = "button";
          b.className = "echo-drip-tile";
          b.innerHTML = `<span class="edt-ic"></span><span class="edt-nm"></span>`;
          (b.querySelector(".edt-ic") as HTMLElement).textContent = emoji;
          (b.querySelector(".edt-nm") as HTMLElement).textContent = name;
          b.addEventListener("click", (e2) => { e2.stopPropagation(); void yoD?.dripsPreview?.(recipe); closeDripPop(); });
          dripPop.appendChild(b);
        };
        for (const fx of builtins) tile(fx.name, fx.name, DRIP_EMOJI[fx.name] || (fx.kind === "loop" ? "♾️" : "🎨"));
        for (const c of customs) tile(c.name, c.recipe, "💧");
        if (!dripPop.childElementCount) {
          const empty = document.createElement("div");
          empty.className = "echo-drip-empty";
          empty.textContent = "No drips yet";
          dripPop.appendChild(empty);
        }
        placeDripPop(anchor);
        dripPop.classList.remove("hidden");
      };
      dripBtn.addEventListener("click", (ev) => {
        ev.stopPropagation();
        if (!dripPop.classList.contains("hidden")) { closeDripPop(); return; }
        void openDripPop();
      });
      // THE global drips opener — the typed `.dip` watcher (help/dip-watch.ts)
      // lands here from anywhere in the app.
      (window as unknown as { __glyphhOpenDrips?: (anchor?: HTMLElement) => void }).__glyphhOpenDrips = (anchor) => { void openDripPop(anchor ?? null); };
      document.addEventListener("click", (ev) => {
        if (dripPop.classList.contains("hidden") || dripPop.contains(ev.target as Node)) return;
        // The button that opened it toggles it shut; its own handler sees a closed popover and opens nothing twice.
        const onOpener = !!(ev.target as HTMLElement | null)?.closest?.('#code-drips-btn, .ws-terminal-tabs [title="Drips"]');
        closeDripPop();
        if (onOpener) { ev.stopPropagation(); ev.preventDefault(); }
      }, true);
      document.addEventListener("keydown", (ev) => {
        if (ev.key === "Escape" && !dripPop.classList.contains("hidden")) closeDripPop();
      });
    }
  }
    // Session head (SessionHeader port): ‹/name → the space's list view; the
  // kebab → Rename / Pin / Delete.
  // BACK = out to the MAIN landing (there was no way back to it from inside
  // a session). The session survives in history — the head's history
  // dropdown resumes it; the list view stays reachable from there.
  // ‹ ALWAYS opens THIS agent's session list (scoped to its type by
  // renderHistory) — never the global landing.
  // ‹ — back to this tab's + New Session screen. (It used to open the session
  // LIST, which is reachable from the rail's recents.)
  // ‹ = the terminal hop, nothing else (his order, 2026-09-11: it closed
  // the whole agent). Same handler the >_ icon rides.
  // Session controls in the agent head (the coding panel's own header row is
  // hidden): + starts a new session, the clock drops the history list.
  type HeadSessionsApi = { list(): Array<{ id: string; title: string }>; currentId(): string | null; switch(id: string): void; startNew(): void };
  const sessApi = (): HeadSessionsApi | undefined => (window as unknown as { __agentSessions?: HeadSessionsApi }).__agentSessions;
  el("code-session-new")?.addEventListener("click", newSessionInPlace);

  // ── THE ONE ⋮ MENU (his report, 2026-10-05: a new agent on a Work session
  // showed two ⋮ on its top row, one of them dead). The top-right ⋮
  // (#code-tools-more, relocated into the head below) is THE menu, on the
  // web and the desktop: the session's panels (by type — Work carries no
  // Files/Terminal/Editor/Diff), the open session's actions (the old kebab's
  // Rename / Pin / New agent panel / Delete), and on the web the attached
  // desktop's Apps and the Agents / CLIs. help/agent-menu.ts is the model,
  // help/agent-menu-ui.ts the paint; never an empty dropdown.
  {
    const moreBtn = el("code-tools-more");
    const menu = el("code-tools-menu");
    // × — an agent PANEL (a solo shell in the desktop's webview) closes its own
    // card; the card's head is hidden, so this is the only way out of one.
    const g = window.glyphh as unknown as { agentPanelClose?: () => Promise<boolean> };
    const inPanel = (new URLSearchParams(window.location.search).get("solo") || "").startsWith("tool:");
    if (moreBtn && inPanel && g.agentPanelClose && !el("code-panel-close")) {
      const close = document.createElement("button");
      close.id = "code-panel-close";
      close.type = "button";
      close.className = "code-icon-btn";
      close.title = "Close panel";
      close.innerHTML = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="6" y1="6" x2="18" y2="18"/><line x1="18" y1="6" x2="6" y2="18"/></svg>`;
      close.addEventListener("click", (ev) => { ev.stopPropagation(); void g.agentPanelClose?.(); });
      (moreBtn.closest(".code-view-more-wrap") ?? moreBtn).after(close);
    }
    if (moreBtn && menu) {
      mountAgentMenu(menu, moreBtn, {
        session: () => { const c = current(); return c ? { pinned: !!c.pinned } : null; },
        onSession: (action) => {
          const c = current();
          if (!c) return;
          if (action === "rename") renameCurrentInline();
          else if (action === "pin") togglePin(c);
          else if (action === "new-panel") (window as unknown as { __wbOpenAgentInstance?: (loop?: string) => void }).__wbOpenAgentInstance?.(GLYPHH_LOOP);
          else if (action === "delete") void deleteChat(c);
        },
      });
      document.addEventListener("pointerdown", (ev) => {
        if (!menu.classList.contains("hidden") && !(ev.target as HTMLElement).closest("#code-tools-wrap")) menu.classList.add("hidden");
      }, true);
    }
  }

  // ── Layout header: name (inline rename) LEFT, controls RIGHT ──────────────
  // In a layout the agent panel shows .code-agent-head (name + kebab). His
  // rule (2026-08-21): the session-controls row (recents/+new/⋯) RELOCATES
  // into that header's right side, and the NAME becomes click-to-rename.
  {
    // Clicking the session name renames it inline (stopPropagation so the
    // surrounding back-button nav doesn't fire).
    const title = el("code-session-title");
    if (title) {
      title.addEventListener("click", (ev) => {
        ev.stopPropagation();
        // A fresh landing has no session row yet — naming one IS starting it.
        if (!current()) { newChat(); renderThread(); }
        renameCurrentInline();
      });
      title.setAttribute("title", "Click to rename this session");
      title.style.cursor = "text";
    }

    // Relocate the controls between the composer's source slot (home) and the
    // head's right actions, driven by body.echo-agent-in-layout.
    const controls = el("code-session-controls");
    const home = el("code-source-slot");            // where they live in the composer
    const headActions = document.querySelector<HTMLElement>(".session-head-actions");
    // UNCONDITIONAL (his spec, 2026-09-11): the cluster lives in the HEAD,
    // never the input box — the terminal and chat headers stay identical.
    if (controls && headActions && controls.parentElement !== headActions) {
      const toggle = document.getElementById("code-term-toggle");
      if (toggle && toggle.parentElement === headActions) headActions.insertBefore(controls, toggle.nextSibling);
      else headActions.insertBefore(controls, headActions.firstChild);
    }
    void home;
  }
  // THE AGENT'S ROW IS ITS CARD'S HEAD (his order, 2026-10-09: "remove the
  // headers off all work panels"): pressing the row drags the card. The
  // agent carries NO expand and NO close (his order the same day). A panel
  // (its own document) asks the shell through main; the in-document agent
  // calls the workbench directly.
  {
    const solo = (new URLSearchParams(window.location.search).get("solo") || "") === "tool:coding";
    const g = window.glyphh as unknown as {
      agentPanelDrag?: (p: { phase: "down" | "move" | "up"; cx: number; cy: number; sx: number; sy: number }) => void;
    };
    // THE WINDOW CONTROLS (his report, 2026-10-09): a panel at the top left
    // under a collapsed rail clears the traffic lights and the rail icon by
    // the width the shell measured.
    (window.glyphh as unknown as { onAgentPanelClearStrip?: (cb: (p: { px: number }) => void) => void })
      .onAgentPanelClearStrip?.((p) => {
        const px = Math.max(0, Math.round(Number(p?.px) || 0));
        document.documentElement.style.setProperty("--panel-strip-clear", `${px}px`);
        document.querySelector(".code-agent-head")?.classList.toggle("panel-clears-strip", px > 0);
      });
    const row = document.querySelector<HTMLElement>(".code-agent-head");
    row?.addEventListener("mousedown", (ev) => {
      if (ev.button !== 0) return;
      if ((ev.target as HTMLElement).closest("button, input, textarea, select, a, .code-menu, .code-drop")) return;
      if (!solo) { (window as unknown as { __wbAgentHeadDrag?: (x: number, y: number) => void }).__wbAgentHeadDrag?.(ev.clientX, ev.clientY); return; }
      if (!g.agentPanelDrag) return;
      g.agentPanelDrag({ phase: "down", cx: ev.clientX, cy: ev.clientY, sx: ev.screenX, sy: ev.screenY });
      let queued: MouseEvent | null = null;
      const move = (mv: MouseEvent): void => {
        if (!queued) requestAnimationFrame(() => { const q = queued; queued = null; if (q) g.agentPanelDrag!({ phase: "move", cx: q.clientX, cy: q.clientY, sx: q.screenX, sy: q.screenY }); });
        queued = mv;
      };
      const up = (u: MouseEvent): void => {
        document.removeEventListener("mousemove", move, true);
        document.removeEventListener("mouseup", up, true);
        g.agentPanelDrag!({ phase: "up", cx: u.clientX, cy: u.clientY, sx: u.screenX, sy: u.screenY });
      };
      document.addEventListener("mousemove", move, true);
      document.addEventListener("mouseup", up, true);
    });
  }
  // ONE COMBINED HISTORY (his order, 2026-09-14: "make them all one
  // thing") — the head's clock opens the SAME dropdown the rail and the
  // terminal head show, refreshed from the CLI stores; a pick adopts into
  // the one chat surface on the session's own CLI (sessOpen).
  el("code-session-history")?.addEventListener("click", (ev) => {
    ev.stopPropagation();
    const anchor = ev.currentTarget as HTMLElement;
    document.querySelector(".wb-session-menu")?.remove();
    void loadRailSessions().then(() => {
      openSessionsDropdown(anchor, { onPick: (sess) => sessOpen(sess) });
    });
  });
  startNavBadges();
  wireComposerAttachments();
  initGlyphhAgentEvents();
  initWorkdirGate();
  initComposerControls();
  void (async () => {
    const raw = String((await window.glyphh.getPreference?.("glyphhMode", "ask")) || "ask");
    const m = raw === "bypass" ? "auto" : raw;  // retired mode, stored on old builds
    // The stored preference is the DEVICE DEFAULT (seeds new sessions); the chip
    // then reflects whichever session is on screen (currentMode via paintChips).
    if (MODES.some((x) => x.id === m)) { defaultMode = m as typeof glyphhMode; glyphhMode = defaultMode; }
    void loadDefaultModelPref();
    paintChips();
    // The model chip renders from the stored pick — the early refresh at menu
    // creation ran before that preference loaded, so without this the chip
    // shows the fallback until the menu is first opened.
    await refreshModelList();
    // Cold start can race auth: an empty catalog gets one quiet retry.
    if (!availModels.length) setTimeout(() => void refreshModelList(), 2500);
  })();
  const ta = input();
  ta?.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      // While the recorder listens, Enter is not a send: ✓ / ✕ / Stop are the doors.
      if (composerListening({ text: ta.value, running: thinking, voice: voiceState() })) return;
      // Mid-run, Enter QUEUES the message as a VISIBLE note (his report,
      // 2026-08-28: the interrupt regressed). Injecting it silently into the
      // live run left nothing on screen — no × to take it back, no way to
      // make the agent read it now. The note card owns both: × drops it, and
      // Interrupt stops the run so it is read and the agent continues.
      if (thinking) queueMidRun();
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
    // BOOT RESTORES THE SESSION THAT WAS IN THE AGENT (his rule, 2026-08-19):
    // the hydrated currentId — or its persisted twin when the store forgot —
    // comes back into the permanent composer (thread, meter, source), with no
    // navigation and no focus steal. Only a session WITH TURNS is worth
    // surfacing: restoring an empty one painted a blank thread strip with no
    // landing behind it (his screenshot, 2026-08-19) — an empty session and no
    // session are the SAME fresh-landing boot.
    if (!current()) {
      const lco = String((await window.glyphh.getPreference?.(LAST_SESSION_PREF, "")) || "");
      if (lco && chats.some((c) => c.id === lco)) currentId = lco;
    }
    const c = current();
    if (c && c.messages.length > 0) {
      lastSession = c.id;
      renderThread();
      repaintSourceUi();
      void checkWorkdirGate();
    } else {
      // No session (or an empty one) restored → the panel holds the SAME
      // new-session welcome the + button paints; opening it at boot must
      // never show a bare strip.
      currentId = "";
      renderThread();
    }
    renderHistory();
  })();
  // A folder change while a session is current binds THAT session to it —
  // its runs keep working there even after another layout moves the global.
  // With NO session (the new-session landing), the pick used to be DROPPED —
  // newChat() then seeded the workdir from the stale persisted source path,
  // so the user's chosen folder "reverted" at send. Hold it in pendingWorkdir
  // (which newChat applies FIRST, beating any source path) and keep the
  // pending source's path in agreement so the chip tells the truth.
  (window as unknown as { wb?: { onCwdChanged?: (cb: (dir: string | null) => void) => void } }).wb?.onCwdChanged?.((dir) => {
    const c = current();
    if (!dir) return;
    // A programmatic re-root (workspace open, thread open) is NOT a pick —
    // stamping it here is what let a workspace's folder overwrite every
    // thread's own folder.
    if (Date.now() < cwdStampSuppressedUntil) return;
    // A PICK IS KEPT: it is the thread's folder from now on (setThreadFolder
    // writes both fields the chip and the run read).
    if (c && threadFolder(c) === dir) return;
    setThreadFolder(dir);
  });
  // Another window (the ghost overlay) saved the shared store — adopt its
  // list so a ghost-created session appears in the history dropdown immediately. The
  // CURRENT chat keeps its local object: it may be mid-stream, and the disk
  // copy of it is never newer than this window's memory.
  /** Take the shared store as it is on disk (another writer — the glyphh
   *  terminal — landed turns). Exposed so the hop back from a terminal can
   *  refresh BEFORE it opens the chat the terminal was on. */
  const reloadSessionsFromDisk = async (): Promise<void> => {
      try {
        const s = await window.glyphh.glyphhSessionsLoad?.();
        const disk = ((s?.chats as CodeChat[]) || []);
        if (!disk.length || !storeLoaded) return;
        const cur = current();
        // The CURRENT chat follows the disk too when another host (the glyphh
        // terminal) wrote newer turns into it and nothing is running here.
        chats = disk.map((d) => {
          if (!cur || d.id !== cur.id) return d;
          const newer = ((d as { updatedAt?: number }).updatedAt ?? 0) > ((cur as { updatedAt?: number }).updatedAt ?? 0)
            && d.messages.length > cur.messages.length && !liveRuns.has(cur.id);
          return newer ? d : cur;
        });
        if (cur && !chats.some((c) => c.id === cur.id)) chats.unshift(cur);
        renderHistory();
        if (cur && current() !== cur) renderThread();
      } catch { /* stale repaint only — next save syncs */ }
  };
  (window as unknown as { __glyphhReloadSessions?: () => Promise<void> }).__glyphhReloadSessions = reloadSessionsFromDisk;
  (window.glyphh as unknown as { onGlyphhSessionsUpdated?: (cb: (info: { deleted: string[] }) => void) => void }).onGlyphhSessionsUpdated?.((info) => {
    // Deleted in another document first: the disk reload keeps the session on
    // screen by design (it may be mid-stream), so a delete has to be said.
    if (info.deleted.length) dropSessions(info.deleted, false);
    void reloadSessionsFromDisk();
    // The RAIL follows the same announcement (his report, 2026-09-29): the
    // shell's recents and the panel's dropdown are one list, so a write in
    // either document repaints both. Debounced like every other history
    // change: a panel saves many times a turn, and each save lands here.
    scheduleRailSessionsRefresh();
  });
  // THE LIVE LEDGER (main's agent-live.ts): which sessions are running
  // anywhere in the app — the rail's rows pulse by it.
  const liveApi = window.glyphh as unknown as { glyphhLiveList?: () => Promise<LiveAgentRun[]>; onGlyphhLive?: (cb: (runs: LiveAgentRun[]) => void) => void };
  // Every ledger push is a chance to pick up a turn whose holder is gone: the
  // panel that started it closed on a workspace jump, and this document now
  // shows the thread. Orphans only — a sibling that is live keeps its run.
  const takeLive = (runs: LiveAgentRun[]): void => {
    liveElsewhere = Array.isArray(runs) ? runs : [];
    renderRailSessions();
    const c = current();
    if (c && !liveRuns.has(c.id)) adoptRunIfElsewhere(c, { orphanOnly: true });
  };
  void liveApi.glyphhLiveList?.().then(takeLive).catch(() => {});
  liveApi.onGlyphhLive?.(takeLive);
  // A turn typed in a CLI itself lands in its own store: the recents follow.
  window.glyphh.onCliSessionsChanged?.(() => scheduleRailSessionsRefresh());
  // A loop turned on or off in Settings: the chips, the filter and the recents follow.
  window.glyphh.onCliAgentsChanged?.(() => { void refreshLoops(); scheduleRailSessionsRefresh(); });
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
// The workbench bundle (a separate esbuild output) reaches this through the
// window hook below — the Tasks page's prompt cards seed the composer with it.
export function seedNewSession(text: string): void {
  // No record until the user actually SENDS — the seed just fills the
  // composer on a cleared selection.
  currentId = "";
  void saveStore();
  renderHistory();
  renderThread();
  seedComposer(text);
  void checkWorkdirGate();
}
(window as unknown as { __glyphhSeedSession?: (text: string) => void }).__glyphhSeedSession = seedNewSession;

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
  // The chip's static/live state keys off composer-on-home (paintSourceDependents)
  // — recompute it for the surface the composer just landed on, so an adoption
  // into a layout card never carries a stale lock (or a stale unlock) with it.
  repaintSourceUi();
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
  // Seeding the composer LEAVES settings ("+ New with AI", "Edit with AI",
  // prompt starters) — drop the modal (no-op when absent) so the composer
  // isn't hidden behind it.
  closeSettingsModal();
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
