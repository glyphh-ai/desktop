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
  description: string;                                   // \n\n-separated paragraphs
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
  conns: string[];
  featured?: boolean; popular?: boolean;
}

const PUBLIC_SEED: Seed[] = [
  { slug: "slack-relay", name: "Slack Companion", tagline: "Let your AI read, search, and post to Slack.", dev: "Northwind Labs", verified: true, rating: 4.8, ratingCount: 1240, price: 0, category: "communication", conns: ["Slack"], featured: true, popular: true },
  { slug: "gmail-triage", name: "Inbox Triage", tagline: "Auto-sort, summarize, and draft replies in Gmail.", dev: "Postbox", verified: true, rating: 4.7, ratingCount: 980, price: 5, category: "productivity", conns: ["Gmail"], featured: true, popular: true },
  { slug: "notion-sync", name: "Notion Sync", tagline: "Two-way sync your workspace docs and databases.", dev: "Blockwork", verified: true, rating: 4.6, ratingCount: 760, price: 3, category: "productivity", conns: ["Notion"], popular: true },
  { slug: "gh-reviewer", name: "PR Reviewer", tagline: "AI code review across your GitHub pull requests.", dev: "Octoflow", verified: true, rating: 4.9, ratingCount: 2110, price: 8, category: "developer", conns: ["GitHub"], featured: true, popular: true },
  { slug: "linear-flow", name: "Linear Flow", tagline: "Turn conversations into tracked Linear issues.", dev: "Cyclon", verified: false, rating: 4.4, ratingCount: 320, price: 0, category: "developer", conns: ["Linear", "Slack"], popular: true },
  { slug: "sheets-crunch", name: "Sheets Crunch", tagline: "Ask questions of any spreadsheet in plain English.", dev: "Gridwise", verified: true, rating: 4.5, ratingCount: 540, price: 4, category: "data", conns: ["Google Sheets"], popular: true },
  { slug: "hubspot-copilot", name: "HubSpot Copilot", tagline: "Enrich records and log activity hands-free.", dev: "Funnelly", verified: true, rating: 4.3, ratingCount: 410, price: 6, category: "marketing", conns: ["HubSpot"] },
  { slug: "stripe-ops", name: "Stripe Ops", tagline: "Refunds, disputes, and MRR reports on command.", dev: "Ledgerline", verified: true, rating: 4.7, ratingCount: 690, price: 6, category: "finance", conns: ["Stripe"], featured: true },
  { slug: "figma-handoff", name: "Figma Handoff", tagline: "Export specs and assets straight to your repo.", dev: "Pixelpush", verified: false, rating: 4.2, ratingCount: 180, price: 0, category: "design", conns: ["Figma", "GitHub"] },
  { slug: "calendar-agent", name: "Calendar Agent", tagline: "Schedule, reschedule, and prep meetings for you.", dev: "Timeblock", verified: true, rating: 4.6, ratingCount: 870, price: 3, category: "productivity", conns: ["Google Calendar"], popular: true },
  { slug: "sql-analyst", name: "SQL Analyst", tagline: "Natural-language queries against your warehouse.", dev: "Queryable", verified: true, rating: 4.8, ratingCount: 1030, price: 8, category: "data", conns: ["Snowflake"] },
  { slug: "brand-writer", name: "Brand Writer", tagline: "On-brand copy for every channel, in seconds.", dev: "Toneup", verified: false, rating: 4.1, ratingCount: 260, price: 4, category: "marketing", conns: ["Notion"] },
  { slug: "docs-bot", name: "Docs Bot", tagline: "Answer questions from your team's docs.", dev: "Northwind Labs", verified: true, rating: 4.5, ratingCount: 600, price: 3, category: "ai", conns: ["Notion", "Google Drive"] },
  { slug: "terminal-pilot", name: "Terminal Pilot", tagline: "Run and explain shell tasks safely.", dev: "Shellworks", verified: true, rating: 4.4, ratingCount: 350, price: 0, category: "developer", conns: [] },
  { slug: "insight-deck", name: "Insight Deck", tagline: "Turn data into slides automatically.", dev: "Decklet", verified: false, rating: 4.0, ratingCount: 140, price: 5, category: "data", conns: ["Google Slides"] },
];

