import { openAppInWorkbench } from "./code.js";
/**
 * marketplace.ts — the Marketplace SECTION SHELL: the storefront (search,
 * categories, sort, cards) and the listing DETAIL page (gallery, video,
 * markdown pitch, pricing + discounts, reviews, developer card, report flow,
 * install/uninstall).
 *
 * One section, five sub-views (#mkt-store / #mkt-detail / #mkt-dev /
 * #mkt-console / #mkt-admin) swapped by showMktView. The developer pages live
 * in marketplace-dev.ts; the platform-admin desk in marketplace-admin.ts.
 *
 * Data: browse rows are the thin contract listing (name, price, kind,
 * installs) — the card's icon / tagline / stars come from the detail record,
 * HYDRATED progressively per slug and cached. An unhydrated card renders
 * honestly from the listing alone and upgrades in place.
 */

import { fixMediaUrl } from "./marketplace-dev.js";
import { confirmAction, promptAction } from "./shared.js";
import { primeConnectedIcons } from "./app-icon.js";
import { formatMarkdown } from "../format-markdown.js";
import {
  mkt, mktIsPlatformAdmin, escMkt, mktConnChip, connLabel, mktConnIconApps,
  mktVideoEmbed, MKT_CATEGORY_LABELS, mktStarRow, mktDate, mktDiscountActive, mktPriceLabel,
  type MktListing, type MktDetail, type MktReview,
} from "./marketplace-data.js";
import { loadMktConsole, openMktDeveloper } from "./marketplace-dev.js";
import { loadMktAdmin } from "./marketplace-admin.js";

// Same branch flag the rest of the renderer uses (set by web/src/bridge.js).
const IS_WEB = !!(window as unknown as { __GLYPHH_WEB__?: boolean }).__GLYPHH_WEB__;

const marketplacePage = document.getElementById("apps-marketplace-page")!;
const mktStoreEl = document.getElementById("mkt-store")!;
const mktDetailEl = document.getElementById("mkt-detail")!;
const mktSearchInput = document.getElementById("mkt-search") as HTMLInputElement;
const mktSortSelect = document.getElementById("mkt-sort") as HTMLSelectElement;
const mktCategoriesEl = document.getElementById("mkt-categories")!;
const mktPopularWrap = document.getElementById("mkt-popular")!;
const mktPopularList = document.getElementById("mkt-popular-list")!;
const mktListEl = document.getElementById("mkt-list")!;
const mktPagerEl = document.getElementById("mkt-pager")!;
const mktCountEl = document.getElementById("mkt-count")!;
const mktAllTitle = document.getElementById("mkt-all-title")!;

// ── Sub-view switching ────────────────────────────────────────────────────

export type MktView = "store" | "detail" | "dev" | "console" | "admin";
const VIEW_IDS: Record<MktView, string> = {
  store: "mkt-store", detail: "mkt-detail", dev: "mkt-dev",
  console: "mkt-console", admin: "mkt-admin",
};

/** Show one sub-view, hide the rest, scroll to the top. */
export function showMktView(view: MktView): void {
  for (const [v, id] of Object.entries(VIEW_IDS)) {
    const el = document.getElementById(id);
    if (!el) continue;
    el.classList.toggle("hidden", v !== view);
    // Sub-pages are filled per open; leaving one clears it so stale DOM and
    // handlers never linger behind the storefront.
    if (v !== view && v !== "store") el.innerHTML = "";
  }
  marketplacePage.scrollTop = 0;
  const scroller = marketplacePage.closest(".wb-card-body, #help-content");
  if (scroller) scroller.scrollTop = 0;
}

// ── Storefront state ──────────────────────────────────────────────────────

let mktScope: "public" | "private" = "public";
let mktCategory = "";
let mktQuery = "";
let mktSort: "popular" | "rating" | "newest" = "popular";
let mktPage = 1;
let mktSearchTimer: ReturnType<typeof setTimeout> | null = null;

// Page size adapts to resolution instead of a fixed count. The grid is
// `repeat(auto-fit, minmax(260px, 1fr))` with a 14px gap, so we derive the
// column count the same way the browser lays it out, work out how many rows
// today's baseline of 12 cards would occupy at that width, and show ONE row
// fewer — a full page minus a row, per desktop / iPad / phone.
const MKT_CARD_MIN = 260; // .mkt-grid minmax() floor
const MKT_GRID_GAP = 14;  // .mkt-grid gap
const MKT_BASE_ITEMS = 12; // the previous fixed page size we trim a row from

function mktColumns(): number {
  const width = mktListEl.clientWidth || marketplacePage.clientWidth || 0;
  return Math.max(1, Math.floor((width + MKT_GRID_GAP) / (MKT_CARD_MIN + MKT_GRID_GAP)));
}

function mktPageSize(): number {
  const cols = mktColumns();
  const baseRows = Math.max(1, Math.ceil(MKT_BASE_ITEMS / cols)); // rows 12 cards fill now
  const rows = Math.max(1, baseRows - 1);                         // one row fewer
  return cols * rows;
}

let mktRows: MktListing[] = [];
let installedSlugs = new Set<string>();
/** Per-slug detail hydration — the storefront's icon/tagline/stars source. */
const detailCache = new Map<string, MktDetail>();
let hydrateEpoch = 0;

/** A card's view = the listing row + its hydrated detail (when landed). */
function cardTitle(l: MktListing): string { return detailCache.get(l.slug)?.listing.title || l.name; }
function cardTagline(l: MktListing): string {
  return detailCache.get(l.slug)?.listing.tagline || l.description || "";
}

function flashMktNote(msg: string): void {
  let note = document.getElementById("mkt-note");
  if (!note) {
    note = document.createElement("div");
    note.id = "mkt-note";
    note.className = "mkt-note";
    marketplacePage.prepend(note);
  }
  note.textContent = msg;
  note.classList.remove("hidden");
  setTimeout(() => note?.classList.add("hidden"), 4000);
}

/** The workpanel marker — work panels install LOCALLY on a desktop. */
function kindBadge(l: { kind: string; builtin: boolean }): string {
  if (l.kind === "workpanel") return `<span class="mkt-kind-badge">Work panel — desktop install</span>`;
  if (l.builtin) return `<span class="mkt-kind-badge">Built-in</span>`;
  return "";
}

function ratingLine(slug: string): string {
  const d = detailCache.get(slug);
  if (!d) return `<span class="mkt-rating mkt-rating-pending">…</span>`;
  const { ratingAvg, ratingCount } = d.listing;
  if (!ratingCount) return `<span class="mkt-rating mkt-rating-none">No reviews yet</span>`;
  return `<span class="mkt-rating"><b>${ratingAvg.toFixed(1)}</b> <span class="mkt-stars">★</span> <span class="mkt-rating-count">(${ratingCount.toLocaleString()})</span></span>`;
}

