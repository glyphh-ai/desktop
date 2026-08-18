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

import { confirmAction, promptAction } from "./shared.js";
import {
  mkt, escMkt, mktStarRow, mktDate, mktDiscountActive, mktErrorText, mktNoticeHtml,
  type MktDetail, type MktDeveloper, type MktDeveloperPatch, type MktRelease,
  type MktReview, type MktOrgApp, type MktReleaseReviewStatus,
} from "./marketplace-data.js";
import {
  showMktView, openMktDetail, mktCachedDetails, mktBrowseRows,
  mktReviewRow, mktReviewFormHtml, wireStarInput,
} from "./marketplace.js";

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

/** One owned listing in the console — pricing editor + releases fold. */
function consoleAppHtml(app: MktOrgApp, detail: MktDetail | null): string {
  const l = app.listing;
  const pricing = detail?.pricing ?? null;
  const listed = !!l?.listedAt;
  const toLocal = (iso: string | null | undefined): string => {
    if (!iso) return "";
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return "";
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  };
  return `
    <div class="mkt-console-app" data-slug="${escMkt(app.slug)}">
      <button class="mkt-console-app-head" type="button">
        <span class="mkt-card-icon">${l?.iconUrl ? `<img src="${escMkt(l.iconUrl)}" alt="" />` : `<span class="mkt-card-initial">${escMkt((l?.title || app.name).charAt(0).toUpperCase())}</span>`}</span>
        <span class="mkt-console-app-name">${escMkt(l?.title || app.name)}</span>
        <span class="mkt-console-app-sub">${escMkt(app.slug)} · v${escMkt(app.version)}</span>
        <span style="flex:1;"></span>
        ${l?.ratingCount ? `<span class="mkt-rating"><b>${l.ratingAvg.toFixed(1)}</b> <span class="mkt-stars">★</span> <span class="mkt-rating-count">(${l.ratingCount})</span></span>` : ""}
        <span class="mkt-listed-chip ${listed ? "on" : ""}">${listed ? "Listed" : "Not listed"}</span>
        <span class="mkt-console-chev">▾</span>
      </button>
      <div class="mkt-console-app-body hidden">
        <div class="mkt-console-cols">
          <div class="mkt-console-col">
            <h5>Pricing — credits only</h5>
            <label class="settings-label">Monthly credits <span style="color:var(--text-2);font-weight:400;">— 0 = free</span></label>
            <input class="settings-input mc-price" type="number" min="0" step="1" value="${pricing ? pricing.monthlyCredits : 0}" />
            <label class="settings-label">Discount % <span style="color:var(--text-2);font-weight:400;">— blank clears the discount</span></label>
            <input class="settings-input mc-disc" type="number" min="1" max="100" step="1" value="${pricing?.discountPercent ?? ""}" />
            <label class="settings-label">Discount window</label>
            <div class="mkt-disc-window">
              <input class="settings-input mc-disc-start" type="datetime-local" value="${escMkt(toLocal(pricing?.discountStartsAt))}" />
              <span>→</span>
              <input class="settings-input mc-disc-end" type="datetime-local" value="${escMkt(toLocal(pricing?.discountEndsAt))}" />
            </div>
            ${pricing && mktDiscountActive(pricing) ? `<p class="proxy-field-hint">Discount live now — installers pay ${pricing.effectiveMonthlyCredits} credits/mo.</p>` : ""}
            <div class="settings-actions" style="margin-top:10px;display:flex;gap:8px;align-items:center;">
              <span class="mc-price-status" style="flex:1;font-size:12px;color:var(--text-3);"></span>
              <button class="action-btn primary mc-price-save" type="button">Save pricing</button>
            </div>
            <p class="proxy-field-hint" style="margin-top:12px;">The listing copy and images are edited on the app itself — Apps → ${escMkt(app.name)} → Marketplace tab.</p>
          </div>
          <div class="mkt-console-col">
            <h5>Releases — every update is re-reviewed before it ships</h5>
            <div class="mc-releases"><div class="inline-empty">Loading…</div></div>
          </div>
        </div>
      </div>
    </div>`;
}

