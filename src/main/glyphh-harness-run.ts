/**
 * glyphh-harness-run.ts — a tool-bearing turn, run on the CLOUD rrotor pod.
 *
 * ONE RROTOR, AND IT IS NOT ON THIS MACHINE. The local harness pod (the
 * vendored/spawned 127.0.0.1 rrotor and its loopback tool bridge) is gone:
 * the desktop no longer installs, spawns, or hosts any runtime. Every
 * tool-bearing turn — whatever its session's source — runs on a provisioned
 * cloud session pod, exactly as it does from the web:
 *
 *   pod        `ensureCloudPod` — the chat's existing runtime binding, or a
 *              freshly provisioned session polled to `ready`.
 *   models     the pod calls the Glyphh gateway with its session's own
 *              runtime token; metering lands on the user.
 *   frames     `glyphh.harness/v1` translates 1:1 onto the renderer's existing
 *              `glyphh-agent:*` IPC — the renderer needs zero changes.
 *   threads    the renderer's thread-store LWW push stays the persistence path.
 */

import { type WebContents } from "electron";
import { openAppByRef, openBrowserAt } from "./app-resolver";
import type { HarnessWireFrame } from "@glyphh/sdk";
import { getClient, SERVER_URL } from "./glyphh-client";
import { loadSessions, saveSessions } from "./glyphh-agent-context";
import { runModel, currentLoop } from "./loop-selections";
import { glyphhMode, registerRemotePause } from "./glyphh-agent-permissions";
import { captureRun } from "./glyphh-agent-training";
import { attachmentImageRefs, type AttachRef } from "./glyphh-agent-attachments";
import { composeTurn, brandError, type ChatMessage } from "./glyphh-agent-prompt";
import { pushToAttach, isAttached } from "./attach-client";
import { toWireFrame } from "./attach-run-frames";

/** Strip the Agent SDK's MCP prefix so tool names read the way the renderer
 *  expects them (`open_app`, not `mcp__desktop__open_app`). */
function bareToolName(name: string): string {
  return name.replace(/^mcp__[a-z0-9_-]+__/i, "");
}

// ── Cloud pods ─────────────────────────────────────────────────────────────
//
// A session runs on a PROVISIONED remote pod, from the desktop exactly as it
// does from the web: same SDK calls, same harness wire.

/** The renderer's workspace Source, as far as a run needs to read it. */
export interface RunSource { kind: string; repo?: string }

/** Where a run's pod lives. */
interface PodTarget { url: string; token: string }

export const isCloudSource = (s?: RunSource): boolean => !!s && s.kind !== "local";

// ── Live-run registry (mid-run permission push) ─────────────────────────────
//
// A run's permission mode is a SNAPSHOT at start (`permission` below). When the
// user flips the mode chip mid-turn, we must push the change to the pod driving
// THIS run so its gate re-evaluates. The pod exposes it as POST
// /runs/:id/permission; the SDK's HarnessRun.setPermission() calls it. We keep
// each live run's handle here, keyed by the runId the renderer knows, so an IPC
// (desktop-local) or attach dispatch (a remote surface driving this machine) can
// reach it. Local runs pass the desktop's OWN runId; relayed runs pass the
// caller's minted runId — both key this map.
type PermMode = "ask" | "plan" | "acceptEdits" | "auto" | "bypass";
interface LiveHandle { setPermission(mode: PermMode): Promise<void>; inject(text: string): Promise<void> }
const liveRuns = new Map<string, LiveHandle>();

/** Push a new permission mode to a run in flight. No-op (returns false) when the
 *  run isn't live here — it may have finished, or never ran on this machine. */
export async function setRunPermission(runId: string, mode: PermMode): Promise<boolean> {
  const h = liveRuns.get(runId);
  if (!h) return false;
  try { await h.setPermission(mode); return true; }
  catch { return false; }
}

/** Add a USER message to a run in flight (the pod drains it at the next
 *  between-turn boundary). False when the run isn't live here or refuses
 *  input (settled / final turn already closing). */
export async function injectRunMessage(runId: string, text: string): Promise<boolean> {
  const h = liveRuns.get(runId);
  if (!h) return false;
  try { await h.inject(text); return true; }
  catch { return false; }
}

const PROVISION_TIMEOUT_MS = 90_000;
const PROVISION_POLL_MS = 1_500;

/** Persist a chat's pod binding. Re-read immediately before writing: the
 *  renderer owns this file too, and a run can outlive several of its saves. */
