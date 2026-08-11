/**
 * attach-run.ts — run a Glyphh agent turn ON THIS MACHINE, driven from the cloud
 * over the attach socket, streaming the run's HarnessWireFrames back up.
 *
 * The web/mobile client cannot drive the local harness directly, so it dispatches
 * `agent.run` here. We run the SAME on-machine harness the desktop uses
 * (`harnessRun`), but feed it a SINK (a fake WebContents) that translates its
 * `glyphh-agent:*` events into the exact wire frames the mobile UI already reads
 * (delta / tool / approval / ask / credits / progress / done / error) and
 * `pushToAttach()`es them on the run's channel (`run:<runId>`). The cloud relays
 * those pushes to the subscribed web client (the same panel-relay path the
 * screencast uses).
 *
 * Answers to parked approvals/asks arrive as `agent.answer {id, allow?, answers?}`;
 * `agent.stop {runId}` aborts the run. The caller mints the runId and subscribes
 * BEFORE dispatching `agent.run`, so no frame is missed.
 */
import type { WebContents } from "electron";
import { registerRelayHandler } from "./relay-client.js";
import { pushToAttach } from "./attach-client.js";
import { harnessRun, setRunPermission, type RunSource } from "./glyphh-harness-run.js";
import { answerRemotePause } from "./glyphh-agent-permissions.js";
import { toWireFrame, baseMessages } from "./attach-run-frames.js";

/** Live run controllers, by runId — so `agent.stop` can abort. */
const controllers = new Map<string, AbortController>();

/** Per-run frame RING — the relay path's reattach store. A phone that leaves a
 *  session (backgrounded Safari, SPA nav) drops its SSE; when it reopens the
 *  session it replays `agent.frames {runId, from}` from here and tails live
 *  pushes again. In-memory and bounded: this machine is the run's only home, so
 *  the ring lives exactly as long as reattach is useful (terminal + grace). */
interface RunRecord { frames: Array<Record<string, unknown> & { seq: number }>; status: "running" | "done" | "error" }
const RING_CAP = 4000;
const RING_TTL_AFTER_END_MS = 10 * 60_000;
const rings = new Map<string, RunRecord>();

/** A fake WebContents whose `send` forwards harnessRun's frames up the socket
 *  AND retains them on the run's ring for reattach. */
function makeSink(runId: string): WebContents {
  let seq = 0;
  const rec: RunRecord = { frames: [], status: "running" };
  rings.set(runId, rec);
  const sink = {
    isDestroyed: () => false,
    send: (channel: string, data: Record<string, unknown>) => {
      const frame = toWireFrame(channel, data ?? {}, seq++, runId);
      if (!frame) return;
      rec.frames.push(frame as Record<string, unknown> & { seq: number });
      if (rec.frames.length > RING_CAP) rec.frames.splice(0, rec.frames.length - RING_CAP);
      const t = (frame as { type?: string }).type;
      if (t === "done" || t === "error") {
        rec.status = t === "done" ? "done" : "error";
        const timer = setTimeout(() => rings.delete(runId), RING_TTL_AFTER_END_MS);
        (timer as { unref?: () => void }).unref?.();
      }
      pushToAttach(`run:${runId}`, frame);
    },
  };
  return sink as unknown as WebContents;
}

