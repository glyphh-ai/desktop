/**
 * marketplace-dev.ts — the marketplace's DEVELOPER pages:
 *
 *   • The public developer PROFILE (#mkt-dev) — avatar, bio, links, direct
 *     stars beside the across-their-apps rollup, their apps, their reviews,
 *     and the write-a-developer-review form (install-gated server-side).
 *   • The developer CONSOLE (#mkt-console) — the org/personal profile as
 *     TABS over one autosaving pane (avatar upload, implicit creation), the
 *     org's own listings with the credits pricing editor (monthly price +
 *     discount window), and each app's releases with submit-for-review +
 *     review-status chips.
 *
 * The PROFILE section (cards + create form + wiring) is exported as
 * renderDeveloperProfiles — Settings → Developer (the M7 program signup area)
 * renders the same machinery instead of duplicating it.
 */

import { confirmAction, promptAction, downscaleImage, paginate, renderPaginationBar } from "./shared.js";
import {
  mkt, escMkt, mktStarRow, mktDate, mktDiscountActive, mktErrorText, mktNoticeHtml,
  type MktDetail, type MktDeveloper, type MktDeveloperPatch, type MktRelease,
  type MktReview, type MktOrgApp, type MktReleaseReviewStatus,
} from "./marketplace-data.js";
import {
  showMktView, openMktDetail, mktCachedDetails, mktBrowseRows,
  mktReviewRow, mktReviewFormHtml, wireStarInput,
} from "./marketplace.js";
import { programPanesHtml, initProgramPanes, loadProgramPanes } from "./marketplace-program.js";
import { MKT_CATEGORY_LABELS } from "./marketplace-data.js";
import { mktProgram, mktCreditsFromMicro, type MktEarningRow } from "./marketplace-data.js";

const devEl = (): HTMLElement => document.getElementById("mkt-dev")!;
const consoleEl = (): HTMLElement => document.getElementById("mkt-console")!;

function note(el: HTMLElement, msg: string): void {
  let n = el.querySelector<HTMLElement>(".mkt-note");
  if (!n) {
    n = document.createElement("div");
    n.className = "mkt-note";
    el.prepend(n);
  }
  n.textContent = msg;
  n.classList.remove("hidden");
  setTimeout(() => n?.classList.add("hidden"), 4000);
}

// ── Public developer profile ──────────────────────────────────────────────

let devReviews: MktReview[] = [];
let devReviewsTotal = 0;

export async function openMktDeveloper(handle: string): Promise<void> {
  showMktView("dev");
  const el = devEl();
  el.innerHTML = `<button class="mkt-back">‹ Back to marketplace</button><div class="crud-empty">Loading…</div>`;
  el.querySelector(".mkt-back")?.addEventListener("click", () => showMktView("store"));

  let dev: MktDeveloper | null = null;
  try { dev = await mkt.devGet(handle); } catch { dev = null; }
  if (!dev) {
    el.innerHTML = `<button class="mkt-back">‹ Back to marketplace</button><div class="crud-empty">Couldn't load this developer.</div>`;
    el.querySelector(".mkt-back")?.addEventListener("click", () => showMktView("store"));
    return;
  }
  devReviews = [];
  devReviewsTotal = 0;
  try {
    const r = await mkt.devReviews(handle, { limit: 20 });
    devReviews = r.reviews;
    devReviewsTotal = r.total;
  } catch { /* the reviews section renders empty */ }
  // "Their profile?" decides whether Respond/Report show on each review.
  let mine = false;
  try {
    const me = await mkt.devMe();
    mine = me.personal?.handle === handle || me.org?.handle === handle;
  } catch { /* signed out — reader view */ }
  renderDeveloperProfile(dev, mine);
}

/** The developer's apps, from the storefront's hydrated details (the browse
 *  rows carry no publisher handle — the detail record does). */
function developerApps(handle: string): MktDetail[] {
  const bySlug = new Map(mktCachedDetails().map((d) => [d.slug, d]));
  return mktBrowseRows()
    .map((l) => bySlug.get(l.slug))
    .filter((d): d is MktDetail => !!d && d.developer?.handle === handle && !d.suspended);
}

