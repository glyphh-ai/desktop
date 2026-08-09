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
import { harnessRun, type RunSource } from "./glyphh-harness-run.js";
import { answerRemotePause } from "./glyphh-agent-permissions.js";
import type { ChatMessage } from "./glyphh-agent-prompt.js";

/** Live run controllers, by runId — so `agent.stop` can abort. */
const controllers = new Map<string, AbortController>();

/** Translate one `glyphh-agent:*` emit into a HarnessWireFrame (the shape the
 *  mobile's remote-run consumer already speaks). Returns null for events with no
 *  wire mapping. `data` already carries the emit payload (minus seq/runId/at). */
function toWireFrame(channel: string, data: Record<string, unknown>, seq: number, runId: string): Record<string, unknown> | null {
  const base = { seq, runId, at: Date.now() };
  switch (channel) {
    case "glyphh-agent:delta": return { ...base, type: "delta", delta: data.delta ?? "" };
    case "glyphh-agent:tool": return { ...base, ...data, type: "tool" };
    case "glyphh-agent:progress": return { ...base, type: "progress", inTokens: data.inTokens ?? 0, outTokens: data.outTokens ?? 0 };
    case "glyphh-agent:credits": return { ...base, type: "credits", creditsMicro: data.creditsMicro ?? 0 };
    case "glyphh-agent:approval": return { ...base, type: "approval", id: data.id, kind: data.kind, title: data.title, detail: data.detail };
    case "glyphh-agent:ask": return { ...base, type: "ask", id: data.id, questions: data.questions };
    case "glyphh-agent:setup": return { ...base, ...data, type: "setup" };
    case "glyphh-agent:done": return { ...base, type: "done", stopped: !!data.stopped };
    case "glyphh-agent:error": return { ...base, type: "error", error: data.error ?? "run failed" };
    default: return null;
  }
}

/** A fake WebContents whose `send` forwards harnessRun's frames up the socket. */
function makeSink(runId: string): WebContents {
  let seq = 0;
  const sink = {
    isDestroyed: () => false,
    send: (channel: string, data: Record<string, unknown>) => {
      const frame = toWireFrame(channel, data ?? {}, seq++, runId);
      if (frame) pushToAttach(`run:${runId}`, frame);
    },
  };
  return sink as unknown as WebContents;
}

/** Build the turn's messages from the caller's history (or just the prompt). */
function baseMessages(params: Record<string, unknown>, prompt: string): ChatMessage[] {
  const hist = Array.isArray(params.messages) ? params.messages : null;
  if (hist && hist.length) {
    return hist
      .map((m) => {
        const mm = (m ?? {}) as Record<string, unknown>;
        const role: ChatMessage["role"] = mm.role === "user" ? "user" : "assistant";
        const content = typeof mm.text === "string" ? mm.text : (typeof mm.content === "string" ? mm.content : "");
        return { role, content };
      })
      .filter((m) => m.content);
  }
  return [{ role: "user", content: prompt }];
}

export function installAttachRunHandlers(): void {
  // agent.run {runId, prompt, messages?, mode?, workdir?} → run locally + stream.
  registerRelayHandler("agent.run", async (params) => {
    const p = (params ?? {}) as Record<string, unknown>;
    const runId = typeof p.runId === "string" && p.runId ? p.runId : `rl-${Date.now().toString(36)}`;
    const prompt = typeof p.prompt === "string" ? p.prompt : "";
    if (!prompt && !Array.isArray(p.messages)) throw new Error("agent.run requires { prompt } or { messages }");
    const mode: "cowork" | "code" = p.mode === "cowork" ? "cowork" : "code";
    const workdir = typeof p.workdir === "string" && p.workdir ? p.workdir : undefined;
    const source = { kind: "local", ...(workdir ? { path: workdir } : {}) } as RunSource;
    const ctrl = new AbortController();
    controllers.set(runId, ctrl);
    const sink = makeSink(runId);
    // Fire-and-forget: frames stream via pushToAttach. Ack the runId immediately
    // so the caller knows the run is live (it already subscribed to run:<runId>).
    void harnessRun(sink, runId, baseMessages(p, prompt), ctrl, [], runId, workdir, mode, source)
      .catch((err) => { try { sink.send("glyphh-agent:error", { error: err instanceof Error ? err.message : String(err) }); } catch { /* socket gone */ } })
      .finally(() => { controllers.delete(runId); });
    return { runId, started: true };
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
}
