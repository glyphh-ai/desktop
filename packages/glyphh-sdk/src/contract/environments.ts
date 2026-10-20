/**
 * contract/environments.ts — named cloud environments (his direction, 2026-10-05:
 * personal environments). A member names an environment the way Claude Code on the
 * web does: a name, a network policy and a block of .env text. PERSONAL: it belongs
 * to the member, never the org. "Default" is not a record: it is the absent
 * environment ({@link DEFAULT_ENVIRONMENT_ID}), zero variables, full network.
 *
 * The variables are encrypted at rest and NEVER come back: a read carries the key
 * names with a masked preview ("hunter2" → "hu•••••"). A cloud turn names the
 * environment by id (`RunTurnOptions.environmentId`); the front door injects the
 * decrypted variables and the network policy into the worker run body server-side.
 */

export const DEFAULT_ENVIRONMENT_ID = "default";

/** The network policy of a cloud environment: `none` has no network at all (the
 *  sandbox unshares it); `trusted` is an allowlist (first cut: runs as full, says
 *  so); `full` is today's open egress. */
export type EnvironmentNetwork = "none" | "trusted" | "full";
export const ENVIRONMENT_NETWORKS: readonly EnvironmentNetwork[] = ["none", "trusted", "full"];

/** The words the pickers show for each policy (his screenshot, 2026-10-05). */
export const ENVIRONMENT_NETWORK_LABELS: Readonly<Record<EnvironmentNetwork, string>> = {
  none: "No network access",
  trusted: "Trusted network access",
  full: "Full network access",
};

/** One row of `environments.list`: never the variables, not even their names. */
export interface EnvironmentSummary {
  id: string;
  name: string;
  network: EnvironmentNetwork;
  varCount: number;
  createdAt: string | null;
  updatedAt: string | null;
}

/** A variable as `environments.get` shows it: the key, and a masked preview of
 *  the value — the first two characters of a value longer than four, then five
 *  dots. The value itself never leaves the server. */
export interface EnvironmentVar {
  key: string;
  preview: string;
}

export interface Environment extends EnvironmentSummary {
  vars: EnvironmentVar[];
}

/** `environments.create` input. `vars` is the .env text: KEY=VALUE lines, blanks
 *  and `#` comments ignored, values may be quoted; 64 variables and 32 KB at most.
 *  A bad line is refused by its number. */
export interface CreateEnvironmentInput {
  /** 1 to 60 characters, unique among the member's own (any case). "Default" is reserved. */
  name: string;
  /** Absent → `full`. */
  network?: EnvironmentNetwork;
  vars?: string;
}

/** `environments.update` input: only what is named changes; `vars` replaces the whole set. */
export interface UpdateEnvironmentInput {
  name?: string;
  network?: EnvironmentNetwork;
  vars?: string;
}
