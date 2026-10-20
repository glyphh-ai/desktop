/**
 * contract/runtime.ts — the CONTROL-plane view of a runtime session. `sessions.create`
 * provisions a rotor runtime (a fly stator machine / pod, a loopback process, or a
 * relayed desktop) and returns where to reach it (`runtimeUrl`) plus a one-time opaque
 * `runtimeToken`. The caller then opens the DATA plane against it via `client.session()`
 * (the streaming `Session` transport — a distinct object from the `RuntimeSession`
 * record here). The runtime authorizes every request by introspecting that token back
 * against the control plane.
 */

/** Where the runtime lives. `remote` = provisioned fly machine; `local` = loopback; `relay` = the user's own desktop. */
export type SessionLocus = "remote" | "local" | "relay";

export type SessionStatus = "provisioning" | "ready" | "error" | "stopped";

export interface RuntimeSession {
  id: string;
  locus: SessionLocus;
  /** Which rotor (agent loop) the runtime runs. */
  rotor: string;
  workspaceId: string;
  userId: string;
  /** Optional git working context injected into the runtime (clone token supplied server-side). */
  repo: string | null;
  branch: string | null;
  path: string | null;
  status: SessionStatus;
  /** Where to open the data-plane stream; null until `ready`. */
  runtimeUrl: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateSessionInput {
  /** Which rotor (agent loop) to run. */
  rotor: string;
  /** Defaults to `remote`. */
  locus?: SessionLocus;
  /** Defaults to the caller's resolved workspace. */
  workspaceId?: string;
  repo?: string;
  branch?: string;
  path?: string;
  /**
   * Provision an EMPTY, git-initialized cloud project with NO GitHub remote —
   * the pod `git init`s a fresh workspace that R2 persists across restarts, so
   * a user can build without ever connecting GitHub. Ignored when `repo` or a
   * local `path` is given (those already carry their working context). Requires
   * server support for durable R2-backed project workspaces; without it the
   * session still provisions but is not persisted.
   */
  newProject?: boolean;
}

/** `sessions.create` returns the record plus the runtime bearer, shown ONCE. */
export interface ProvisionedSession {
  session: RuntimeSession;
  /** Opaque bearer for the data plane; the runtime validates it via introspection. Store it now. */
  runtimeToken: string;
}

/** Where a runtime model switch happened — the audit surface it was driven from. */
export type ModelSwitchSurface = "cli" | "desktop" | "mobile" | "platform";

/**
 * A mid-stream role→model change to record for traceability (e.g. opus→haiku→opus).
 * The runtime posts this so the whole switch (who / where / when / from→to) lands in
 * the model-governance audit. `to` is required; the rest give the full context.
 */
export interface ModelSwitchInput {
  sessionId: string;
  rotorSlug?: string;
  role?: string;
  from?: string;
  to: string;
  surface: ModelSwitchSurface;
}

/** The echo a recorded model switch returns. */
export interface ModelSwitchResult {
  sessionId: string;
  from: string | null;
  to: string;
  surface: ModelSwitchSurface;
}
