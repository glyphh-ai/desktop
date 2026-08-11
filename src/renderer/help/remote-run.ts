/**
 * remote-run.ts — the renderer's TURN TRANSPORT, routing by the runtime/stator
 * split (server/docs/runtime-stator-split.md): the STATOR is one regional memory
 * plane; the RUNTIME is chosen per session.
 *
 *   LOCAL (machine) session → the attach RELAY (`attach.run`) → the user's own
 *     rrotor — tools on their real folder, memory via /api/stator/*.
 *   everything else → THE SINGLE FRONT DOOR (`harnessViaApi()` → /api/harness/*)
 *     → the org's regional cloud runtime. No pod URL, no per-session
 *     provisioning — the server region-routes and the pod introspects the
 *     user's own bearer (docs/turn-proxy.md).
 *
 * Both paths stream the same HarnessWireFrames onto the same callbacks, so the
 * UI renders identically wherever the turn ran. `threadId` = the CLIENT's chat
 * id — it scopes the pod-side transcript AND the stator memory session.
 *
 * Failure is a TYPED RESULT, not an exception: code.ts renders the designed
 * "runtime not connected" state — never a fake reply.
 *
 * The renderer cannot import from @glyphh/sdk (preload boundary), so the SDK
 * handle's shapes are mirrored here (same discipline as code-source-chip.ts /
 * library-types.ts). They cross window.glyphhSdk verbatim from the SDK.
 */

import type { Source } from "./code-source-chip.js";

// ── SDK handle mirrors (window.glyphhSdk = the raw @glyphh/sdk client) ─────────

/** A harness frame as it rides `glyphh.harness/v1` (SDK contract/harness.ts —
 *  itself the desktop's glyphh-agent frame vocabulary, enveloped). */
type HarnessWireFrame = (
  | { type: "prompt"; text: string }
  | { type: "delta"; delta: string }
  | { type: "tool"; phase: "start" | "done"; name: string; thought?: string; title?: string; denied?: boolean; failed?: boolean; preview?: string }
  | { type: "progress"; inTokens: number; outTokens: number }
  | { type: "credits"; creditsMicro: number }
  | { type: "approval"; id: string; kind: string; title: string; detail: string }
  | { type: "ask"; id: string; questions: Array<{ question: string; options?: string[] }> }
  | { type: "setup"; phase: string }
  | { type: "permission"; permission: RemotePermission }
  | { type: "done"; stopped: boolean }
  | { type: "error"; error: string }
) & { seq: number; runId: string; at: number };

interface HarnessRunHandle {
  readonly whenStarted: Promise<{ runId: string; sessionId: string; wire: string }>;
  /** Terminal result — an `error` FRAME resolves (with `error` set); only a
   *  transport-level failure (unreachable pod, wire mismatch) rejects. */
  readonly done: Promise<{ runId: string; stopped: boolean; text: string; error?: string }>;
  on(fn: (frame: HarnessWireFrame) => void): () => void;
  answer(id: string, reply: { allow?: boolean; answers?: string[] }): Promise<void>;
  stop(): Promise<void>;
  /** Change THIS in-flight run's permission mode — the executor re-reads it on the
   *  next tool decision (added with the mid-run mode-change fix). */
  setPermission(mode: RemotePermission): Promise<void>;
}

/** The pod's permission modes — verbatim from the desktop (MODES in code.ts,
 *  enforced by glyphh-agent-permissions.ts locally / rrotor harness/gate.ts in
 *  the pod). Sent per RUN: the pod's own default is `auto`, so a session left
 *  in Ask mode would silently run unattended if we didn't say so. */
export type RemotePermission = "ask" | "plan" | "acceptEdits" | "auto" | "bypass";

/** The LOOP's memory policy for a turn (mirrors the SDK's HarnessMemoryPolicy):
 *  whether the turn rotates around the stator and how. Absent = runtime default. */
export interface RemoteMemoryPolicy { recall?: boolean; write?: boolean; topK?: number; threshold?: number; entity?: string }

interface HarnessPod {
  start(opts: {
    prompt: string;
    threadId?: string;
    mode?: "chat" | "cowork" | "code";
    model?: string;
    permission?: RemotePermission;
    signal?: AbortSignal;
  }): HarnessRunHandle;
}

