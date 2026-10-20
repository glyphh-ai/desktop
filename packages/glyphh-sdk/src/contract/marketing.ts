/**
 * contract/marketing.ts — trackable marketing links + click analytics (super_admin).
 * Mirrors the server's snake_case wire shapes the admin links pages read directly.
 * The public redirect (glyphh.ai/api/r/<slug>) is a browser navigation, not an SDK
 * call, so it has no method here.
 */

export interface MarketingLink {
  id: string;
  slug: string;
  url: string;
  label: string | null;
  campaign: string | null;
  is_active: boolean;
  click_count: number;
  expires_at: string | null;
  created_at: string;
}

export interface MarketingClick {
  id: string;
  created_at: string;
  ip_hash: string | null;
  referer: string | null;
  user_agent: string | null;
}

export interface ClicksByDay {
  day: string;
  count: number;
}

export interface MarketingLinksPage {
  links: MarketingLink[];
  total: number;
}

export interface MarketingStats {
  clicksByDay: ClicksByDay[];
  totalClicks: number;
  totalSignups: number;
  totalConversions: number;
}

export interface CreateLinkInput {
  slug: string;
  url: string;
  label?: string;
  campaign?: string;
  expiresAt?: string; // ISO
}

export interface UpdateLinkInput {
  label?: string;
  url?: string;
  campaign?: string;
  isActive?: boolean;
  expiresAt?: string | null; // ISO or null to clear
}

export interface LinksQuery {
  q?: string | undefined;
  campaign?: string | undefined;
  page?: number | undefined;
  limit?: number | undefined;
}

export interface MarketingStatsQuery {
  campaign?: string | undefined;
  from?: string | undefined; // YYYY-MM-DD
  to?: string | undefined;
}
