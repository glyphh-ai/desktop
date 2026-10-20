/**
 * contract/admin.ts — the super_admin platform-console wire shapes. These mirror
 * the server's admin endpoints, which back the admin pages that read snake_case
 * fields directly, so (unlike the camelCase billing/catalog contracts) the admin
 * shapes are snake_case — the SDK is a faithful typed passthrough. Money is
 * dollars (Budget spend from the spend log; plan prices in USD cents);
 * the daily token buckets are camelCase to match the chart series the Usage
 * page consumes.
 */

export interface AdminStats {
  users: { total: number; active: number };
  orgCount: number;
}

// ── orgs ─────────────────────────────────────────────────────────────────────
export interface AdminOrgListItem {
  id: string;
  name: string;
  tier: string;
  billing_status: string;
  member_count: number;
  /** Dollars ever added on top of the plan pool (purchases + admin grants). */
  funds_usd: number;
  /** Pipedream dollars spent all-time. */
  spent_usd: number;
}
export interface AdminOrgsPage {
  orgs: AdminOrgListItem[];
  total: number;
}
export interface AdminOrgMember {
  id: string;
  first_name: string;
  last_name: string;
  email: string;
  role: string;
  status: string;
}
export interface AdminOrgDetail extends AdminOrgListItem {
  max_seats: number;
  created_at: string;
  /** The org's budget this period, in dollars. */
  budget: { remaining_usd: number; spent_usd: number };
  members: AdminOrgMember[];
}
export interface AdminOrgPatch {
  name?: string;
  tier?: string;
  billingStatus?: string;
}
/** Create a brand-new org from the console (name required, tier defaults to free). */
export interface AdminCreateOrg {
  name: string;
  tier?: string;
}

// ── users ────────────────────────────────────────────────────────────────────
export interface AdminUser {
  id: string;
  email: string;
  first_name: string;
  last_name: string;
  role: string;
  status: string;
  org_id: string | null;
  org_name: string | null;
  tier: string | null;
  billing_status: string | null;
  created_at: string;
}
export interface AdminUsersPage {
  users: AdminUser[];
  total: number;
}
export interface AdminUserPatch {
  firstName?: string;
  lastName?: string;
  email?: string;
  role?: string;
  status?: string;
  tier?: string;
  billingStatus?: string;
}

// ── plans / models pricing ────────────────────────────────────────────────────
export interface AdminPlan {
  tier: string;
  display_name: string;
  monthly_usd_cents: number; // per-seat price — also the monthly pool, dollar for dollar
  max_seats: number;
  active: boolean;
  /** NULL for a global catalog plan; the org id for a bespoke per-org plan. */
  org_id: string | null;
  /** The bespoke plan's org name (null for global plans). */
  org_name: string | null;
  /** Gateway requests/minute for orgs on this plan; null = unlimited. */
  rate_limit_rpm?: number | null;
  /** The plan's MODEL allow-list (catalog ids); null = every model. */
  allowed_models?: string[] | null;
}
export interface AdminPlanUpdate {
  display_name?: string;
  monthly_usd_cents?: number;
  max_seats?: number;
  active?: boolean;
  /** Gateway requests/minute; null clears the limit (unlimited). */
  rate_limit_rpm?: number | null;
  /** The plan's MODEL allow-list (catalog ids). null clears it (every model). */
  allowed_models?: string[] | null;
}
/** One PLATFORM provider key row — write-only: label + last-4 hint, never the secret. */
export interface AdminProviderKey {
  id: string;
  label: string;
  /** Last 4 characters of the key, for identification. */
  hint: string;
  active: boolean;
  createdAt: string;
}

export interface AdminPlanCreate {
  /** New tier key — lowercase letters, digits, dashes. */
  tier: string;
  display_name: string;
  monthly_usd_cents: number;
  max_seats: number;
  rate_limit_rpm?: number | null;
  active?: boolean;
}

/**
 * A per-org bespoke (enterprise) plan. Unlike the snake_case global-plan shapes above,
 * the org-plan write payloads are camelCase — they mirror the server's org-plan
 * endpoints (which take camelCase directly). `monthlyUsdCents` is the per-seat
 * price — the plan's monthly pool is that price, dollar for dollar.
 */