const PRIVATE_SEED: Seed[] = [
  { slug: "acme-onboarding", name: "Acme Onboarding", tagline: "Provision new hires across our internal tools.", dev: "Acme IT", verified: true, rating: 4.9, ratingCount: 34, price: 0, category: "productivity", conns: ["Okta", "Slack"], popular: true },
  { slug: "acme-deploy", name: "Acme Deploy", tagline: "One-command deploys to our staging cluster.", dev: "Platform Team", verified: true, rating: 4.7, ratingCount: 21, price: 0, category: "developer", conns: ["GitHub"], featured: true },
  { slug: "acme-support", name: "Support Triage", tagline: "Route and draft answers for the support queue.", dev: "Success Team", verified: true, rating: 4.6, ratingCount: 18, price: 0, category: "communication", conns: ["Zendesk"] },
];

// Display name → Pipedream app id (drives the catalog icon, same source the
// Apps/Layouts pages use). Unknown names fall back to a slugified form.
const CONN_SLUG: Record<string, string> = {
  "Slack": "slack", "Gmail": "gmail", "Notion": "notion", "GitHub": "github",
  "Linear": "linear", "Google Sheets": "google_sheets", "HubSpot": "hubspot",
  "Stripe": "stripe", "Figma": "figma", "Google Calendar": "google_calendar",
  "Snowflake": "snowflake", "Google Drive": "google_drive", "Google Slides": "google_slides",
  "Okta": "okta", "Zendesk": "zendesk",
};
function connOf(name: string): { name: string; slug: string } {
  return { name, slug: CONN_SLUG[name] || name.toLowerCase().replace(/[^a-z0-9]+/g, "_") };
}

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
    connections: s.conns.map(connOf),
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

// ── Detail page (Shopify-style listing) ────────────────────────────
// Until the server marketplace API lands, the rich detail payload is
// synthesized deterministically from the same seed the storefront uses —
// enough to render (and review) a convincing listing page offline.

function hashOf(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h;
}
function escXml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

const CATEGORY_LABEL: Record<string, string> = Object.fromEntries(CATEGORIES.map((c) => [c.id, c.label]));

const WORKS_WITH: Record<string, string[]> = {
  communication: ["Slack", "Microsoft Teams", "Discord"],
  productivity: ["Notion", "Google Workspace", "Todoist"],
  developer: ["GitHub", "GitLab", "Linear"],
  ai: ["Claude", "OpenAI", "Gemini"],
  marketing: ["HubSpot", "Salesforce", "Mailchimp"],
  finance: ["Stripe", "QuickBooks", "Xero"],
  design: ["Figma", "Adobe Creative Cloud"],
  data: ["Snowflake", "BigQuery", "PostgreSQL"],
};

const REVIEW_POOL: MarketplaceReview[] = [
  { author: "Jordan M.", location: "United States", rating: 5, date: "June 12, 2026", body: "Genuinely feels like my assistant grew hands. Set it up once and it just works in the background — exactly what I hoped for.", usage: "About 4 months using the app" },
  { author: "Priya S.", location: "United Kingdom", rating: 5, date: "May 3, 2026", body: "The approval gating is the killer feature. I trust it with real actions because nothing happens without my ok. Support was responsive too.", usage: "Over 1 year using the app" },
  { author: "Marco T.", location: "Germany", rating: 5, date: "March 21, 2026", body: "Saved our team hours every week. The relay is fast and the setup was painless. Would recommend to anyone on the fence.", usage: "5 months using the app" },
  { author: "Aisha R.", location: "Canada", rating: 4, date: "January 8, 2026", body: "Does exactly what it says. Would love a couple more integrations but otherwise no complaints at all.", usage: "2 months using the app" },
  { author: "Diego F.", location: "Spain", rating: 5, date: "November 30, 2025", body: "Rock solid so far. It quietly handles the tedious parts and lets me stay in flow. Great value for the credits.", usage: "7 months using the app" },
];

const LAUNCH_DATES = ["January 18, 2024", "March 12, 2024", "May 4, 2024", "August 22, 2024", "November 9, 2024", "February 15, 2025", "April 30, 2025"];
const UPDATE_DATES = ["Updated February 3, 2026", "Updated April 19, 2026", "Updated May 28, 2026", "Updated June 14, 2026"];

