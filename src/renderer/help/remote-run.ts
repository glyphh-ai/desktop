/**
 * remote-run.ts — the app-web REMOTE turn transport. The desktop app runs the
 * harness locally (window.glyphh.glyphhRun → main); the WEB build cannot. When
 * a session's workspace SOURCE is remote (or web = cloud, period), a turn goes
 * through the SDK handle (window.glyphhSdk) against the control plane's session
 * surface + the provisioned pod's HARNESS data plane (`glyphh.harness/v1`):
 *
 *   1. glyphhSdk.sessions.create(provisionArgsFor(source))
 *        → provisions a runtime pod, returns { session, runtimeToken }
 *          (the token is shown ONCE — the chat record binds it).
 *   2. poll glyphhSdk.sessions.get(id) until status === 'ready' (bounded).
 *   3. glyphhSdk.harness({ url: runtimeUrl, token })
 *        → opens the harness data plane (POST /run + frame stream, durable
 *          reconnect inside the SDK: WS when reachable, frame-poll otherwise).
 *   4. pod.start({ prompt, threadId: chat.id, mode }) → a run handle streaming
 *        the DESKTOP FRAME VOCABULARY (delta/tool/progress/approval/ask/done/
 *        error) — near-1:1 onto the same callbacks the local path drives.
 *
 * `threadId` rides every run: the pod records the transcript under the CLIENT's
 * chat id (auth stays bound to the provisioned sessionId via the bearer).
 *
 * Every stage can honestly fail on web today (no runtime deployed for the org's
 * region, the provisioner disabled, the runtime unreachable from a browser).
 * Failure is a TYPED RESULT, not an exception: code.ts renders the designed
 * "runtime not connected" state — never a fake reply. Even on an unavailable
 * provision the session id (when we got one) is bound onto the chat: the session
 * EXISTS server-side, and re-provision must not orphan it.
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
  | { type: "delta"; delta: string }
  | { type: "tool"; phase: "start" | "done"; name: string; thought?: string; title?: string; denied?: boolean; failed?: boolean; preview?: string }
  | { type: "progress"; inTokens: number; outTokens: number }
  | { type: "credits"; creditsMicro: number }
  | { type: "approval"; id: string; kind: string; title: string; detail: string }
  | { type: "ask"; id: string; questions: Array<{ question: string; options?: string[] }> }
  | { type: "setup"; phase: string }
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

type SessionStatus = "provisioning" | "ready" | "error" | "stopped";
interface RuntimeSession {
  id: string;
  status: SessionStatus;
  runtimeUrl: string | null;
  [k: string]: unknown;
}
interface ProvisionedSession { session: RuntimeSession; runtimeToken: string }
interface CreateSessionInput {
  rotor?: unknown;
  locus?: "remote" | "local" | "relay";
  repo?: string;
  path?: string;
  newProject?: boolean;
}

interface SdkHandle {
  sessions?: {
    create?: (input: CreateSessionInput) => Promise<ProvisionedSession>;
    get?: (id: string) => Promise<RuntimeSession>;
  };
  harness?: (opts: { url: string; token?: () => Promise<string>; run?: { maxReconnects?: number } }) => HarnessPod;
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

const DEFAULT_ROTOR = "default";
const READY_POLL_MS = 1500;
const READY_POLL_TRIES = 10;

/** How long the runtime waits before deciding FOR the user. Mirrored from the
 *  pod (rrotor `harness/gate.ts`) — and identical to the desktop's local gate
 *  (`glyphh-agent-permissions.ts`), so the dock's countdown is honest on BOTH
 *  paths and there is one set of numbers in the UI. */
export const APPROVAL_TIMEOUT_MS = 120_000;
export const ASK_TIMEOUT_MS = 10 * 60_000;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

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

/** A session's source is remote iff it runs in the cloud (cloud-new/cloud-repo). */
export function isRemoteSource(source?: Source): boolean {
  return !!source && source.kind !== "local";
}

/** A remote turn is only routed here on WEB, where the SDK handle is exposed and
 *  the local harness (window.glyphh.glyphhRun → main) does not exist. */
