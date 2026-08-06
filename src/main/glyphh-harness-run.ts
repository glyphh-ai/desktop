/**
 * glyphh-harness-run.ts — a tool-bearing turn, run on the machine's LOCAL
 * HARNESS POD instead of in Electron's own process.
 *
 * ONE HARNESS EVERYWHERE. The same rrotor harness that serves cloud sessions
 * runs here on 127.0.0.1 (`ROTOR_MODE=harness`, introspection OFF → the pod
 * loopback-binds itself; that bind is the security boundary). The desktop
 * stops owning an agent loop and becomes what it should be: the machine, the
 * window, and the user's tool surface.
 *
 *   pod        `@glyphh/sdk/runtime` ensureLocalHarnessPod — the runtime
 *              supervisor's singleton lock / discovery record / detached spawn,
 *              with a harness-mode state home. One pod per MACHINE, shared with
 *              the CLI, deliberately outliving this app (it is a machine
 *              service, not an app subprocess).
 *   tools      the desktop's own surface, lent over loopback MCP
 *              (harness-mcp-bridge.ts) — the pod's `mcpServers` entry.
 *   models     the pod calls the Glyphh gateway directly with the USER's
 *              `gy_at_` access token as `runtimeToken`; metering lands on the
 *              user. No local interceptor is involved.
 *   frames     `glyphh.harness/v1` translates 1:1 onto the renderer's existing
 *              `glyphh-agent:*` IPC — the renderer needs zero changes.
 *   threads    no stator locally, so the pod records nothing; the renderer's
 *              thread-store LWW push stays the persistence path.
 *
 * NOT YET AT PARITY with the in-process path — see GLYPHH_LOCAL_ROTOR in
 * glyphh-agent.ts for the exact list that keeps this behind a flag.
 */

import { app, type WebContents } from "electron";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { ensureLocalHarnessPod } from "@glyphh/sdk/runtime";
import type { HarnessWireFrame } from "@glyphh/sdk";
import { getClient, SERVER_URL } from "./glyphh-client";
import { runModel } from "./loop-selections";
import { glyphhMode, registerRemotePause } from "./glyphh-agent-permissions";
import { captureRun } from "./glyphh-agent-training";
import { glyphhToolDefs, connectorWireTools, type ConnectorWireDef } from "./glyphh-agent-tools";
import { selectConnectorTools } from "./tool-vectors";
import { attachmentImageRefs, type AttachRef } from "./glyphh-agent-attachments";
import { composeTurn, brandError, type ChatMessage } from "./glyphh-agent-prompt";
import { lendToolSurface, BRIDGE_TOOL_PREFIX, type LentSurface } from "./harness-mcp-bridge";

/** Strip the Agent SDK's MCP prefix so tool names read the way the in-process
 *  path emits them (`open_app`, not `mcp__desktop__open_app`). */
function bareToolName(name: string): string {
  return name.replace(/^mcp__[a-z0-9_-]+__/i, "");
}

// ── The pod ────────────────────────────────────────────────────────────────

/** A plain `node` on PATH. The dev pod must NOT be spawned with
 *  `process.execPath` — under Electron that is the Electron binary, which runs
 *  a script as an app (dock icon, Chromium runtime) rather than as Node. */
function nodeOnPath(): string | undefined {
  for (const dir of (process.env.PATH ?? "").split(":")) {
    if (!dir) continue;
    const bin = join(dir, "node");
    if (existsSync(bin)) return bin;
  }
  return undefined;
}

/**
 * The launch command for the local pod.
 *
 * `GLYPHH_LOCAL_ROTOR_CMD` always wins (the SDK reads it too). Otherwise, in a
 * DEV checkout, prefer the sibling rrotor build — `<repo>/rrotor/dist/cli.js`,
 * whose `serve -p <port>` entry dispatches on ROTOR_MODE — so a developer runs
 * the code they are editing. A packaged build falls through to the SDK's own
 * resolution (`$GLYPHH_ROTOR_BIN`, then `rrotor` on PATH).
 */
function localRotorCmd(): string | undefined {
  if (process.env.GLYPHH_LOCAL_ROTOR_CMD?.trim()) return undefined; // the SDK reads it
  if (app.isPackaged) return undefined;
  const repoBuild = join(app.getAppPath(), "..", "rrotor", "dist", "cli.js");
  if (!existsSync(repoBuild)) return undefined;
  const node = nodeOnPath();
  return node ? `${node} ${repoBuild}` : undefined;
}

/**
 * The pod's URL, starting it if needed. `ensureLocalHarnessPod` is idempotent
 * and atomic across processes: a healthy discovery record attaches, otherwise
 * the mkdir lock elects one starter and everyone else waits for its record. A
 * pod that died since the last run fails its health check and is respawned —
 * liveness, port persistence and restart-if-dead all live in the supervisor.
 */
async function ensurePod(): Promise<string> {
  const cmd = localRotorCmd();
  const pod = await ensureLocalHarnessPod({
    ...(cmd ? { cmd } : {}),
    // Electron's boot is busy; a cold pod (node + SDK load) needs more than
    // the supervisor's 15s default on a first run.
    startTimeoutMs: 30_000,
  });
  return pod.url;
}

