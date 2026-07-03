/**
 * marketplace — Shopify-style app catalog for the client Apps → Marketplace
 * tab. Two scopes: `public` (developer-published, sold for credits) and
 * `private` (org-built, released to members only).
 *
 * The yo-server marketplace API is pending (a `marketplace_listings` table
 * with developer identity, rating, media, pricing, and per-org release/
 * install state — that's the next server pass). Until it lands, this serves a
 * PLACEHOLDER catalog so the storefront UI is fully renderable and reviewable.
 * When the server routes exist, `listMarketplace` switches to `serverGetAuthed`
 * and the placeholder is deleted.
 */

import { serverGetAuthed, serverPostAuthed } from "./auth.js";
import { invalidateServerCache } from "./server-cache.js";

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
  version?: string;
  videoUrl?: string;
  mockups?: string[];
  installed: boolean;
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
const USE_SERVER = process.env.GLYPHH_MARKETPLACE_SERVER === "1"; // flip on when routes land

// ── Category taxonomy ──────────────────────────────────────────────
const CATEGORIES: Array<{ id: string; label: string }> = [
  { id: "productivity", label: "Productivity" },
  { id: "communication", label: "Communication" },
  { id: "developer", label: "Developer tools" },
  { id: "ai", label: "AI & automation" },
  { id: "marketing", label: "Marketing & sales" },
  { id: "finance", label: "Finance" },
  { id: "design", label: "Design" },
  { id: "data", label: "Data & analytics" },
];

