/**
 * run-frames.ts — the agent run's frame vocabulary, pure: what a turn streams
 * (HarnessWireFrame), the sub-agent tags on it, where an `open-app` frame
 * points, and how long a parked approval or question waits before the loop
 * decides for the user (main's own gate uses the same numbers).
 */

/** The permission modes — verbatim from MODES in code.ts. */
export type RemotePermission = "ask" | "plan" | "acceptEdits" | "auto";

/** A harness frame as it rides `glyphh.harness/v1` (SDK contract/harness.ts —
 *  itself the desktop's glyphh-agent frame vocabulary, enveloped). */
export type HarnessWireFrame = (
  | { type: "prompt"; text: string }
  | { type: "open-app"; ref?: string; url?: string }
  /** A task program's ctx.log line (2026-10-07). */
  | { type: "log"; message: string; detail?: unknown }
  | { type: "delta"; delta: string }
  | { type: "thinking"; text: string }
  | { type: "tool"; phase: "start" | "done"; name: string; thought?: string; title?: string; denied?: boolean; failed?: boolean; preview?: string; detail?: unknown; input?: string; output?: string }
  | { type: "agent"; phase: "start" | "done"; agent: SubAgentRef; task?: string; failed?: boolean; summary?: string }
  | { type: "progress"; inTokens: number; outTokens: number }
  | { type: "credits"; usd: number }
  | { type: "approval"; id: string; kind: string; title: string; detail: string }
  | { type: "ask"; id: string; questions: Array<{ question: string; options?: string[] }> }
  | { type: "setup"; phase: string }
  | { type: "permission"; permission: RemotePermission }
  | { type: "done"; stopped: boolean }
  | { type: "error"; error: string }
) & { seq: number; runId: string; at: number; /** Set on a SUB-AGENT's frame: whose feed it belongs to. */ agent?: SubAgentRef };

/** A sub-agent as the engine names it on every frame of its work. */
export interface SubAgentRef { childId: string; slug: string; name: string; model: string }

/** How long the loop waits before deciding FOR the user — identical to main's
 *  local gate, so the dock's countdown is honest. */
export const APPROVAL_TIMEOUT_MS = 120_000;
export const ASK_TIMEOUT_MS = 10 * 60_000;

/** What an `open-app` frame's `ref` names: `layout:<name>` is a saved
 *  workspace, `settings:<page>` a Settings page, anything else an app slug (a
 *  house slug opens its house panel). */
export type OpenRef = { kind: "layout"; name: string } | { kind: "settings"; page: string } | { kind: "app"; slug: string };

export function parseOpenRef(ref: string): OpenRef | null {
  const r = ref.trim();
  if (!r) return null;
  const m = /^(layout|settings):(.*)$/i.exec(r);
  if (!m) return { kind: "app", slug: r };
  const rest = m[2]!.trim();
  if (!rest) return null;
  return m[1]!.toLowerCase() === "layout" ? { kind: "layout", name: rest } : { kind: "settings", page: rest.toLowerCase() };
}
