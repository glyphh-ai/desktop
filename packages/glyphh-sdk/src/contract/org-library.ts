/**
 * contract/org-library.ts — the ORG LIBRARY: promoted tasks / agents / skills.
 *
 * One library, keyed by KIND (his ruling, 2026-09-12): a member promotes a
 * local build, the org reviews it, the admin decides which roles may see it,
 * and members install from the role-narrowed published list. Payloads live in
 * R2 as immutable versions; these types carry only the index.
 *
 * Distinct from contract/library.ts (the dormant generic item CRUD — a dead
 * surface awaiting restore; different kinds, different rows).
 */

export type OrgLibraryKind = "task" | "agent" | "skill";

/** One published item as the CALLER sees it (already role-narrowed). */
export interface OrgLibraryItem {
  id: string;
  kind: OrgLibraryKind;
  slug: string;
  name: string;
  description: string;
  /** Role-gated item (meaningful on admin reads). */
  restricted: boolean;
  /** The role grant list — what the Access editor pre-checks (admin reads). */
  /** When restricted, the members the org made it available to. */
  grantedUserIds: string[];
  /** The admin's kill-switch: disabled = invisible to members, installs kept. */
  enabled: boolean;
  /** How many members have it installed. */
  installs: number;
  /** Newest APPROVED version — what an install rides. Null = nothing live. */
  headVersion: number | null;
  /** A version awaiting review, when one exists. */
  pendingVersion: number | null;
  /** Whether the CALLER has it installed — lets a picker subtract without a
   *  second read. */
  installed: boolean;
  createdBy: string | null;
  updatedAt: string;
}

/** A pending promotion on the review desk. */
export interface OrgLibraryPending {
  id: string;
  kind: OrgLibraryKind;
  entity_id: string;
  version: number;
  notes: string;
  slug: string;
  name: string;
  submitted_by: string | null;
  created_at: string;
}

export interface OrgLibraryPromoteInput {
  slug: string;
  name: string;
  description?: string;
  notes?: string;
  /** The version's whole payload (manifest + program), stored verbatim. */
  payload: unknown;
}

export interface OrgLibraryPromoteResult {
  id: string;
  kind: OrgLibraryKind;
  slug: string;
  version: number;
  status: "pending";
}

/** Light per-item metrics — real numbers only; token/invocation lanes arrive
 *  with per-item run attribution. */
export interface OrgLibraryMetrics {
  installs: number;
  versions: Array<{ version: number; status: string; created_at: string; decided_at: string | null }>;
}