export function installAttachRunHandlers(): void {
  // agent.run {runId, prompt, messages?, mode?, workdir?} → run locally + stream.
  registerRelayHandler("agent.run", async (params) => {
    const p = (params ?? {}) as Record<string, unknown>;
    const runId = typeof p.runId === "string" && p.runId ? p.runId : `rl-${Date.now().toString(36)}`;
    // The STABLE transcript thread (the caller's chat id). harnessRun keys the
    // pod's thread + per-session home by this, so a relayed session remembers
    // across turns. Falls back to the per-turn runId only for old callers.
    const threadId = typeof p.threadId === "string" && p.threadId ? p.threadId : runId;
    const prompt = typeof p.prompt === "string" ? p.prompt : "";
    if (!prompt && !Array.isArray(p.messages)) throw new Error("agent.run requires { prompt } or { messages }");
    const mode: "cowork" | "code" = p.mode === "cowork" ? "cowork" : "code";
    const workdir = typeof p.workdir === "string" && p.workdir ? p.workdir : undefined;
    const source = { kind: "local", ...(workdir ? { path: workdir } : {}) } as RunSource;
    // The RELAYING client's permission mode MUST be honored — the run is theirs, not
    // this machine's. Absent ⇒ harnessRun falls back to the desktop's own mode.
    const PERMS = ["ask", "plan", "acceptEdits", "auto", "bypass"] as const;
    const permission = (PERMS as readonly string[]).includes(p.permission as string)
      ? (p.permission as (typeof PERMS)[number])
      : undefined;
    const ctrl = new AbortController();
    controllers.set(runId, ctrl);
    const sink = makeSink(runId);
    // Fire-and-forget: frames stream via pushToAttach. Ack the runId immediately
    // so the caller knows the run is live (it already subscribed to run:<runId>).
    void harnessRun(sink, runId, baseMessages(p, prompt), ctrl, [], threadId, workdir, mode, source, permission)
      .catch((err) => { try { sink.send("glyphh-agent:error", { error: err instanceof Error ? err.message : String(err) }); } catch { /* socket gone */ } })
      .finally(() => { controllers.delete(runId); });
    return { runId, started: true };
  });

  // agent.frames {runId, from?} → replay the run's ring for a reattaching
  // client: frames with seq > from, plus the run's status. Unknown run (never
  // ran here, or the post-terminal grace expired) → status "gone".
  registerRelayHandler("agent.frames", async (params) => {
    const p = (params ?? {}) as Record<string, unknown>;
    const runId = typeof p.runId === "string" ? p.runId : "";
    const from = typeof p.from === "number" && Number.isFinite(p.from) ? p.from : -1;
    const rec = rings.get(runId);
    if (!rec) return { runId, status: "gone", frames: [] };
    return { runId, status: rec.status, frames: rec.frames.filter((f) => f.seq > from) };
  });

  // agent.answer {id, allow?, answers?} → resolve a parked approval/ask.
  registerRelayHandler("agent.answer", async (params) => {
    const p = (params ?? {}) as Record<string, unknown>;
    const id = typeof p.id === "string" ? p.id : "";
    if (!id) throw new Error("agent.answer requires { id }");
    const reply = {
      ...(typeof p.allow === "boolean" ? { allow: p.allow } : {}),
      ...(Array.isArray(p.answers) ? { answers: p.answers.map(String) } : {}),
    };
    return { answered: answerRemotePause(id, reply) };
  });

  // agent.stop {runId} → abort a live run.
  registerRelayHandler("agent.stop", async (params) => {
    const runId = typeof (params as Record<string, unknown>)?.runId === "string" ? (params as Record<string, unknown>).runId as string : "";
    const ctrl = controllers.get(runId);
    if (ctrl) ctrl.abort();
    return { stopped: !!ctrl };
  });

  // agent.permission {runId, permission} → change a live run's permission mode.
  // A remote surface (web/mobile) flipped the mode chip while its turn runs ON
  // this machine; push it to the run's pod so the gate re-evaluates the next
  // action under the new mode. Unknown/finished run → { updated: false }.
  registerRelayHandler("agent.permission", async (params) => {
    const p = (params ?? {}) as Record<string, unknown>;
    const runId = typeof p.runId === "string" ? p.runId : "";
    const PERMS = ["ask", "plan", "acceptEdits", "auto", "bypass"] as const;
    const permission = (PERMS as readonly string[]).includes(p.permission as string) ? (p.permission as (typeof PERMS)[number]) : null;
    if (!runId || !permission) throw new Error("agent.permission requires { runId, permission }");
    return { updated: await setRunPermission(runId, permission) };
  });
}