function bindRuntime(chatId: string, runtime: { sessionId: string; url: string; token: string }): void {
  try {
    const { chats, currentId } = loadSessions();
    const chat = chats.find((c) => c.id === chatId);
    if (!chat) return;
    chat.runtime = runtime;
    saveSessions(chats, currentId);
  } catch (err) {
    // A binding that fails to persist costs a re-provision next launch, not
    // the run in flight — never fatal.
    console.warn("[harness] could not persist the runtime binding:", err instanceof Error ? err.message : String(err));
  }
}

/** The chat's cloud pod: its existing binding when it has one, else a freshly
 *  provisioned session polled to `ready`. */
async function ensureCloudPod(chatId: string, source?: RunSource): Promise<PodTarget> {
  const bound = loadSessions().chats.find((c) => c.id === chatId)?.runtime;
  if (bound?.url && bound.token) return { url: bound.url, token: bound.token };

  const client = getClient();
  const { session, runtimeToken } = await client.sessions.create({
    // The user's selected agent loop.
    rotor: currentLoop(),
    locus: "remote",
    ...(source?.kind === "cloud-repo" && source.repo ? { repo: source.repo } : { newProject: true }),
  });

  let live = session;
  const deadline = Date.now() + PROVISION_TIMEOUT_MS;
  while (live.status === "provisioning" && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, PROVISION_POLL_MS));
    live = await client.sessions.get(session.id);
  }
  if (live.status !== "ready" || !live.runtimeUrl) {
    throw new Error(
      live.status === "provisioning"
        ? "the cloud runtime is still starting — try again in a moment"
        : `the cloud runtime could not start (${live.status})`,
    );
  }
  bindRuntime(chatId, { sessionId: live.id, url: live.runtimeUrl, token: runtimeToken });
  return { url: live.runtimeUrl, token: runtimeToken };
}

/**
 * Build + deploy a Glyphh app IN THE CLOUD POD — the remote-dev counterpart of
 * `deployAppFromWorkdir`. The pod runs `npm install && npm run build` in the SAME
 * workspace the session's turns use, then uploads + deploys via the control plane
 * (POST {runtimeUrl}/apps/deploy). So a user with no local machine can still ship —
 * and, since deploy/promote are server-side, push to production.
 */
export async function deployAppFromCloud(
  slug: string, chatId: string, source: RunSource,
): Promise<{ ok: boolean; result?: { version?: string; url?: string }; error?: string }> {
  const pod = await ensureCloudPod(chatId, source);
  // Key the pod's workspace to the SAME session its runs resolve (sessionId when
  // bound, else the client thread id) so the build sees the app's source.
  const sessionId = loadSessions().chats.find((c) => c.id === chatId)?.runtime?.sessionId;
  const res = await fetch(`${pod.url.replace(/\/+$/, "")}/apps/deploy`, {
    method: "POST",
    headers: { authorization: `Bearer ${pod.token}`, "content-type": "application/json" },
    body: JSON.stringify({ slug, ...(sessionId ? { sessionId } : { threadId: chatId }), distDir: "dist" }),
  });
  const json = (await res.json().catch(() => null)) as
    | { ok?: boolean; result?: string; error?: string; stage?: string }
    | null;
  if (!res.ok || !json?.ok) {
    const detail = json?.error ? `${json.stage ? `${json.stage}: ` : ""}${json.error}` : `cloud deploy failed (${res.status})`;
    return { ok: false, error: detail };
  }
  // build_app's text result carries the slug/version/url — surface them like the
  // local path so the Releases tab shows the same "Built vX — live at …".
  let info: { version?: string; url?: string } = {};
  try {
    const p = JSON.parse(json.result ?? "") as Record<string, unknown>;
    info = {
      version: typeof p.version === "string" ? p.version : undefined,
      url: typeof p.url === "string" ? p.url : (typeof p.deployUrl === "string" ? p.deployUrl : undefined),
    };
  } catch { /* non-JSON text — no structured fields */ }
  return { ok: true, result: info };
}

// ── The run ────────────────────────────────────────────────────────────────

/**
 * Run one tool-bearing turn on the session's CLOUD pod. Emits the SAME
 * renderer events the old in-process path emitted, on the same channels,
 * with the same payloads.
 *
 * `runWorkdir` is accepted for call-site compatibility but no longer rides
 * the run: the pod works in its own cloud workspace. (The directory GRANT —
 * the one local folder apps may reach — travels a separate path once the
 * runtime's grant transport lands.)
 */
