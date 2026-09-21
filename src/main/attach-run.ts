/**
 * attach-run.ts — run a Glyphh agent turn ON THIS MACHINE, driven from the
 * server over the attach socket, streaming HarnessWireFrames back up
 * (RELAY-RESEARCH.md §4). The web/mobile client cannot drive the machine
 * directly, so it dispatches `agent.run` here.
 *
 * The engine is the CLI bridge (glyphh-cli-bridge.ts), the same `claude`
 * subprocess the Agent panel runs, fed a SINK (a fake WebContents) that
 * translates its `glyphh-agent:*` events into wire frames and pushes them on
 * the run's channel (`run:<runId>`). The caller's threadId is the chat, so a
 * relayed conversation continues across turns through the CLI's own session.
 *
 * Answers to parked approvals arrive as `agent.answer {id, allow}`;
 * `agent.stop {runId}` interrupts; `agent.permission {runId, permission}`
 * flips the mode mid-flight. A per-run frame RING backs `agent.frames` so a
 * phone that dropped its stream can replay and re-tail.
 */
import type { WebContents } from "electron";
import { registerRelayHandler } from "./relay-client.js";
import { pushToAttach } from "./attach-host.js";
import { runAgentTurn, stopAgentChat, setAgentPermission, respondAgentApproval } from "./glyphh-cli-bridge.js";
import { toWireFrame, turnText, relayPermission } from "./attach-run-frames.js";

interface RunRecord { frames: Array<Record<string, unknown> & { seq: number }>; status: "running" | "done" | "error"; chatId: string }
const RING_CAP = 4000;
const RING_TTL_AFTER_END_MS = 10 * 60_000;
const rings = new Map<string, RunRecord>();

function str(params: unknown, key: string): string {
  const v = (params as Record<string, unknown> | null)?.[key];
  return typeof v === "string" ? v : "";
}

/** A fake WebContents whose `send` forwards the bridge's frames up the socket
 *  AND retains them on the run's ring for reattach. */
function makeSink(runId: string, chatId: string): WebContents {
  let seq = 0;
  const rec: RunRecord = { frames: [], status: "running", chatId };
  rings.set(runId, rec);
  const sink = {
    isDestroyed: () => false,
    send: (channel: string, data: Record<string, unknown>) => {
      const frame = toWireFrame(channel, { ...(data ?? {}), runId }, seq++, runId);
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
  registerRelayHandler("agent.run", async (params) => {
    const p = (params ?? {}) as Record<string, unknown>;
    const runId = str(p, "runId") || `rl-${Date.now().toString(36)}`;
    // The STABLE transcript thread (the caller's chat id) is the chat: the CLI
    // session binds to it, so a relayed conversation remembers across turns.
    const chatId = str(p, "threadId") || runId;
    const prompt = str(p, "prompt");
    if (!prompt && !Array.isArray(p.messages)) throw new Error("agent.run requires { prompt } or { messages }");
    const text = turnText(p, prompt);
    const sink = makeSink(runId, chatId);
    sink.send("glyphh-agent:prompt", { text });
    // The RELAYING client's permission, loop and model win over this machine's
    // own: the run is theirs. Absent, the bridge falls back to its defaults.
    void runAgentTurn(sink, {
      chatId, prompt: text,
      ...(relayPermission(p.permission) ? { permission: relayPermission(p.permission) } : {}),
      ...(str(p, "model") ? { model: str(p, "model") } : {}),
      ...(str(p, "loop") ? { loop: str(p, "loop") } : {}),
      ...(str(p, "workdir") ? { workdir: str(p, "workdir") } : {}),
    }).catch((err) => { try { sink.send("glyphh-agent:error", { error: err instanceof Error ? err.message : String(err) }); sink.send("glyphh-agent:done", { stopped: true }); } catch { /* gone */ } });
    return { runId, started: true };
  });

  registerRelayHandler("agent.frames", async (params) => {
    const p = (params ?? {}) as Record<string, unknown>;
    const runId = str(p, "runId");
    const from = typeof p.from === "number" && Number.isFinite(p.from) ? p.from : -1;
    const rec = rings.get(runId);
    if (!rec) return { runId, status: "gone", frames: [] };
    return { runId, status: rec.status, frames: rec.frames.filter((f) => f.seq > from) };
  });

  registerRelayHandler("agent.answer", async (params) => {
    const p = (params ?? {}) as Record<string, unknown>;
    const id = str(p, "id");
    if (!id) throw new Error("agent.answer requires { id }");
    return { answered: respondAgentApproval(id, p.allow === true) };
  });

  registerRelayHandler("agent.stop", async (params) => {
    const runId = str(params, "runId");
    const rec = rings.get(runId);
    return { stopped: rec ? stopAgentChat(rec.chatId) : false };
  });

  registerRelayHandler("agent.permission", async (params) => {
    const runId = str(params, "runId");
    const permission = relayPermission((params as Record<string, unknown> | null)?.permission);
    if (!runId || !permission) throw new Error("agent.permission requires { runId, permission }");
    const rec = rings.get(runId);
    return { updated: rec ? setAgentPermission(rec.chatId, permission) : false };
  });
}
