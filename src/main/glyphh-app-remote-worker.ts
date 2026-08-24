/**
 * glyphh-app-remote-worker — run a handler-backed app tool on the org's
 * REGIONAL rrotor pod instead of this machine's hidden worker window.
 *
 * The spec's one-execution-home rule (server/docs/app-runtime-spec.md,
 * "Distribution and execution home"): panels render anywhere, but an app's
 * WORKER and SCHEDULES run in exactly one place. When an org app's
 * `executionHome` is "regional", the desktop stands down (glyphh-app-services
 * disarms cron + worker) and tool calls that need the worker travel HERE:
 *
 *   POST {runtimeUrl}/app-worker/invoke  { slug, handler, args }
 *   Authorization: Bearer <the user's own gy_at_ access token>
 *
 * The pod introspects the bearer, binds the caller's org, mints the app's
 * gy_wk_ worker token, materializes the bundle, and runs the handler in its vm
 * sandbox (the rail server/scripts/e2e-app-worker.mjs proves end to end). Its
 * failures are TYPED ({ error: kind, detail } — rrotor/src/app-worker/
 * service.ts classifyWorkerError) and mapped below onto the EXACT error shapes
 * the local worker path throws, so panels and the agent's tool seam cannot
 * tell where the worker ran.
 */

import { app } from "electron";
import { getClient } from "./glyphh-client.js";
import { loadSessions } from "./glyphh-agent-context.js";

/** Local parity: the pod's 60s handler cap plus slack so the pod's own typed
 *  timeout (which carries the handler name) arrives before ours fires. */
const REMOTE_INVOKE_TIMEOUT_MS = 65_000;

/**
 * Where the org's regional runtime lives, as far as this machine knows:
 *
 *   1. an explicit env override (`GLYPHH_APP_RUNTIME_URL` / `GLYPHH_RUNTIME_URL`
 *      / `RUNTIME_URL`) — ops and tests;
 *   2. the newest cloud-session binding (glyphh-harness-run.ts bindRuntime
 *      persists `chat.runtime.url` = session.runtimeUrl from sessions.create);
 *   3. a DEV checkout falls back to the runtime-compose rrotor on :8080 —
 *      the pod the e2e drives. A packaged build never guesses.
 */
export function regionalRuntimeUrl(): string | null {
  const env = process.env.GLYPHH_APP_RUNTIME_URL || process.env.GLYPHH_RUNTIME_URL || process.env.RUNTIME_URL;
  if (env && env.trim()) return env.trim().replace(/\/+$/, "");
  try {
    const { chats } = loadSessions();
    for (let i = chats.length - 1; i >= 0; i--) {
      const url = (chats[i] as { runtime?: { url?: string } }).runtime?.url;
      if (url) return url.replace(/\/+$/, "");
    }
  } catch { /* sessions unreadable — fall through */ }
  if (!app.isPackaged) return "http://127.0.0.1:8080";
  return null;
}

/** The pod's typed failure kinds (rrotor classifyWorkerError + server.ts). */
type PodErrorKind =
  | "timeout" | "capability-denied" | "not-installed" | "forbidden"
  | "no-handler" | "invoke-error" | "not-found" | string;

/**
 * Map a pod refusal onto the LOCAL path's error shapes — the whole point is
 * that a panel showing `handler "x" timed out after 60s` or `unknown app: y`
 * reads identically wherever the worker ran:
 *   timeout           → invokeAppWorkerHandler's timeout message
 *   capability-denied → the grant wall's own phrase (pod speaks desktop parity)
 *   not-installed     → findAppRow's `unknown app: <slug>`
 *   no-handler        → the worker preload's `no handler registered: <name>`
 */
function mapPodWorkerError(
  kind: PodErrorKind | undefined,
  detail: string | undefined,
  ctx: { slug: string; handler: string; status: number; timeoutMs: number },
): Error {
  const d = (detail ?? "").trim();
  switch (kind) {
    case "timeout":
      return new Error(`handler "${ctx.handler}" timed out after ${Math.round(ctx.timeoutMs / 1000)}s`);
    case "capability-denied":
      // Already the desktop's phrasing ("capability not granted: m",
      // "connector not declared in manifest: c") — pass it through.
      return new Error(d || `capability not granted`);
    case "not-installed":
      return new Error(`unknown app: ${ctx.slug}`);
    case "no-handler":
      return new Error(`no handler registered: ${ctx.handler}`);
    case "not-found":
      // The pod exists but does not run app workers (ROTOR_APP_WORKERS off).
      return new Error(
        `the cloud runtime does not run app workers — switch "${ctx.slug}" back to "This machine" on the Apps page, or point at a pod with app workers enabled`,
      );
    default:
      // forbidden / invoke-error / anything else: the pod's detail is the
      // truth; "handler failed" is the local path's generic shape.
      return new Error(d || `handler failed (HTTP ${ctx.status})`);
  }
}

/**
 * Invoke one worker handler on the regional pod with the user's own session
 * bearer. Mirrors invokeAppWorkerHandler's contract: resolves the handler's
 * result, rejects with the same error shapes the local worker path produces.
 */
export async function invokeRegionalAppHandler(
  slug: string,
  handler: string,
  args: Record<string, unknown>,
  timeoutMs = REMOTE_INVOKE_TIMEOUT_MS,
): Promise<unknown> {
  const base = regionalRuntimeUrl();
  if (!base) {
    throw new Error(
      `app "${slug}" runs on the cloud runtime, but no runtime is reachable from this machine — open a cloud session first (or set GLYPHH_RUNTIME_URL)`,
    );
  }
  const token = await getClient().token();
  if (!token) {
    throw new Error(`sign in to use "${slug}" — its worker runs on the cloud runtime and needs your access token`);
  }

  let res: Response;
  try {
    res = await fetch(`${base}/app-worker/invoke`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ slug, handler, args: args ?? {} }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    const name = (err as Error)?.name;
    if (name === "TimeoutError" || name === "AbortError") {
      // The local path's timeout shape — a hung pod reads like a hung worker.
      throw new Error(`handler "${handler}" timed out after ${Math.round(timeoutMs / 1000)}s`);
    }
    throw new Error(`the cloud runtime at ${base} is unreachable: ${err instanceof Error ? err.message : String(err)}`);
  }

  const body = (await res.json().catch(() => null)) as
    | { ok?: boolean; result?: unknown; error?: string; detail?: string }
    | null;
  if (res.ok && body?.ok) return body.result ?? null;
  throw mapPodWorkerError(body?.error, body?.detail, { slug, handler, status: res.status, timeoutMs });
}