interface SdkHandle {
  /** THE SINGLE FRONT DOOR: a harness bound to the control-plane turn proxy
   *  (`/api/harness`), auth'd by the user's session token. Region-routes to the
   *  org's regional rrotor + stator — no pod url, no provisioning. */
  harnessViaApi?: () => HarnessPod;
}

const sdk = (): SdkHandle | undefined =>
  (window as unknown as { glyphhSdk?: SdkHandle }).glyphhSdk;

// ── The chat's runtime binding — mirrors code.ts's CodeChat (kept structural so
//    remote-run doesn't reach back into code.ts's interfaces). ────────────────
export interface RuntimeBinding { sessionId: string; url: string; token: string }
export interface RemoteChat {
  id: string;
  source?: Source;
  /** The session's SPACE + toolbelt (code.ts modeOf) — rides every run. */
  mode?: "chat" | "cowork" | "code";
  /** LEGACY pre-mode flag (code.ts) — folded in by modeFor, never written. */
  chat?: boolean;
  /** Bound after a successful provision — reused for every later turn. */
  runtime?: RuntimeBinding;
  [k: string]: unknown;
}

/** How long the runtime waits before deciding FOR the user. Mirrored from the
 *  pod (rrotor `harness/gate.ts`) — and identical to the desktop's local gate
 *  (`glyphh-agent-permissions.ts`), so the dock's countdown is honest on BOTH
 *  paths and there is one set of numbers in the UI. */
export const APPROVAL_TIMEOUT_MS = 120_000;
export const ASK_TIMEOUT_MS = 10 * 60_000;

// ── The answer seam ───────────────────────────────────────────────────────────
//
// A parked `approval`/`ask` frame is answered on the RUN HANDLE that streamed it
// (`run.answer(id, …)` → POST /runs/:id/answer). The handle is owned by
// runRemoteTurnOnce and must not leak into the UI, so a parked frame registers
// its id here and the renderer answers BY ID — exactly the shape the desktop's
// local path has (`window.glyphh.glyphhApprovalRespond(id, allow)` → main's
// pending map). code.ts therefore routes both paths through one call: try this
// registry, and an id it doesn't know is a LOCAL card and goes over IPC.
//
// Entries are dropped the moment they're answered and swept when their run
// settles, so a stopped/finished run leaves nothing behind.

interface PendingAnswer { run: HarnessRunHandle; kind: "approval" | "ask"; deadline: number }
const pending = new Map<string, PendingAnswer>();

/** What answering did: `sent` reached the pod, `late` means the pod had already
 *  resolved it on its own (its timeout fired first — a 404 we swallow), and
 *  `unknown` means this id was never a REMOTE card (the caller should try the
 *  local IPC path). Never throws — a dead pod must not break a click. */
export type AnswerRouting = "sent" | "late" | "unknown";

/** The wall-clock instant the runtime decides on its own, for a parked id. */
export function pendingDeadline(id: string): number | undefined {
  return pending.get(id)?.deadline;
}

/** Answer a parked REMOTE approval (`{allow}`) or ask (`{answers}`). */
export async function answerPending(
  id: string,
  reply: { allow?: boolean; answers?: string[] },
): Promise<AnswerRouting> {
  const entry = pending.get(id);
  if (!entry) return "unknown";
  // Drop it FIRST: a double-click must not post twice, and a failed post means
  // the pod already moved on — there is nothing left to answer either way.
  pending.delete(id);
  try {
    await entry.run.answer(id, reply);
    return "sent";
  } catch (err) {
    try { console.warn("[remote-run] answer landed too late", { id, detail: err instanceof Error ? err.message : String(err) }); } catch { /* no console */ }
    return "late";
  }
}

/** Forget every id parked on a run that has settled (done/stopped/failed). */
function forgetPending(run: HarnessRunHandle): void {
  for (const [id, entry] of pending) if (entry.run === run) pending.delete(id);
}

// ── Live remote-run handles, by threadId (chat id) — the mid-run mode push seam.
// A turn started here holds its handle so a mode-chip flip mid-turn can reach the
// executor (cloud pod or the attached desktop) via handle.setPermission → the
// server's /permission route. Cleared when the run settles.
const liveRemote = new Map<string, HarnessRunHandle>();

/** Change a live remote run's permission mode mid-flight. No live run for the
 *  chat → a harmless no-op (returns false). Never throws. */