/** A browser-window style product screenshot as an inline SVG data-URI. */
function shot(name: string, idx: number, hue: number): string {
  const W = 1200, H = 750;
  const accent = `hsl(${hue} 62% 50%)`;
  const soft = `hsl(${hue} 55% 94%)`;
  const line = `hsl(${hue} 20% 88%)`;
  const bar = (x: number, y: number, w: number, h: number, fill: string, r = 4) =>
    `<rect x='${x}' y='${y}' width='${w}' height='${h}' rx='${r}' fill='${fill}'/>`;
  // Content varies per screenshot for a believable gallery.
  let content = "";
  const cx0 = 40, cy0 = 96, cw = W - 240; // inner content area (after 80px window margins + 40 padding)
  if (idx % 4 === 0) {
    // sidebar + card grid
    content += bar(cx0, cy0, 180, H - 260, soft, 10);
    for (let i = 0; i < 5; i++) content += bar(cx0 + 20, cy0 + 26 + i * 44, 140, 14, line);
    for (let r = 0; r < 2; r++) for (let c = 0; c < 3; c++)
      content += bar(cx0 + 220 + c * 230, cy0 + 20 + r * 210, 200, 180, soft, 12) + bar(cx0 + 240 + c * 230, cy0 + 40 + r * 210, 120, 16, accent);
  } else if (idx % 4 === 1) {
    // data table
    content += bar(cx0, cy0, cw, 44, accent, 8);
    for (let i = 0; i < 8; i++) {
      content += bar(cx0, cy0 + 56 + i * 52, cw, 40, i % 2 ? soft : "white", 6);
      content += bar(cx0 + 20, cy0 + 68 + i * 52, 160, 14, line) + bar(cx0 + 260, cy0 + 68 + i * 52, 220, 14, line) + bar(cx0 + cw - 120, cy0 + 68 + i * 52, 80, 16, accent);
    }
  } else if (idx % 4 === 2) {
    // dashboard with chart
    for (let i = 0; i < 3; i++) content += bar(cx0 + i * (cw / 3), cy0, cw / 3 - 20, 110, soft, 12) + bar(cx0 + 20 + i * (cw / 3), cy0 + 24, 90, 30, accent);
    let pts = "";
    for (let i = 0; i <= 10; i++) { const px = cx0 + (i / 10) * cw; const py = cy0 + 400 - ((hashOf(name + idx + i) % 220)); pts += `${px},${py} `; }
    content += `<polyline points='${pts.trim()}' fill='none' stroke='${accent}' stroke-width='5' stroke-linecap='round' stroke-linejoin='round'/>`;
    content += bar(cx0, cy0 + 150, cw, 260, "white", 12) + bar(cx0 + 24, cy0 + 172, 180, 18, line);
  } else {
    // conversation / feed
    for (let i = 0; i < 5; i++) {
      const right = i % 2 === 1;
      const bw = 360 + (hashOf(name + i) % 220);
      content += bar(right ? cx0 + cw - bw : cx0, cy0 + i * 108, bw, 84, right ? accent : soft, 16);
      content += bar((right ? cx0 + cw - bw : cx0) + 20, cy0 + 18 + i * 108, bw - 120, 14, right ? "rgba(255,255,255,.7)" : line);
      content += bar((right ? cx0 + cw - bw : cx0) + 20, cy0 + 44 + i * 108, bw - 200, 14, right ? "rgba(255,255,255,.5)" : line);
    }
  }
  const svg = `<svg xmlns='http://www.w3.org/2000/svg' width='${W}' height='${H}' viewBox='0 0 ${W} ${H}'>` +
    `<rect width='${W}' height='${H}' fill='hsl(${hue} 40% 97%)'/>` +
    `<g transform='translate(80,64)'>` +
    `<rect width='${W - 160}' height='${H - 128}' rx='18' fill='white' stroke='${line}'/>` +
    `<path d='M0 18 a18 18 0 0 1 18 -18 h${W - 196} a18 18 0 0 1 18 18 v46 h-${W - 160} z' fill='${accent}'/>` +
    `<circle cx='34' cy='32' r='7' fill='rgba(255,255,255,.75)'/><circle cx='60' cy='32' r='7' fill='rgba(255,255,255,.5)'/><circle cx='86' cy='32' r='7' fill='rgba(255,255,255,.35)'/>` +
    `<text x='${(W - 160) / 2}' y='40' font-family='Inter,-apple-system,sans-serif' font-size='23' font-weight='700' fill='white' text-anchor='middle'>${escXml(name)}</text>` +
    content +
    `</g></svg>`;
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

function plansFor(price: number): MarketplacePlan[] {
  if (price === 0) {
    return [
      { name: "Free", priceCredits: 0, blurb: "Everything to get started", features: ["Up to 100 tool calls / month", "1 connected account", "Community support"] },
      { name: "Pro", priceCredits: 5, blurb: "For power users", features: ["Unlimited tool calls", "Up to 5 connected accounts", "Priority relay throughput", "Email support"] },
    ];
  }
  return [
    { name: "Starter", priceCredits: price, blurb: "For individuals", features: [`~${price * 10} tool calls / month`, "1 connected account", "Standard relay", "Email support"] },
    { name: "Growth", priceCredits: price * 3, blurb: "For teams", features: [`~${price * 30} tool calls / month`, "Up to 10 connected accounts", "Priority relay", "Shared skills"] },
    { name: "Scale", priceCredits: price * 6, blurb: "For organizations", features: ["High-volume tool calls", "Unlimited connected accounts", "Dedicated relay lane", "SSO & audit log"] },
  ];
}

/** Synthesize a star distribution that averages near `rating`. */
function breakdown(rating: number, count: number): Array<{ stars: number; count: number }> {
  const stars = [5, 4, 3, 2, 1];
  const weights = stars.map((s) => Math.max(0.015, Math.exp(-Math.pow(s - rating, 2) * 1.5)));
  const sum = weights.reduce((a, b) => a + b, 0);
  const res = stars.map((s, i) => ({ stars: s, count: Math.round((weights[i] / sum) * count) }));
  const diff = count - res.reduce((a, b) => a + b.count, 0);
  res[0].count = Math.max(0, res[0].count + diff); // absorb rounding into the top bucket
  return res;
}

function pick<T>(arr: T[], seed: number): T { return arr[seed % arr.length]; }

/** Build the full detail payload for one app id (`mkt_<scope>_<slug>`). */
export async function getMarketplaceApp(id: string): Promise<MarketplaceAppDetail | null> {
  if (USE_SERVER) {
    try { return await serverGetAuthed<MarketplaceAppDetail>(`/api/marketplace/apps/${encodeURIComponent(id)}`); }
    catch { return null; }
  }

  const m = /^mkt_(public|private)_(.+)$/.exec(id);
  if (!m) return null;
  const scope = m[1] as "public" | "private";
  const slug = m[2];
  const seedList = scope === "private" ? PRIVATE_SEED : PUBLIC_SEED;
  const s = seedList.find((x) => x.slug === slug);
  if (!s) return null;

  const installed = await installedSlugSet();
  const base = toApp(s, scope, installed);
  const h = hashOf(s.slug);
  const hue = h % 360;
  const catLabel = (CATEGORY_LABEL[s.category] || "work").toLowerCase();
  const tag = s.tagline.replace(/\.$/, "");
  const short = tag.charAt(0).toLowerCase() + tag.slice(1);

  const description = [
    `${s.name} lets your AI ${short} — no manual steps, no context-switching.`,
    `Once connected, ${s.name} exposes a focused set of tools your assistant can call directly over the Glyphh MCP relay. It reads what it needs, takes the actions you approve, and reports back inline. Everything runs against your own connected account, so your data stays under your control.`,
    `Built by ${s.dev}, ${s.name} is designed to feel invisible: describe the outcome you want and your AI handles the ${catLabel}. No new dashboard to babysit — it works wherever your model already runs.`,
  ].join("\n\n");

  const highlights = [
    "Works over the Glyphh MCP relay — drive it from Claude, Cursor, or any MCP client",
    "Scoped, approval-gated actions so your AI never oversteps",
    "Connect one account and you're live in minutes",
    s.price > 0 ? "Metered by compute credits — you only pay for what actually runs" : "Free plan available, upgrade any time",
  ];

  const worksWith = ["Glyphh MCP relay", ...(WORKS_WITH[s.category] || [])];

  const shotCaptions = [
    tag,
    `${s.name} running inside your workspace`,
    "Approve actions before anything happens",
    "Review every run from one place",
    "Set it up in a couple of clicks",
  ];
  const shotCount = 4 + (h % 2); // 4 or 5
  const screenshots = Array.from({ length: shotCount }, (_, i) => ({
    url: shot(s.name, i, hue),
    caption: shotCaptions[i % shotCaptions.length],
  }));

  const plans = plansFor(s.price);
  const ratingBreakdown = breakdown(s.rating, s.ratingCount);

  const reviewN = 2 + (h % 2); // 2 or 3
  const reviews = Array.from({ length: reviewN }, (_, i) => pick(REVIEW_POOL, h + i * 7));

  const dataAccess = [
    `Read your connected ${s.dev} account's data`,
    "Take approved actions on your behalf",
    "No customer data is stored on Glyphh servers",
  ];

  const similar = seedList
    .filter((x) => x.category === s.category && x.slug !== s.slug)
    .slice(0, 3)
    .map((x) => toApp(x, scope, installed));

  return {
    ...base,
    description,
    highlights,
    worksWith,
    screenshots,
    plans,
    ratingBreakdown,
    reviews,
    launchedAt: pick(LAUNCH_DATES, h),
    updatedAt: pick(UPDATE_DATES, h >> 3),
    website: `https://${s.slug}.glyphh.app`,
    dataAccess,
    languages: ["English"],
    similar,
  };
}
