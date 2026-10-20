/**
 * contract/bindings.ts — the ROLE→MODEL binding (per workspace, per rotor) + the resolved
 * REGISTRY the runtime consumes. A binding says "the planner role uses catalog model X over
 * the gateway; the coder role uses local model Y." The control plane resolves that binding
 * (against the catalog + governance) into a registry rrotor injects: gateway models come
 * back fully addressed; local models come back with a null url the SDK fills from the machine.
 */

export type ModelTransport = "gateway" | "local";

export interface RoleBinding {
  role: string;
  /** Catalog `Model.id`, e.g. "anthropic::claude-sonnet-5". */
  modelId: string;
  transport: ModelTransport;
}

export interface RotorBinding {
  rotorSlug: string;
  /** Empty until the user binds the rotor's roles. */
  roles: RoleBinding[];
}

export interface SetBindingInput {
  roles: RoleBinding[];
}

/** One resolved role → where/what the runtime calls. */
export interface ResolvedModel {
  role: string;
  transport: ModelTransport;
  /** The OpenAI-compatible endpoint: the gateway for `gateway`; null for `local` (SDK fills). */
  url: string | null;
  /** The provider's model id to send (the catalog id stripped of its `provider::` prefix). */
  model: string;
  /** Metered (gateway/hosted) vs free (local). */
  metered: boolean;
}

/** The resolved binding, ready for the SDK to complete (gateway auth / local url) + inject. */
export interface RotorRegistry {
  rotorSlug: string;
  models: ResolvedModel[];
}