export async function setRemotePermission(chatId: string, mode: RemotePermission): Promise<boolean> {
  const run = liveRemote.get(chatId);
  if (!run?.setPermission) return false;
  try { await run.setPermission(mode); return true; }
  catch { return false; }
}

/** A session's source is remote iff it runs in the cloud (cloud-new/cloud-repo). */
export function isRemoteSource(source?: Source): boolean {
  return !!source && source.kind !== "local";
}

/** A remote turn is only routed here on WEB, where the SDK handle is exposed and
 *  the local harness (window.glyphh.glyphhRun → main) does not exist. */
export function canRunRemote(source?: Source): boolean {
  return isRemoteSource(source) && !!sdk()?.harnessViaApi;
}

/** The honest typed failure — never thrown to the UI, always rendered as the
 *  designed "runtime not connected" state. */
export interface Unavailable { ok: false; unavailable: true; stage: string; detail: string; sessionId?: string }
function unavailable(stage: string, err: unknown): Unavailable {
  const detail = err instanceof Error ? err.message : String(err);
  try { console.warn("[remote-run] unavailable", { stage, detail }); } catch { /* no console */ }
  return { ok: false, unavailable: true, stage, detail };
}

/**
 * Ensure the chat has a live runtime binding, provisioning one if needed and
 * persisting it via `save`. Reuses an existing binding (later turns don't
 * re-provision). On an unavailable provision that still minted a session id, the
 * id is bound onto the chat (the session exists server-side — never orphan it).
 * Returns the binding or a typed unavailable result.
 */
export async function ensureRuntime(
  chat: RemoteChat,
  save: () => void,
  _opts: { rotor?: unknown; signal?: AbortSignal; forceFresh?: boolean } = {},
): Promise<{ ok: true; runtime: RuntimeBinding } | Unavailable | { ok: false; stopped: true }> {
  // SINGLE FRONT DOOR: nothing to provision — a turn goes straight through
  // `harnessViaApi()`, region-routed server-side. Hand back a synthetic binding
  // so the UI reads "connected" (isCommitted) instantly. The per-session
  // provision-and-poll path was deleted with the cutover (no-dead-code).
  if (sdk()?.harnessViaApi) {
    const runtime: RuntimeBinding = { sessionId: chat.id, url: "api", token: "api" };
    chat.runtime = runtime; save();
    return { ok: true, runtime };
  }
  return unavailable("open", new Error("this build cannot run turns (SDK harnessViaApi missing)"));
}

/** The session's effective mode for the pod (mirror of code.ts modeOf: the
 *  legacy chat flag folds in; default code). */
function modeFor(chat: RemoteChat): "chat" | "cowork" | "code" {
  return chat.mode ?? (chat.chat ? "chat" : "code");
}

/** The stream callbacks — mirror code.ts's CURRENT (glyphhRun) run event model so
 *  the thread renders identically whether a turn is local or remote:
 *    onStep   ≈ onGlyphhAgentTool  (a step/tool breadcrumb)
 *    onToken  ≈ onGlyphhAgentDelta (a streamed answer delta — appended)
 *    onDone   ≈ onGlyphhAgentDone
 *    onError  ≈ onGlyphhAgentError
 *    onStopped is onDone with stopped=true (the user aborted). */
