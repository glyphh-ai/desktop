/**
 * contract/workspace.ts — workspace governance (the ex-`org_roles` layer). A user
 * belongs to one workspace; the workspace grants/filters what its members may use.
 *
 * Flag semantics (per product): each `limit<X>` is an explicit toggle —
 *   limit<X> = false → ALL of X are granted (the `allowed<X>` list is ignored);
 *   limit<X> = true  → only the `allowed<X>` list is granted.
 */

/**
 * Per-connection TOOL grants, keyed by connection slug → the granted tool names.
 * Layers UNDER the connection gate (a connection must first be allowed): an absent
 * slug ⇒ ALL of that connection's tools; a present slug ⇒ only the listed tools
 * (an empty array ⇒ none).
 */
export type ConnectionToolGrants = Record<string, string[]>;

export interface Workspace {
  id: string;
  orgId: string;
  name: string;
  /** The one undeletable workspace per org; unassigned members fall back to it. */
  isBase: boolean;

  limitProviders: boolean;
  allowedProviders: string[];
  limitModels: boolean;
  allowedModels: string[];
  autoExemptModels: string[];
  limitConnections: boolean;
  allowedConnections: string[];
  /** Per-connection tool scoping. Absent slug ⇒ all tools; present ⇒ only listed. */
  allowedConnectionTools: ConnectionToolGrants;
  /** PERSONAL (member-made) connections — which apps a member may connect with their
   *  OWN auth, and each app's tool scoping. Independent of the shared `connections` gate. */
  limitPersonalConnections: boolean;
  allowedPersonalConnections: string[];
  allowedPersonalConnectionTools: ConnectionToolGrants;
  limitApps: boolean;
  allowedApps: string[];
  limitAppHosting: boolean;
  allowedHosting: string[];

  allowCustomMcp: boolean;

  rateLimitCalls: number | null;
  rateLimitWindowSeconds: number | null;
  /** Gateway budget in USD per period (null = untracked) + the hard-limit toggle. */
  budgetUsd: number | null;
  budgetHard: boolean;
  /** 1 / 7 / 30 — calendar-aligned periods. Null reads as monthly. */
  budgetPeriodDays: number | null;
  /** Tokens per minute across the role's minted keys. Null = unlimited. */
  tpmLimit: number | null;
  /** Assigned members — present on the LIST read only. */
  memberCount?: number;
}

/** Create/update payload — every field optional; base-role restrictions apply server-side. */
export interface WorkspaceInput {
  name?: string;
  limitProviders?: boolean;
  allowedProviders?: string[];
  limitModels?: boolean;
  allowedModels?: string[];
  autoExemptModels?: string[];
  limitConnections?: boolean;
  allowedConnections?: string[];
  allowedConnectionTools?: ConnectionToolGrants;
  limitPersonalConnections?: boolean;
  allowedPersonalConnections?: string[];
  allowedPersonalConnectionTools?: ConnectionToolGrants;
  limitApps?: boolean;
  allowedApps?: string[];
  limitAppHosting?: boolean;
  allowedHosting?: string[];
  allowCustomMcp?: boolean;
  rateLimitCalls?: number | null;
  rateLimitWindowSeconds?: number | null;
  budgetUsd?: number | null;
  budgetHard?: boolean;
  budgetPeriodDays?: number | null;
  tpmLimit?: number | null;
}

/** A resolved grant: "all" (unlimited) or the exact allow-list. */
export type Grant = "all" | string[];

/** The effective governance for a member — what the runtime enforces. */
export interface EffectiveGrants {
  providers: Grant;
  models: Grant;
  connections: Grant;
  /** Which apps a member may PERSONALLY connect (their own auth). */
  personalConnections: Grant;
  apps: Grant;
  hosting: Grant;
  allowCustomMcp: boolean;
  rateLimitCalls: number | null;
  rateLimitWindowSeconds: number | null;
}