function mktCard(l: MktListing, variant: "grid" | "row"): HTMLElement {
  const card = document.createElement("div");
  card.className = `mkt-card mkt-card-${variant}`;
  const d = detailCache.get(l.slug);
  const iconUrl = d?.listing.iconUrl;
  const icon = iconUrl
    ? `<img src="${escMkt(iconUrl)}" alt="" />`
    : `<span class="mkt-card-initial">${escMkt((cardTitle(l) || "?").charAt(0).toUpperCase())}</span>`;
  card.innerHTML = `
    <div class="mkt-card-top">
      <div class="mkt-card-icon">${icon}</div>
      <div class="mkt-card-head">
        <div class="mkt-card-name">${escMkt(cardTitle(l))}</div>
        <div class="mkt-card-metaline">
          ${ratingLine(l.slug)}
          <span class="mkt-dot">•</span>
          <span class="mkt-price">${mktPriceLabel(l.pricing)}</span>
          ${l.kind !== "workpanel" && typeof l.installs === "number" ? `<span class="mkt-dot">•</span><span class="mkt-installs-count">${l.installs.toLocaleString()} install${l.installs === 1 ? "" : "s"}</span>` : ""}
          ${installedSlugs.has(l.slug) ? `<span class="mkt-dot">•</span><span class="mkt-installed">Installed</span>` : ""}
        </div>
      </div>
    </div>
    <div class="mkt-card-tagline">${escMkt(cardTagline(l))}</div>
    ${kindBadge(l)}`;
  // The whole card is a link into the detail page — no per-card Install button.
  card.setAttribute("role", "link");
  card.tabIndex = 0;
  card.addEventListener("click", () => void openMktDetail(l.slug));
  card.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); void openMktDetail(l.slug); } });
  return card;
}

// ── Load + hydrate ────────────────────────────────────────────────────────

export async function loadMarketplace(): Promise<void> {
  mktListEl.innerHTML = `<div class="crud-empty">Loading…</div>`;
  try {
    const { apps, installedSlugs: installed } = await mkt.browse();
    // Suspension is the platform kill switch — a suspended listing never
    // renders, even if a stale row slips through the server filter.
    mktRows = apps.filter((a) => !a.suspended);
    installedSlugs = new Set(installed);
  } catch (err) {
    mktRows = [];
    mktListEl.innerHTML = `<div class="crud-empty">${escMkt(err instanceof Error ? err.message : "Marketplace unavailable right now.")}</div>`;
    return;
  }
  renderMktStorefront();
  hydrateDetails(true);
  void loadLibraryStrip();
}

/** The Skills & Loops strip (his order, 2026-09-02): approved library listings
 *  + the org's own shared items. Always free; Install copies into the caller's
 *  library. Quiet on failure — the app storefront never waits on it. */
async function loadLibraryStrip(): Promise<void> {
  const wrap = document.getElementById("mkt-library");
  const list = document.getElementById("mkt-library-list");
  if (!wrap || !list) return;
  const res = await window.glyphh.libraryMarket?.().catch(() => null);
  if (!res?.ok) { wrap.classList.add("hidden"); return; }
  const orgSlugs = new Set(res.org.map((o) => `${o.kind}|${o.slug}`));
  const rows = [
    ...res.listings.map((l) => ({ ...l, inOrg: orgSlugs.has(`${l.kind}|${l.slug}`) })),
    ...res.org.filter((o) => !res.listings.some((l) => l.kind === o.kind && l.slug === o.slug))
      .map((o) => ({ id: "", kind: o.kind as "skill" | "loop", slug: o.slug, name: o.name, description: o.description,
                     installs: 0, installed: false, inOrg: true })),
  ];
  if (!rows.length) { wrap.classList.add("hidden"); return; }
  wrap.classList.remove("hidden");
  list.innerHTML = "";
  for (const r of rows) {
    const row = document.createElement("div");
    row.style.cssText = "display:flex;align-items:center;gap:10px;padding:9px 0;border-bottom:1px solid var(--border);";
    row.innerHTML = `
      <span class="lib-badge">${r.kind === "skill" ? "Skill" : "Loop"}</span>
      <div style="flex:1;min-width:0;">
        <span style="font-size:13px;color:var(--text-1);"></span>
        <span style="font-size:12px;color:var(--text-3);margin-left:6px;"></span>
      </div>
      ${r.inOrg && !r.id ? `<span class="lib-badge on">In your org</span>`
        : r.installed ? `<button type="button" class="action-btn mkt-lib-un" style="height:26px;font-size:12px;">Installed</button>`
        : `<button type="button" class="action-btn primary mkt-lib-in" style="height:26px;font-size:12px;">Install</button>`}`;
    const [nameEl, descEl] = Array.from(row.querySelectorAll("div > span"));
    (nameEl as HTMLElement).textContent = r.name;
    (descEl as HTMLElement).textContent = r.description || (r.id && r.installs ? `${r.installs} installs` : "");
    row.querySelector(".mkt-lib-in")?.addEventListener("click", () => {
      void window.glyphh.libraryMarketInstall?.(r.id).then((rr) => {
        if (!rr?.ok) {
          const err = document.createElement("div");
          err.className = "crud-form-error";
          err.textContent = rr?.error || "Couldn't install.";
          row.appendChild(err);
          return;
        }
        void loadLibraryStrip();
      });
    });
    row.querySelector(".mkt-lib-un")?.addEventListener("click", () => {
      void window.glyphh.libraryMarketUninstall?.(r.id).then(() => void loadLibraryStrip());
    });
    list.appendChild(row);
  }
}

/** Fetch each listing's detail (icon / tagline / stars / category / developer)
 *  with a small concurrency cap, re-rendering as batches land.
 *  `revalidate` refetches EVERY row (his report, 2026-08-20: the marketplace
 *  didn't update — cached details froze icons/ratings/status at first sight):
 *  cached entries still paint instantly, then fresh data re-renders over them
 *  as it lands. Stale-while-revalidate, no flash. */
function hydrateDetails(revalidate = false): void {
  const epoch = ++hydrateEpoch;
  const missing = (revalidate ? mktRows : mktRows.filter((l) => !detailCache.has(l.slug))).map((l) => l.slug);
  if (!missing.length) return;
  let inFlight = 0, landedSinceRender = 0;
  const queue = [...missing];
  const pump = (): void => {
    if (epoch !== hydrateEpoch) return; // a refresh restarted hydration
    while (inFlight < 5 && queue.length) {
      const slug = queue.shift()!;
      inFlight++;
      mkt.detail(slug)
        .then(({ detail }) => { detailCache.set(slug, detail); landedSinceRender++; })
        .catch(() => { /* one card stays thin — the listing row still renders */ })
        .finally(() => {
          inFlight--;
          if (epoch !== hydrateEpoch) return;
          // Re-render in batches (or at the end) — not per card.
          if ((landedSinceRender >= 6 || (!queue.length && !inFlight)) && landedSinceRender > 0) {
            landedSinceRender = 0;
            if (!mktStoreEl.classList.contains("hidden")) renderMktStorefront();
          }
          pump();
        });
    }
  };
  pump();
}