export function canRunRemote(source?: Source): boolean {
  return isRemoteSource(source) && !!sdk()?.harness && !!sdk()?.sessions?.create;
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
 * Translate the UI workspace SOURCE into sessions.create arguments.
 *   cloud-repo → remote runtime cloning the repo (scoped clone token server-side)
 *   cloud-new  → remote runtime, empty git-init'd R2-durable project (newProject)
 *   local      → the attached desktop (relay locus) in the picked folder
 * A missing/unknown source is the safe default: an empty cloud project.
 */
function provisionArgsFor(source: Source | undefined, rotor: unknown): CreateSessionInput {
  const base = { rotor };
  if (source?.kind === "cloud-repo" && source.repo) return { ...base, locus: "remote", repo: source.repo };
  // WEB = the shared CLOUD rotor even for machine-sourced sessions (driving
  // the attached machine from web is deferred) — provision plain remote.
  if (source?.kind === "local") return { ...base, locus: "remote", newProject: true };
  return { ...base, locus: "remote", newProject: true };
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
  opts: { rotor?: unknown; signal?: AbortSignal; forceFresh?: boolean } = {},
): Promise<{ ok: true; runtime: RuntimeBinding } | Unavailable | { ok: false; stopped: true }> {
  // SINGLE FRONT DOOR: with the proxy, there is nothing to provision — a turn
  // goes straight through `harnessViaApi()`, region-routed server-side. Hand back
  // a synthetic binding so the UI reads "connected" (isCommitted) instantly.
  if (sdk()?.harnessViaApi) {
    const runtime: RuntimeBinding = { sessionId: chat.id, url: "api", token: "api" };
    chat.runtime = runtime; save();
    return { ok: true, runtime };
  }
  // A cached binding is reused — EXCEPT when the caller knows it's dead
  // (forceFresh). Without that escape a binding minted against an old pod
  // URL/port, a stopped session, or a pre-CORS pod is permanent: every later
  // turn in that chat fails identically and no reload can heal it.
  if (!opts.forceFresh && chat.runtime?.url && chat.runtime?.token) return { ok: true, runtime: chat.runtime };
  if (opts.forceFresh) { chat.runtime = undefined; save(); }

  const handle = sdk();
  if (!handle?.sessions?.create || !handle.sessions.get) {
    return unavailable("provision", new Error("the SDK runtime surface is not available"));
  }
  const rotor = opts.rotor ?? DEFAULT_ROTOR;

  let provisioned: ProvisionedSession;
  try {
    provisioned = await handle.sessions.create(provisionArgsFor(chat.source, rotor));
  } catch (err) {
    return unavailable("provision", err);
  }
  const token = provisioned?.runtimeToken;
  let session = provisioned?.session;
  if (!token || !session?.id) return unavailable("provision", new Error("provisioning returned no runtime"));

  // Bind the session id NOW — even if it never reaches ready, the session
  // exists server-side and a later attempt must reuse it, not orphan it.
  bindSessionId(chat, session.id, save);

  // The runtime may still be standing up — poll until ready (bounded).
  let tries = 0;
  while (session.status === "provisioning" && tries < READY_POLL_TRIES) {
    if (opts.signal?.aborted) return { ok: false, stopped: true };
    await sleep(READY_POLL_MS);
    tries += 1;
    try {
      session = await handle.sessions.get(session.id);
    } catch (err) {
      const u = unavailable("provision-poll", err);
      u.sessionId = session.id;
      return u;
    }
  }
  if (session.status !== "ready" || !session.runtimeUrl) {
    const u = unavailable(
      "not-ready",
      new Error(`runtime ${session.status}${session.runtimeUrl ? "" : " (no runtime url)"}`),
    );
    u.sessionId = session.id;
    return u;
  }

  const runtime: RuntimeBinding = { sessionId: session.id, url: session.runtimeUrl, token };
  chat.runtime = runtime;
  save();
  return { ok: true, runtime };
}

/** Bind only the session id (the session exists server-side even when not ready),
 *  so a re-provision reuses the same session space. Kept idempotent. */
function bindSessionId(chat: RemoteChat, sessionId: string, save: () => void): void {
  if (chat.runtime?.sessionId === sessionId) return;
  chat.runtime = { sessionId, url: chat.runtime?.url ?? "", token: chat.runtime?.token ?? "" };
  save();
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
 * Run a turn through THE SINGLE FRONT DOOR: `harnessViaApi()` binds to the
 * control-plane proxy, which region-routes to the org's regional rrotor + stator.
 * No provisioning, no pod url, no relay — the user's session token authenticates
 * and the server picks the region. Same frames as every other path, so the UI is
 * identical. `threadId` (the chat id) scopes the transcript + memory.
 */
async function runViaFrontDoor(
  chat: RemoteChat,
  prompt: string,
  callbacks: RemoteRunCallbacks,
  opts: { model?: string; permission?: RemotePermission; signal?: AbortSignal; images?: Array<{ mediaType: string; data: string }>; memory?: RemoteMemoryPolicy },
): Promise<RemoteRunOutcome> {
  const pod = (sdk() as unknown as { harnessViaApi?: () => HarnessPod })?.harnessViaApi?.();
  if (!pod) { const u = unavailable("open", new Error("this build can't run turns (SDK harnessViaApi missing)")); callbacks.onError?.(u.detail); return u; }
  // Synthetic "connected" binding — enough for the UI's isCommitted state; there
  // is no pod url to hold. The proxy needs only the chat id (threadId) + the
  // user's token, both server-side.
  chat.runtime = { sessionId: chat.id, url: "api", token: "api" };
  const workdir = chat.source?.kind === "local" ? chat.source.path : undefined;
  let run: HarnessRunHandle;
  try {
    run = pod.start({
      prompt,
      threadId: chat.id,
      mode: modeFor(chat),
      ...(opts.model ? { model: opts.model } : {}),
      ...(opts.permission ? { permission: opts.permission } : {}),
      ...(opts.images && opts.images.length ? { images: opts.images } : {}),
      // The LOOP's memory policy — when memory is used and how (absent = default on).
      ...(opts.memory ? { memory: opts.memory } : {}),
      ...(workdir ? { workdir } : {}),
      ...(opts.signal ? { signal: opts.signal } : {}),
    } as Parameters<HarnessPod["start"]>[0]);
  } catch (err) { const u = unavailable("open", err); callbacks.onError?.(u.detail); return u; }

  const state = { text: "", error: null as string | null };
  const off = run.on((frame) => { if (opts.signal?.aborted) return; dispatchFrame(frame, callbacks, state, run); });
  let stopped = false;
  try {
    const result = await run.done;
    stopped = result.stopped;
    if (result.error && !state.error) state.error = result.error;
  } catch (err) {
    off(); forgetPending(run);
    if (opts.signal?.aborted) { callbacks.onStopped?.(); return { ok: false, stopped: true, runtime: chat.runtime }; }
    if (!state.text) { const u = unavailable("stream", err); callbacks.onError?.(u.detail); return u; }
    state.error = err instanceof Error ? err.message : String(err);
  }
  off(); forgetPending(run);
  if (opts.signal?.aborted || stopped) { callbacks.onStopped?.(); return { ok: false, stopped: true, runtime: chat.runtime }; }
  if (state.error && !state.text) { callbacks.onError?.(state.error); return { ok: false, error: state.error, runtime: chat.runtime }; }
  callbacks.onDone?.(state.text);
  return { ok: true, text: state.text, runtime: chat.runtime, ...(state.error ? { error: state.error } : {}) };
}

/**
 * Run a turn ON the caller's attached MACHINE via the SDK relay (attach.run),
 * streaming the SAME frames the cloud path streams — so the UI is identical. Used
 * for a LOCAL (machine-bound) session; the desktop runs it in `source.path`.
 */
async function runRelayTurn(
  chat: RemoteChat,
  prompt: string,
  callbacks: RemoteRunCallbacks,
  opts: { signal?: AbortSignal },
): Promise<RemoteRunOutcome> {
  const handle = sdk() as unknown as { attach?: { run?: (p: unknown, o: unknown) => HarnessRunHandle } };
  if (!handle?.attach?.run) {
    const u = unavailable("open", new Error("this build can't run on a machine (SDK attach.run missing)"));
    callbacks.onError?.(u.detail); return u;
  }
  chat.runtime = RELAY_RUNTIME(chat);   // mark as connected (no cloud pod)
  const workdir = chat.source?.kind === "local" ? chat.source.path : undefined;
  let run: HarnessRunHandle;
  try {
    run = handle.attach.run(
      // threadId = the CHAT's id (stable across turns). The DESKTOP keys the
      // relay session's transcript + compaction by it (glyphh-agent-context),
      // so the mobile need only send the new turn — not the whole history.
      { prompt, threadId: chat.id, mode: modeFor(chat), ...(workdir ? { workdir } : {}) },
      { ...(opts.signal ? { signal: opts.signal } : {}) },
    );
  } catch (err) { const u = unavailable("open", err); callbacks.onError?.(u.detail); return u; }

  const state = { text: "", error: null as string | null };
  const off = run.on((frame) => { if (opts.signal?.aborted) return; dispatchFrame(frame, callbacks, state, run); });
  let stopped = false;
  try {
    const result = await run.done;
    stopped = result.stopped;
    if (result.error && !state.error) state.error = result.error;
  } catch (err) {
    off(); forgetPending(run);
    if (opts.signal?.aborted) { callbacks.onStopped?.(); return { ok: false, stopped: true, runtime: chat.runtime }; }
    if (!state.text) { const u = unavailable("stream", err); callbacks.onError?.(u.detail); return u; }
    state.error = err instanceof Error ? err.message : String(err);
  }
  off(); forgetPending(run);
  if (opts.signal?.aborted || stopped) { callbacks.onStopped?.(); return { ok: false, stopped: true, runtime: chat.runtime }; }
  if (state.error && !state.text) { callbacks.onError?.(state.error); return { ok: false, error: state.error, runtime: chat.runtime }; }
  callbacks.onDone?.(state.text);
  return { ok: true, text: state.text, runtime: chat.runtime, ...(state.error ? { error: state.error } : {}) };
}

export async function runRemoteTurn(
  chat: RemoteChat,
  prompt: string,
  save: () => void,
  callbacks: RemoteRunCallbacks = {},
  opts: { rotor?: unknown; model?: string; permission?: RemotePermission; signal?: AbortSignal; images?: Array<{ mediaType: string; data: string }>; memory?: RemoteMemoryPolicy } = {},
): Promise<RemoteRunOutcome> {
  // THE RUNTIME SPLIT (docs/runtime-stator-split.md): the STATOR is one regional
  // plane; the RUNTIME is chosen per session. A LOCAL (machine-bound) session
  // runs on the user's OWN machine over the relay — tools touch its real folder,
  // memory reaches the same regional stator via /api/stator/*. Everything else
  // goes through the front door to the cloud runtime. The cloud pod REJECTS a
  // caller workdir by design, so local must never route there.
  if (chat.source?.kind === "local") return runRelayTurn(chat, prompt, callbacks, { ...(opts.signal ? { signal: opts.signal } : {}) });
  if (sdk()?.harnessViaApi) return runViaFrontDoor(chat, prompt, callbacks, opts);
  // ONE silent retry on a dead binding: attempt 1 swallows its error, drops
  // the cached runtime, re-provisions, and runs again. Only the second
  // failure reaches the user.
  const first = await runRemoteTurnOnce(chat, prompt, save, { ...callbacks, onError: undefined }, opts, false);
  if (!("unavailable" in first)) return first;
  if (!chat.runtime && first.stage === "provision") { callbacks.onError?.(first.detail); return first; }
  return runRemoteTurnOnce(chat, prompt, save, callbacks, opts, true);
}

async function runRemoteTurnOnce(
  chat: RemoteChat,
  prompt: string,
  save: () => void,
  callbacks: RemoteRunCallbacks,
  opts: { rotor?: unknown; model?: string; permission?: RemotePermission; signal?: AbortSignal; images?: Array<{ mediaType: string; data: string }> },
  forceFresh: boolean,
): Promise<RemoteRunOutcome> {
  const rotor = opts.rotor ?? DEFAULT_ROTOR;
  const ensured = await ensureRuntime(chat, save, { rotor, signal: opts.signal, forceFresh });
  if (!ensured.ok) {
    if ("stopped" in ensured) { callbacks.onStopped?.(); return ensured; }
    callbacks.onError?.(ensured.detail);
    return ensured;
  }
  const { runtime } = ensured;

  const handle = sdk();
  let run: HarnessRunHandle;
  try {
    if (!handle?.harness) throw new Error("the SDK harness transport is not available");
    const pod = handle.harness({ url: runtime.url, token: async () => runtime.token });
    // threadId = the CHAT's id on every run — the pod records the transcript
    // under it (auth stays bound to the provisioned session via the bearer).
    run = pod.start({
      prompt,
      threadId: chat.id,
      mode: modeFor(chat),
      ...(opts.model ? { model: opts.model } : {}),
      // The pod defaults to `auto`; the SESSION's picked mode is what governs.
      ...(opts.permission ? { permission: opts.permission } : {}),
      ...(opts.images && opts.images.length ? { images: opts.images } : {}),
      ...(opts.signal ? { signal: opts.signal } : {}),
    });
  } catch (err) {
    const u = unavailable("open", err);
    callbacks.onError?.(u.detail);
    return u;
  }

  const state = { text: "", error: null as string | null };
  const off = run.on((frame) => {
    if (opts.signal?.aborted) return;
    dispatchFrame(frame, callbacks, state, run);
  });

  let stopped = false;
  try {
    const result = await run.done;
    stopped = result.stopped;
    if (result.error && !state.error) state.error = result.error;
  } catch (err) {
    off();
    forgetPending(run);
    if (opts.signal?.aborted) { callbacks.onStopped?.(); return { ok: false, stopped: true, runtime }; }
    // A run that never streamed (unreachable pod, 401 bearer, 409 at-capacity,
    // wire mismatch) is the honest not-connected state; mid-stream loss with
    // text already on screen is a turn error.
    if (!state.text) {
      const u = unavailable("stream", err);
      u.sessionId = runtime.sessionId;
      callbacks.onError?.(u.detail);
      return u;
    }
    state.error = err instanceof Error ? err.message : String(err);
  }
  off();
  // The run is over: any card still parked on it can never be answered.
  forgetPending(run);

  if (opts.signal?.aborted || stopped) { callbacks.onStopped?.(); return { ok: false, stopped: true, runtime }; }
  if (state.error && !state.text) { callbacks.onError?.(state.error); return { ok: false, error: state.error, runtime }; }
  callbacks.onDone?.(state.text);
  return { ok: true, text: state.text, runtime, ...(state.error ? { error: state.error } : {}) };
}