export async function loadMktConsole(): Promise<void> {
  showMktView("console");
  const el = consoleEl();
  el.innerHTML = `<button class="mkt-back">‹ Back to marketplace</button><div class="crud-empty">Loading…</div>`;
  el.querySelector(".mkt-back")?.addEventListener("click", () => showMktView("store"));

  let apps: MktOrgApp[] = [];
  try {
    apps = (await mkt.myApps()).apps.filter((a) => a.kind === "glyphh" && a.owned !== false);
  } catch { /* the listings block renders its empty note */ }
  // Pricing prefills come from the marketplace detail (mine() carries none).
  const details = new Map<string, MktDetail>();
  await Promise.all(apps.map(async (a) => {
    try { details.set(a.slug, (await mkt.detail(a.slug)).detail); } catch { /* thin row */ }
  }));

  el.innerHTML = `
    <button class="mkt-back">‹ Back to marketplace</button>
    <nav class="mkt-crumbs">Marketplace<span class="sep">›</span><span class="cur">Developer console</span></nav>
    <h1 class="mkt-console-title">Developer console</h1>
    <p class="mkt-console-sub">Your marketplace identity, your listings, their pricing in credits, and the release review pipeline.</p>

    <section class="mkt-dt-section">
      <h3>Developer profiles</h3>
      <p class="settings-hint" style="margin:0 0 12px;">One profile per organization OR per person — apps you publish carry whichever profile your org uses.</p>
      <div class="mc-profiles-host"><div class="crud-empty">Loading…</div></div>
    </section>

    <section class="mkt-dt-section">
      <h3>Your listings</h3>
      ${apps.length
        ? `<div class="mkt-console-apps">${apps.map((a) => consoleAppHtml(a, details.get(a.slug) ?? null)).join("")}</div>`
        : `<div class="mkt-empty-card">No published apps yet — build a Glyphh app and list it from Apps → the app → Marketplace tab.</div>`}
    </section>`;

  const profilesHost = el.querySelector<HTMLElement>(".mc-profiles-host");
  if (profilesHost) {
    void renderDeveloperProfiles(profilesHost, {
      onChange: () => void loadMktConsole(),
      onView: (handle) => void openMktDeveloper(handle),
    });
  }
  wireConsole(el);
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
}): Promise<void> {
  let me: { personal: MktDeveloper | null; org: MktDeveloper | null } = { personal: null, org: null };
  let meError = "";
  try { me = await mkt.devMe(); }
  catch (err) { meError = mktErrorText(err); }
  // First paint lands on a tab that has a profile (org wins ties).
  if (!mcScopePinned) mcScope = me.org || !me.personal ? "org" : "personal";

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
      if (f.size > 512 * 1024) { note(host, "That image is over 512 KB — pick a smaller one."); return; }
      const bytes = new Uint8Array(await f.arrayBuffer());
      const res = await mkt.devAvatar(dev.handle, bytes);
      if (res.ok) opts.onChange();
      else note(host, res.error);
    });
  };

  const paint = (): void => {
    const dev = mcScope === "org" ? me.org : me.personal;
    // The app's REAL tab strip (Workspaces/Models/app editors): app-detail-tabs
    // with the underline active treatment — not pill buttons. The autosave
    // chip rides the strip's right edge, standing in for the heading it sits
    // beside on other settings panels.
    host.innerHTML = `
      ${meError ? mktNoticeHtml(meError) : ""}
      <div class="app-detail-tabs mc-tabs">
        <button class="app-detail-tab${mcScope === "org" ? " active" : ""}" data-scope="org" type="button">Organization</button>
        <button class="app-detail-tab${mcScope === "personal" ? " active" : ""}" data-scope="personal" type="button">Personal</button>
        <span class="set-save-state mc-save-state"></span>
      </div>
      <div class="acct-section">
        ${dev ? profileEditorHtml(dev) : profileCreateHtml(mcScope)}
      </div>`;
    wire(dev);
  };

  paint();
}

function wireConsole(el: HTMLElement): void {
  el.querySelector(".mkt-back")?.addEventListener("click", () => showMktView("store"));

  // Listing folds: expand → load releases.
  el.querySelectorAll<HTMLElement>(".mkt-console-app").forEach((card) => {
    const head = card.querySelector<HTMLButtonElement>(".mkt-console-app-head")!;
    const body = card.querySelector<HTMLElement>(".mkt-console-app-body")!;
    const chev = card.querySelector<HTMLElement>(".mkt-console-chev")!;
    const slug = card.dataset.slug!;
    head.addEventListener("click", () => {
      const open = !body.classList.toggle("hidden");
      chev.textContent = open ? "▴" : "▾";
      if (open && !body.dataset.loaded) {
        body.dataset.loaded = "1";
        void loadConsoleReleases(card, slug);
      }
    });

    // Pricing save.
    card.querySelector<HTMLButtonElement>(".mc-price-save")?.addEventListener("click", async () => {
      const num = (sel: string): number | null => {
        const raw = (card.querySelector(sel) as HTMLInputElement | null)?.value.trim() ?? "";
        return raw === "" ? null : Number(raw);
      };
      const iso = (sel: string): string | null => {
        const raw = (card.querySelector(sel) as HTMLInputElement | null)?.value ?? "";
        return raw ? new Date(raw).toISOString() : null;
      };
      const status = card.querySelector<HTMLElement>(".mc-price-status");
      const monthly = num(".mc-price");
      if (monthly == null || Number.isNaN(monthly) || monthly < 0) {
        if (status) status.textContent = "Monthly credits must be 0 or more.";
        return;
      }
      const disc = num(".mc-disc");
      if (status) status.textContent = "Saving…";
      const res = await mkt.setPricing(slug, {
        monthlyCredits: Math.round(monthly),
        // Blank % clears the whole discount (null on the wire).
        discountPercent: disc == null || Number.isNaN(disc) ? null : Math.round(disc),
        discountStartsAt: disc == null ? null : iso(".mc-disc-start"),
        discountEndsAt: disc == null ? null : iso(".mc-disc-end"),
      });
      if (status) status.textContent = res.ok ? "Saved ✓" : "";
      if (!res.ok) note(el, res.error);
    });
  });
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
      </div>`;
  }).join("");

  host.querySelectorAll<HTMLButtonElement>(".mc-submit-release").forEach((b) => {
    b.addEventListener("click", async () => {
      const r = releases.find((x) => x.id === b.dataset.id);
      if (!r) return;
      const confirmed = await confirmAction({
        title: `Submit ${r.version} for marketplace review?`,
        body: "A platform reviewer rules on every release before it ships. Approval promotes it live; a rejection comes back with notes.",
        confirmLabel: "Submit",
      });
      if (!confirmed) return;
      b.disabled = true;
      const res = await mkt.submitRelease(slug, b.dataset.id!);
      if (res.ok) { delete card.querySelector<HTMLElement>(".mkt-console-app-body")!.dataset.loaded; void loadConsoleReleases(card, slug); }
      else {
        b.disabled = false;
        const consoleHost = document.getElementById("mkt-console");
        if (consoleHost) note(consoleHost, res.error);
      }
    });
  });
}