// ── Filter / sort / render ────────────────────────────────────────────────

function filteredRows(): MktListing[] {
  const q = mktQuery.toLowerCase();
  return mktRows
    .filter((l) => (mktScope === "public" ? l.visibility === "public" : l.visibility !== "public"))
    .filter((l) => {
      if (!mktCategory) return true;
      return detailCache.get(l.slug)?.listing.category === mktCategory;
    })
    .filter((l) => {
      if (!q) return true;
      const d = detailCache.get(l.slug);
      return cardTitle(l).toLowerCase().includes(q)
        || (l.description || "").toLowerCase().includes(q)
        || (d?.listing.tagline || "").toLowerCase().includes(q)
        || (d?.listing.category || "").toLowerCase().includes(q)
        || (d?.developer?.displayName || "").toLowerCase().includes(q)
        || (d?.developer?.handle || "").toLowerCase().includes(q);
    });
}

function sortRows(rows: MktListing[]): MktListing[] {
  const rating = (l: MktListing) => detailCache.get(l.slug)?.listing.ratingAvg ?? 0;
  const sorted = [...rows];
  if (mktSort === "newest") sorted.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  else if (mktSort === "rating") sorted.sort((a, b) => rating(b) - rating(a) || b.installs - a.installs);
  else sorted.sort((a, b) => b.installs - a.installs);
  return sorted;
}

function renderMktCategories(): void {
  // Category counts come from the hydrated details of the CURRENT scope.
  const counts = new Map<string, number>();
  for (const l of mktRows) {
    if (mktScope === "public" ? l.visibility !== "public" : l.visibility === "public") continue;
    const cat = detailCache.get(l.slug)?.listing.category;
    if (cat) counts.set(cat, (counts.get(cat) || 0) + 1);
  }
  mktCategoriesEl.innerHTML = "";
  const chip = (id: string, label: string, count?: number) => {
    const b = document.createElement("button");
    b.className = "mkt-cat" + (mktCategory === id ? " active" : "");
    b.textContent = count != null ? `${label} ${count}` : label;
    b.addEventListener("click", () => { mktCategory = mktCategory === id ? "" : id; mktPage = 1; renderMktStorefront(); });
    return b;
  };
  mktCategoriesEl.appendChild(chip("", "All"));
  for (const [id, count] of [...counts.entries()].sort((a, b) => b[1] - a[1])) {
    mktCategoriesEl.appendChild(chip(id, MKT_CATEGORY_LABELS[id] || id, count));
  }
}

function renderMktStorefront(): void {
  renderMktCategories();

  const rows = sortRows(filteredRows());

  // Popular strip only on the default view (no search / category / first page).
  const stripsVisible = !mktQuery && !mktCategory && mktPage === 1;
  const popular = rows.filter((l) => l.installs > 0).slice(0, 8);
  mktPopularWrap.classList.toggle("hidden", !stripsVisible || popular.length === 0);
  if (stripsVisible) {
    mktPopularList.innerHTML = "";
    for (const l of popular) mktPopularList.appendChild(mktCard(l, "row"));
  }

  mktAllTitle.textContent = mktCategory ? (MKT_CATEGORY_LABELS[mktCategory] || "Apps")
    : mktQuery ? `Results for “${mktQuery}”` : "All apps";
  mktCountEl.textContent = rows.length ? `${rows.length} app${rows.length === 1 ? "" : "s"}` : "";

  const pageSize = mktPageSize();
  const totalPages = Math.max(1, Math.ceil(rows.length / pageSize));
  if (mktPage > totalPages) mktPage = totalPages;
  const pageRows = rows.slice((mktPage - 1) * pageSize, mktPage * pageSize);

  mktListEl.innerHTML = "";
  if (rows.length === 0) {
    mktListEl.innerHTML = mktScope === "private"
      ? `<div class="crud-empty">Your organization hasn't published any apps yet. Build one, list it, and it appears here.</div>`
      : `<div class="crud-empty">No apps match your search.</div>`;
  } else {
    for (const l of pageRows) mktListEl.appendChild(mktCard(l, "grid"));
  }

  // Pagination.
  mktPagerEl.innerHTML = "";
  if (totalPages > 1) {
    const mk = (label: string, to: number, disabled: boolean) => {
      const b = document.createElement("button");
      b.className = "pagination-btn"; b.textContent = label; b.disabled = disabled;
      b.addEventListener("click", () => { mktPage = to; renderMktStorefront(); marketplacePage.scrollTop = 0; });
      return b;
    };
    mktPagerEl.appendChild(mk("‹ Prev", mktPage - 1, mktPage <= 1));
    const info = document.createElement("span");
    info.className = "pagination-info";
    info.textContent = `${mktPage} / ${totalPages}`;
    mktPagerEl.appendChild(info);
    mktPagerEl.appendChild(mk("Next ›", mktPage + 1, mktPage >= totalPages));
  }
}

// ── Detail page ───────────────────────────────────────────────────────────

/** Reviews already fetched for the OPEN detail page (summary bars + list). */
let dtReviews: MktReview[] = [];
let dtReviewsTotal = 0;
let dtMyStars = 0;

function closeMktDetail(): void {
  showMktView("store");
  renderMktStorefront();
}

export async function openMktDetail(slug: string): Promise<void> {
  showMktView("detail");
  mktDetailEl.innerHTML = `<button class="mkt-back">‹ Back to marketplace</button><div class="crud-empty">Loading…</div>`;
  mktDetailEl.querySelector(".mkt-back")?.addEventListener("click", closeMktDetail);

  let detail: MktDetail | null = null;
  let installed = false;
  try {
    const res = await mkt.detail(slug);
    detail = res.detail;
    installed = res.installed;
    detailCache.set(slug, res.detail);
  } catch { detail = null; }
  if (!detail) {
    mktDetailEl.innerHTML = `<button class="mkt-back">‹ Back to marketplace</button><div class="crud-empty">Couldn't load this app right now.</div>`;
    mktDetailEl.querySelector(".mkt-back")?.addEventListener("click", closeMktDetail);
    return;
  }
  dtReviews = [];
  dtReviewsTotal = 0;
  dtMyStars = 0;
  try {
    const r = await mkt.reviews(slug, { limit: 20 });
    dtReviews = r.reviews;
    dtReviewsTotal = r.total;
  } catch { /* reviews section renders empty */ }
  renderMktDetail(detail, installed, await mktIsPlatformAdmin() === true);
}

