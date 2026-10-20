/**
 * contract/org.ts — the accounts wire shapes (orgs, members, invites). Pure types,
 * the single source of truth both the SDK and the control plane implement.
 */

export interface Address {
  line1: string;
  line2?: string;
  city: string;
  state: string;
  postalCode: string;
  country: string;
}

export interface BillingContact {
  name: string;
  email: string;
  phone?: string;
}

export interface Org {
  id: string;
  name: string;
  slug: string;
  tier: string;
  maxSeats: number;
  seatsUsed: number;
  address: Address | null;
  billingAddress: Address | null;
  billingSameAsAddress: boolean;
  billingContact: BillingContact | null;
  workosOrgId: string | null;
  /** Opt into the metered memory rotor (org-admin). */
  memoryRotorEnabled: boolean;
  /** The org's chosen memory-rotor assembler model (a supported catalog model), or null. */
  memoryRotorModel: string | null;  /** The org's uploaded image (logo/avatar), or null. */
  imageUrl: string | null;
}

export interface OrgUpdate {
  name?: string;
  address?: Address | null;
  billingAddress?: Address | null;
  billingSameAsAddress?: boolean;
  billingContact?: BillingContact | null;
  memoryRotorEnabled?: boolean;
  memoryRotorModel?: string | null;
}

/**
 * Org-wide runtime guardrails (org_admin). All fields optional non-negative
 * integers; the runtime enforces them under its own floor (a policy only tightens).
 */
export interface GuardrailsPolicy {
  maxInputTokens?: number;
  maxOutputTokens?: number;
  windowSeconds?: number;
  windowTokens?: number;
  windowCalls?: number;
  maxConcurrent?: number;
}

/** The guardrails wire envelope — a policy, or null when the org set none. */
export interface Guardrails {
  guardrails_policy: GuardrailsPolicy | null;
}

export type MemberRole = "org_admin" | "admin" | "user";

/** The system role a member may be SET to (org_admin is granted via invite, not here). */
export type MemberSystemRole = "org_admin" | "admin" | "user";

export interface Member {
  userId: string;
  email: string;
  name: string | null;
  role: string;
  disabled: boolean;
}

/** `members.updateProfile` — set a member's display name from a first/last pair. */
export interface MemberProfileUpdate {
  firstName?: string;
  lastName?: string;
}

export interface Invite {
  id: string;
  email: string;
  role: MemberRole;
  expiresAt: string;
  invitedBy: string | null;
}

/** `members.invite` returns the invite + the raw token (shown once). */
/** A pending (unaccepted, unexpired) invite — the Members page's Invited tab. */
export interface PendingInvite {
  id: string;
  email: string;
  role: string;
  invitedByEmail: string | null;
  createdAt: string;
  expiresAt: string;
}

export interface CreatedInvite {
  invite: Invite;
  token: string;
  /** The platform accept-invite URL carrying the token — email it, or share directly. */
  acceptUrl?: string;
}

/** `invites.peek(token)` — the unauthenticated accept-page view. */
export interface InvitePreview {
  email: string;
  orgName: string;
  role: MemberRole;
}

/** `org.infra()` — the caller org's runtime infrastructure + the one-time region
 *  choice state. `regionChosen` gates the first-run region prompt. */
export interface OrgInfra {
  mode: string;
  region: string | null;
  tier: string | null;
  status: string;
  regionChosen: boolean;
  /** Regions the org may pin to (id + label), for the picker. */
  regions: Array<{ id: string; label?: string }>;
}

/** `org.chooseInfra()` — the one-time (idempotent) region/tier selection. */
export interface OrgInfraChoice {
  region: string;
  /** infra tier id ('shared' | 'ded-small' | …); 'shared' is the free default. */
  tier: string;
}

/** One org white-label domain (docs/custom-domains.md P1): verify once, then every
 *  published app answers at `<slug>.<domain>`. */
export interface OrgDomain {
  id: string;
  domain: string;
  /** pending | verifying | active | error | removed */
  status: string;
  /** WorkOS SSO binding (P3) — null means the platform login fronts this domain. */
  sso: string | null;
  /** The app the BARE apex serves (null = nothing at the naked domain). */
  apexAppId: string | null;
  /** Opt-in: expose EVERY published app at <slug>.<domain>. Default false —
   *  explicit per-app hostnames are the norm; the wildcard hijacks undefined
   *  subdomains, so it is flipped on deliberately. */
  wildcard: boolean;
  error: string | null;
  verifiedAt: string | null;
  createdAt: string;
  /** The records to publish: ownership TXT + apex A/AAAA (always, when the apex
   *  IPs are configured), and the wildcard CNAME only when wildcard is on. */
  dns: Array<{ type: "TXT" | "CNAME" | "A" | "AAAA"; name: string; value: string }>;
  /** Per-app hostname states under this domain (hostname → verifying|active|error). */
  hostnames: Record<string, string>;
}

/** One day (or one hostname's total) of apex-edge traffic. */
export interface EdgeTrafficDay {
  day: string;
  requests: number;
  bytesIn: number;
  bytesOut: number;
  avgMs: number;
  maxMs: number;
  s2xx: number;
  s3xx: number;
  s4xx: number;
  s5xx: number;
  /** Edge-served refusals: rate limit, challenge, unknown hostname. */
  blocked: number;
  /** Platform-served unavailability pages (app offline / not connected) —
   *  our honest answer, never the app's error. */
  offline: number;
}

/** The apex-edge traffic report both dashboards read (org + per-app), plus
 *  the telemetry rollups (his order, 2026-09-02): pages, referrers, uniques,
 *  sessions/bounce/duration. A page view is a served HTML document; visitors
 *  are daily-salted hashes (no IP ever stored). */
export interface EdgeTrafficReport {
  days: EdgeTrafficDay[];
  hosts: Array<EdgeTrafficDay & { hostname: string }>;
  topPages: Array<{ path: string; views: number }>;
  topReferrers: Array<{ refHost: string; views: number }>;
  /** WHAT the errors are: paths behind 4xx/5xx that reached the app. */
  topErrorPaths: Array<{ path: string; hits: number }>;
  engagement: {
    uniques: number;
    sessions: number;
    bounced: number;
    durationMsSum: number;
    viewsSum: number;
  };
}

/** An org-minted marketing link: target + ?glm=<code>; the edge attributes
 *  clicks and whole sessions back to the code. Stats cover the asked window. */
export interface MarketingLink {
  id: string;
  code: string;
  name: string;
  targetUrl: string;
  /** The shareable URL — target with the glm code applied. */
  url: string;
  appId: string | null;
  archived: boolean;
  createdAt: string;
  clicks: number;
  sessions: number;
  bounced: number;
  durationMsSum: number;
}