// ── The run ────────────────────────────────────────────────────────────────

/**
 * Run one tool-bearing turn on the local pod. Emits the SAME renderer events
 * the in-process path emits, on the same channels, with the same payloads —
 * this function is a drop-in for `sdkRun`.
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
): Promise<void> {
  const emit = (channel: string, data: Record<string, unknown>): void => {
    try { if (!wc.isDestroyed()) wc.send(channel, { runId, ...data }); } catch { /* panel gone */ }
  };

  let lent: LentSurface | null = null;
  const cancelPauses: Array<() => void> = [];
  let finalText = "";
  let runError = "";
  /** Tool starts — the run's work magnitude for the training capture. */
  let turnsUsed = 0;

  try {
    // 1. The credential. The pod holds none of its own (auth off), so the
    //    USER's control-plane access token rides the run body: the gateway's
    //    resolvePrincipal accepts gy_at_ as readily as a pod's gy_rk_, and the
    //    metering lands on the user who asked.
    const runtimeToken = await getClient().token();
    if (!runtimeToken) throw new Error("sign in to run a turn — the local harness needs your access token to reach the gateway");

    // 2. The turn, assembled exactly as the in-process path assembles it —
    //    the path manifest in the text, the images as real vision blocks.
    const { system, lastUser, ask } = await composeTurn(base, chatId, attachments);
    const images = attachmentImageRefs(attachments);

    // 3. The tool surface. Builtins for the mode; connectors as first-class
    //    tools with their real schemas (code mode pays for find_tools/call_tool
    //    instead of a catalog subset — the same trade the in-process path makes).
    const defs = glyphhToolDefs(mode);
    const connCatalog = await connectorWireTools().catch(() => [] as ConnectorWireDef[]);
    const connDefs = mode === "code"
      ? []
      : await selectConnectorTools(ask, connCatalog).catch(() => connCatalog.slice(0, 24));

    // 4. Pod + bridge, in parallel — neither depends on the other.
    const knownTools = new Set([...defs.map((d) => d.name), ...connDefs.map((d) => d.name)]);
    const [podUrl, surface] = await Promise.all([
      ensurePod(),
      lendToolSurface({
        wc,
        signal: ctrl.signal,
        ...(runWorkdir ? { workdir: runWorkdir } : {}),
        defs,
        connDefs,
        // Lent-tool activity is reported HERE, in full fidelity (gate title,
        // denial, failure, preview) — the pod's own frames for the same calls
        // are suppressed below so the renderer sees each tool exactly once.
        onTool: (e) => emit("glyphh-agent:tool", e as unknown as Record<string, unknown>),
      }),
    ]);
    lent = surface;

    // 5. Start the run and translate its frames. The model is the user's pick,
    //    already constrained to what their workspace allows (loop-selections);
    //    an unresolved one lets the pod fall back to its own default.
    const model = await runModel("default").catch(() => null);
    const pod = getClient().harness({ url: podUrl });
    const run = pod.start({
      prompt: lastUser,
      system,
      // The CLIENT's chat id on both axes: `threadId` scopes the transcript,
      // `sessionId` keys the pod's per-session workspace + agent config home
      // (auth-off means no token binding to inherit one from).
      threadId: chatId || undefined,
      sessionId: chatId || undefined,
      mode,
      permission: glyphhMode(),
      ...(model ? { model } : {}),
      // The SESSION'S REAL FOLDER as the run's cwd. A LOCAL (auth-off,
      // loopback) pod honours this and anchors its OWN preset tools —
      // Bash/Read/Edit/Glob/Grep — there; a cloud pod 400s the field, which is
      // exactly the boundary we want. Without it those tools worked inside the
      // pod's empty sandbox while the user's folder sat untouched.
      ...(runWorkdir ? { workdir: runWorkdir } : {}),
      // Pasted screenshots as vision blocks ahead of the prompt text. Pod-side
      // caps (8 × ~7.5MiB) sit above the decoder's, so an accepted turn is
      // never one the pod rejects.
      ...(images.length ? { images } : {}),
      gatewayUrl: `${SERVER_URL}/api/gateway`,
      runtimeToken,
      mcpServers: [{ name: surface.name, url: surface.url, headers: surface.headers }],
      signal: ctrl.signal,
    });

    run.on((frame: HarnessWireFrame) => {
      switch (frame.type) {
        case "delta":
          finalText += frame.delta;
          emit("glyphh-agent:delta", { delta: frame.delta });
          return;
        case "tool": {
          // Our own lent tools already reported themselves (start AND done)
          // through the bridge, with the gate's title and denial state — which
          // the pod cannot see. Drop its echo.
          if (frame.name.startsWith(BRIDGE_TOOL_PREFIX)) return;
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
          // The pod gates its OWN sandbox tools; the desktop gates the lent
          // ones inside executeGlyphhTool. A lent tool falls into the pod's
          // unknown-tool bucket, whose card title IS the bare tool name — let
          // it through so the user sees ONE card (the desktop's), not two.
          if (knownTools.has(frame.title)) { void run.answer(frame.id, { allow: true }); return; }
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
    for (const cancel of cancelPauses) cancel();
    lent?.release();
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