/** Star-breakdown bars computed from the loaded reviews (5 → 1). */
function reviewBars(): string {
  if (!dtReviews.length) return "";
  const total = dtReviews.length;
  return [5, 4, 3, 2, 1].map((stars) => {
    const count = dtReviews.filter((r) => r.stars === stars).length;
    const pct = Math.round((count / total) * 100);
    return `<div class="mkt-bar-row"><span>${stars} star</span><div class="mkt-bar-track"><div class="mkt-bar-fill" style="width:${pct}%"></div></div><span class="pct">${pct}%</span></div>`;
  }).join("");
}

/** Required connections with connected status — what the app needs to work. */
function requiredConnsHtml(conns: MktDetail["requiredConnections"]): string {
  if (!conns.length) return "";
  const rows = conns.map((c) => `
    <div class="mkt-req-conn">
      ${mktConnChip({ name: connLabel(c.slug), slug: c.slug })}
      <span class="mkt-req-conn-name">${escMkt(connLabel(c.slug))}</span>
      <span class="app-conn-status ${c.connected ? "ok" : "missing"}">${c.connected ? "Connected" : "Not connected"}</span>
    </div>`).join("");
  return `<section class="mkt-dt-section">
    <h3>Requires</h3>
    <p class="settings-hint" style="margin:0 0 8px;">This app calls these connected accounts through Glyphh's governed connectors.</p>
    <div class="mkt-req-conns">${rows}</div></section>`;
}

/** One review row (app or developer): stars, date, body, the owner's public
 *  reply, and the caller's actions. */
export function mktReviewRow(r: MktReview, actions: string): string {
  return `
    <div class="mkt-review" data-review-id="${escMkt(r.id)}">
      <div class="mkt-review-head">${mktStarRow(r.stars)}<span class="mkt-review-date">${escMkt(mktDate(r.createdAt))}</span>
        ${r.status === "flagged" ? `<span class="mkt-flag-chip">Under moderation</span>` : ""}
        <span style="flex:1;"></span>${actions}</div>
      ${r.body ? `<p class="mkt-review-body">${escMkt(r.body)}</p>` : ""}
      <div class="mkt-review-who"><b>${escMkt(r.authorName || "A Glyphh member")}</b>${r.version ? ` · v${escMkt(r.version)}` : ""}</div>
      ${r.ownerResponse ? `<div class="mkt-review-response"><span class="mkt-review-response-tag">Developer response</span> ${escMkt(r.ownerResponse)}</div>` : ""}
    </div>`;
}

/** The write-your-review form. One review per person — writing again edits it. */
export function mktReviewFormHtml(idPrefix: string, heading: string): string {
  return `
    <div class="mkt-review-form" id="${idPrefix}-form">
      <h4>${escMkt(heading)}</h4>
      <div class="mkt-star-input" id="${idPrefix}-stars">
        ${[1, 2, 3, 4, 5].map((n) => `<button type="button" class="mkt-star-btn" data-stars="${n}" aria-label="${n} star${n === 1 ? "" : "s"}">☆</button>`).join("")}
      </div>
      <textarea id="${idPrefix}-body" class="settings-input" rows="3" maxlength="4000" placeholder="What should other installers know? (optional)" spellcheck="true"></textarea>
      <div class="settings-actions" style="margin-top:8px;display:flex;gap:8px;align-items:center;">
        <span id="${idPrefix}-status" style="flex:1;font-size:12px;color:var(--text-3);"></span>
        <button id="${idPrefix}-delete" class="action-btn" type="button" title="Remove the review you wrote">Remove mine</button>
        <button id="${idPrefix}-submit" class="action-btn primary" type="button" disabled>Post review</button>
      </div>
      <p class="proxy-field-hint" style="margin-top:6px;">One review per person — posting again replaces yours.</p>
    </div>`;
}

/** Wire the star picker; returns a getter for the chosen stars. */
export function wireStarInput(container: HTMLElement, onPick?: (stars: number) => void): () => number {
  let picked = 0;
  const paint = () => {
    container.querySelectorAll<HTMLButtonElement>(".mkt-star-btn").forEach((b) => {
      const n = Number(b.dataset.stars);
      b.textContent = n <= picked ? "★" : "☆";
      b.classList.toggle("on", n <= picked);
    });
  };
  container.querySelectorAll<HTMLButtonElement>(".mkt-star-btn").forEach((b) => {
    b.addEventListener("click", () => { picked = Number(b.dataset.stars); paint(); onPick?.(picked); });
  });
  return () => picked;
}

/** The pricing section body: price, active discount, upcoming window. */
function pricingHtml(d: MktDetail): string {
  const p = d.pricing;
  if (p.monthlyCredits <= 0) {
    return `<div class="mkt-plan"><div class="mkt-plan-price">Free</div><div class="mkt-plan-blurb">Install at no monthly cost.</div></div>`;
  }
  const active = mktDiscountActive(p);
  const discount = active
    ? `<div class="mkt-discount-note">${p.discountPercent}% off${p.discountEndsAt ? ` until ${escMkt(mktDate(p.discountEndsAt))}` : ""} — pay ${p.effectiveMonthlyCredits} credits/mo now.</div>`
    : "";
  return `
    <div class="mkt-plan">
      <div class="mkt-plan-price">${active ? `<s>${p.monthlyCredits}</s> ${p.effectiveMonthlyCredits}` : p.monthlyCredits}<small> credits/mo</small></div>
      <div class="mkt-plan-blurb">Billed monthly in Glyphh credits; the first month is charged when you install.</div>
      ${discount}
    </div>`;
}

