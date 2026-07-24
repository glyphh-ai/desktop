/**
 * marketplace — the app catalog behind Apps → Marketplace. Two scopes: `public`
 * (published for anyone) and `private` (your org's own, members only).
 *
 * Everything here reads the server's marketplace API through the SDK. A
 * placeholder catalog used to stand in front of it, gated on an env flag; it was
 * deleted once the routes landed, because a storefront that renders invented apps
 * is indistinguishable from a broken one that renders nothing.
 *
 * The listing fields the server does not carry yet (rating, media, pricing,
 * publisher identity) come back empty rather than synthesized — the UI treats an
 * empty value as "not rated yet", which is true.
 */

import type { AppListing, InstalledApp } from "@glyphh/client";
import { getClient } from "./glyphh-client.js";
import { fetchOrgApps, invalidateOrgApps } from "./org-apps.js";

export interface MarketplaceApp {
  id: string;
  slug: string;
  name: string;
  tagline: string;
  description?: string;
  iconUrl?: string;
  developer: { name: string; verified: boolean };
  rating: number;
  ratingCount: number;
  priceCredits: number;
  category: string;
  scope: "public" | "private";
  featured: boolean;
  popular: boolean;
  connections: Array<{ name: string; slug: string }>;  // required connections; slug = Pipedream app id (for the catalog icon)
  version?: string;
  videoUrl?: string;
  mockups?: string[];
  installed: boolean;
}

/** A single customer review on an app's detail page. */
export interface MarketplaceReview {
  author: string;
  location?: string;
  rating: number;    // 1–5
  date: string;      // e.g. "June 12, 2026"
  body: string;
  usage?: string;    // e.g. "About 1 year using the app"
}

/** A pricing tier shown in the detail page's plan cards. */
export interface MarketplacePlan {
  name: string;
  priceCredits: number;  // per month; 0 = free
  blurb?: string;
  features: string[];
}

/** The full detail payload for one app — everything the Shopify-style
 *  detail page needs (gallery, highlights, plans, reviews, sidebar). */
export interface MarketplaceAppDetail extends MarketplaceApp {
  /** Connections the app requires, with whether the caller's org has each. */
  requiredConnections: Array<{ slug: string; actAs: string; connected: boolean }>;
  owned: boolean;
  description: string;                                   // markdown
  highlights: string[];
  worksWith: string[];
  screenshots: Array<{ url: string; caption: string }>;
  plans: MarketplacePlan[];
  ratingBreakdown: Array<{ stars: number; count: number }>; // 5→1
  reviews: MarketplaceReview[];
  launchedAt: string;
  updatedAt?: string;
  website?: string;
  dataAccess: string[];
  languages: string[];
  similar: MarketplaceApp[];
}

export interface MarketplaceQuery {
  scope: "public" | "private";
  category?: string;
  q?: string;
  sort?: "popular" | "rating" | "newest";
  page?: number;
}

export interface MarketplaceResponse {
  items: MarketplaceApp[];
  total: number;
  page: number;
  pageSize: number;
  categories: Array<{ id: string; label: string; count: number }>;
  featured: MarketplaceApp[];
  popular: MarketplaceApp[];
}

const PAGE_SIZE = 12;

/** One server listing → the storefront's card shape. */
function listingToApp(l: AppListing, installed: Set<string>): MarketplaceApp {
  return {
    id: l.slug,
    slug: l.slug,
    name: l.name,
    tagline: l.description ?? "",
    description: l.description ?? undefined,
    developer: { name: "", verified: false },
    rating: 0,
    ratingCount: 0,
    priceCredits: 0,
    category: "",
    scope: l.visibility === "public" ? "public" : "private",
    featured: false,
    popular: l.installs > 0,
    connections: [],
    version: l.version,
    installed: installed.has(l.slug),
  };
}

/** List the marketplace for a scope, filtered + paginated. */
export async function listMarketplace(query: MarketplaceQuery): Promise<MarketplaceResponse> {
  const client = getClient();
  const [listings, installedApps] = await Promise.all([
    client.apps.browse(),
    client.apps.installed().catch(() => [] as InstalledApp[]),
  ]);
  const installedSlugs = new Set(installedApps.map((a) => a.slug));
  const q = (query.q || "").trim().toLowerCase();
  const scoped = listings
    .filter((l) => (query.scope === "public" ? l.visibility === "public" : l.visibility !== "public"))
    .filter((l) => !q || l.name.toLowerCase().includes(q) || (l.description ?? "").toLowerCase().includes(q))
    .map((l) => listingToApp(l, installedSlugs));
  if (query.sort === "newest") scoped.sort((a, b) => a.name.localeCompare(b.name));
  else scoped.sort((a, b) => Number(b.popular) - Number(a.popular));
  const page = Math.max(1, query.page || 1);
  const start = (page - 1) * PAGE_SIZE;
  return {
    items: scoped.slice(start, start + PAGE_SIZE),
    total: scoped.length,
    page,
    pageSize: PAGE_SIZE,
    categories: [],
    featured: scoped.filter((a) => a.featured).slice(0, 4),
    popular: scoped.filter((a) => a.popular).slice(0, 8),
  };
}

/** Install a marketplace app into the org library. */
export async function installMarketplaceApp(slug: string): Promise<{ ok: boolean; slug?: string; error?: string }> {
  try {
    const app = await getClient().apps.install(slug);
    invalidateOrgApps();
    return { ok: true, slug: app?.slug };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** The detail payload for one listing. Sections the server does not carry yet
 *  come back empty — the page hides an empty section rather than inventing one. */
export async function getMarketplaceApp(slug: string): Promise<MarketplaceAppDetail | null> {
  try {
    const client = getClient();
    const [detail, installedApps] = await Promise.all([
      client.apps.get(slug),
      client.apps.installed().catch(() => [] as InstalledApp[]),
    ]);
    const l = detail.listing;
    return {
      id: detail.slug,
      slug: detail.slug,
      name: l.title || detail.name,
      tagline: l.tagline ?? "",
      // The long-form pitch is MARKDOWN — the detail page renders it.
      description: l.body ?? detail.description ?? "",
      iconUrl: l.iconUrl ?? undefined,
      developer: { name: "", verified: false },
      rating: l.ratingAvg,
      ratingCount: l.ratingCount,
      priceCredits: 0,
      category: l.category ?? "",
      scope: "public",
      featured: false,
      popular: detail.installs > 0,
      // Legacy connection chips (name/slug) alongside the richer required list.
      connections: detail.requiredConnections.map((c) => ({ name: c.slug, slug: c.slug })),
      requiredConnections: detail.requiredConnections,
      owned: detail.owned,
      version: detail.version,
      installed: installedApps.some((a) => a.slug === detail.slug),
      videoUrl: l.videoUrl ?? undefined,
      ...(l.website ? { website: l.website } : {}),
      screenshots: l.screenshots,
      highlights: [],
      worksWith: [],
      plans: [],
      ratingBreakdown: [],
      reviews: [],
      launchedAt: l.listedAt ?? "",
      dataAccess: [],
      languages: [],
      similar: [],
    };
  } catch { return null; }
}