export interface RemoteRunCallbacks {
  onStep?: (step: { id: string; type: string; status: string; error?: string }) => void;
  /** Richer per-tool breadcrumb than onStep — fires on BOTH start and finish and
   *  carries the tool's thought, human title, and diff badge. Additive: desktop
   *  keeps using onStep unchanged; the mobile UI uses this to render a collapsible
   *  tool group with proper ✓/✕ rows and [+N -M] badges. Correlate start→done by
   *  name (the most recent still-running step of that name). */
  onTool?: (t: {
    name: string;
    phase: "start" | "done";
    status: "running" | "ok" | "denied" | "failed";
    thought?: string;
    title?: string;
    diff?: string;     // "[+N -M]"
    error?: string;
  }) => void;
  /** Live usage for the turn — credits (micro) as the runtime meters them, and
   *  token progress. Additive; desktop ignores it. Mobile shows a per-turn
   *  credits + duration footer. */
  onUsage?: (u: { creditsMicro?: number; inTokens?: number; outTokens?: number }) => void;
  onToken?: (delta: string) => void;
  onAnswer?: (fullText: string) => void;
  /** The turn's USER prompt — the run's first frame. Only surfaces OBSERVING a run
   *  started elsewhere render this (the initiating surface already has its own bubble,
   *  so it omits this callback). */
  onUserPrompt?: (text: string) => void;
  onDone?: (fullText: string) => void;
  onStopped?: () => void;
  onError?: (detail: string) => void;
  /** A tool wants permission — the run is PARKED until `answerPending(id,
   *  {allow})` (or the runtime's own deadline). Same payload the desktop's
   *  `glyphh-agent:approval` IPC carries, plus the deadline. */
  onApproval?: (a: RemoteApprovalRequest) => void;
  /** The agent is asking the user — parked until `answerPending(id, {answers})`
   *  (or the deadline). Mirrors `glyphh-agent:ask`. */
  onAsk?: (a: RemoteAskRequest) => void;
  /** The run's permission mode changed mid-flight (another surface flipped it) —
   *  the surface repaints its mode chip. Rides the frame stream so observers stay
   *  in lockstep with the surface that made the change. */
  onPermission?: (mode: RemotePermission) => void;
}

export interface RemoteApprovalRequest { id: string; kind: string; title: string; detail: string; deadline: number }
export interface RemoteAskRequest { id: string; questions: Array<{ question: string; options?: string[] }>; deadline: number }

export type RemoteRunOutcome =
  | { ok: true; text: string; runtime: RuntimeBinding; error?: string }
  | { ok: false; stopped: true; runtime?: RuntimeBinding }
  | { ok: false; error: string; runtime?: RuntimeBinding }
  | Unavailable;

/** Map one harness frame onto the UI callbacks. `delta` appends; `tool` leaves a
 *  breadcrumb on start (and on a denied/failed finish); `approval`/`ask` PARK the
 *  run — the id is registered on the answer seam and handed to the UI, which
 *  answers it through `answerPending`. A caller with no approval UI (no
 *  onApproval/onAsk) still gets an honest breadcrumb and rides the POD's timeout
 *  (approval → denied after ~2min; ask → answered empty after ~10min, the agent
 *  re-plans). progress/credits/setup: no UI mapping. */
function dispatchFrame(
  frame: HarnessWireFrame,
  cb: RemoteRunCallbacks,
  state: { text: string; error: string | null },
  run: HarnessRunHandle,
): void {
  switch (frame.type) {
    case "prompt":
      cb.onUserPrompt?.(frame.text);
      return;
    case "delta":
      state.text += frame.delta;
      cb.onToken?.(frame.delta);
      cb.onAnswer?.(state.text);
      return;
    case "tool":
      if (frame.phase === "start") {
        cb.onStep?.({ id: `${frame.name}#${frame.seq}`, type: frame.name, status: "" });
        cb.onTool?.({ name: frame.name, phase: "start", status: "running", ...(frame.thought ? { thought: frame.thought } : {}) });
      } else {
        if (frame.denied || frame.failed) {
          cb.onStep?.({ id: `${frame.name}#${frame.seq}`, type: frame.name, status: frame.denied ? "denied" : "failed", ...(frame.title ? { error: frame.title } : {}) });
        }
        const diff = /\[\+\d+ -\d+\]/.exec(String(frame.preview ?? ""))?.[0] ?? "";
        cb.onTool?.({
          name: frame.name,
          phase: "done",
          status: frame.denied ? "denied" : frame.failed ? "failed" : "ok",
          ...(frame.title ? { title: frame.title } : {}),
          ...(diff ? { diff } : {}),
          ...((frame.denied || frame.failed) && frame.preview ? { error: String(frame.preview).split("\n")[0].slice(0, 140) } : {}),
        });
      }
      return;
    case "approval": {
      if (!cb.onApproval) {
        cb.onStep?.({
          id: frame.id,
          type: "approval",
          status: `${frame.title} — nothing here can answer; auto-denied by the runtime if unanswered`,
        });
        return;
      }
      // The deadline is measured from RECEIPT, not the frame's pod-side `at`:
      // the two clocks are unrelated, and overshooting by the network hop is
      // the safe direction for a countdown the user acts on.
      const deadline = Date.now() + APPROVAL_TIMEOUT_MS;
      pending.set(frame.id, { run, kind: "approval", deadline });
      cb.onApproval({ id: frame.id, kind: frame.kind, title: frame.title, detail: frame.detail, deadline });
      return;
    }
    case "ask": {
      if (!cb.onAsk) {
        cb.onStep?.({
          id: frame.id,
          type: "question",
          status: `${frame.questions.map((q) => q.question).join(" · ")} — nothing here can answer; the agent continues without one after the runtime's timeout`,
        });
        return;
      }
      const deadline = Date.now() + ASK_TIMEOUT_MS;
      pending.set(frame.id, { run, kind: "ask", deadline });
      cb.onAsk({ id: frame.id, questions: frame.questions, deadline });
      return;
    }
    case "permission":
      cb.onPermission?.(frame.permission);
      return;
    case "error":
      state.error = frame.error || "the runtime reported an error";
      return;
    case "credits":
      cb.onUsage?.({ creditsMicro: frame.creditsMicro });
      return;
    case "progress":
      cb.onUsage?.({ inTokens: frame.inTokens, outTokens: frame.outTokens });
      return;
    default:
      // setup / done — no UI mapping (done resolves run.done).
      return;
  }
}