function renderMktDetail(d: MktDetail, installed: boolean, isAdmin: boolean): void {
  const l = d.listing;
  const catLabel = l.category ? (MKT_CATEGORY_LABELS[l.category] || l.category) : "Apps";
  const priceLabel = mktPriceLabel(d.pricing);
  const icon = l.iconUrl
    ? `<img src="${escMkt(l.iconUrl)}" alt="" />`
    : `<span class="mkt-card-initial">${escMkt((l.title || d.name || "?").charAt(0).toUpperCase())}</span>`;

  // The description is markdown — render it, don't escape it into raw syntax.
  const descHtml = (l.body || d.description) ? formatMarkdown(l.body || d.description || "") : "";
  const videoHtml = "";   // the demo video lives IN the gallery strip now
  const reqConnHtml = requiredConnsHtml(d.requiredConnections);
  // An ingest-declaring app RECEIVES external data — installers must know a
  // third-party pipeline (n8n / make.com / Boomi) feeds it, and what to do
  // after install (create a pipeline under the app's Integration tab).
  const ingestHtml = d.hasIngest
    ? `<div class="mkt-notice info" role="status"><span class="mkt-notice-icon"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><line x1="12" y1="11" x2="12" y2="16"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg></span><span class="mkt-notice-text">This app receives data from an external pipeline (n8n, make.com, Boomi, …). After installing, create a pipeline on the app's Integration tab and point your system at its door URL.</span></div>`
    : "";

  // ── CTA: install / uninstall, with the credit price on the button. ─────────
  const isWorkpanel = d.kind === "workpanel";
  const priced = d.pricing.effectiveMonthlyCredits > 0;
  const installLabel = priced ? `Install — ${d.pricing.effectiveMonthlyCredits} credits/mo` : "Install — Free";
  const cta = d.suspended
    ? `<button class="action-btn" disabled>Suspended</button>`
    : (d as { blockedForOrg?: boolean }).blockedForOrg
      ? `<button class="action-btn" disabled title="Your organization's administrator has blocked this app.">Blocked by your organization</button>`
      : d.owned
      ? `<button class="action-btn" disabled title="Publishers can't install their own app — it's already yours.">Your listing</button>`
      : installed
      ? `<button class="action-btn primary mkt-dt-open" type="button">Open app</button>
         <button class="action-btn mkt-dt-uninstall" type="button">Uninstall</button>`
      : `<button class="action-btn primary mkt-dt-install" type="button">${escMkt(installLabel)}</button>`;
  // Workpanels read EXACTLY like every other app (his rule, 2026-08-20) --
  // no special explainer under the button.
  void isWorkpanel;
  const ctaNote = priced
    ? `Charges the first month (${d.pricing.effectiveMonthlyCredits} credits) now, then monthly.`
    : "Free to install";

  // ── Developer card (side) — support falls to the developer, never Glyphh. ──
  const dev = d.developer;
  const devCard = dev ? `
    <div class="mkt-side-card mkt-dev-card">
      <h4>Developer</h4>
      <div class="mkt-dev-row">
        <div class="mkt-dev-avatar">${dev.avatarUrl ? `<img src="${escMkt(dev.avatarUrl)}" alt="" />` : `<span class="mkt-card-initial">${escMkt(dev.displayName.charAt(0).toUpperCase())}</span>`}</div>
        <div class="mkt-dev-id">
          <b>${escMkt(dev.displayName)}</b>
          <span class="mkt-dev-handle">@${escMkt(dev.handle)}</span>
        </div>
      </div>
      <div class="mkt-dev-stats">
        ${dev.ratingCount
          ? `<div>${mktStarRow(dev.ratingAvg)} <b>${dev.ratingAvg.toFixed(1)}</b> <span class="mkt-rating-count">(${dev.ratingCount} developer review${dev.ratingCount === 1 ? "" : "s"})</span></div>`
          : `<div class="mkt-rating-none">Not rated yet</div>`}
        <div id="mkt-dev-rollup" class="mkt-dev-rollup"></div>
      </div>
      <button class="action-btn mkt-dev-profile-btn" type="button">View profile</button>
      ${dev.supportEmail
        ? `<a class="mkt-support-link" href="mailto:${escMkt(dev.supportEmail)}">Support by ${escMkt(dev.displayName)}</a>`
        : l.website
          ? `<a class="mkt-support-link mkt-ext" data-url="${escMkt(l.website)}" href="#">Support by ${escMkt(dev.displayName)}</a>`
          : `<div class="proxy-field-hint" style="margin-top:8px;">Support falls to the developer.</div>`}
    </div>` : "";

  // ── Admin strip: suspend/unsuspend + the open-report marker. ───────────────
  const adminStrip = isAdmin ? `
    <div class="mkt-admin-strip">
      <span class="mkt-admin-tag">Platform admin</span>
      ${d.reported ? `<span class="mkt-reported-chip">Open malicious report</span>` : ""}
      <span style="flex:1;"></span>
      <button class="action-btn ${d.suspended ? "" : "danger"} mkt-admin-suspend-btn" type="button">${d.suspended ? "Unsuspend" : "Suspend listing"}</button>
    </div>` : "";

  // ONE MEDIA STRIP (his rule, 2026-08-20): the demo video leads — a trailer
  // sells before stills do (the store convention) — then the screenshots.
  const uploadedVideo = !!l.videoUrl && (l.videoUrl.startsWith("/") || l.videoUrl.includes("/api/apps/"));
  const linkEmbed = ((): string => {
    if (!l.videoUrl || uploadedVideo) return "";
    try {
      const u = new URL(l.videoUrl);
      const host = u.hostname.replace(/^www\./, "");
      if (host === "youtu.be") return `https://www.youtube.com/embed/${u.pathname.slice(1)}`;
      if (host.endsWith("youtube.com")) { const v = u.searchParams.get("v"); return v ? `https://www.youtube.com/embed/${v}` : ""; }
      if (host.endsWith("vimeo.com")) { const id = u.pathname.split("/").filter(Boolean).pop(); return id ? `https://player.vimeo.com/video/${id}` : ""; }
    } catch { /* not embeddable */ }
    return "";
  })();
  const hasVideoSlide = uploadedVideo || !!linkEmbed;
  const videoMainHtml = uploadedVideo
    ? `<video class="mkt-gallery-video" src="${escMkt(fixMediaUrl(l.videoUrl))}" controls preload="metadata"></video>`
    : linkEmbed ? `<div class="mkt-video"><iframe src="${escMkt(linkEmbed)}" allow="fullscreen; picture-in-picture" allowfullscreen loading="lazy"></iframe></div>` : "";
  const gallery = (l.screenshots.length || hasVideoSlide) ? `
    <section class="mkt-dt-section mkt-gallery">
      <div class="mkt-gallery-main" id="mkt-gallery-main">${hasVideoSlide ? videoMainHtml : `<img id="mkt-shot-main" src="${escMkt(fixMediaUrl(l.screenshots[0]?.url))}" alt="" />`}</div>
      <div class="mkt-gallery-caption" id="mkt-shot-caption">${hasVideoSlide ? "" : escMkt(l.screenshots[0]?.caption || "")}</div>
      <div class="mkt-gallery-thumbs">
        ${hasVideoSlide ? ((): string => {
          // A REAL thumbnail for the video tile (his bug, 2026-08-20):
          // uploaded → the file's own first frame; YouTube → the poster JPEG;
          // anything else → the dark branded tile.
          const ytId = linkEmbed.includes("youtube.com/embed/") ? linkEmbed.split("/embed/")[1] : "";
          const inner = uploadedVideo
            ? `<video src="${escMkt(fixMediaUrl(l.videoUrl))}#t=0.5" preload="metadata" muted playsinline></video>`
            : ytId ? `<img src="https://i.ytimg.com/vi/${escMkt(ytId)}/hqdefault.jpg" alt="" />` : "";
          return `<button class="mkt-thumb mkt-thumb-video active" data-video="1" title="Demo video">${inner}<span class="mkt-thumb-play">▶</span></button>`;
        })() : ""}
        ${l.screenshots.map((s, i) => `<button class="mkt-thumb${!hasVideoSlide && i === 0 ? " active" : ""}" data-i="${i}"><img src="${escMkt(fixMediaUrl(s.url))}" alt="" /></button>`).join("")}
      </div>
    </section>` : "";

  const reviewsList = dtReviews.filter((r) => r.status !== "removed").map((r) => {
    const actions = [
      d.owned && !r.ownerResponse ? `<button class="mkt-rev-act mkt-rev-respond" type="button" data-id="${escMkt(r.id)}">Respond</button>` : "",
      `<button class="mkt-rev-act mkt-rev-report" type="button" data-id="${escMkt(r.id)}">Report</button>`,
    ].join("");
    return mktReviewRow(r, actions);
  }).join("");

  mktDetailEl.innerHTML = `
    <button class="mkt-back">‹ Back to marketplace</button>
    <nav class="mkt-crumbs">Marketplace<span class="sep">›</span><a class="mkt-crumb-cat" href="#">${escMkt(catLabel)}</a><span class="sep">›</span><span class="cur">${escMkt(l.title || d.name)}</span></nav>
    ${adminStrip}
    ${d.suspended ? `<div class="mkt-suspended-banner">This listing is suspended — hidden from browse and uninstallable.</div>` : ""}

    <header class="mkt-dt-hero">
      <div class="mkt-dt-icon">${icon}</div>
      <div class="mkt-dt-headmain">
        <h1 class="mkt-dt-name">${escMkt(l.title || d.name)}</h1>
        ${l.tagline ? `<p class="mkt-dt-tagline">${escMkt(l.tagline)}</p>` : ""}
        <div class="mkt-dt-metarow">
          ${dev ? `<span class="mkt-dt-dev">by <b>${escMkt(dev.displayName)}</b></span>` : ""}
          ${kindBadge(d)}
        </div>
        <div class="mkt-dt-statrow">
          ${l.ratingCount ? `${mktStarRow(l.ratingAvg)}<b>${l.ratingAvg.toFixed(1)}</b><span>(${l.ratingCount.toLocaleString()} review${l.ratingCount === 1 ? "" : "s"})</span>` : `<span class="mkt-rating-none">No reviews yet</span>`}
          <span class="mkt-dot">•</span><span>${priceLabel}</span>
          ${mktDiscountActive(d.pricing) ? `<span class="mkt-discount-chip">${d.pricing.discountPercent}% off${d.pricing.discountEndsAt ? ` until ${escMkt(mktDate(d.pricing.discountEndsAt))}` : ""}</span>` : ""}
        </div>
      </div>
      <div class="mkt-dt-cta">
        ${cta}
        <div class="mkt-dt-price-note">${escMkt(ctaNote)}</div>
      </div>
    </header>

    <div class="mkt-dt-body">
      <div class="mkt-dt-main">
        ${gallery}
        ${videoHtml}
        ${descHtml ? `<section class="mkt-dt-section mkt-dt-desc"><h3>About ${escMkt(l.title || d.name)}</h3><div class="mkt-md">${descHtml}</div></section>` : ""}
        ${reqConnHtml}${ingestHtml}

        <section class="mkt-dt-section">
          <h3>Pricing</h3>
          <div class="mkt-plans">${pricingHtml(d)}</div>
          <div class="mkt-plans-note">All charges are billed in Glyphh compute credits.</div>
        </section>

        <section class="mkt-dt-section">
          <h3>Reviews</h3>
          ${dtReviewsTotal ? `
          <div class="mkt-reviews-summary">
            <div class="mkt-reviews-score">
              <div class="big">${l.ratingAvg.toFixed(1)}</div>
              ${mktStarRow(l.ratingAvg)}
              <div class="cnt">${l.ratingCount.toLocaleString()} review${l.ratingCount === 1 ? "" : "s"}</div>
            </div>
            <div class="mkt-reviews-bars">${reviewBars()}</div>
          </div>` : `<p class="settings-hint">No reviews yet — be the first.</p>`}
          <div class="mkt-review-list" id="mkt-dt-review-list">${reviewsList}</div>
          ${dtReviews.length < dtReviewsTotal ? `<button id="mkt-dt-more-reviews" class="action-btn" type="button">Show more reviews</button>` : ""}
          ${mktReviewFormHtml("mkt-dt-review", installed || d.owned ? "Write a review" : "Write a review (installers only)")}
        </section>
      </div>

      <aside class="mkt-dt-side">
        ${devCard}
        <div class="mkt-side-card">
          <h4>Resources</h4>
          ${l.website ? `<div class="mkt-side-row"><span>Website</span><a class="mkt-ext" data-url="${escMkt(l.website)}" href="#">${escMkt(l.website.replace(/^https?:\/\//, ""))}</a></div>` : ""}
          ${l.supportEmail ? `<div class="mkt-side-row"><span>Support</span><a href="mailto:${escMkt(l.supportEmail)}">${escMkt(l.supportEmail)}</a></div>` : ""}
          ${l.listedAt ? `<div class="mkt-side-row"><span>Listed</span><b>${escMkt(mktDate(l.listedAt))}</b></div>` : ""}
          <div class="mkt-side-row"><span>Category</span><b>${escMkt(catLabel)}</b></div>
          <div class="mkt-side-row"><span>Version</span><b>${escMkt(d.version)}</b></div>
          <div class="mkt-side-row"><span>Installs</span><b>${d.installs.toLocaleString()}</b></div>
        </div>
        <div class="mkt-side-card">
          <h4>Something wrong?</h4>
          <p class="proxy-field-hint" style="margin:0 0 8px;">Reports of malicious apps are taken seriously — every one lands in the platform triage queue.</p>
          <button class="action-btn mkt-report-app-btn" type="button">Report this app</button>
        </div>
      </aside>
    </div>
    <div class="mkt-lightbox hidden" id="mkt-lightbox"><img alt="" /></div>`;

  wireMktDetail(d, installed);
}

function wireMktDetail(d: MktDetail, installed: boolean): void {
  mktDetailEl.querySelector(".mkt-back")?.addEventListener("click", closeMktDetail);

  // Tap-to-expand: any clamped image (description-body screenshot or the gallery's
  // main shot) opens fullscreen; tap the backdrop to close. Delegated on .mkt-dt-main
  // (rebuilt each render) so the gallery's swapped-in <img> is covered and listeners
  // never accumulate across detail opens.
  const lb = mktDetailEl.querySelector("#mkt-lightbox") as HTMLElement | null;
  const lbImg = lb?.querySelector("img") as HTMLImageElement | null;
  lb?.addEventListener("click", () => lb.classList.add("hidden"));
  mktDetailEl.querySelector(".mkt-dt-main")?.addEventListener("click", (e) => {
    const t = e.target as HTMLElement;
    if (t.tagName !== "IMG") return;
    if (t.id !== "mkt-shot-main" && !t.closest(".mkt-md")) return;   // only clamped content images
    const src = (t as HTMLImageElement).src;
    if (!lb || !lbImg || !src) return;
    lbImg.src = src;
    lb.classList.remove("hidden");
  });
  mktDetailEl.querySelector(".mkt-crumb-cat")?.addEventListener("click", (e) => {
    e.preventDefault();
    mktCategory = d.listing.category || ""; mktQuery = ""; mktPage = 1;
    if (mktSearchInput) mktSearchInput.value = "";
    closeMktDetail();
  });
  mktDetailEl.querySelectorAll<HTMLElement>(".mkt-ext").forEach((a) => {
    a.addEventListener("click", (e) => {
      e.preventDefault();
      const url = a.dataset.url;
      if (!url) return;
      if (IS_WEB) window.open(url, "_blank", "noopener");
      else void window.glyphh.execCommand(`dip ${url}`);
    });
  });

  // Gallery thumbs — the video slide and the screenshots share one strip.
  {
    const main = mktDetailEl.querySelector("#mkt-gallery-main") as HTMLElement | null;
    const cap = mktDetailEl.querySelector("#mkt-shot-caption") as HTMLElement | null;
    const videoHtmlSlide = main?.innerHTML ?? "";   // painted first when a video exists
    for (const t of Array.from(mktDetailEl.querySelectorAll<HTMLButtonElement>(".mkt-thumb"))) {
      t.addEventListener("click", () => {
        if (!main) return;
        if (t.dataset.video) {
          main.innerHTML = videoHtmlSlide;
          if (cap) cap.textContent = "";
        } else {
          const s2 = d.listing.screenshots[Number(t.dataset.i)];
          if (!s2) return;
          main.innerHTML = `<img id="mkt-shot-main" alt="" />`;
          (main.querySelector("img") as HTMLImageElement).src = fixMediaUrl(s2.url);
          if (cap) cap.textContent = s2.caption;
        }
        mktDetailEl.querySelectorAll(".mkt-thumb").forEach((x) => x.classList.toggle("active", x === t));
      });
    }
  }

  // Install — a priced app charges its first month NOW, so it always confirms.
  const installEl = mktDetailEl.querySelector(".mkt-dt-install") as HTMLButtonElement | null;
  installEl?.addEventListener("click", async () => {
    const priced = d.pricing.effectiveMonthlyCredits > 0;
    if (priced || d.kind === "workpanel") {
      const confirmed = await confirmAction({
        title: `Install ${d.listing.title || d.name}?`,
        body: [
          priced ? `Installing charges the first month — ${d.pricing.effectiveMonthlyCredits} credits — from your org's balance now, then monthly.` : "",
          d.kind === "workpanel" ? "This is a desktop work panel: it installs locally on your machine and opens beside your agent. On the web it shows as installed and finishes on your desktop." : "",
        ].filter(Boolean).join("\n\n"),
        confirmLabel: "Install",
      });
      if (!confirmed) return;
    }
    installEl.disabled = true;
    installEl.textContent = "Installing…";
    const res = await mkt.install(d.slug);
    if (res.ok) {
      installedSlugs.add(d.slug);
      void openMktDetail(d.slug);
    } else {
      installEl.disabled = false;
      installEl.textContent = "Install";
      flashMktNote(res.error || "Install failed");
    }
  });

  // Uninstall — entitlement + membership end; the modal is the app's confirm.
  // Open the installed app (his rule, 2026-08-20): workpanels open their
  // view; everything else mounts as a workbench panel by slug.
  mktDetailEl.querySelector(".mkt-dt-open")?.addEventListener("click", () => {
    if (d.kind === "workpanel") {
      (window as unknown as { __wbOpenTool?: (v: string) => void }).__wbOpenTool?.(d.slug);
      return;
    }
    // Installed = a PANEL app to this user: chromeless, no hosted URL shown.
    openAppInWorkbench({ slug: d.slug, name: d.listing.title || d.name, glyphh: d.kind === "glyphh", workbench: true });
  });
  const uninstallEl = mktDetailEl.querySelector(".mkt-dt-uninstall") as HTMLButtonElement | null;
  uninstallEl?.addEventListener("click", async () => {
    const confirmed = await confirmAction({
      title: `Uninstall ${d.listing.title || d.name}?`,
      body: "Removes it from your organization. Monthly charges stop; already-charged credits aren't refunded.",
      confirmLabel: "Uninstall",
      danger: true,
    });
    if (!confirmed) return;
    uninstallEl.disabled = true;
    uninstallEl.textContent = "Uninstalling…";
    const res = await mkt.uninstall(d.slug);
    if (res.ok) {
      installedSlugs.delete(d.slug);
      void openMktDetail(d.slug);
    } else {
      uninstallEl.disabled = false;
      uninstallEl.textContent = "Uninstall";
      flashMktNote(res.error || "Uninstall failed");
    }
  });

  // Developer card → profile page + rollup line.
  const dev = d.developer;
  if (dev) {
    mktDetailEl.querySelector(".mkt-dev-profile-btn")?.addEventListener("click", () => void openMktDeveloper(dev.handle));
    // The developer's NAME/avatar row is a link too (his rule, 2026-08-20).
    mktDetailEl.querySelector(".mkt-dev-row-link")?.addEventListener("click", () => void openMktDeveloper(dev.handle));
    void mkt.devGet(dev.handle).then((full) => {
      const rollup = mktDetailEl.querySelector("#mkt-dev-rollup");
      if (!rollup) return;
      rollup.innerHTML = full.apps.ratingCount
        ? `Across their ${full.apps.count} app${full.apps.count === 1 ? "" : "s"}: <b>${full.apps.ratingAvg.toFixed(1)}★</b> <span class="mkt-rating-count">(${full.apps.ratingCount})</span>`
        : "";
    }).catch(() => { /* the direct rating already renders */ });
  }

  // Report this app → the triage queue.
  mktDetailEl.querySelector(".mkt-report-app-btn")?.addEventListener("click", async () => {
    const reason = await promptAction("Report this app — what's wrong?", "", "It exfiltrates data / it's malicious / it impersonates…", "Report");
    if (!reason?.trim()) return;
    const res = await mkt.reportApp(d.slug, reason.trim());
    flashMktNote(res.ok ? "Reported — the platform team will triage it." : res.error);
  });

  // Admin: suspend / unsuspend.
  mktDetailEl.querySelector(".mkt-admin-suspend-btn")?.addEventListener("click", async () => {
    const suspend = !d.suspended;
    const confirmed = await confirmAction({
      title: suspend ? `Suspend ${d.listing.title || d.name}?` : `Lift the suspension on ${d.listing.title || d.name}?`,
      body: suspend
        ? "Hidden from browse and uninstallable immediately. Existing installs keep running."
        : "The listing returns to browse and becomes installable again.",
      confirmLabel: suspend ? "Suspend" : "Unsuspend",
      danger: suspend,
    });
    if (!confirmed) return;
    const res = await mkt.adminSuspend(d.slug, suspend);
    if (!res.ok) { flashMktNote(res.error); return; }
    detailCache.delete(d.slug);
    void openMktDetail(d.slug);
  });

  // Reviews: report / respond on each row.
  mktDetailEl.querySelectorAll<HTMLButtonElement>(".mkt-rev-report").forEach((b) => {
    b.addEventListener("click", async () => {
      const reason = await promptAction("Report this review — why should a moderator look at it?", "", "Spam / abuse / off-topic…", "Report");
      if (!reason?.trim()) return;
      const res = await mkt.reportReview(d.slug, b.dataset.id!, reason.trim());
      flashMktNote(res.ok ? "Review reported for moderation." : res.error);
    });
  });
  mktDetailEl.querySelectorAll<HTMLButtonElement>(".mkt-rev-respond").forEach((b) => {
    b.addEventListener("click", async () => {
      const response = await promptAction("Respond publicly to this review", "", "Thanks for the report — fixed in 1.2.1…", "Post response");
      if (!response?.trim()) return;
      const res = await mkt.respondToReview(d.slug, b.dataset.id!, response.trim());
      if (res.ok) void openMktDetail(d.slug);
      else flashMktNote(res.error);
    });
  });

  // Show more reviews.
  mktDetailEl.querySelector("#mkt-dt-more-reviews")?.addEventListener("click", async (e) => {
    const btn = e.currentTarget as HTMLButtonElement;
    btn.disabled = true;
    try {
      const r = await mkt.reviews(d.slug, { limit: 20, offset: dtReviews.length });
      dtReviews = [...dtReviews, ...r.reviews];
      dtReviewsTotal = r.total;
      void mktIsPlatformAdmin().then((admin) => renderMktDetail(d, installed, admin === true));
    } catch { btn.disabled = false; }
  });

  // Write / edit / remove your review.
  const starsWrap = mktDetailEl.querySelector<HTMLElement>("#mkt-dt-review-stars");
  const submitBtn = mktDetailEl.querySelector<HTMLButtonElement>("#mkt-dt-review-submit");
  const statusEl = mktDetailEl.querySelector<HTMLElement>("#mkt-dt-review-status");
  if (starsWrap && submitBtn) {
    const stars = wireStarInput(starsWrap, (n) => { dtMyStars = n; submitBtn.disabled = n < 1; });
    submitBtn.disabled = dtMyStars < 1;
    submitBtn.addEventListener("click", async () => {
      const body = (mktDetailEl.querySelector("#mkt-dt-review-body") as HTMLTextAreaElement | null)?.value.trim();
      submitBtn.disabled = true;
      if (statusEl) statusEl.textContent = "Posting…";
      const res = await mkt.putReview(d.slug, { stars: stars(), ...(body ? { body } : {}) });
      if (res.ok) void openMktDetail(d.slug);
      else {
        submitBtn.disabled = false;
        if (statusEl) statusEl.textContent = "";
        flashMktNote(res.error);
      }
    });
    mktDetailEl.querySelector("#mkt-dt-review-delete")?.addEventListener("click", async () => {
      const confirmed = await confirmAction({
        title: "Remove your review?",
        body: "Your stars and text are deleted; the listing's rating recomputes.",
        confirmLabel: "Remove",
        danger: true,
      });
      if (!confirmed) return;
      const res = await mkt.deleteReview(d.slug);
      if (res.ok) void openMktDetail(d.slug);
      else flashMktNote(res.error);
    });
  }

  // Real connection icons for the Requires rows, then re-render (only if this
  // detail is still on screen). primeConnectedIcons only re-fires for uncached
  // slugs, so this can't loop.
  if (d.requiredConnections.length) {
    void primeConnectedIcons(mktConnIconApps(d.requiredConnections), () => {
      if (!mktDetailEl.classList.contains("hidden")) {
        void mktIsPlatformAdmin().then((admin) => renderMktDetail(d, installed, admin === true));
      }
    });
  }
}