export interface AdminOrgPlanInput {
  maxSeats: number;
  monthlyUsdCents: number;
  displayName: string;
  /** The specific Stripe price the org is billed on (enterprise is provisioned/invoiced). */
  stripePriceId?: string;
}
/** Partial edit of an org's bespoke plan (every field optional). */
export interface AdminOrgPlanPatch {
  maxSeats?: number;
  monthlyUsdCents?: number;
  displayName?: string;
  stripePriceId?: string;
}
export interface AdminModel {
  provider: string;
  model: string;
  display_name: string;
  /** Short @-mention name; null = not mentionable. */
  alias: string | null;
  /** chat | image | video | speech | transcription. */
  modality: string;
  /** Unit the rates are quoted in: mtok | image | second | mchar | minute. */
  rate_unit: string;
  /** Total tokens the model holds; what the gateway fits requests to. Null = unrecorded. */
  context_window: number | null;
  /** Largest single completion. Null = unrecorded. */
  max_output_tokens: number | null;
  active: boolean;
  /** Live per-org default: orgs with no explicit org_models override follow this. */
  default_on: boolean;
  /** Long-context tier: the WHOLE request bills at the multipliers once the
   *  prompt crosses this token threshold. Null = flat pricing. */
  long_context_threshold: number | null;
  long_context_input_mult: number | null;
  long_context_output_mult: number | null;
}
export interface AdminModelUpdate {
  display_name?: string;
  /** Short @-mention name; null clears it, omit keeps it. */
  alias?: string | null;
  active?: boolean;
  /** Live per-org default: orgs with no explicit org_models override follow this. */
  default_on?: boolean;
  modality?: string;
  rate_unit?: string;
  context_window?: number | null;
  max_output_tokens?: number | null;
  long_context_threshold?: number | null;
  long_context_input_mult?: number | null;
  long_context_output_mult?: number | null;
}

/**
 * One entry of a plan's Stripe price history (super_admin). Unlike the other admin
 * shapes this is camelCase — it mirrors the billing wire contract, where the price
 * history is served alongside the checkout surface. `createdAt` is an ISO timestamp.
 */
export interface AdminPlanPrice {
  id: string;
  stripePriceId: string;
  active: boolean;
  createdAt: string;
}

// ── audit ────────────────────────────────────────────────────────────────────
export interface AuditEntry {
  id: string;
  action: string;
  actor_id: string | null;
  actor_email: string | null;
  target_id: string | null;
  target_email: string | null;
  metadata: unknown;
  created_at: string;
}
export interface AuditPage {
  entries: AuditEntry[];
  total: number;
}
export interface AuditQuery {
  action?: string | undefined;
  actor?: string | undefined;
  days?: number | undefined;
  page?: number | undefined;
  limit?: number | undefined;
}

// ── usage ────────────────────────────────────────────────────────────────────
export interface AdminUsageByUser {
  userId: string;
  email: string;
  name: string;
  requests: number;
  usd: number; // dollars
  tokens: number;
}
export interface AdminUsageDay {
  day: string; // YYYY-MM-DD
  usd: number; // dollars
  requests: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
}
export interface AdminDailyQuery {
  from: string; // YYYY-MM-DD
  to: string; // YYYY-MM-DD
  tz?: string | undefined;
  orgId?: string | undefined;
  userId?: string | undefined;
  /** Runtime drill-downs (server migration 008). Omit for every region / both modes. */
  region?: string | undefined;
  mode?: RuntimeMode | undefined;
}

/** 'shared' — the region's one shared runtime; 'dedicated' — an org's own instance. */
export type RuntimeMode = "shared" | "dedicated";

/**
 * One cell of the platform usage/billing breakdown BY RUNTIME: region × shared|dedicated
 * × plan tier, with how many distinct rrotor instances and orgs sit behind it.
 */
export interface AdminUsageByRuntime {
  region: string;
  mode: RuntimeMode | string;
  /** Plan tier the usage was billed under; 'unknown' if the org no longer exists. */
  tier: string;
  runtimes: number;
  orgs: number;
  users: number;
  requests: number;
  usd: number; // dollars
  inputTokens: number;
  outputTokens: number;
}

export interface AdminRuntimeUsageQuery {
  from: string; // YYYY-MM-DD
  to: string; // YYYY-MM-DD
  region?: string | undefined;
  mode?: RuntimeMode | undefined;
  tier?: string | undefined;
  /** Narrow to ONE org (the Usage page's All-orgs filter). */
  orgId?: string | undefined;
}

/** The admin REVENUE rollup: real Stripe cash. */
export interface AdminRevenue {
  /** Collected cash in the window (succeeded charges − refunds); null = Stripe unconfigured. */
  stripe: { totalUsdCents: number; byDay: Array<{ day: string; usdCents: number }> } | null;
}

/** Common list query for the paginated/searchable admin tables. */
export interface AdminListQuery {
  q?: string | undefined;
  page?: number | undefined;
  limit?: number | undefined;
  /** Orgs list only: narrow to one agency's client fleet. */
  parent?: string | undefined;
}