// ── Placeholder catalog (deleted when the server API lands) ─────────
function mono(seed: string): string {
  // A tiny inline SVG data-URI icon so cards render without a network fetch.
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  const hue = h % 360;
  const letter = seed.charAt(0).toUpperCase();
  const svg = `<svg xmlns='http://www.w3.org/2000/svg' width='96' height='96'><rect width='96' height='96' rx='22' fill='hsl(${hue} 62% 46%)'/><text x='50%' y='54%' font-family='Inter,sans-serif' font-size='46' font-weight='700' fill='white' text-anchor='middle' dominant-baseline='middle'>${letter}</text></svg>`;
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

interface Seed {
  slug: string; name: string; tagline: string; dev: string; verified: boolean;
  rating: number; ratingCount: number; price: number; category: string;
  featured?: boolean; popular?: boolean;
}

const PUBLIC_SEED: Seed[] = [
  { slug: "slack-relay", name: "Slack Companion", tagline: "Let your AI read, search, and post to Slack.", dev: "Northwind Labs", verified: true, rating: 4.8, ratingCount: 1240, price: 0, category: "communication", featured: true, popular: true },
  { slug: "gmail-triage", name: "Inbox Triage", tagline: "Auto-sort, summarize, and draft replies in Gmail.", dev: "Postbox", verified: true, rating: 4.7, ratingCount: 980, price: 5, category: "productivity", featured: true, popular: true },
  { slug: "notion-sync", name: "Notion Sync", tagline: "Two-way sync your workspace docs and databases.", dev: "Blockwork", verified: true, rating: 4.6, ratingCount: 760, price: 3, category: "productivity", popular: true },
  { slug: "gh-reviewer", name: "PR Reviewer", tagline: "AI code review across your GitHub pull requests.", dev: "Octoflow", verified: true, rating: 4.9, ratingCount: 2110, price: 8, category: "developer", featured: true, popular: true },
  { slug: "linear-flow", name: "Linear Flow", tagline: "Turn conversations into tracked Linear issues.", dev: "Cyclon", verified: false, rating: 4.4, ratingCount: 320, price: 0, category: "developer", popular: true },
  { slug: "sheets-crunch", name: "Sheets Crunch", tagline: "Ask questions of any spreadsheet in plain English.", dev: "Gridwise", verified: true, rating: 4.5, ratingCount: 540, price: 4, category: "data", popular: true },
  { slug: "hubspot-copilot", name: "HubSpot Copilot", tagline: "Enrich records and log activity hands-free.", dev: "Funnelly", verified: true, rating: 4.3, ratingCount: 410, price: 6, category: "marketing" },
  { slug: "stripe-ops", name: "Stripe Ops", tagline: "Refunds, disputes, and MRR reports on command.", dev: "Ledgerline", verified: true, rating: 4.7, ratingCount: 690, price: 6, category: "finance", featured: true },
  { slug: "figma-handoff", name: "Figma Handoff", tagline: "Export specs and assets straight to your repo.", dev: "Pixelpush", verified: false, rating: 4.2, ratingCount: 180, price: 0, category: "design" },
  { slug: "calendar-agent", name: "Calendar Agent", tagline: "Schedule, reschedule, and prep meetings for you.", dev: "Timeblock", verified: true, rating: 4.6, ratingCount: 870, price: 3, category: "productivity", popular: true },
  { slug: "sql-analyst", name: "SQL Analyst", tagline: "Natural-language queries against your warehouse.", dev: "Queryable", verified: true, rating: 4.8, ratingCount: 1030, price: 8, category: "data" },
  { slug: "brand-writer", name: "Brand Writer", tagline: "On-brand copy for every channel, in seconds.", dev: "Toneup", verified: false, rating: 4.1, ratingCount: 260, price: 4, category: "marketing" },
  { slug: "docs-bot", name: "Docs Bot", tagline: "Answer questions from your team's docs.", dev: "Northwind Labs", verified: true, rating: 4.5, ratingCount: 600, price: 3, category: "ai" },
  { slug: "terminal-pilot", name: "Terminal Pilot", tagline: "Run and explain shell tasks safely.", dev: "Shellworks", verified: true, rating: 4.4, ratingCount: 350, price: 0, category: "developer" },
  { slug: "insight-deck", name: "Insight Deck", tagline: "Turn data into slides automatically.", dev: "Decklet", verified: false, rating: 4.0, ratingCount: 140, price: 5, category: "data" },
];

const PRIVATE_SEED: Seed[] = [
  { slug: "acme-onboarding", name: "Acme Onboarding", tagline: "Provision new hires across our internal tools.", dev: "Acme IT", verified: true, rating: 4.9, ratingCount: 34, price: 0, category: "productivity", popular: true },
  { slug: "acme-deploy", name: "Acme Deploy", tagline: "One-command deploys to our staging cluster.", dev: "Platform Team", verified: true, rating: 4.7, ratingCount: 21, price: 0, category: "developer", featured: true },
  { slug: "acme-support", name: "Support Triage", tagline: "Route and draft answers for the support queue.", dev: "Success Team", verified: true, rating: 4.6, ratingCount: 18, price: 0, category: "communication" },
];

function toApp(s: Seed, scope: "public" | "private", installedSlugs: Set<string>): MarketplaceApp {
  return {
    id: `mkt_${scope}_${s.slug}`,
    slug: s.slug,
    name: s.name,
    tagline: s.tagline,
    iconUrl: mono(s.name),
    developer: { name: s.dev, verified: s.verified },
    rating: s.rating,
    ratingCount: s.ratingCount,
    priceCredits: s.price,
    category: s.category,
    scope,
    featured: !!s.featured,
    popular: !!s.popular,
    version: "1.0.0",
    installed: installedSlugs.has(s.slug),
  };
}

async function installedSlugSet(): Promise<Set<string>> {
  try {
    const apps = await serverGetAuthed<Array<{ slug: string }>>("/api/panel-apps");
    return new Set(apps.map((a) => a.slug));
  } catch { return new Set(); }
}

/** List the marketplace for a scope, filtered + paginated. */
export async function listMarketplace(query: MarketplaceQuery): Promise<MarketplaceResponse> {
  if (USE_SERVER) {
    const qs = new URLSearchParams();
    qs.set("scope", query.scope);
    if (query.category) qs.set("category", query.category);
    if (query.q) qs.set("q", query.q);
    if (query.sort) qs.set("sort", query.sort);
    if (query.page) qs.set("page", String(query.page));
    return serverGetAuthed<MarketplaceResponse>(`/api/marketplace/apps?${qs.toString()}`);
  }

  // Placeholder path.
  const installed = await installedSlugSet();
  const seed = query.scope === "private" ? PRIVATE_SEED : PUBLIC_SEED;
  const all = seed.map((s) => toApp(s, query.scope, installed));

  const q = (query.q || "").trim().toLowerCase();
  let items = all.filter((a) =>
    (!query.category || a.category === query.category) &&
    (!q || a.name.toLowerCase().includes(q) || a.tagline.toLowerCase().includes(q) || a.developer.name.toLowerCase().includes(q)));

  const sort = query.sort || "popular";
  items.sort((a, b) =>
    sort === "rating" ? b.rating - a.rating
    : sort === "newest" ? a.name.localeCompare(b.name)
    : (Number(b.popular) - Number(a.popular)) || (b.ratingCount - a.ratingCount));

  // Category counts reflect the current scope + search (not the category filter).
  const searchScoped = all.filter((a) => !q || a.name.toLowerCase().includes(q) || a.tagline.toLowerCase().includes(q));
  const categories = CATEGORIES
    .map((c) => ({ id: c.id, label: c.label, count: searchScoped.filter((a) => a.category === c.id).length }))
    .filter((c) => c.count > 0);

  const total = items.length;
  const page = Math.max(1, query.page || 1);
  const start = (page - 1) * PAGE_SIZE;
  const paged = items.slice(start, start + PAGE_SIZE);

  // Strips are drawn from the full (unfiltered) scope so they stay stable.
  const featured = all.filter((a) => a.featured).slice(0, 4);
  const popular = all.filter((a) => a.popular).slice(0, 8);

  return { items: paged, total, page, pageSize: PAGE_SIZE, categories, featured, popular };
}

/** Install a marketplace app into the org library. Placeholder path is a
 *  friendly not-yet error; the real path installs server-side. */
export async function installMarketplaceApp(id: string): Promise<{ ok: boolean; slug?: string; error?: string }> {
  if (!USE_SERVER) {
    return { ok: false, error: "The marketplace is a preview — publishing and install go live with the server update." };
  }
  try {
    const app = await serverPostAuthed<{ slug?: string }>(`/api/marketplace/apps/${encodeURIComponent(id)}/install`, {});
    invalidateServerCache("/api/panel-apps");
    return { ok: true, slug: app?.slug };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
