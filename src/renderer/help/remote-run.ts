/**
 * remote-run.ts — the app-web REMOTE runtime transport (a vanilla-TS port of the
 * platform's lib/agent/transport.js). The desktop app runs the harness locally
 * (window.glyphh.glyphhRun → main); the WEB build cannot. When a session's
 * workspace SOURCE is remote (cloud-new / cloud-repo), a turn instead goes
 * through the SDK handle (window.glyphhSdk) against the control plane's session
 * surface + the data-plane rotor stream:
 *
 *   1. glyphhSdk.sessions.create(provisionArgsFor(source))
 *        → provisions a rotor runtime, returns { session, runtimeToken }
 *          (the token is shown ONCE — the chat record binds it).
 *   2. poll glyphhSdk.sessions.get(id) until status === 'ready' (bounded).
 *   3. glyphhSdk.session({ url: runtimeUrl, token, rotor, sessionId })
 *        → opens the data plane (rotor.stream/v1 over SSE).
 *   4. session.turn(prompt) → a Run: for await (ev of run.events) yields
 *        open → step* → (answer | error) → done; run.done resolves the terminal.
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

/** A run's streamed frame — the `rotor.stream/v1` wire contract (+ SDK lifecycle). */
type WireEvent =
  | { seq: number; kind: "open"; wire: string; run_id: string; trace_id: string; rotor: string; session?: string }
  | { seq: number; kind: "step"; step_id: string; type: string; status: string; frames: string[]; tick: number; error?: string }
  | { seq: number; kind: "answer"; text: string }
  | { seq: number; kind: "interrupt"; step_id: string; awaiting: unknown }
  | { seq: number; kind: "error"; code: string; detail: string; remediation: string }
  | { seq: number; kind: "done"; status: string; terminal: string; outputs: unknown };
type LifecycleEvent = { kind: "reconnecting"; attempt: number } | { kind: "reconnected"; from: number };
type TurnEvent = WireEvent | LifecycleEvent;

interface RunResult {
  runId: string;
  status: string;
  terminal: string;
  outputs: unknown;
  error?: { code: string; detail: string; remediation: string };
}

interface SdkRun {
  readonly events: AsyncIterable<TurnEvent>;
  readonly done: Promise<RunResult>;
}

interface SdkSession {
  turn(prompt: string, opts?: { inputs?: Record<string, unknown>; signal?: AbortSignal }): SdkRun;
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

interface OpenSessionArgs {
  url?: string;
  token?: () => Promise<string>;
  rotor: unknown;
  sessionId?: string;
  model?: string;
  run?: { maxReconnects?: number };
}

interface SdkHandle {
  sessions?: {
    create?: (input: CreateSessionInput) => Promise<ProvisionedSession>;
    get?: (id: string) => Promise<RuntimeSession>;
  };
  session?: (opts: OpenSessionArgs) => SdkSession;
}

const sdk = (): SdkHandle | undefined =>
  (window as unknown as { glyphhSdk?: SdkHandle }).glyphhSdk;

// ── The chat's runtime binding — mirrors code.ts's CodeChat (kept structural so
//    remote-run doesn't reach back into code.ts's interfaces). ────────────────
export interface RuntimeBinding { sessionId: string; url: string; token: string }
export interface RemoteChat {
  id: string;
  source?: Source;
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
  return isRemoteSource(source) && !!sdk()?.session && !!sdk()?.sessions?.create;
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

/**
 * Run ONE remote turn end to end. Provisions/reuses the runtime, opens the data
 * plane, streams the turn through the callbacks, and resolves a typed outcome.
 * Never throws to the caller — every failure is a typed result the UI can render
 * as the honest not-connected / turn-error state.
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
  let session: SdkSession;
  try {
    if (!handle?.session) throw new Error("the SDK session transport is not available");
    session = handle.session({
      url: runtime.url,
      token: async () => runtime.token,
      rotor,
      sessionId: runtime.sessionId,
      ...(opts.model ? { model: opts.model } : {}),
      run: { maxReconnects: 1 },
    });
  } catch (err) {
    const u = unavailable("open", err);
    callbacks.onError?.(u.detail);
    return u;
  }

  let text = "";
  let outcomeError: string | null = null;
  try {
    const run = session.turn(prompt, { signal: opts.signal });
    for await (const ev of run.events) {
      if (opts.signal?.aborted) break;
      if (ev.kind === "step") {
        callbacks.onStep?.({ id: ev.step_id, type: ev.type, status: ev.status, error: ev.error });
      } else if (ev.kind === "answer") {
        text += ev.text;
        callbacks.onToken?.(ev.text);
        callbacks.onAnswer?.(text);
      } else if (ev.kind === "error") {
        outcomeError = ev.detail || ev.code || "the runtime reported an error";
      }
      // open / interrupt / done / reconnecting / reconnected: no UI mapping here
      // (done's terminal is read from run.done below).
    }
    const result = await run.done;
    if (result?.error && !outcomeError) outcomeError = result.error.detail || result.error.code;
  } catch (err) {
    if (opts.signal?.aborted) { callbacks.onStopped?.(); return { ok: false, stopped: true, runtime }; }
    // A stream that never opened (unreachable runtime, CORS, no /run surface) is
    // the honest not-connected state; anything mid-stream is a turn error.
    if (!text) {
      const u = unavailable("stream", err);
      u.sessionId = runtime.sessionId;
      callbacks.onError?.(u.detail);
      return u;
    }
    outcomeError = err instanceof Error ? err.message : String(err);
  }

  if (opts.signal?.aborted) { callbacks.onStopped?.(); return { ok: false, stopped: true, runtime }; }
  if (outcomeError && !text) { callbacks.onError?.(outcomeError); return { ok: false, error: outcomeError, runtime }; }
  callbacks.onDone?.(text);
  return { ok: true, text, runtime, ...(outcomeError ? { error: outcomeError } : {}) };
}