// ── Section load + init ───────────────────────────────────────────────────

/** Load the Marketplace SECTION — its own left-rail page. Called by
 *  navigation.ts whenever the section shows. */
export function loadMarketplaceSection(): void {
  showMktView("store");
  void loadMarketplace();
  // The Review desk is super-admin only — the server enforces it regardless;
  // this only unhides the door.
  void mktIsPlatformAdmin().then((admin) => {
    document.getElementById("mkt-admin-btn")?.classList.toggle("hidden", admin !== true);
  });
}

export function initMarketplace(): void {
  // Scope (Public / Your organization).
  for (const t of Array.from(document.querySelectorAll<HTMLButtonElement>(".mkt-scope"))) {
    t.addEventListener("click", () => {
      const scope = t.dataset.scope === "private" ? "private" : "public";
      if (scope === mktScope) return;
      mktScope = scope; mktCategory = ""; mktPage = 1;
      document.querySelectorAll<HTMLButtonElement>(".mkt-scope").forEach((x) => x.classList.toggle("active", x === t));
      renderMktStorefront();
    });
  }
  // Search (debounced) + sort — all client-side over the hydrated rows.
  mktSearchInput?.addEventListener("input", () => {
    if (mktSearchTimer) clearTimeout(mktSearchTimer);
    mktSearchTimer = setTimeout(() => { mktQuery = mktSearchInput.value.trim(); mktPage = 1; renderMktStorefront(); }, 200);
  });
  mktSortSelect?.addEventListener("change", () => {
    mktSort = (mktSortSelect.value as "popular" | "rating" | "newest") || "popular";
    mktPage = 1;
    renderMktStorefront();
  });
  // Refresh — drop the caches and reload the whole storefront.
  const mktRefreshBtn = document.getElementById("mkt-refresh");
  mktRefreshBtn?.addEventListener("click", async () => {
    mktRefreshBtn.classList.add("spinning");
    detailCache.clear();
    showMktView("store");
    await loadMarketplace();
    mktRefreshBtn.classList.remove("spinning");
  });
  // The publish + moderation doors.
  document.getElementById("mkt-console-btn")?.addEventListener("click", () => { void loadMktConsole(); });
  document.getElementById("mkt-admin-btn")?.addEventListener("click", () => { void loadMktAdmin(); });
  // Re-page when the panel width changes breakpoints (the column count, and so
  // the page size, is resolution-derived). Debounced; only while the store shows.
  let mktResizeTimer: ReturnType<typeof setTimeout> | null = null;
  let mktLastCols = mktColumns();
  window.addEventListener("resize", () => {
    if (mktResizeTimer) clearTimeout(mktResizeTimer);
    mktResizeTimer = setTimeout(() => {
      const cols = mktColumns();
      if (cols === mktLastCols) return;
      mktLastCols = cols;
      if (!mktStoreEl.classList.contains("hidden")) renderMktStorefront();
    }, 150);
  });
}

/** The store's hydrated detail for a slug, when it already landed — the
 *  developer pages reuse it to list "their apps" without refetching. */
export function mktCachedDetails(): MktDetail[] {
  return [...detailCache.values()];
}

/** Browse rows the storefront currently holds (suspended already filtered). */
export function mktBrowseRows(): MktListing[] {
  return mktRows;
}
