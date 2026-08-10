/**
 * attach-run-frames — the PURE frame helpers for the relay run (attach-run.ts):
 * translate a local `glyphh-agent:*` event into a HarnessWireFrame, and build a
 * turn's messages from the caller's params. No Electron / harness imports, so
 * these are unit-testable in a plain node env (see test/main/attach-run-frames.test.ts).
 */

export interface RelayChatMessage { role: "system" | "user" | "assistant"; content: string }

/** Translate one `glyphh-agent:*` emit into a HarnessWireFrame (the shape the
 *  mobile's remote-run consumer already speaks). Returns null for events with no
 *  wire mapping. `data` carries the emit payload (minus seq/runId/at). */
export function toWireFrame(channel: string, data: Record<string, unknown>, seq: number, runId: string, now: number = Date.now()): Record<string, unknown> | null {
  const base = { seq, runId, at: now };
  switch (channel) {
    // The user's prompt as the FIRST frame of a run — lets a surface observing this run
    // render the turn's user message (it isn't in the assistant frame stream otherwise).
    case "glyphh-agent:prompt": return { ...base, type: "prompt", text: data.text ?? "" };
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

/** Build the turn's messages from the caller's history (or just the prompt). */
export function baseMessages(params: Record<string, unknown>, prompt: string): RelayChatMessage[] {
  const hist = Array.isArray(params.messages) ? params.messages : null;
  if (hist && hist.length) {
    return hist
      .map((m) => {
        const mm = (m ?? {}) as Record<string, unknown>;
        const role: RelayChatMessage["role"] = mm.role === "user" ? "user" : "assistant";
        const content = typeof mm.text === "string" ? mm.text : (typeof mm.content === "string" ? mm.content : "");
        return { role, content };
      })
      .filter((m) => m.content);
  }
  return [{ role: "user", content: prompt }];
}
