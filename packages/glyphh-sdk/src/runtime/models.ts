/**
 * runtime/models.ts — the governed SDK↔rrotor MODEL bridge (Node-only). Resolves a
 * LOOP's slot→model resolution — `loops.roles`, the very call the desktop's agent and
 * every model picker read, so a chip can never show a model the run won't use — into
 * the endpoint map rrotor injects. Every endpoint is the METERING GATEWAY with the
 * caller's bearer: the exact transport the desktop runs turns through. Plus per-session
 * model SWITCHING with an audit trail — an in-process override store the next
 * `resolveModels` layers on, so opus→haiku→opus is both live and fully auditable.
 *
 * The gateway is untouched: it already meters proxied calls WITH the model server-side,
 * so spend attribution needs no change here.
 */

import type { Client } from "../client.js";
import type { ModelSwitchSurface } from "../contract/runtime.js";

/**
 * A runtime-agnostic model endpoint. Structurally matches rrotor's `ModelEndpoint`
 * (its `BasicModelsOptions.registry` value) — the CLI passes `{ registry }` straight to
 * `runInProcess({ models })`. Defined here so the SDK never imports rrotor.
 */
export interface ModelEndpoint {
  /** Endpoint base url — the runtime appends the provider path (`/v1/messages` or
   *  `/v1/chat/completions`), so the gateway root goes here. */
  url: string;
  /** Wire the endpoint speaks. Anthropic models are relayed verbatim; everything
   *  else goes through the gateway's OpenAI-compatible face. */
  provider?: "anthropic" | "openai";
  /** The provider model id to send (catalog id stripped of its `provider::` prefix). */
  model?: string;
  /** Per-request headers — the caller's bearer for gateway roles. */
  headers?: Record<string, string>;
  /** Metered (gateway) vs free. Gateway endpoints are always metered. */
  metered?: boolean;
}

/** The registry shape rrotor consumes, plus the loop's primary endpoint so a caller
 *  can alias it under its own rotor's role names (registry lookups are exact). */
export interface ResolvedModels {
  registry: Record<string, ModelEndpoint>;
  /** The first resolved slot's endpoint — the loop's primary model. */
  primary?: ModelEndpoint;
}

export interface ResolveModelsOptions {
  /** The loop whose resolved slots to run on (same `loops.roles` the pickers read). */
  loop: string;
  /** The caller's bearer, attached to every gateway endpoint. */
  token: string;
  /** The server base url — the metering gateway lives under `<server>/api/gateway`. */
  server: string;
  /**
   * Per-slot model selections layered into the server-side resolution (the same
   * `select=` the pickers preview with, so governance filters them there). Pass a
   * session's current overrides (see {@link sessionOverrides}) for live switches.
   */
  overrides?: Record<string, string>;
  /**
   * Where the resolved models will EXECUTE. "cloud" (a hosted pod) excludes
   * on-device models server-side — their weights only exist on a user's machine.
   * Defaults to "local" (the desktop's embedded runtime).
   */
  context?: "local" | "cloud";
}

/** Strip a catalog id's `provider::` prefix down to the bare model id. */
function bareId(modelId: string): string {
  const i = modelId.indexOf("::");
  return i === -1 ? modelId : modelId.slice(i + 2);
}

/**
 * Resolve `loop`'s slots into the endpoint map rrotor injects — THE DESKTOP'S PATH:
 * the model comes from `loops.roles` (governance enforced server-side: catalog ∩
 * org-supported ∩ workspace-allowed), and every call travels through the metering
 * gateway with the caller's bearer. Returns `undefined` when no slot resolves (the
 * rotor then streams its basic-tier stub) or the control plane is unreachable.
 */
export async function resolveModels(
  client: Client,
  opts: ResolveModelsOptions,
): Promise<ResolvedModels | undefined> {
  const { loop, token, server, overrides } = opts;
  let roles;
  try {
    roles = await client.tasks.roles(loop, overrides ?? {}, { context: opts.context ?? "local" });
  } catch {
    return undefined; // control plane doesn't know this loop / not reachable
  }

  // The runtime appends `/v1/messages` | `/v1/chat/completions` to this root —
  // landing exactly on the gateway endpoints the desktop's interceptor targets.
  const gateway = `${server.replace(/\/+$/, "")}/api/gateway`;
  const registry: Record<string, ModelEndpoint> = {};
  let primary: ModelEndpoint | undefined;
  for (const r of roles) {
    if (!r.modelId) continue;
    const ep: ModelEndpoint = {
      url: gateway,
      provider: r.modelId.startsWith("anthropic::") ? "anthropic" : "openai",
      model: bareId(r.modelId),
      headers: { authorization: `Bearer ${token}` },
      metered: true,
    };
    registry[r.name] = ep;
    primary ??= ep;
  }
  return primary ? { registry, primary } : undefined;
}

// ── Per-session model switching + audit ──────────────────────────────────────
//
// The runtime is one process, so overrides live in a simple in-memory map and need not
// persist. Keyed sessionId → rotorSlug → { role: catalog modelId }.

const overridesStore = new Map<string, Map<string, Record<string, string>>>();

/** A snapshot of a session+rotor's current overrides — pass into `resolveModels`. */
export function sessionOverrides(sessionId: string, rotorSlug: string): Record<string, string> {
  return { ...(overridesStore.get(sessionId)?.get(rotorSlug) ?? {}) };
}

/** Drop every override for a session (e.g. on session end). */
export function clearSessionOverrides(sessionId: string): void {
  overridesStore.delete(sessionId);
}

export interface SwitchModelOptions {
  sessionId: string;
  /** The rotor whose role is being re-bound. */
  rotorSlug: string;
  /** The role to switch (e.g. "planner"). */
  role: string;
  /** The catalog model id to switch TO. */
  to: string;
  /** The model id being switched FROM, if known (for the audit trail). */
  from?: string;
  /** The surface the switch was driven from. */
  surface: ModelSwitchSurface;
}

/**
 * Switch a role's model for a session: (a) record it via `sessions.recordModelSwitch` so the
 * whole change lands in the model-governance audit, then (b) update the in-process override so
 * the NEXT `resolveModels(client, { ..., overrides: sessionOverrides(sessionId, rotorSlug) })`
 * reflects it. Each call audits again (opus→haiku→opus is three audited switches).
 */
export async function switchModel(client: Client, opts: SwitchModelOptions): Promise<void> {
  const { sessionId, rotorSlug, role, to, from, surface } = opts;
  // (a) Audit first — the governance trail must record every change, ordered.
  await client.sessions.recordModelSwitch({
    sessionId,
    rotorSlug,
    role,
    to,
    surface,
    ...(from !== undefined ? { from } : {}),
  });
  // (b) Update the in-memory override so the next resolve reflects it.
  let byRotor = overridesStore.get(sessionId);
  if (!byRotor) {
    byRotor = new Map();
    overridesStore.set(sessionId, byRotor);
  }
  const current = byRotor.get(rotorSlug) ?? {};
  current[role] = to;
  byRotor.set(rotorSlug, current);
}
