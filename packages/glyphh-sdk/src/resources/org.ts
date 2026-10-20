/**
 * resources/org.ts — the caller's organization. Read + (org_admin) update. Authz is
 * server-side; a non-admin update surfaces as a ForbiddenError.
 */

import type { AuthedHttp } from "../core/authed-http.js";
import type { Org, OrgUpdate, Guardrails, GuardrailsPolicy, OrgInfra, OrgInfraChoice, OrgDomain, EdgeTrafficReport, MarketingLink } from "../contract/org.js";

/** A WorkOS SSO connection (identity provider) linked to the org. */
export interface OrgSsoConnection { id: string; name: string; type: string; state: string }
/** The org's SSO posture — org-level OAuth; members-only apps ride this. */
export interface OrgSecurity {
  /** WorkOS is configured on the server at all (else SSO is unavailable). */
  configured: boolean;
  /** A WorkOS organization is linked to this Glyphh org. */
  linked: boolean;
  /** At least one connection is live. */
  ssoActive: boolean;
  /** Members must sign in through the IdP. */
  requireSso: boolean;
  connections: OrgSsoConnection[];
  domains: Array<{ domain: string; status: string }>;
}

export class OrgClient {
  constructor(private readonly http: AuthedHttp) {}

  get(): Promise<Org> {
    return this.http.get<Org>("/api/org");
  }

  /** Upload the org's image (PNG/JPEG/GIF/WebP, ≤0.5MB; sniffed server-side).
   *  org_admin only. The refreshed org (with imageUrl) comes from get(). */
  uploadImage(bytes: Uint8Array): Promise<{ key: string; contentType: string; bytes: number }> {
    return this.http.post<{ key: string; contentType: string; bytes: number }>("/api/org/image", bytes);
  }

  /** ORG ADMIN: marketplace apps blocked for this org (installs refuse). */
  appBlocks(): Promise<{ blocks: Array<{ appId: string; slug: string; name: string; createdAt: string }> }> {
    return this.http.get("/api/org/app-blocks") as Promise<{ blocks: Array<{ appId: string; slug: string; name: string; createdAt: string }> }>;
  }
  blockApp(ref: string): Promise<{ ok: boolean; blocked: boolean; slug: string }> {
    return this.http.put<{ ok: boolean; blocked: boolean; slug: string }>(`/api/org/app-blocks/${encodeURIComponent(ref)}`, {});
  }
  unblockApp(ref: string): Promise<{ ok: boolean; blocked: boolean; slug: string }> {
    return this.http.del<{ ok: boolean; blocked: boolean; slug: string }>(`/api/org/app-blocks/${encodeURIComponent(ref)}`);
  }

  update(patch: OrgUpdate): Promise<Org> {
    return this.http.patch<Org>("/api/org", patch);
  }

  /** The org's runtime infra + the one-time region-choice state (any member). */
  infra(): Promise<OrgInfra> {
    return this.http.get<OrgInfra>("/api/org/infra");
  }

  /** Make the one-time region/tier choice (org_admin; idempotent — flips
   *  `regionChosen`, provisioning/moving the org's runtime as needed). */
  chooseInfra(choice: OrgInfraChoice): Promise<OrgInfra> {
    return this.http.post<OrgInfra>("/api/org/infra", choice);
  }

  /** The org-wide runtime guardrails policy (org_admin). */
  guardrails(): Promise<Guardrails> {
    return this.http.get<Guardrails>("/api/org/guardrails");
  }

  /** Replace the org guardrails policy wholesale; pass null to clear it (org_admin). */
  setGuardrails(policy: GuardrailsPolicy | null): Promise<Guardrails> {
    return this.http.patch<Guardrails>("/api/org/guardrails", { guardrails_policy: policy });
  }

  // ── org white-label domains (org_admin) ─────────────────────────────────

  /** The org's custom domains (docs/custom-domains.md): verify one, and every
   *  published app answers at `<slug>.<domain>`. */
  async domains(): Promise<OrgDomain[]> {
    const { domains } = await this.http.get<{ domains: OrgDomain[] }>("/api/org/domains");
    return domains;
  }

  /** Apex-edge traffic for the org's hostnames: per-day series + per-host totals.
   *  Optionally narrowed to one hostname and/or one app (the Metrics filters). */
  domainsTraffic(days = 30, filter?: { host?: string; appId?: string }): Promise<EdgeTrafficReport> {
    const q = new URLSearchParams({ days: String(Math.max(1, Math.min(90, days))) });
    if (filter?.host) q.set("host", filter.host);
    if (filter?.appId) q.set("app", filter.appId);
    return this.http.get<EdgeTrafficReport>(`/api/org/domains/traffic?${q.toString()}`);
  }