/**
 * Run ONE remote turn end to end. Provisions/reuses the runtime, opens the
 * harness data plane, streams the frames through the callbacks, and resolves a
 * typed outcome. Never throws to the caller — every failure is a typed result
 * the UI can render as the honest not-connected / turn-error state.
 */
/** The synthetic runtime binding a relay (on-machine) run carries — it has no
 *  cloud pod, but a non-empty binding keeps `isCommitted` true so the session
 *  doesn't try to provision a cloud pod on open. */
const RELAY_RUNTIME = (chat: RemoteChat): RuntimeBinding => ({ sessionId: chat.id, url: "relay", token: "relay" });



/**
 * THE ONE PATH. Run a turn through the SDK's single `run()` entry, which routes on
 * where execution belongs: a LOCAL (machine-bound) session runs on the user's OWN
 * machine over the relay (`target: 'desktop'` — tools touch its real folder); every
 * other session runs on the cloud runtime through the region-routed front door
 * (`target: 'cloud'`). BOTH reach the SAME regional stator for memory and stream the
 * SAME frames — so the UI is identical and there is exactly one code path here.
 * (docs/runtime-stator-split.md: the cloud pod rejects a caller workdir by design,
 * so a local session must carry `target: 'desktop'`.)
 */
export async function runRemoteTurn(
  chat: RemoteChat,
  prompt: string,
  save: () => void,
  callbacks: RemoteRunCallbacks = {},
  opts: { rotor?: unknown; model?: string; permission?: RemotePermission; signal?: AbortSignal; images?: Array<{ mediaType: string; data: string }>; memory?: RemoteMemoryPolicy } = {},
): Promise<RemoteRunOutcome> {
  void save; // callers keep it in the signature; nothing binds a pod per session now
  const client = sdk() as unknown as { run?: (o: unknown) => HarnessRunHandle };
  if (!client?.run) {
    const u = unavailable("open", new Error("this build cannot run turns (SDK run missing)"));
    callbacks.onError?.(u.detail);
    return u;
  }

  const isLocal = chat.source?.kind === "local";
  // Runtime binding for the UI's isCommitted state: the relay marker for an
  // on-machine run, a synthetic api binding for the front door (no pod url to hold).
  chat.runtime = isLocal ? RELAY_RUNTIME(chat) : { sessionId: chat.id, url: "api", token: "api" };
  const workdir = chat.source?.kind === "local" ? chat.source.path : undefined;

  let run: HarnessRunHandle;
  try {
    run = client.run({
      target: isLocal ? "desktop" : "cloud", // the one decision: your machine, or the cloud
      prompt,
      threadId: chat.id, // stable chat id → transcript + memory scope
      mode: modeFor(chat),
      ...(workdir ? { workdir } : {}),
      ...(opts.model ? { model: opts.model } : {}),
      ...(opts.permission ? { permission: opts.permission } : {}),
      ...(opts.images && opts.images.length ? { images: opts.images } : {}),
      ...(opts.memory ? { memory: opts.memory } : {}),
      ...(opts.signal ? { signal: opts.signal } : {}),
    });
  } catch (err) { const u = unavailable("open", err); callbacks.onError?.(u.detail); return u; }

  // Hold the handle so a mid-turn mode-chip flip can push to this run (the
  // executor re-reads it per tool decision). Keyed by the chat/thread id.
  liveRemote.set(chat.id, run);
  const state = { text: "", error: null as string | null };
  const off = run.on((frame) => { if (opts.signal?.aborted) return; dispatchFrame(frame, callbacks, state, run); });
  let stopped = false;
  try {
    const result = await run.done;
    stopped = result.stopped ?? false;
    if (result.error && !state.error) state.error = result.error;
  } catch (err) {
    off(); forgetPending(run); liveRemote.delete(chat.id);
    if (opts.signal?.aborted) { callbacks.onStopped?.(); return { ok: false, stopped: true, runtime: chat.runtime }; }
    if (!state.text) { const u = unavailable("stream", err); callbacks.onError?.(u.detail); return u; }
    state.error = err instanceof Error ? err.message : String(err);
  }
  off(); forgetPending(run); liveRemote.delete(chat.id);
  if (opts.signal?.aborted || stopped) { callbacks.onStopped?.(); return { ok: false, stopped: true, runtime: chat.runtime }; }
  if (state.error && !state.text) { callbacks.onError?.(state.error); return { ok: false, error: state.error, runtime: chat.runtime }; }
  callbacks.onDone?.(state.text);
  return { ok: true, text: state.text, runtime: chat.runtime, ...(state.error ? { error: state.error } : {}) };
}

