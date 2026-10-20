/**
 * resources/marketing.ts — trackable marketing links + click analytics (super_admin;
 * server-enforced). CRUD over links, per-link stats/clicks/reset, and the aggregate
 * campaign overview. The public redirect that records clicks is a browser navigation
 * to /api/r/<slug>, not a method here.
 */

import type { AuthedHttp } from "../core/authed-http.js";
import type {
  MarketingLink, MarketingClick, MarketingLinksPage, MarketingStats,
  CreateLinkInput, UpdateLinkInput, LinksQuery, MarketingStatsQuery, ClicksByDay,
} from "../contract/marketing.js";

function withQuery(path: string, params: Record<string, string | number | undefined>): string {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== "") qs.set(k, String(v));
  const s = qs.toString();
  return s ? `${path}?${s}` : path;
}

export class MarketingClient {
  constructor(private readonly http: AuthedHttp) {}

  links(query: LinksQuery = {}): Promise<MarketingLinksPage> {
    return this.http.get<MarketingLinksPage>(withQuery("/api/marketing/links", { q: query.q, campaign: query.campaign, page: query.page, limit: query.limit }));
  }
  link(id: string): Promise<MarketingLink> {
    return this.http.get<MarketingLink>(`/api/marketing/links/${encodeURIComponent(id)}`);
  }
  create(input: CreateLinkInput): Promise<MarketingLink> {
    return this.http.post<MarketingLink>("/api/marketing/links", input);
  }
  update(id: string, patch: UpdateLinkInput): Promise<MarketingLink> {
    return this.http.patch<MarketingLink>(`/api/marketing/links/${encodeURIComponent(id)}`, patch);
  }
  remove(id: string): Promise<void> {
    return this.http.del<void>(`/api/marketing/links/${encodeURIComponent(id)}`);
  }
  /** Per-day clicks for one link (last 30 days). */
  linkStats(id: string): Promise<{ daily: ClicksByDay[] }> {
    return this.http.get<{ daily: ClicksByDay[] }>(`/api/marketing/links/${encodeURIComponent(id)}/stats`);
  }
  /** A page of a link's raw clicks (newest first). */
  clicks(id: string, page = 1, limit = 20): Promise<MarketingClick[]> {
    return this.http.get<MarketingClick[]>(withQuery(`/api/marketing/links/${encodeURIComponent(id)}/clicks`, { page, limit }));
  }
  /** Zero a link's counter and clear its click stream. */
  reset(id: string): Promise<{ ok: boolean }> {
    return this.http.post<{ ok: boolean }>(`/api/marketing/links/${encodeURIComponent(id)}/reset`);
  }
  /** Aggregate campaign overview (clicks by day + totals). */
  stats(query: MarketingStatsQuery = {}): Promise<MarketingStats> {
    return this.http.get<MarketingStats>(withQuery("/api/marketing/stats", { campaign: query.campaign, from: query.from, to: query.to }));
  }
}