  // ── Agency client orgs (org_admin; his order 2026-09-02): workspaces the
  // org creates and FUNDS for its clients — the consultancy model. ──
  clients(): Promise<{ clients: Array<{ id: string; name: string; createdAt: string; creditsMicro: number; members: number; monthlyCapMicro: number; monthUsedMicro: number }> }> {
    return this.http.get("/api/org/clients") as Promise<{ clients: Array<{ id: string; name: string; createdAt: string; creditsMicro: number; members: number; monthlyCapMicro: number; monthUsedMicro: number }> }>;
  }
  createClient(name: string): Promise<{ id: string; name: string }> {
    return this.http.post<{ id: string; name: string }>("/api/org/clients", { name });
  }
  /** The monthly gate: the client spends from YOUR pool up to this many
   *  credits per calendar month (0 closes it). Their own lots drain first. */
  setClientCap(id: string, monthlyCapCredits: number): Promise<void> {
    return this.http.patch<void>(`/api/org/clients/${encodeURIComponent(id)}`, { monthlyCapCredits });
  }
  /** Detach (graduate) a client: the org lives on, unmanaged and unfunded. */
  detachClient(id: string): Promise<void> {
    return this.http.del<void>(`/api/org/clients/${encodeURIComponent(id)}`);
  }

  // ── Marketing links (org_admin/admin): campaign URLs the edge attributes ──
  marketingLinks(days = 30): Promise<{ links: MarketingLink[] }> {
    return this.http.get<{ links: MarketingLink[] }>(`/api/org/marketing/links?days=${Math.max(1, Math.min(90, days))}`);
  }
  createMarketingLink(input: { name: string; targetUrl: string; appId?: string }): Promise<{ link: MarketingLink }> {
    return this.http.post<{ link: MarketingLink }>("/api/org/marketing/links", input);
  }
  updateMarketingLink(id: string, patch: { name?: string; archived?: boolean }): Promise<void> {
    return this.http.patch<void>(`/api/org/marketing/links/${encodeURIComponent(id)}`, patch);
  }
  deleteMarketingLink(id: string): Promise<void> {
    return this.http.del<void>(`/api/org/marketing/links/${encodeURIComponent(id)}`);
  }

  /** Claim a domain — returns the DNS records (TXT + wildcard CNAME) to publish. */
  addDomain(domain: string): Promise<OrgDomain> {
    return this.http.post<OrgDomain>("/api/org/domains", { domain });
  }

  /** Check the ownership TXT; on success the domain goes active and per-app
   *  hostnames start registering. Throws E_FAILED_PRECONDITION while DNS lags. */
  verifyDomain(id: string): Promise<OrgDomain> {
    return this.http.post<OrgDomain>(`/api/org/domains/${encodeURIComponent(id)}/verify`, {});
  }

  /** Remove a domain — tears down its per-app hostnames; the edge stops at once. */
  removeDomain(id: string): Promise<void> {
    return this.http.del<void>(`/api/org/domains/${encodeURIComponent(id)}`);
  }

  /** Point the domain's BARE apex at a flagship app (null clears it). */
  setDomainApexApp(id: string, appId: string | null): Promise<OrgDomain> {
    return this.http.post<OrgDomain>(`/api/org/domains/${encodeURIComponent(id)}/apex-app`, { appId });
  }

  /** Flip the org-wide wildcard (opt-in). ON exposes every published app at
   *  `<slug>.<domain>`; OFF tears down the swept subdomains (apex + explicit
   *  per-app hostnames untouched). Off by default — see the footgun warning. */
  setDomainWildcard(id: string, wildcard: boolean): Promise<OrgDomain> {
    return this.http.post<OrgDomain>(`/api/org/domains/${encodeURIComponent(id)}/wildcard`, { wildcard });
  }

  // ── Security: organization SSO via WorkOS (org OAuth). A members-only app
  //    (access='members') rides this org auth — no per-app OAuth. (org_admin) ──

  /** SSO posture: configured?, linked?, connections + active, require_sso. */
  security(): Promise<OrgSecurity> {
    return this.http.get<OrgSecurity>("/api/org/security");
  }
  /** A WorkOS Admin Portal link the admin opens to connect an IdP / directory
   *  sync / verify a domain. Provisions the WorkOS org on first use. */
  securityPortal(intent: "sso" | "dsync" | "domain_verification" = "sso"): Promise<{ url: string }> {
    return this.http.post<{ url: string }>("/api/org/security/portal", { intent });
  }
  /** Require every member to sign in through the org's IdP. Refused unless a
   *  connection is already active — enabling it blind would lock the org out. */
  setRequireSso(requireSso: boolean): Promise<{ requireSso: boolean }> {
    return this.http.patch<{ requireSso: boolean }>("/api/org/security/require-sso", { requireSso });
  }
}