// ── Attach to a run happening ELSEWHERE (the run-stream broker consumer) ───────

/** The SDK's `runStream` resource (window.glyphhSdk.runStream), mirrored here the
 *  same way HarnessPod is — the renderer can't import @glyphh/sdk across preload. */
interface RunStreamResource {
  attach(threadId: string, opts?: { from?: string }): {
    on(cb: (frame: HarnessWireFrame) => void): () => void;
    onRun(cb: (runId: string) => void): () => void;
    stop(): void;
  };
}

export interface AttachHandle { readonly runId: string | null; stop(): void }

/**
 * "Open a thread anywhere, see the live turn." A surface OBSERVES a thread's
 * currently-active run — wherever it executes (this user's desktop or a cloud pod)
 * — by asking the broker for the thread's active run, then subscribing to that run's
 * durable frame stream (replay the tape so far, then follow live). Frames drive the
 * SAME callbacks a live turn uses, so the thread renders identically.
 *
 * READ-ONLY: this surface does not own answering approvals/asks (the executing
 * surface does), so pass no `onApproval`/`onAsk` — parked frames land as honest
 * breadcrumbs and the run rides its owner's answer. `onAttached` fires ONCE with the
 * runId before any frame, so the caller can seed its live-run state first. Returns a
 * null-runId handle (a no-op) when nothing is running — safe to call on every open.
 */
export function attachToActiveRun(
  chat: RemoteChat,
  callbacks: RemoteRunCallbacks = {},
  onRun?: (runId: string) => void,
): AttachHandle {
  const rs = (sdk() as unknown as { runStream?: RunStreamResource })?.runStream;
  if (!rs?.attach) return { runId: null, stop: () => {} };

  // ONE call: the SDK owns "watch this thread and stream whatever runs on it, run after
  // run, forever until stop." This function is just the shared frame->callbacks glue every
  // surface reuses; it does NOT know or care where a run executes. `onRun` fires per run so
  // the surface can start a fresh turn; a terminal frame fires onDone/onError.
  // dispatchFrame only touches `run` to PARK approval/ask (which an observer omits), so the
  // stub handle is never dereferenced.
  const stubRun = {} as unknown as HarnessRunHandle;
  let state = { text: "", error: null as string | null };
  const h = rs.attach(chat.id, { from: "0" });
  h.onRun((runId) => { state = { text: "", error: null }; onRun?.(runId); });
  h.on((frame) => {
    dispatchFrame(frame, callbacks, state, stubRun);
    if (frame.type === "done") callbacks.onDone?.(state.text);
    else if (frame.type === "error") callbacks.onError?.(state.error || "the run reported an error");
  });
  return { runId: null, stop: () => h.stop() };
}
