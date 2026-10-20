/**
 * attach-run-frames — the PURE frame helpers for the relay run (attach-run.ts):
 * translate a local `glyphh-agent:*` event into a HarnessWireFrame, and build a
 * turn's messages from the caller's params. No Electron imports, so these are
 * unit-testable in a plain node env (test/main/attach-run-frames.test.ts).
 */

export interface RelayChatMessage { role: "system" | "user" | "assistant"; content: string }

/** Translate one `glyphh-agent:*` emit into a HarnessWireFrame (the shape the
 *  mobile's remote-run consumer already speaks). Returns null for events with no
 *  wire mapping. `data` carries the emit payload (minus seq/runId/at). */
export function toWireFrame(channel: string, data: Record<string, unknown>, seq: number, runId: string, now: number = Date.now()): Record<string, unknown> | null {
  const base = { seq, runId, at: now };
  // A SUB-AGENT's frames ride the wire WITH their `agent` tag, so they never
  // land in the parent's bubble — every consumer keys on the tag (code.ts
  // isChildFrame).
  const tag = data.agent && typeof data.agent === "object" ? { agent: data.agent } : {};
  switch (channel) {
    // The user's prompt as the FIRST frame of a run, so an observing surface
    // renders the turn's user message.
    case "glyphh-agent:prompt": return { ...base, type: "prompt", text: data.text ?? "" };
    case "glyphh-agent:delta": return { ...base, type: "delta", delta: data.delta ?? "", ...tag };
    // The model's thinking: the fold above the answer (code.ts thinkingEl).
    case "glyphh-agent:thinking": return { ...base, type: "thinking", text: data.text ?? "", ...tag };
    case "glyphh-agent:tool": return { ...base, ...data, type: "tool" };
    // A sub-agent's life: `start` (who, on what model, asked what) and `done`
    // (how it ended).
    case "glyphh-agent:agent": {
      if (!data.agent || typeof data.agent !== "object") return null;
      return {
        ...base, type: "agent", phase: data.phase === "done" ? "done" : "start", agent: data.agent,
        ...(data.task !== undefined ? { task: data.task } : {}),
        ...(data.failed !== undefined ? { failed: !!data.failed } : {}),
        ...(data.summary !== undefined ? { summary: data.summary } : {}),
      };
    }
    case "glyphh-agent:progress": return { ...base, type: "progress", inTokens: data.inTokens ?? 0, outTokens: data.outTokens ?? 0 };
    // The contract's credits frame carries DOLLARS (credits are dead, 2026-09-20).
    case "glyphh-agent:credits": return { ...base, type: "credits", usd: Number(data.usd ?? 0) || 0 };
    case "glyphh-agent:approval": return { ...base, type: "approval", id: data.id, kind: data.kind, title: data.title, detail: data.detail, ...tag };
    case "glyphh-agent:ask": return { ...base, type: "ask", id: data.id, questions: data.questions };
    case "glyphh-agent:setup": return { ...base, ...data, type: "setup" };
    case "glyphh-agent:permission": return { ...base, type: "permission", permission: data.permission };
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

/** The last user message of a relayed history, or the prompt: what the CLI is sent this turn. */
export function turnText(params: Record<string, unknown>, prompt: string): string {
  const msgs = baseMessages(params, prompt);
  const last = [...msgs].reverse().find((m) => m.role === "user");
  return last?.content ?? prompt;
}

export const PERMISSIONS = ["ask", "plan", "acceptEdits", "auto"] as const;
export type RelayPermission = (typeof PERMISSIONS)[number];

/** The relaying client's permission mode; "bypass" is retired and means auto; anything else is "not given". */
export function relayPermission(raw: unknown): RelayPermission | undefined {
  const v = raw === "bypass" ? "auto" : raw;
  return (PERMISSIONS as readonly string[]).includes(v as string) ? (v as RelayPermission) : undefined;
}

/** The relay sinks: the fake WebContents a relayed run (attach-run.ts) streams
 *  into. Marked here so the loop can tell a relay's originator from a panel. */
const relaySinks = new WeakSet<object>();
export function markRelaySink(sink: object): void { relaySinks.add(sink); }
export function isRelaySink(sink: object | null | undefined): boolean { return !!sink && relaySinks.has(sink); }

/** Where a turn's frames go. A panel that adopts a run REPLACES the panel that
 *  started it (the thread moved windows). A RELAY sink is different: it is the
 *  web or the phone that asked for the turn, and a desktop panel opening the
 *  same thread must not take the frames away from it (his report, 2026-10-04:
 *  "the stream worked sending to the desktop but the route back did not"). So
 *  a relay originator always stays a target, and the adopter is added beside it. */
export function frameTargets<T extends object>(origin: T, adopted: T | undefined): T[] {
  if (!adopted || adopted === origin) return [origin];
  return isRelaySink(origin) ? [origin, adopted] : [adopted];
}