export async function harnessRun(
  wc: WebContents,
  runId: string,
  base: ChatMessage[],
  ctrl: AbortController,
  attachments: AttachRef[] = [],
  chatId = "",
  runWorkdir?: string,
  mode: "cowork" | "code" = "code",
  source?: RunSource,
  /** Permission mode from a RELAYING client (mobile/web driving this machine). When
   *  set it OVERRIDES the desktop's own mode — the run must honor the caller's choice
   *  (e.g. 'bypass'). Absent for a desktop-local run → the local `glyphhMode()`. */
  permissionOverride?: "ask" | "plan" | "acceptEdits" | "auto" | "bypass",
  /** Publish this run's frames UP the attach socket (channel `run:<runId>`) so the
   *  run-stream broker captures them and ANOTHER surface (web/mobile) can watch this
   *  desktop-local turn live. The RELAY path (attach-run.ts) already publishes via its
   *  sink, so it leaves this false; the desktop-local IPC path sets it true. Best-effort:
   *  a closed socket just means nobody's watching elsewhere — the local run is untouched. */
  publishFrames = false,
  /** Model id from a RELAYING client (web/mobile driving this machine). When set
   *  it OVERRIDES the desktop's own loop model — the caller's picker wins. Absent
   *  for a desktop-local run → the local `runModel('default')` resolution. */
  modelOverride?: string,
  /** Agent LOOP (rotor) id from a RELAYING client. When set it OVERRIDES the
   *  desktop's own active loop (the `rotor` the pod runs). Absent → `currentLoop()`. */
  loopOverride?: string,
): Promise<void> {
  void runWorkdir; // kept in the signature; see the doc comment above
  // Monotonic seq for the published wire frames (broker ordering rides Redis stream
  // ids, but the frame carries its own seq for parity with the relay ring).
  let pubSeq = 0;
  const emit = (channel: string, data: Record<string, unknown>): void => {
    try { if (!wc.isDestroyed()) wc.send(channel, { runId, ...data }); } catch { /* panel gone */ }
    // Tee to the broker for cross-surface observation. `threadId` on every frame lets
    // the server record this thread's active run once (broker setActiveRun), so a web
    // client can discover + attach to it.
    if (publishFrames && isAttached()) {
      try {
        const wf = toWireFrame(channel, { ...data }, pubSeq++, runId);
        if (wf) pushToAttach(`run:${runId}`, { ...wf, ...(chatId ? { threadId: chatId } : {}) });
      } catch { /* never let publishing perturb the run */ }
    }
  };

  const cancelPauses: Array<() => void> = [];
  let finalText = "";
  let runError = "";
  /** Tool starts — the run's work magnitude for the training capture. */
  let turnsUsed = 0;

  try {
    // 1. The turn, assembled exactly as before — the path manifest in the
    //    text, the images as real vision blocks.
    const { system, lastUser, ask } = await composeTurn(base, chatId, attachments);
    const images = attachmentImageRefs(attachments);

    // 2. The pod. Every run executes on the session's cloud pod — its
    //    existing binding, or a freshly provisioned session. The pod brings
    //    its own tools (and derives the control plane's app tools from
    //    `gatewayUrl` below); nothing is lent from this machine.
    const target = await ensureCloudPod(chatId, source);

    // 3. Start the run and translate its frames. The model is the user's pick,
    //    already constrained to what their workspace allows (loop-selections);
    //    an unresolved one lets the pod fall back to its own default.
    // A relaying client's model wins outright; else resolve via ITS loop (or the
    // desktop's own when no override), so the caller's loop pick drives the model.
    const model = modelOverride ?? await runModel("default", loopOverride).catch(() => null);
    const pod = getClient().harness({
      url: target.url,
      token: async (): Promise<string> => target.token,
    });
    const run = pod.start({
      prompt: lastUser,
      system,
      // The CLIENT's chat id on both axes: `threadId` scopes the transcript,
      // `sessionId` keys the pod's per-session workspace + agent config home
      // (auth-off means no token binding to inherit one from).
      threadId: chatId || undefined,
      sessionId: chatId || undefined,
      mode,
      permission: permissionOverride ?? glyphhMode(),
      ...(model ? { model } : {}),
      // Pasted screenshots as vision blocks ahead of the prompt text. Pod-side
      // caps (8 × ~7.5MiB) sit above the decoder's, so an accepted turn is
      // never one the pod rejects.
      ...(images.length ? { images } : {}),
      // The gateway is named on EVERY run. The pod needs it for two things:
      // model egress, and deriving the control plane's app tool surface
      // (scaffold_app/create_app_entry/build_app/deploy_app), which it lends
      // itself so a run can actually PUBLISH what it built.
      gatewayUrl: `${SERVER_URL}/api/gateway`,
      signal: ctrl.signal,
    });

    // Register the live handle so a mid-run permission-mode change (the user
    // flipping the mode chip on ANY surface) reaches THIS run's pod: the local
    // IPC path and the attach `agent.permission` dispatch both resolve by runId
    // here and call HarnessRun.setPermission → POST /runs/:id/permission.
    liveRuns.set(runId, { setPermission: (mode) => run.setPermission(mode), inject: (text) => run.inject(text) });

    // Publish the user's prompt as the run's FIRST frame so any surface observing this
    // run over the broker renders the turn's user message (assistant frames don't carry
    // it). Local display ignores the channel; the broker + relay sink forward it.
    emit("glyphh-agent:prompt", { text: ask });

    run.on((frame: HarnessWireFrame) => {
      switch (frame.type) {
        case "open-app" as never: {
          // The pod asked to SHOW something. This machine executes the run, so
          // it opens the panel here (RPA needs the desktop webview; a user at
          // the desktop sees it); a web/mobile surface watching the run's
          // stream renders its own view from the same frame.
          const f = frame as unknown as { ref?: string; url?: string };
          if (f.url) openBrowserAt(f.url);
          else if (f.ref) void openAppByRef(f.ref).catch(() => { /* unknown app — the tool result already told the model */ });
          return;
        }
        case "delta":
          finalText += frame.delta;
          emit("glyphh-agent:delta", { delta: frame.delta });
          return;
        case "tool": {
          // The wire carries no turn count (the pod keeps it internally), so
          // the training capture uses tool starts as its proxy for "how much
          // work did this run do" — honest as a magnitude, not as a turn count.
          if (frame.phase === "start") turnsUsed++;
          const { seq: _s, runId: _r, at: _a, type: _t, ...rest } = frame;
          emit("glyphh-agent:tool", { ...rest, name: bareToolName(frame.name) });
          return;
        }
        case "progress":
          emit("glyphh-agent:progress", { inTokens: frame.inTokens, outTokens: frame.outTokens });
          return;
        case "credits":
          emit("glyphh-agent:credits", { creditsMicro: frame.creditsMicro });
          return;
        case "approval": {
          // The pod gates its own tools; the desktop renders the card and
          // relays the answer.
          cancelPauses.push(registerRemotePause(frame.id, (reply) => void run.answer(frame.id, { allow: !!reply.allow })));
          emit("glyphh-agent:approval", { id: frame.id, kind: frame.kind, title: frame.title, detail: frame.detail });
          return;
        }
        case "ask":
          cancelPauses.push(registerRemotePause(frame.id, (reply) => void run.answer(frame.id, { answers: reply.answers ?? [] })));
          emit("glyphh-agent:ask", { id: frame.id, questions: frame.questions });
          return;
        case "setup": {
          const { seq: _s, runId: _r, at: _a, type: _t, ...rest } = frame;
          emit("glyphh-agent:setup", rest as Record<string, unknown>);
          return;
        }
        case "permission":
          // The pod echoes a mid-run mode change back on the stream — forward it
          // so the local renderer AND any surface observing this run (via the
          // broker tee in `emit`) re-render the mode chip together.
          emit("glyphh-agent:permission", { permission: (frame as { permission?: string }).permission });
          return;
        default:
          // done/error settle `run.done` — reported once, below.
          return;
      }
    });

    const result = await run.done;
    if (result.stopped || ctrl.signal.aborted) {
      emit("glyphh-agent:done", { stopped: true });
      captureRun({ kind: "agent", mode: glyphhMode(), turnsUsed, stopped: true, messages: base });
      return;
    }
    if (result.error) {
      runError = brandError(result.error);
      emit("glyphh-agent:error", { error: runError });
    } else {
      emit("glyphh-agent:done", { stopped: false });
    }
  } catch (err) {
    if (ctrl.signal.aborted) {
      emit("glyphh-agent:done", { stopped: true });
      captureRun({ kind: "agent", mode: glyphhMode(), turnsUsed, stopped: true, messages: base });
      return;
    }
    runError = brandError(err instanceof Error ? err.message : String(err));
    emit("glyphh-agent:error", { error: runError });
  } finally {
    liveRuns.delete(runId);
    for (const cancel of cancelPauses) cancel();
  }

  // The flywheel: transcript + outcome are next-era training data.
  captureRun({
    kind: "agent",
    mode: glyphhMode(),
    turnsUsed,
    final: finalText,
    ...(runError ? { error: runError } : {}),
    messages: [...base, { role: "assistant", content: finalText }],
  });
}
