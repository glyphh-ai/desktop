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

interface HarnessPod {
  start(opts: {
    prompt: string;
    threadId?: string;
    mode?: "chat" | "cowork" | "code";
    model?: string;
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

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

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
  opts: { rotor?: unknown; signal?: AbortSignal } = {},
): Promise<{ ok: true; runtime: RuntimeBinding } | Unavailable | { ok: false; stopped: true }> {
  if (chat.runtime?.url && chat.runtime?.token) return { ok: true, runtime: chat.runtime };

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
  onToken?: (delta: string) => void;
  onAnswer?: (fullText: string) => void;
  onDone?: (fullText: string) => void;
  onStopped?: () => void;
  onError?: (detail: string) => void;
}

export type RemoteRunOutcome =
  | { ok: true; text: string; runtime: RuntimeBinding; error?: string }
  | { ok: false; stopped: true; runtime?: RuntimeBinding }
  | { ok: false; error: string; runtime?: RuntimeBinding }
  | Unavailable;

/** Map one harness frame onto the UI callbacks. `delta` appends; `tool` leaves a
 *  breadcrumb on start (and on a denied/failed finish); `approval`/`ask` have no
 *  web UI yet, so they surface as honestly-labeled breadcrumbs and ride the
 *  POD's timeout semantics (approval → denied after ~2min; ask → answered empty
 *  after ~10min, the agent re-plans). progress/credits/setup: no UI mapping. */
function dispatchFrame(
  frame: HarnessWireFrame,
  cb: RemoteRunCallbacks,
  state: { text: string; error: string | null },
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
      } else if (frame.denied || frame.failed) {
        cb.onStep?.({ id: `${frame.name}#${frame.seq}`, type: frame.name, status: frame.denied ? "denied" : "failed", ...(frame.title ? { error: frame.title } : {}) });
      }
      return;
    case "approval":
      cb.onStep?.({
        id: frame.id,
        type: "approval",
        status: `${frame.title} — no approval UI here yet; auto-denied by the runtime if unanswered`,
      });
      return;
    case "ask":
      cb.onStep?.({
        id: frame.id,
        type: "question",
        status: `${frame.questions.map((q) => q.question).join(" · ")} — no answer UI here yet; the agent continues without one after the runtime's timeout`,
      });
      return;
    case "error":
      state.error = frame.error || "the runtime reported an error";
      return;
    default:
      // progress / credits / setup / done — no UI mapping (done resolves run.done).
      return;
  }
}

/**
 * Run ONE remote turn end to end. Provisions/reuses the runtime, opens the
 * harness data plane, streams the frames through the callbacks, and resolves a
 * typed outcome. Never throws to the caller — every failure is a typed result
 * the UI can render as the honest not-connected / turn-error state.
 */
export async function runRemoteTurn(
  chat: RemoteChat,
  prompt: string,
  save: () => void,
  callbacks: RemoteRunCallbacks = {},
  opts: { rotor?: unknown; model?: string; signal?: AbortSignal } = {},
): Promise<RemoteRunOutcome> {
  const rotor = opts.rotor ?? DEFAULT_ROTOR;
  const ensured = await ensureRuntime(chat, save, { rotor, signal: opts.signal });
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
    dispatchFrame(frame, callbacks, state);
  });

  let stopped = false;
  try {
    const result = await run.done;
    stopped = result.stopped;
    if (result.error && !state.error) state.error = result.error;
  } catch (err) {
    off();
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

  if (opts.signal?.aborted || stopped) { callbacks.onStopped?.(); return { ok: false, stopped: true, runtime }; }
  if (state.error && !state.text) { callbacks.onError?.(state.error); return { ok: false, error: state.error, runtime }; }
  callbacks.onDone?.(state.text);
  return { ok: true, text: state.text, runtime, ...(state.error ? { error: state.error } : {}) };
}
