/**
 * contract/rotors.ts — the ROTOR CATALOG: the runnable rotors the control plane offers and
 * the model ROLES each declares. A rotor names roles + capability needs, never a model or an
 * endpoint — binding a role to a concrete model is a separate, governed step (contract/bindings).
 */

export interface RotorRole {
  /** The role name a rotor step references (its `config.model`), e.g. "assistant", "planner". */
  role: string;
  description: string;
  /** Capability hints used to filter which catalog models fit, e.g. ["reasoning","code"]. */
  needs: string[];
}

export interface RotorCatalogEntry {
  slug: string; // "base", "planning"
  name: string;
  description: string;
  /** The model roles this rotor needs bound before it can run. */
  roles: RotorRole[];
}