function renderDeveloperProfile(dev: MktDeveloper, mine: boolean): void {
  const el = devEl();
  const apps = developerApps(dev.handle);
  const links = Object.entries(dev.links || {});

  const appCards = apps.map((d) => `
    <button class="mkt-dev-app" type="button" data-slug="${escMkt(d.slug)}">
      <span class="mkt-card-icon">${d.listing.iconUrl ? `<img src="${escMkt(d.listing.iconUrl)}" alt="" />` : `<span class="mkt-card-initial">${escMkt((d.listing.title || d.name).charAt(0).toUpperCase())}</span>`}</span>
      <span class="mkt-dev-app-name">${escMkt(d.listing.title || d.name)}</span>
      ${d.listing.ratingCount ? `<span class="mkt-rating"><b>${d.listing.ratingAvg.toFixed(1)}</b> <span class="mkt-stars">★</span></span>` : `<span class="mkt-rating-none">New</span>`}
    </button>`).join("");

  const reviewsList = devReviews.filter((r) => r.status !== "removed").map((r) => {
    const actions = mine ? [
      !r.ownerResponse ? `<button class="mkt-rev-act mkt-devrev-respond" type="button" data-id="${escMkt(r.id)}">Respond</button>` : "",
      `<button class="mkt-rev-act mkt-devrev-report" type="button" data-id="${escMkt(r.id)}">Report</button>`,
    ].join("") : "";
    return mktReviewRow(r, actions);
  }).join("");

  el.innerHTML = `
    <button class="mkt-back">‹ Back to marketplace</button>
    <nav class="mkt-crumbs">Marketplace<span class="sep">›</span>Developers<span class="sep">›</span><span class="cur">@${escMkt(dev.handle)}</span></nav>

    <header class="mkt-dt-hero mkt-devp-hero">
      <div class="mkt-dt-icon mkt-devp-avatar">${dev.avatarUrl ? `<img src="${escMkt(dev.avatarUrl)}" alt="" />` : `<span class="mkt-card-initial">${escMkt(dev.displayName.charAt(0).toUpperCase())}</span>`}</div>
      <div class="mkt-dt-headmain">
        <h1 class="mkt-dt-name">${escMkt(dev.displayName)}</h1>
        <p class="mkt-dt-tagline">@${escMkt(dev.handle)} · ${dev.scope === "org" ? "Organization" : "Independent developer"}</p>
        <div class="mkt-dt-statrow">
          ${dev.ratingCount
            ? `${mktStarRow(dev.ratingAvg)}<b>${dev.ratingAvg.toFixed(1)}</b><span>(${dev.ratingCount} developer review${dev.ratingCount === 1 ? "" : "s"})</span>`
            : `<span class="mkt-rating-none">Not rated yet</span>`}
          ${dev.apps.ratingCount ? `<span class="mkt-dot">•</span><span>Across ${dev.apps.count} app${dev.apps.count === 1 ? "" : "s"}: <b>${dev.apps.ratingAvg.toFixed(1)}★</b> (${dev.apps.ratingCount})</span>` : ""}
        </div>
      </div>
    </header>

    <div class="mkt-dt-body">
      <div class="mkt-dt-main">
        ${dev.bio ? `<section class="mkt-dt-section"><h3>About</h3><p class="mkt-devp-bio">${escMkt(dev.bio)}</p></section>` : ""}

        <section class="mkt-dt-section">
          <h3>Apps by ${escMkt(dev.displayName)}</h3>
          ${apps.length ? `<div class="mkt-dev-apps">${appCards}</div>` : `<p class="settings-hint">No public listings yet${mktBrowseRows().length && mktCachedDetails().length < mktBrowseRows().length ? " (still loading the storefront)" : ""}.</p>`}
        </section>

        <section class="mkt-dt-section">
          <h3>Developer reviews</h3>
          <p class="settings-hint" style="margin:0 0 10px;">Developers get stars too — reviewing one requires your organization to run at least one of their apps.</p>
          <div class="mkt-review-list" id="mkt-devp-review-list">${reviewsList || `<p class="settings-hint">No reviews yet.</p>`}</div>
          ${devReviews.length < devReviewsTotal ? `<button id="mkt-devp-more" class="action-btn" type="button">Show more reviews</button>` : ""}
          ${mktReviewFormHtml("mkt-devp-review", `Review ${dev.displayName}`)}
        </section>
      </div>

      <aside class="mkt-dt-side">
        <div class="mkt-side-card">
          <h4>Links</h4>
          ${dev.website ? `<div class="mkt-side-row"><span>Website</span><a href="${escMkt(dev.website)}" target="_blank" rel="noreferrer noopener">${escMkt(dev.website.replace(/^https?:\/\//, ""))}</a></div>` : ""}
          ${links.map(([label, url]) => `<div class="mkt-side-row"><span>${escMkt(label)}</span><a href="${escMkt(url)}" target="_blank" rel="noreferrer noopener">${escMkt(url.replace(/^https?:\/\//, ""))}</a></div>`).join("")}
          ${dev.supportEmail ? `<div class="mkt-side-row"><span>Support</span><a href="mailto:${escMkt(dev.supportEmail)}">${escMkt(dev.supportEmail)}</a></div>` : ""}
          ${!dev.website && !links.length && !dev.supportEmail ? `<p class="proxy-field-hint" style="margin:0;">None published.</p>` : ""}
        </div>
        <div class="mkt-side-card">
          <h4>Developer since</h4>
          <div class="mkt-side-row"><span>Joined</span><b>${escMkt(mktDate(dev.createdAt))}</b></div>
        </div>
      </aside>
    </div>`;

  // Wiring.
  el.querySelector(".mkt-back")?.addEventListener("click", () => showMktView("store"));
  el.querySelectorAll<HTMLButtonElement>(".mkt-dev-app").forEach((b) => {
    b.addEventListener("click", () => void openMktDetail(b.dataset.slug!));
  });
  el.querySelector("#mkt-devp-more")?.addEventListener("click", async (e) => {
    const btn = e.currentTarget as HTMLButtonElement;
    btn.disabled = true;
    try {
      const r = await mkt.devReviews(dev.handle, { limit: 20, offset: devReviews.length });
      devReviews = [...devReviews, ...r.reviews];
      devReviewsTotal = r.total;
      renderDeveloperProfile(dev, mine);
    } catch { btn.disabled = false; }
  });
  el.querySelectorAll<HTMLButtonElement>(".mkt-devrev-respond").forEach((b) => {
    b.addEventListener("click", async () => {
      const response = await promptAction("Respond publicly to this review", "", "Thanks — here's what changed…", "Post response");
      if (!response?.trim()) return;
      const res = await mkt.respondToDevReview(dev.handle, b.dataset.id!, response.trim());
      if (res.ok) void openMktDeveloper(dev.handle);
      else note(el, res.error);
    });
  });
  el.querySelectorAll<HTMLButtonElement>(".mkt-devrev-report").forEach((b) => {
    b.addEventListener("click", async () => {
      const reason = await promptAction("Flag this review for platform moderation — why?", "", "Spam / abuse / off-topic…", "Report");
      if (!reason?.trim()) return;
      const res = await mkt.reportDevReview(dev.handle, b.dataset.id!, reason.trim());
      note(el, res.ok ? "Review flagged for moderation." : res.error);
    });
  });

  // Write / edit / remove your developer review (server gates on running one
  // of their apps — a refusal surfaces as the honest error).
  const starsWrap = el.querySelector<HTMLElement>("#mkt-devp-review-stars");
  const submitBtn = el.querySelector<HTMLButtonElement>("#mkt-devp-review-submit");
  const statusEl = el.querySelector<HTMLElement>("#mkt-devp-review-status");
  if (starsWrap && submitBtn) {
    const stars = wireStarInput(starsWrap, (n) => { submitBtn.disabled = n < 1; });
    submitBtn.addEventListener("click", async () => {
      const body = (el.querySelector("#mkt-devp-review-body") as HTMLTextAreaElement | null)?.value.trim();
      submitBtn.disabled = true;
      if (statusEl) statusEl.textContent = "Posting…";
      const res = await mkt.putDevReview(dev.handle, { stars: stars(), ...(body ? { body } : {}) });
      if (res.ok) void openMktDeveloper(dev.handle);
      else {
        submitBtn.disabled = false;
        if (statusEl) statusEl.textContent = "";
        note(el, res.error);
      }
    });
    el.querySelector("#mkt-devp-review-delete")?.addEventListener("click", async () => {
      const confirmed = await confirmAction({
        title: "Remove your review of this developer?",
        body: "Your stars and text are deleted; the developer's rating recomputes.",
        confirmLabel: "Remove",
        danger: true,
      });
      if (!confirmed) return;
      const res = await mkt.deleteDevReview(dev.handle);
      if (res.ok) void openMktDeveloper(dev.handle);
      else note(el, res.error);
    });
  }
}

// ── Developer console ─────────────────────────────────────────────────────

const RELEASE_CHIP: Record<MktReleaseReviewStatus, string> = {
  draft: "Draft",
  submitted: "Submitted",
  in_review: "In review",
  approved: "Approved",
  rejected: "Rejected",
};

/** The LISTING's pipeline state, derived from its releases: anything
 *  submitted/in_review wins ("In review"), else a standing rejection shows
 *  until a newer build is approved or resubmitted. Null = nothing to say. */
export function listingReviewState(releases: MktRelease[]): { label: string; cls: string } | null {
  if (releases.some((r) => r.reviewStatus === "submitted" || r.reviewStatus === "in_review")) {
    return { label: "In review", cls: "in_review" };
  }
  const newest = releases[0];
  if (newest && newest.reviewStatus === "rejected") return { label: "Changes requested", cls: "rejected" };
  return null;
}

function releaseChip(r: MktRelease): string {
  return `<span class="mkt-review-chip ${r.reviewStatus}">${RELEASE_CHIP[r.reviewStatus] || r.reviewStatus}</span>`;
}

// ── Developer profile section (shared: console + Settings → Developer) ────
//
// Organization / Personal are TABS over one pane — the active tab IS the
// scope (no scope dropdown anywhere). No Save/Create buttons either: an
// existing profile autosaves debounced like the Settings panels (the
// .set-save-state chip beside the tabs reports it), and a missing profile
// creates itself once its handle + display name are set — committed on blur,
// never mid-keystroke, because the handle is permanent.

type MktScope = "org" | "personal";

/** The active tab survives re-renders (autosave → onChange → repaint). */
let mcScope: MktScope = "org";
let mcScopePinned = false;

const HANDLE_RE = /^[a-z0-9][a-z0-9-]*$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// ── Field validation (Apps → New grammar: `.invalid` + an inline
//    settings-error line under the field; NEVER a banner, NEVER a request) ──
//
// The server's zod schemas hard-require website `.url()` and supportEmail
// `.email()` — an unvalidated autosave PATCHing a half-typed value used to
// bounce off them as a 400 "invalid request body" banner. Invalid values now
// report inline and never cross the wire.

const HANDLE_MSG = "Lowercase letters, numbers, dashes.";
const WEBSITE_MSG = "Enter a full URL, like https://acme.com.";
const EMAIL_MSG = "Enter an email address, like help@acme.com.";

/** "" stays "" (blank hides it); a bare domain gains https://; anything that
 *  still isn't an http(s) URL with a real hostname returns null (invalid). */
function normalizeWebsite(v: string): string | null {
  if (!v) return "";
  const withScheme = /^https?:\/\//i.test(v) ? v : `https://${v}`;
  try {
    const u = new URL(withScheme);
    if (!/^https?:$/.test(u.protocol) || !u.hostname.includes(".")) return null;
    return withScheme;
  } catch { return null; }
}

function handleError(v: string): string | null {
  if (!v) return null; // required-ness reports on commit, not per keystroke
  return HANDLE_RE.test(v) && v.length >= 2 && v.length <= 40 ? null : HANDLE_MSG;
}

/** One field in the settings form grammar (the Account panel's rows, in the
 *  Apps → New form idiom): acct-field wrapper, short settings-label, guidance
 *  in the placeholder, an inline settings-error line for validation — the
 *  rare always-visible hint is a settings-hint line. */
function mcFieldHtml(f: string, label: string, value: string, placeholder: string, opts: { hint?: string; wide?: boolean; textarea?: boolean } = {}): string {
  const control = opts.textarea
    ? `<textarea id="mc-${f}" class="settings-input mc-field" data-f="${f}" rows="3" placeholder="${escMkt(placeholder)}" spellcheck="true">${escMkt(value)}</textarea>`
    : `<input id="mc-${f}" type="text" class="settings-input mc-field" data-f="${f}" value="${escMkt(value)}" placeholder="${escMkt(placeholder)}" spellcheck="false" autocomplete="off" />`;
  return `
    <div class="acct-field${opts.wide ? " acct-field-wide" : ""}">
      <label class="settings-label" for="mc-${f}">${label}</label>
      ${control}
      <span class="settings-error hidden" data-err="${f}"></span>
      ${opts.hint ? `<span class="settings-hint" style="margin:0;">${opts.hint}</span>` : ""}
    </div>`;
}

/** The active tab's pane when its profile EXISTS — the Account panel's
 *  identity card (avatar + name/@handle left, ONE action right) over
 *  autosaving rows. "View public page" is navigation, so it's a link in the
 *  identity text, never a button floating beside the fields. */
function profileEditorHtml(dev: MktDeveloper): string {
  return `
    <div class="acct-identity">
      <div class="acct-id-face">
        <div class="acct-avatar-slot">
          <span class="acct-initials${dev.avatarUrl ? " hidden" : ""}">${escMkt(dev.displayName.charAt(0).toUpperCase())}</span>
          <img class="acct-avatar${dev.avatarUrl ? "" : " hidden"}"${dev.avatarUrl ? ` src="${escMkt(dev.avatarUrl)}"` : ""} alt="" />
        </div>
        <div class="acct-id-text">
          <div class="acct-name mc-id-name">${escMkt(dev.displayName)}</div>
          <div class="acct-email">@${escMkt(dev.handle)}${dev.ratingCount ? ` · ${dev.ratingAvg.toFixed(1)}★ (${dev.ratingCount})` : ""}</div>
          <a class="mc-view-link" href="#">View public page ↗</a>
        </div>
      </div>
      <div class="acct-id-actions">
        <button class="action-btn mc-avatar-pick" type="button" title="PNG/JPEG/GIF/WebP, up to 512 KB">Change avatar…</button>
        <input type="file" class="mc-avatar-file hidden" accept="image/png,image/jpeg,image/gif,image/webp" />
      </div>
    </div>
    <div class="acct-row">
      ${mcFieldHtml("displayName", "Display name", dev.displayName, "Acme Tools")}
      ${mcFieldHtml("website", "Website", dev.website || "", "https://… — blank hides it")}
    </div>
    <div class="acct-row">
      ${mcFieldHtml("bio", "Bio", dev.bio || "", "What you build — blank hides it", { wide: true, textarea: true })}
    </div>
    <div class="acct-row">
      ${mcFieldHtml("supportEmail", "Support email", dev.supportEmail || "", "help@… — shown as “Support by you” on every listing")}
    </div>`;
}

/** The active tab's pane when its profile DOESN'T exist yet — the same rows,
 *  plus the permanent handle; it creates itself once handle + name are set. */
function profileCreateHtml(scope: MktScope): string {
  return `
    <p class="settings-hint" style="margin:0;">${scope === "org"
      ? "No organization profile yet — the whole org publishes under it."
      : "No personal profile yet — publish under your own name."} Fill in a handle and display name and the profile creates itself.</p>
    <div class="acct-row">
      ${mcFieldHtml("handle", "Handle", "", "acme-tools", { hint: "Kebab-case, globally unique — this becomes your @handle and is permanent." })}
      ${mcFieldHtml("displayName", "Display name", "", "Acme Tools")}
    </div>
    <div class="acct-row">
      ${mcFieldHtml("bio", "Bio", "", "What you build (optional)", { wide: true, textarea: true })}
    </div>
    <div class="acct-row">
      ${mcFieldHtml("website", "Website", "", "https://… (optional)")}
      ${mcFieldHtml("supportEmail", "Support email", "", "help@… — shown as “Support by you” on every listing")}
    </div>`;
}

/** One owned listing — a compact ROW that opens the LISTING BUILDER page
 *  (his rule, 2026-08-20: a full builder, not an expandable fold). */
function consoleAppHtml(app: MktOrgApp, detail: MktDetail | null): string {
  void detail;
  const l = app.listing;
  const listed = !!l?.listedAt;
  return `
    <button class="mkt-console-app mkt-console-approw" data-slug="${escMkt(app.slug)}" type="button">
      <span class="mkt-card-icon">${l?.iconUrl ? `<img src="${escMkt(fixMediaUrl(l.iconUrl))}" alt="" />` : `<span class="mkt-card-initial">${escMkt((l?.title || app.name).charAt(0).toUpperCase())}</span>`}</span>
      <span class="mkt-console-app-name">${escMkt(l?.title || app.name)}</span>
      <span class="mkt-console-app-sub">${escMkt(app.slug)} · v${escMkt(app.version)}</span>
      <span style="flex:1;"></span>
      ${l?.ratingCount ? `<span class="mkt-rating"><b>${l.ratingAvg.toFixed(1)}</b> <span class="mkt-stars">★</span> <span class="mkt-rating-count">(${l.ratingCount})</span></span>` : ""}
      <span class="mkt-review-slot" data-slug="${escMkt(app.slug)}"></span>
      <span class="mkt-listed-chip ${listed ? "on" : ""}">${listed ? "Listed" : "Not listed"}</span>
      <span class="mkt-console-chev">›</span>
    </button>`;
}

/** The client's API origin — media URLs are PINNED to it (a server-config
 *  publicUrl may be a tunnel; the origin the client already talks to is the
 *  one it can load from). */
function apiBase(): string {
  const w = window as unknown as { __GLYPHH_API_URL__?: string; glyphh?: { apiUrl?: string } };
  return (w.__GLYPHH_API_URL__ || w.glyphh?.apiUrl || "").replace(/\/$/, "");
}
/** Re-origin any listing media URL onto the client's API base; relative
 *  paths (uploaded demo videos) resolve against it too. */
export function fixMediaUrl(u: string | null | undefined): string {
  if (!u) return "";
  if (u.startsWith("/")) return `${apiBase()}${u}`;
  const i = u.indexOf("/api/apps/");
  const j = i === -1 ? u.indexOf("/api/marketplace/") : i;
  return j > 0 ? `${apiBase()}${u.slice(j)}` : u;
}

/** One transport for the builder — web rides the SDK handle, desktop the IPC. */
type ListingSdk = {
  apps?: {
    updateListing?: (slug: string, patch: Record<string, unknown>) => Promise<unknown>;
    uploadMedia?: (slug: string, kind: "icon" | "screenshot" | "video", bytes: Uint8Array, caption?: string) => Promise<{ key: string }>;
    removeMedia?: (slug: string, key: string) => Promise<void>;
    list?: (slug: string) => Promise<unknown>;
    unlist?: (slug: string) => Promise<unknown>;
  };
};
type ListingIpc = {
  appListingSet?: (slug: string, patch: Record<string, unknown>) => Promise<{ ok: boolean; error?: string }>;
  appListingImageAdd?: (slug: string, kind: "icon" | "screenshot" | "video") => Promise<{ ok: boolean; key?: string; error?: string }>;
  appListingImageRemove?: (slug: string, key: string) => Promise<{ ok: boolean; error?: string }>;
  appListingList?: (slug: string, listed: boolean) => Promise<{ ok: boolean; listed?: boolean; error?: string }>;
};
const listingSdk = (): ListingSdk["apps"] | undefined => (window as unknown as { glyphhSdk?: ListingSdk }).glyphhSdk?.apps;
const listingIpc = (): ListingIpc => (window as unknown as { glyphh: ListingIpc }).glyphh;
const onWeb = (): boolean => !!(window as unknown as { __GLYPHH_WEB__?: boolean }).__GLYPHH_WEB__;

async function lbSetListing(slug: string, patch: Record<string, unknown>): Promise<{ ok: boolean; error?: string }> {
  try {
    const sdk = listingSdk();
    if (onWeb() && sdk?.updateListing) { await sdk.updateListing(slug, patch); return { ok: true }; }
    return (await listingIpc().appListingSet?.(slug, patch)) ?? { ok: false, error: "unsupported build" };
  } catch (e) { return { ok: false, error: (e as Error).message }; }
}
/** Web: an in-page file input (bytes via SDK). Desktop: the native picker IPC. */
async function lbAddMedia(slug: string, kind: "icon" | "screenshot" | "video"): Promise<{ ok: boolean; error?: string }> {
  try {
    const sdk = listingSdk();
    if (onWeb() && sdk?.uploadMedia) {
      // Screenshots multi-select (his rule, 2026-08-20); icon/video stay single.
      const picked = await new Promise<File[]>((res) => {
        const input = document.createElement("input");
        input.type = "file";
        input.accept = kind === "video" ? "video/mp4,video/webm" : "image/png,image/jpeg,image/webp,image/gif";
        input.multiple = kind === "screenshot";
        input.addEventListener("change", () => res(Array.from(input.files ?? [])));
        input.click();
      });
      if (!picked.length) return { ok: false, error: "" };   // canceled — silent
      const limit = kind === "video" ? 50 * 1024 * 1024 : kind === "icon" ? 512 * 1024 : 4 * 1024 * 1024;
      for (const f of picked) {
        const bytes = kind === "video"
          ? new Uint8Array(await f.arrayBuffer())
          : await downscaleImage(f, kind === "icon" ? 512 : 1600, kind === "icon" ? 480 * 1024 : 3_800_000);
        if (bytes.byteLength > limit) return { ok: false, error: `"${f.name}" is over ${Math.round(limit / 1024 / 1024)}MB.` };
        await sdk.uploadMedia(slug, kind, bytes);
      }
      return { ok: true };
    }
    return (await listingIpc().appListingImageAdd?.(slug, kind)) ?? { ok: false, error: "unsupported build" };
  } catch (e) { return { ok: false, error: (e as Error).message }; }
}
async function lbRemoveMedia(slug: string, key: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const sdk = listingSdk();
    if (onWeb() && sdk?.removeMedia) { await sdk.removeMedia(slug, key); return { ok: true }; }
    return (await listingIpc().appListingImageRemove?.(slug, key)) ?? { ok: false, error: "unsupported build" };
  } catch (e) { return { ok: false, error: (e as Error).message }; }
}
async function lbSetListed(slug: string, listed: boolean): Promise<{ ok: boolean; error?: string }> {
  try {
    const sdk = listingSdk();
    if (onWeb() && sdk?.list && sdk?.unlist) { await (listed ? sdk.list(slug) : sdk.unlist(slug)); return { ok: true }; }
    return (await listingIpc().appListingList?.(slug, listed)) ?? { ok: false, error: "unsupported build" };
  } catch (e) { return { ok: false, error: (e as Error).message }; }
}

/** The console's Home charts — destroyed before every repaint (Chart.js
 *  instances leak canvases otherwise). */
let mccCharts: Array<{ destroy(): void }> = [];
const cssVar = (n: string): string => getComputedStyle(document.documentElement).getPropertyValue(n).trim();

/** Net-credits-by-day (last 30) + share-by-app, from the earnings ledger. */
function paintHomeCharts(host: HTMLElement, rows: MktEarningRow[]): void {
  for (const c of mccCharts) { try { c.destroy(); } catch { /* gone */ } }
  mccCharts = [];
  const ChartCtor = (window as unknown as { Chart?: new (ctx: CanvasRenderingContext2D, cfg: unknown) => { destroy(): void } }).Chart;
  if (!ChartCtor) return;
  const DAYS = 30;
  const dayKeys: string[] = [];
  const now = new Date();
  for (let i = DAYS - 1; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i);
    dayKeys.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`);
  }
  const perDay = new Map(dayKeys.map((k) => [k, 0]));
  const perApp = new Map<string, number>();
  for (const r of rows) {
    const k = String(r.createdAt).slice(0, 10);
    if (perDay.has(k)) perDay.set(k, perDay.get(k)! + r.netCreditsMicro);
    perApp.set(r.appSlug, (perApp.get(r.appSlug) ?? 0) + r.netCreditsMicro);
  }
  const toCr = (micro: number): number => micro / 1_000_000;
  const ink = cssVar("--text-3") || "#868686";
  const grid = cssVar("--border") || "rgba(128,128,128,0.2)";
  const accent = cssVar("--accent") || "#8c3bf2";

  const barCtx = host.querySelector<HTMLCanvasElement>("#mcc-chart-days")?.getContext("2d");
  if (barCtx) {
    mccCharts.push(new ChartCtor(barCtx, {
      type: "bar",
      data: {
        labels: dayKeys.map((k) => k.slice(5)),
        datasets: [{ label: "Net credits", data: dayKeys.map((k) => toCr(perDay.get(k)!)), backgroundColor: accent, borderRadius: 3 }],
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        scales: {
          x: { grid: { display: false }, ticks: { color: ink, maxRotation: 0, autoSkip: true } },
          y: { beginAtZero: true, grid: { color: grid }, ticks: { color: ink } },
        },
      },
    }));
  }
  const byApp = [...perApp.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);
  const pieCtx = host.querySelector<HTMLCanvasElement>("#mcc-chart-apps")?.getContext("2d");
  if (pieCtx && byApp.length) {
    const palette = [accent, "#4285f4", "#2bbf8f", "#f2a83c", "#ec4899", "#38bdf8", "#a3e635", "#ef4444"];
    mccCharts.push(new ChartCtor(pieCtx, {
      type: "doughnut",
      data: {
        labels: byApp.map(([slug]) => slug),
        datasets: [{ data: byApp.map(([, v]) => toCr(v)), backgroundColor: palette.slice(0, byApp.length), borderWidth: 0 }],
      },
      options: {
        responsive: true, maintainAspectRatio: false, cutout: "62%",
        plugins: { legend: { position: "bottom", labels: { color: ink, boxWidth: 10, boxHeight: 10, usePointStyle: true, pointStyle: "circle" } } },
      },
    }));
  }
}

/** The HOME tab — usage-style stat cards, the two charts, then Your listings
 *  under a search bar. */
async function loadConsoleHome(el: HTMLElement, apps: MktOrgApp[], details: Map<string, MktDetail>): Promise<void> {
  const host = el.querySelector<HTMLElement>("#mcc-home");
  if (!host) return;
  host.innerHTML = `
    <div class="dash-grid" id="mcc-stats">
      <div class="dash-card"><div class="dash-card-label">Gross</div><div class="dash-card-value">—</div><div class="dash-card-sub">earned credits</div></div>
      <div class="dash-card"><div class="dash-card-label">Net</div><div class="dash-card-value">—</div><div class="dash-card-sub">after the store cut</div></div>
      <div class="dash-card"><div class="dash-card-label">Unpaid</div><div class="dash-card-value">—</div><div class="dash-card-sub">awaiting payout</div></div>
      <div class="dash-card"><div class="dash-card-label">Listings</div><div class="dash-card-value">${apps.length}</div><div class="dash-card-sub">${apps.filter((a) => !!a.listing?.listedAt).length} listed</div></div>
    </div>
    <div class="mcc-charts">
      <div class="dash-card dash-card-wide">
        <div class="dash-card-head"><div><div class="dash-card-label">Net earnings</div><div class="dash-card-sub">last 30 days</div></div></div>
        <div class="mcc-chart-host"><canvas id="mcc-chart-days"></canvas></div>
      </div>
      <div class="dash-card">
        <div class="dash-card-head"><div><div class="dash-card-label">By app</div><div class="dash-card-sub">net share</div></div></div>
        <div class="mcc-chart-host"><canvas id="mcc-chart-apps"></canvas></div>
      </div>
    </div>
    <section class="mkt-dt-section">
      <h3>Your listings</h3>
      <input id="mcc-listing-search" class="settings-input" type="text" placeholder="Search your listings…" spellcheck="false" autocomplete="off" style="margin:0 0 12px;max-width:340px;" />
      <div id="mcc-listings-host"></div>
    </section>`;

  // Listings: searched + PAGINATED (his rule, 2026-08-20) — 10 per page.
  const LIST_PAGE = 10;
  let listingQuery = "";
  let listingPage = 1;
  const paintListings = (): void => {
    const lhost = host.querySelector<HTMLElement>("#mcc-listings-host");
    if (!lhost) return;
    const q = listingQuery.toLowerCase();
    const filtered = apps.filter((a) => !q
      || (a.listing?.title || a.name).toLowerCase().includes(q)
      || a.slug.toLowerCase().includes(q));
    if (!filtered.length) {
      lhost.innerHTML = `<div class="mkt-empty-card">${apps.length ? "No listings match." : "No published apps yet — build a Glyphh app and list it from Apps → the app → Marketplace tab."}</div>`;
      return;
    }
    const { items, state } = paginate(filtered, listingPage, LIST_PAGE);
    lhost.innerHTML = `<div class="mkt-console-apps">${items.map((a) => consoleAppHtml(a, details.get(a.slug) ?? null)).join("")}</div>`;
    if (state.totalPages > 1) {
      lhost.appendChild(renderPaginationBar(state, (p) => { listingPage = p; paintListings(); }));
    }
    wireConsole(lhost);
    // Review chips for the visible page.
    void Promise.all(items.map(async (a) => {
      try {
        const st = listingReviewState((await mkt.releases(a.slug)).releases);
        if (!st) return;
        const slot = lhost.querySelector<HTMLElement>(`.mkt-review-slot[data-slug="${CSS.escape(a.slug)}"]`);
        if (slot) slot.innerHTML = `<span class="mkt-review-chip ${st.cls}">${escMkt(st.label)}</span>`;
      } catch { /* row stays plain */ }
    }));
  };
  const search = host.querySelector<HTMLInputElement>("#mcc-listing-search");
  search?.addEventListener("input", () => { listingQuery = search.value.trim(); listingPage = 1; paintListings(); });
  paintListings();


  // Money — the program's earnings feed the cards + charts; no profile or no
  // program yet degrades to the zeros the markup already shows.
  try {
    const me = await mkt.devMe();
    const handle = me.org?.handle ?? me.personal?.handle ?? null;
    if (!handle) return;
    const earnings = await mktProgram.earnings(handle);
    if (!earnings) return;   // program surface not live on this SDK bundle
    const t = earnings.totals;
    const cards = host.querySelectorAll<HTMLElement>("#mcc-stats .dash-card-value");
    if (cards[0]) cards[0].textContent = mktCreditsFromMicro(t.grossCreditsMicro);
    if (cards[1]) cards[1].textContent = mktCreditsFromMicro(t.netCreditsMicro);
    if (cards[2]) cards[2].textContent = mktCreditsFromMicro(t.unpaidNetCreditsMicro);
    paintHomeCharts(host, earnings.earnings);
  } catch { /* signed-out / program not live — the dashes stand */ }
}

export async function loadMktConsole(): Promise<void> {
  showMktView("console");
  const el = consoleEl();
  el.innerHTML = `<button class="mkt-back">‹ Back to marketplace</button><div class="crud-empty">Loading…</div>`;
  el.querySelector(".mkt-back")?.addEventListener("click", () => showMktView("store"));

  let apps: MktOrgApp[] = [];
  try {
    // OWNED only (his rule, 2026-08-20): "Your listings" is what you BUILT —
    // an installed marketplace app is someone else's listing.
    apps = (await mkt.myApps()).apps.filter((a) => a.kind === "glyphh" && a.owned === true);
  } catch { /* the listings block renders its empty note */ }
  // Pricing prefills come from the marketplace detail (mine() carries none).
  const details = new Map<string, MktDetail>();
  await Promise.all(apps.map(async (a) => {
    try { details.set(a.slug, (await mkt.detail(a.slug)).detail); } catch { /* thin row */ }
  }));

  const panes = programPanesHtml();
  el.innerHTML = `
    <button class="mkt-back">‹ Back to marketplace</button>
    <h1 class="mkt-console-title">Developer console</h1>
    <p class="mkt-console-sub">Your marketplace identity, your listings, their pricing in credits, and the release review pipeline.</p>
    <div id="dev-program-error" class="hidden"></div>

    <div class="app-detail-tabs" id="mcc-tabs">
      <button class="app-detail-tab active" data-mcctab="home" type="button">Home</button>
      <button class="app-detail-tab" data-mcctab="personal" type="button">Profile</button>
      <button class="app-detail-tab" data-mcctab="agreement" type="button">Developer Agreement</button>
      <button class="app-detail-tab" data-mcctab="payouts" type="button">Payouts</button>
    </div>
    <div id="mcc-home"><div class="crud-empty">Loading…</div></div>
    <div id="mcc-personal" class="hidden"></div>
    <div id="mcc-agreement" class="hidden">${panes.agreement}</div>
    <div id="mcc-payouts" class="hidden">${panes.payouts}</div>`;

  el.querySelector(".mkt-back")?.addEventListener("click", () => showMktView("store"));
  initProgramPanes();

  // Org profile pane parked until the verified-org tier (his decision, 2026-08-20).
  const paneIds: Record<string, string> = { home: "mcc-home", personal: "mcc-personal", agreement: "mcc-agreement", payouts: "mcc-payouts" };
  const loaded = new Set<string>(["home"]);
  const profilePane = (scope: MktScope, id: string): void => {
    const host = el.querySelector<HTMLElement>(`#${id}`);
    if (!host) return;
    void renderDeveloperProfiles(host, {
      scope,
      onChange: () => profilePane(scope, id),
      onView: (handle) => void openMktDeveloper(handle),
    });
  };
  el.querySelectorAll<HTMLButtonElement>("#mcc-tabs .app-detail-tab").forEach((b) => {
    b.addEventListener("click", () => {
      const tab = b.dataset.mcctab!;
      el.querySelectorAll("#mcc-tabs .app-detail-tab").forEach((t) => t.classList.toggle("active", t === b));
      for (const [k, id] of Object.entries(paneIds)) el.querySelector(`#${id}`)?.classList.toggle("hidden", k !== tab);
      if (loaded.has(tab)) return;
      loaded.add(tab);
      if (tab === "personal") profilePane("personal", "mcc-personal");
      else if (tab === "agreement" || tab === "payouts") void loadProgramPanes();
    });
  });

  void loadConsoleHome(el, apps, details);
}

/**
 * The developer-profile SECTION — Organization/Personal tabs over one pane
 * (editor or create state) — rendered into `host`. Shared by the marketplace
 * console and Settings → Developer (M7 signup). `onChange` fires after a
 * successful create or avatar upload so the CALLER re-renders itself;
 * `onView` opens a public profile page (the console's marketplace view —
 * Settings closes its modal and navigates there first).
 */
export async function renderDeveloperProfiles(host: HTMLElement, opts: {
  onChange: () => void;
  onView: (handle: string) => void;
  /** Fixed scope (the console's top-level Organization/Personal tabs own the
   *  choice) — the pane renders WITHOUT its own tab strip. */
  scope?: MktScope;
}): Promise<void> {
  let me: { personal: MktDeveloper | null; org: MktDeveloper | null } = { personal: null, org: null };
  let meError = "";
  try { me = await mkt.devMe(); }
  catch (err) { meError = mktErrorText(err); }
  // First paint lands on a tab that has a profile (org wins ties). A fixed
  // scope from the caller overrides both the heuristic and the pin.
  if (opts.scope) { mcScope = opts.scope; }
  else if (!mcScopePinned) mcScope = me.org || !me.personal ? "org" : "personal";

  let saveTimer = 0;
  let statusTimer = 0;
  let busy = false; // one write at a time — creation must never double-fire
  // Repaint guard: paint() bumps this, and a commit measured against a stale
  // epoch aborts. A debounce timer armed before a re-render (a write's
  // onChange → the caller reloads → fresh innerHTML) would otherwise fire
  // against the freshly-POPULATED fields and autosave programmatic values.
  let paintEpoch = 0;

  /** The one place a write reports itself (no Save button anywhere). */
  const setStatus = (msg: string, kind: "success" | "error" | "" = ""): void => {
    const el = host.querySelector<HTMLElement>(".mc-save-state");
    if (!el) return;
    el.textContent = msg;
    el.className = `set-save-state mc-save-state${kind ? ` ${kind}` : ""}`;
    window.clearTimeout(statusTimer);
    if (kind === "success") statusTimer = window.setTimeout(() => { el.textContent = ""; }, 2500);
  };

  const val = (f: string): string =>
    host.querySelector<HTMLInputElement | HTMLTextAreaElement>(`.mc-field[data-f="${f}"]`)?.value.trim() ?? "";

  /** Inline field validation, Apps → New style: `.invalid` on the control,
   *  the message on the settings-error line under it. Field errors NEVER
   *  reach the note banner and NEVER produce a request. */
  const setFieldError = (f: string, msg: string | null): void => {
    const input = host.querySelector<HTMLElement>(`.mc-field[data-f="${f}"]`);
    const err = host.querySelector<HTMLElement>(`[data-err="${f}"]`);
    input?.classList.toggle("invalid", !!msg);
    if (err) {
      err.textContent = msg || "";
      err.classList.toggle("hidden", !msg);
    }
  };

  /** Validate website + supportEmail off the live inputs. Returns the wire
   *  values (website normalized to https://…) or null when anything is
   *  invalid — in which case the errors are already showing inline. */
  const validateOptionalFields = (): { website: string; supportEmail: string } | null => {
    const website = normalizeWebsite(val("website"));
    setFieldError("website", website === null ? WEBSITE_MSG : null);
    const supportEmail = val("supportEmail");
    const emailOk = !supportEmail || EMAIL_RE.test(supportEmail);
    setFieldError("supportEmail", emailOk ? null : EMAIL_MSG);
    if (website === null || !emailOk) return null;
    return { website, supportEmail };
  };

  /** Autosave an existing profile — only the fields that actually changed,
   *  and only when every field is valid (an invalid field holds the save and
   *  reports inline — the server's zod is never reachable from typing). */
  const saveExisting = async (dev: MktDeveloper): Promise<void> => {
    if (busy) return;
    const displayName = val("displayName");
    // An empty name is an unfinished edit, not a save — say so and wait.
    if (!displayName) { setStatus("Needs a display name", "error"); return; }
    const optional = validateOptionalFields();
    if (!optional) { setStatus(""); return; } // inline errors are the report
    const patch: MktDeveloperPatch = {};
    if (displayName !== dev.displayName) patch.displayName = displayName;
    const bio = val("bio");
    if (bio !== (dev.bio || "")) patch.bio = bio || null;
    if (optional.website !== (dev.website || "")) patch.website = optional.website || null;
    if (optional.supportEmail !== (dev.supportEmail || "")) patch.supportEmail = optional.supportEmail || null;
    if (!Object.keys(patch).length) { setStatus(""); return; } // never PATCH {}
    busy = true;
    setStatus("Saving…");
    const res = await mkt.devUpdate(dev.handle, patch);
    busy = false;
    if (!res.ok) { setStatus("Not saved", "error"); note(host, res.error); return; }
    // Reconcile the snapshot the next dirty-check measures against; the inputs
    // deliberately aren't rewritten (a keystroke mid-flight would be yanked).
    Object.assign(dev, res.data ?? patch);
    const nameEl = host.querySelector<HTMLElement>(".mc-id-name");
    if (nameEl) nameEl.textContent = dev.displayName;
    setStatus("Saved", "success");
  };

  /** Implicit creation — fires on blur (change), never mid-keystroke, once
   *  the permanent handle and the display name are both present and valid. */
  const create = async (): Promise<void> => {
    if (busy) return;
    const handle = val("handle");
    const displayName = val("displayName");
    if (!handle && !displayName) { setStatus(""); return; } // untouched form
    setFieldError("handle", handleError(handle));
    const optional = validateOptionalFields();
    if (!handle) { setStatus("Needs a handle", "error"); return; }
    if (handleError(handle)) return; // inline error is showing on the field
    if (!displayName) { setStatus("Needs a display name", "error"); return; }
    if (!optional) return; // inline errors are showing — hold the create
    busy = true;
    setStatus("Creating…");
    const res = await mkt.devCreate({
      scope: mcScope,
      handle,
      displayName,
      ...(val("bio") ? { bio: val("bio") } : {}),
      ...(optional.website ? { website: optional.website } : {}),
      ...(optional.supportEmail ? { supportEmail: optional.supportEmail } : {}),
    });
    busy = false;
    if (!res.ok) { setStatus("Not created", "error"); note(host, res.error); return; }
    setStatus("Created", "success");
    opts.onChange(); // the caller re-renders; the pinned tab shows the editor
  };

  const wire = (dev: MktDeveloper | null): void => {
    const epoch = paintEpoch;
    host.querySelectorAll<HTMLButtonElement>(".mc-tabs .app-detail-tab").forEach((b) => {
      b.addEventListener("click", () => {
        const scope: MktScope = b.dataset.scope === "personal" ? "personal" : "org";
        if (scope === mcScope) return;
        window.clearTimeout(saveTimer);
        mcScope = scope;
        mcScopePinned = true;
        paint();
      });
    });

    const commit = (): void => {
      window.clearTimeout(saveTimer);
      if (epoch !== paintEpoch) return; // stale — the pane was re-rendered
      void (dev ? saveExisting(dev) : create());
    };
    host.querySelectorAll<HTMLElement>(".mc-field").forEach((f) => {
      // Existing profiles debounce while typing, like every Settings panel.
      // The create form commits on blur ONLY — the handle is permanent, so it
      // must never be claimed off a half-typed value.
      if (dev) {
        f.addEventListener("input", () => {
          window.clearTimeout(saveTimer);
          saveTimer = window.setTimeout(commit, 700);
        });
      }
      f.addEventListener("change", commit);
    });
    // The permanent handle validates LIVE — the kebab-case rule shows the
    // moment a keystroke breaks it, not after a failed commit.
    host.querySelector<HTMLInputElement>(`.mc-field[data-f="handle"]`)?.addEventListener("input", (e) => {
      setFieldError("handle", handleError((e.currentTarget as HTMLInputElement).value.trim()));
    });

    if (!dev) return;
    host.querySelector(".mc-view-link")?.addEventListener("click", (e) => {
      e.preventDefault();
      opts.onView(dev.handle);
    });

    // Avatar upload (file input → bytes → the write path; sniffed server-side).
    const pick = host.querySelector<HTMLButtonElement>(".mc-avatar-pick");
    const file = host.querySelector<HTMLInputElement>(".mc-avatar-file");
    if (!pick || !file) return;
    pick.addEventListener("click", () => file.click());
    file.addEventListener("change", async () => {
      const f = file.files?.[0];
      file.value = "";
      if (!f) return;
      // DOWNSCALE, never reject — a phone photo is MBs; the silent 512KB
      // bounce read as "the upload doesn't work" (his bug, 2026-08-20).
      const bytes = await downscaleImage(f);
      if (bytes.byteLength > 512 * 1024) { note(host, "That image couldn't be shrunk under 512 KB — try a different one."); return; }
      const res = await mkt.devAvatar(dev.handle, bytes);
      if (res.ok) opts.onChange();
      else note(host, res.error);
    });
  };

  const paint = (): void => {
    // Bump the repaint epoch FIRST — any debounce timer armed by the previous
    // paint (a mid-edit save) now measures against a newer epoch in commit()
    // and aborts, so it can never fire a write against the freshly-populated
    // inputs this repaint is about to paint. Without this the guard is dead
    // and a stale timer autosaves programmatic values → the server's zod
    // bounces the malformed body as the purple "invalid request body" note.
    paintEpoch++;
    window.clearTimeout(saveTimer);
    const dev = mcScope === "org" ? me.org : me.personal;
    // The app's REAL tab strip (Workspaces/Models/app editors): app-detail-tabs
    // with the underline active treatment — not pill buttons. The autosave
    // chip rides the strip's right edge, standing in for the heading it sits
    // beside on other settings panels.
    const strip = opts.scope
      ? `<div class="mc-chip-row"><span class="set-save-state mc-save-state"></span></div>`
      : `<div class="app-detail-tabs mc-tabs">
        <button class="app-detail-tab${mcScope === "org" ? " active" : ""}" data-scope="org" type="button">Organization</button>
        <button class="app-detail-tab${mcScope === "personal" ? " active" : ""}" data-scope="personal" type="button">Personal</button>
        <span class="set-save-state mc-save-state"></span>
      </div>`;
    host.innerHTML = `
      ${meError ? mktNoticeHtml(meError) : ""}
      ${strip}
      <div class="acct-section">
        ${dev ? profileEditorHtml(dev) : profileCreateHtml(mcScope)}
      </div>`;
    wire(dev);
  };

  paint();
}

function wireConsole(el: HTMLElement): void {
  el.querySelectorAll<HTMLButtonElement>(".mkt-console-approw").forEach((row) => {
    row.addEventListener("click", () => { void openListingBuilder(row.dataset.slug!); });
  });
}

/**
 * THE LISTING BUILDER (his rule, 2026-08-20) — one full page per owned app:
 * icon, screenshots, an UPLOADED demo video, the storefront copy, pricing in
 * credits, links, the release pipeline, and the list/unlist act. Renders over
 * the console view; ‹ returns to it. Copy autosaves debounced; everything
 * else commits on its own control.
 */
export async function openListingBuilder(slug: string): Promise<void> {
  showMktView("console");
  const el = consoleEl();
  el.innerHTML = `<button class="mkt-back">‹ Developer console</button><div class="crud-empty">Loading…</div>`;
  el.querySelector(".mkt-back")?.addEventListener("click", () => void loadMktConsole());

  let app: MktOrgApp | null = null;
  let detail: MktDetail | null = null;
  try {
    app = (await mkt.myApps()).apps.find((a) => a.slug === slug && a.owned === true) ?? null;
    if (app) detail = (await mkt.detail(slug)).detail;
  } catch { /* renders the honest empty below */ }
  if (!app) {
    el.innerHTML = `<button class="mkt-back">‹ Developer console</button><div class="crud-empty">Couldn't load this listing.</div>`;
    el.querySelector(".mkt-back")?.addEventListener("click", () => void loadMktConsole());
    return;
  }
  const l = app.listing;
  const pricing = detail?.pricing ?? null;
  const listed = !!l?.listedAt;
  const shots = detail?.listing.screenshots ?? l?.screenshots ?? [];
  const videoUrl = detail?.listing.videoUrl ?? l?.videoUrl ?? null;
  const isUploadedVideo = !!videoUrl && (videoUrl.startsWith("/") || videoUrl.includes("/api/apps/"));
  const toLocal = (iso: string | null | undefined): string => {
    if (!iso) return "";
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return "";
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  };

  el.innerHTML = `
    <button class="mkt-back">‹ Developer console</button>
    <div class="lb-head">
      <div class="lb-icon">
        ${l?.iconUrl ? `<img src="${escMkt(fixMediaUrl(l.iconUrl))}" alt="" />` : `<span class="mkt-card-initial">${escMkt((l?.title || app.name).charAt(0).toUpperCase())}</span>`}
      </div>
      <div class="lb-head-main">
        <h1 class="mkt-console-title" style="margin:0;">${escMkt(l?.title || app.name)}</h1>
        <p class="mkt-console-sub" style="margin:4px 0 0;">${escMkt(app.slug)} · v${escMkt(app.version)} <span class="mkt-listed-chip ${listed ? "on" : ""}" id="lb-listed-chip">${listed ? "Listed" : "Not listed"}</span></p>
      </div>
      <div class="lb-head-actions">
        <span id="lb-status" class="set-save-state"></span>
        <button id="lb-preview-btn" class="action-btn" type="button" title="The store page exactly as installers will see it">Preview listing</button>
        <button id="lb-icon-btn" class="action-btn" type="button" title="512×512 square — smaller images are upscaled by the store card">Change icon…</button>
        <button id="lb-list-btn" class="action-btn ${listed ? "" : "primary"}" type="button">${listed ? "Unlist from marketplace" : "List on marketplace"}</button>
      </div>
    </div>
    ${detail?.suspended ? `<div class="mq-recs" style="border-color:#e5484d;"><b>This app is SUSPENDED by platform moderation.</b>${(detail as { suspendReason?: string | null }).suspendReason ? ` Reason: ${escMkt((detail as { suspendReason?: string | null }).suspendReason!)}` : ""} Contact support to resolve it.</div>` : ""}
    <div id="lb-error" class="hidden"></div>

    <section class="mkt-dt-section">
      <h3>Storefront copy</h3>
      <div class="acct-row">
        <div class="acct-field"><label class="settings-label">Title</label><input id="lb-title" class="settings-input" value="${escMkt(l?.title || "")}" placeholder="${escMkt(app.name)}" spellcheck="false" /></div>
        <div class="acct-field"><label class="settings-label">Category</label>
          <select id="lb-category" class="settings-input">
            <option value="">— pick a category —</option>
            ${Object.entries(MKT_CATEGORY_LABELS).map(([v, label]) => `<option value="${escMkt(v)}"${(l?.category || "") === v ? " selected" : ""}>${escMkt(label)}</option>`).join("")}
          </select></div>
      </div>
      <div class="acct-row">
        <div class="acct-field acct-field-wide"><label class="settings-label">Tagline <span style="color:var(--text-3);font-weight:400;">— one line under the title, ≤140 chars</span></label><input id="lb-tagline" class="settings-input" maxlength="140" value="${escMkt(l?.tagline || "")}" /></div>
      </div>
      <div class="acct-row">
        <div class="acct-field acct-field-wide"><label class="settings-label">Description <span style="color:var(--text-3);font-weight:400;">— markdown, the long-form store page</span></label><textarea id="lb-body" class="settings-input" rows="8" spellcheck="true">${escMkt(l?.body || "")}</textarea></div>
      </div>
      <p class="settings-hint" style="margin:6px 0 0;">Website and support come from your developer profile — one place to maintain them (Profile tab).</p>
    </section>

    <section class="mkt-dt-section">
      <h3>Screenshots <button id="lb-shot-add" class="action-btn" type="button" style="margin-left:10px;">Add screenshot…</button></h3>
      <div class="lb-shots" id="lb-shots">
        ${shots.length ? shots.map((sc) => `
          <div class="lb-shot" data-url="${escMkt(sc.url)}">
            <img src="${escMkt(fixMediaUrl(sc.url))}" alt="" />
            <button class="lb-shot-del" type="button" title="Remove">×</button>
          </div>`).join("") : `<p class="settings-hint" style="margin:0;">None yet — 1280×800 or wider reads best. The first screenshot is the store card's hero.</p>`}
      </div>
    </section>

    <section class="mkt-dt-section">
      <h3>Demo video</h3>
      <div id="lb-video-host">
        ${videoUrl
          ? (isUploadedVideo
            ? `<video class="lb-video" src="${escMkt(fixMediaUrl(videoUrl))}" controls preload="metadata"></video>`
            : `<p class="settings-hint" style="margin:0 0 8px;">Linked video: <a href="${escMkt(videoUrl)}" target="_blank" rel="noreferrer noopener">${escMkt(videoUrl)}</a></p>`)
          : `<p class="settings-hint" style="margin:0 0 8px;">No demo yet — a 30–90s walkthrough sells the app better than any copy.</p>`}
      </div>
      <div style="display:flex;gap:8px;align-items:center;margin-top:10px;">
        <button id="lb-video-btn" class="action-btn" type="button" title="MP4 (H.264) or WebM, up to 50MB">${videoUrl ? "Replace video…" : "Upload video…"}</button>
        ${videoUrl ? `<button id="lb-video-del" class="action-btn" type="button">Remove</button>` : ""}
        <input id="lb-video-link" class="settings-input" style="max-width:340px;" placeholder="…or paste a YouTube/Vimeo link" value="${escMkt(!isUploadedVideo && videoUrl ? videoUrl : "")}" spellcheck="false" />
      </div>
    </section>

    <section class="mkt-dt-section">
      <h3>Pricing — credits only <span id="lb-price-status" class="set-save-state"></span></h3>
      <div class="acct-row">
        <div class="acct-field"><label class="settings-label">Monthly credits <span style="color:var(--text-3);font-weight:400;">— 0 = free</span></label><input id="lb-price" class="settings-input" type="number" min="0" step="1" value="${pricing ? pricing.monthlyCredits : 0}" /></div>
        <div class="acct-field"><label class="settings-label">Discount % <span style="color:var(--text-3);font-weight:400;">— blank clears it</span></label><input id="lb-disc" class="settings-input" type="number" min="1" max="100" step="1" value="${pricing?.discountPercent ?? ""}" /></div>
      </div>
      <div class="acct-row">
        <div class="acct-field acct-field-wide"><label class="settings-label">Discount window</label>
          <div class="mkt-disc-window">
            <input id="lb-disc-start" class="settings-input" type="datetime-local" value="${escMkt(toLocal(pricing?.discountStartsAt))}" />
            <span>→</span>
            <input id="lb-disc-end" class="settings-input" type="datetime-local" value="${escMkt(toLocal(pricing?.discountEndsAt))}" />
          </div>
        </div>
      </div>
      <button id="lb-price-save" class="action-btn primary" type="button">Save pricing</button>
    </section>

    <section class="mkt-dt-section">
      <h3>Releases — every update is re-reviewed before it ships</h3>
      <div class="mkt-console-app" data-slug="${escMkt(app.slug)}"><div class="mc-releases"><div class="inline-empty">Loading…</div></div></div>
    </section>`;

  el.querySelector(".mkt-back")?.addEventListener("click", () => void loadMktConsole());
  const status = (msg: string, kind: "success" | "error" | "" = ""): void => {
    const st = el.querySelector<HTMLElement>("#lb-status");
    if (!st) return;
    st.textContent = msg;
    st.className = `set-save-state${kind ? ` ${kind}` : ""}`;
    if (kind === "success") window.setTimeout(() => { if (st.textContent === msg) st.textContent = ""; }, 2500);
  };
  const fail2 = (msg: string): void => {
    const e2 = el.querySelector<HTMLElement>("#lb-error");
    if (!e2) return;
    e2.innerHTML = mktNoticeHtml(msg);
    e2.classList.remove("hidden");
  };
  const reload = (): void => { void openListingBuilder(slug); };

  // Copy autosave — debounced, only changed fields, settings grammar.
  const val = (id: string): string => (el.querySelector(`#${id}`) as HTMLInputElement | HTMLTextAreaElement | null)?.value.trim() ?? "";
  const snapshot = { title: l?.title || "", tagline: l?.tagline || "", category: l?.category || "", body: l?.body || "", website: l?.website || "", supportEmail: l?.supportEmail || "" };
  let copyTimer = 0;
  const saveCopy = async (): Promise<void> => {
    const patch: Record<string, unknown> = {};
    for (const [field, id] of [["title", "lb-title"], ["tagline", "lb-tagline"], ["category", "lb-category"], ["body", "lb-body"]] as const) {
      const v = val(id);
      if (v !== snapshot[field]) patch[field] = v;
    }
    if (!Object.keys(patch).length) return;
    status("Saving…");
    const r = await lbSetListing(slug, patch);
    if (!r.ok) { status("Not saved", "error"); if (r.error) fail2(r.error); return; }
    Object.assign(snapshot, patch);
    status("Saved", "success");
  };
  for (const id of ["lb-title", "lb-tagline", "lb-category", "lb-body"]) {
    const f = el.querySelector(`#${id}`);
    f?.addEventListener("input", () => { window.clearTimeout(copyTimer); copyTimer = window.setTimeout(() => void saveCopy(), 800); });
    f?.addEventListener("change", () => { window.clearTimeout(copyTimer); void saveCopy(); });
  }

  // Media.
  // PREVIEW (his rule, 2026-08-20): the marketplace detail page renders for
  // its owner whether or not it is listed — exactly what installers will see.
  el.querySelector("#lb-preview-btn")?.addEventListener("click", () => { void openMktDetail(slug); });
  el.querySelector("#lb-icon-btn")?.addEventListener("click", async () => {
    status("Uploading…");
    const r = await lbAddMedia(slug, "icon");
    if (r.ok) reload(); else { status("", ""); if (r.error) fail2(r.error); }
  });
  el.querySelector("#lb-shot-add")?.addEventListener("click", async () => {
    status("Uploading…");
    const r = await lbAddMedia(slug, "screenshot");
    if (r.ok) reload(); else { status("", ""); if (r.error) fail2(r.error); }
  });
  el.querySelectorAll<HTMLButtonElement>(".lb-shot-del").forEach((b) => {
    b.addEventListener("click", async () => {
      const url = (b.closest(".lb-shot") as HTMLElement).dataset.url || "";
      const key = decodeURIComponent(url.split("/media/").pop() || "");
      if (!key) return;
      const sure = await confirmAction({ title: "Remove this screenshot?", body: "It disappears from the store page immediately.", confirmLabel: "Remove", danger: true });
      if (!sure) return;
      const r = await lbRemoveMedia(slug, key);
      if (r.ok) reload(); else if (r.error) fail2(r.error);
    });
  });
  el.querySelector("#lb-video-btn")?.addEventListener("click", async () => {
    status("Uploading video…");
    const r = await lbAddMedia(slug, "video");
    if (r.ok) reload(); else { status("", ""); if (r.error) fail2(r.error); }
  });
  el.querySelector("#lb-video-del")?.addEventListener("click", async () => {
    const r = await lbSetListing(slug, { videoUrl: null });
    if (r.ok) reload(); else if (r.error) fail2(r.error);
  });
  el.querySelector("#lb-video-link")?.addEventListener("change", async (e2) => {
    const v = (e2.currentTarget as HTMLInputElement).value.trim();
    if (!v) return;
    const r = await lbSetListing(slug, { videoUrl: v });
    if (r.ok) reload(); else if (r.error) fail2(r.error);
  });

  // Pricing.
  el.querySelector("#lb-price-save")?.addEventListener("click", async () => {
    const num = (id: string): number | null => { const raw = val(id); return raw === "" ? null : Number(raw); };
    const iso = (id: string): string | null => { const raw = (el.querySelector(`#${id}`) as HTMLInputElement | null)?.value ?? ""; return raw ? new Date(raw).toISOString() : null; };
    const st = el.querySelector<HTMLElement>("#lb-price-status");
    const monthly = num("lb-price");
    if (monthly == null || Number.isNaN(monthly) || monthly < 0) { if (st) st.textContent = "Monthly credits must be 0 or more."; return; }
    const disc = num("lb-disc");
    if (st) st.textContent = "Saving…";
    const r = await mkt.setPricing(slug, {
      monthlyCredits: Math.round(monthly),
      discountPercent: disc == null || Number.isNaN(disc) ? null : Math.round(disc),
      discountStartsAt: disc == null ? null : iso("lb-disc-start"),
      discountEndsAt: disc == null ? null : iso("lb-disc-end"),
    });
    if (st) st.textContent = r.ok ? "Saved ✓" : "";
    if (!r.ok) fail2(r.error);
  });

  // List / unlist — the one public act; confirm the listing direction.
  el.querySelector("#lb-list-btn")?.addEventListener("click", async () => {
    const going = !listed;
    const sure = await confirmAction(going
      ? { title: "List this app on the marketplace?", body: "It becomes publicly browsable and installable (needs a tagline, category, and icon; releases still pass review).", confirmLabel: "List it" }
      : { title: "Unlist this app?", body: "The store card disappears. Orgs that already installed it keep it.", confirmLabel: "Unlist", danger: true });
    if (!sure) return;
    const r = await lbSetListed(slug, going);
    if (r.ok) reload(); else if (r.error) fail2(r.error);
  });

  // Releases — the same fold loader, hosted in the builder.
  const relCard = el.querySelector<HTMLElement>(`.mkt-console-app[data-slug="${CSS.escape(slug)}"]`);
  if (relCard) void loadConsoleReleases(relCard, slug);
  // The header says where the listing stands in review.
  void mkt.releases(slug).then((r) => {
    const state = listingReviewState(r.releases);
    if (!state) return;
    el.querySelector("#lb-listed-chip")?.insertAdjacentHTML("afterend",
      ` <span class="mkt-review-chip ${state.cls}">${escMkt(state.label)}</span>`);
  }).catch(() => { /* header stays plain */ });
}

/** The releases fold — status + review-status chips + submit-for-review. */
async function loadConsoleReleases(card: HTMLElement, slug: string): Promise<void> {
  const host = card.querySelector<HTMLElement>(".mc-releases");
  if (!host) return;
  let releases: MktRelease[] = [];
  try { releases = (await mkt.releases(slug)).releases; }
  catch (err) {
    host.innerHTML = `<div class="inline-empty">${escMkt(err instanceof Error ? err.message : "Couldn't load releases.")}</div>`;
    return;
  }
  if (!releases.length) {
    host.innerHTML = `<div class="inline-empty">No releases yet — building the app cuts the first one.</div>`;
    return;
  }
  host.innerHTML = releases.map((r) => {
    const submittable = r.status === "ready" && (r.reviewStatus === "draft" || r.reviewStatus === "rejected");
    return `
      <div class="mkt-release-row" data-id="${escMkt(r.id)}">
        <div class="mkt-release-head">
          <span class="release-version">${escMkt(r.version)}</span>
          <span class="release-badge${r.channel === "live" ? " live" : ""}">${r.channel}</span>
          ${r.status !== "ready" ? `<span class="release-state ${r.status}">${escMkt(r.status)}</span>` : ""}
          ${releaseChip(r)}
          <span class="release-date">${escMkt(mktDate(r.submittedAt || r.createdAt))}</span>
          <span style="flex:1;"></span>
          ${submittable ? `<button class="action-btn primary mc-submit-release" type="button" data-id="${escMkt(r.id)}">Submit for review</button>` : ""}
        </div>
        ${r.reviewStatus === "rejected" && r.reviewNotes ? `<div class="mkt-review-notes"><b>Reviewer:</b> ${escMkt(r.reviewNotes)}</div>` : ""}
        ${r.reviewRecommendations ? `
          <div class="mq-recs">
            <div class="mq-recs-head"><b>Review recommendations:</b> ${escMkt(r.reviewRecommendations.summary)}</div>
            <ul class="mq-recs-list">${r.reviewRecommendations.items.map((it) => `
              <li><span class="mkt-review-chip ${it.severity === "critical" ? "rejected" : it.severity === "warning" ? "in_review" : ""}">${escMkt(it.severity)}</span> <b>${escMkt(it.area)}</b> — ${escMkt(it.note)}</li>`).join("")}
            </ul>
            <p class="settings-hint" style="margin:6px 0 0;">Fix, rebuild, and resubmit — every resubmission is re-reviewed (see the marketplace review policy).</p>
          </div>` : ""}
      </div>`;
  }).join("");

  host.querySelectorAll<HTMLButtonElement>(".mc-submit-release").forEach((b) => {
    b.addEventListener("click", async () => {
      const r = releases.find((x) => x.id === b.dataset.id);
      if (!r) return;
      // ONE dialog, comment box inside it (his rule, 2026-08-20, third ask):
      // self-contained DOM — no shared modal to depend on.
      const submitted = await new Promise<string | null>((resolve) => {
        const overlay = document.createElement("div");
        overlay.className = "confirm-overlay";
        overlay.innerHTML = `
          <div class="confirm-box" style="max-width:560px;width:min(560px,92vw);">
            <div class="confirm-head"><h3>Submit ${escMkt(r.version)} for review?</h3></div>
            <div class="confirm-body">
              <p style="margin:0 0 12px;">A platform reviewer rules on every release before it ships. Approval promotes it live; a rejection comes back with notes.</p>
              <label class="settings-label" style="display:block;margin:16px 0 8px;">Note to the reviewers <span style="color:var(--text-3);font-weight:400;">— optional: what changed, what to look at</span></label>
              <textarea class="settings-input" rows="4" spellcheck="true" placeholder="Context for the reviewers…" style="width:100%;box-sizing:border-box;"></textarea>
            </div>
            <div class="confirm-foot">
              <button class="action-btn" data-x="cancel" type="button">Cancel</button>
              <button class="action-btn primary" data-x="go" type="button">Submit for review</button>
            </div>
          </div>`;
        const done = (v: string | null): void => { overlay.remove(); resolve(v); };
        overlay.addEventListener("mousedown", (ev) => { if (ev.target === overlay) done(null); });
        overlay.querySelector('[data-x="cancel"]')!.addEventListener("click", () => done(null));
        overlay.querySelector('[data-x="go"]')!.addEventListener("click", () =>
          done((overlay.querySelector("textarea") as HTMLTextAreaElement).value.trim()));
        document.body.appendChild(overlay);
        (overlay.querySelector("textarea") as HTMLTextAreaElement).focus();
      });
      if (submitted === null) return;
      b.disabled = true;
      const res = await mkt.submitRelease(slug, b.dataset.id!, submitted || undefined);
      if (res.ok) {
        // The old fold tracked a loaded flag on its body; the BUILDER hosts
        // the releases bare — clear the flag only where it exists.
        const foldBody = card.querySelector<HTMLElement>(".mkt-console-app-body");
        if (foldBody) delete foldBody.dataset.loaded;
        void loadConsoleReleases(card, slug);
      }
      else {
        b.disabled = false;
        const consoleHost = document.getElementById("mkt-console");
        if (consoleHost) note(consoleHost, res.error);
      }
    });
  });
}
