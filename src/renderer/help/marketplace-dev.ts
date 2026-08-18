/**
 * marketplace-dev.ts — the marketplace's DEVELOPER pages:
 *
 *   • The public developer PROFILE (#mkt-dev) — avatar, bio, links, direct
 *     stars beside the across-their-apps rollup, their apps, their reviews,
 *     and the write-a-developer-review form (install-gated server-side).
 *   • The developer CONSOLE (#mkt-console) — create/edit the org or personal
 *     profile (avatar upload), the org's own listings with the credits
 *     pricing editor (monthly price + discount window), and each app's
 *     releases with submit-for-review + review-status chips.
 *
 * The PROFILE section (cards + create form + wiring) is exported as
 * renderDeveloperProfiles — Settings → Developer (the M7 program signup area)
 * renders the same machinery instead of duplicating it.
 */

import { confirmAction, promptAction } from "./shared.js";
import {
  mkt, escMkt, mktStarRow, mktDate, mktDiscountActive,
  type MktDetail, type MktDeveloper, type MktRelease, type MktReview,
  type MktOrgApp, type MktReleaseReviewStatus,
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

/** A profile card in the console: the existing profile's edit form, or the
 *  invitation to create one for that scope. */
function profileCardHtml(scope: "personal" | "org", dev: MktDeveloper | null): string {
  const p = scope === "personal" ? "mc-p" : "mc-o";
  if (!dev) {
    return `
      <div class="mkt-console-card" data-scope="${scope}">
        <h4>${scope === "org" ? "Organization profile" : "Personal profile"}</h4>
        <p class="settings-hint">No ${scope === "org" ? "org" : "personal"} developer profile yet.</p>
        <button class="action-btn primary mc-create-btn" type="button" data-scope="${scope}">Create profile</button>
      </div>`;
  }
  return `
    <div class="mkt-console-card" data-scope="${scope}">
      <h4>${scope === "org" ? "Organization profile" : "Personal profile"}
        <span class="mkt-dev-handle">@${escMkt(dev.handle)}</span>
        ${dev.ratingCount ? `<span class="mkt-rating" style="margin-left:auto;"><b>${dev.ratingAvg.toFixed(1)}</b> <span class="mkt-stars">★</span> <span class="mkt-rating-count">(${dev.ratingCount})</span></span>` : ""}
      </h4>
      <div class="mkt-console-avatar-row">
        <div class="mkt-dev-avatar" id="${p}-avatar">${dev.avatarUrl ? `<img src="${escMkt(dev.avatarUrl)}" alt="" />` : `<span class="mkt-card-initial">${escMkt(dev.displayName.charAt(0).toUpperCase())}</span>`}</div>
        <div style="display:flex;flex-direction:column;gap:6px;">
          <button class="action-btn mc-avatar-pick" type="button" data-handle="${escMkt(dev.handle)}" data-p="${p}">Change avatar…</button>
          <input type="file" id="${p}-avatar-file" accept="image/png,image/jpeg,image/gif,image/webp" class="hidden" />
          <span class="proxy-field-hint">PNG/JPEG/GIF/WebP, ≤ 512 KB.</span>
        </div>
      </div>
      <label class="settings-label">Display name</label>
      <input id="${p}-name" class="settings-input" value="${escMkt(dev.displayName)}" spellcheck="false" />
      <label class="settings-label">Bio</label>
      <textarea id="${p}-bio" class="settings-input" rows="3" spellcheck="true">${escMkt(dev.bio || "")}</textarea>
      <label class="settings-label">Website</label>
      <input id="${p}-website" class="settings-input" value="${escMkt(dev.website || "")}" placeholder="https://…" spellcheck="false" />
      <label class="settings-label">Support email <span style="color:var(--text-2);font-weight:400;">— "Support by you" on every listing</span></label>
      <input id="${p}-support" class="settings-input" value="${escMkt(dev.supportEmail || "")}" placeholder="help@…" spellcheck="false" />
      <div class="settings-actions" style="margin-top:10px;display:flex;gap:8px;align-items:center;">
        <span id="${p}-status" style="flex:1;font-size:12px;color:var(--text-3);"></span>
        <button class="action-btn mc-view-btn" type="button" data-handle="${escMkt(dev.handle)}">View public page</button>
        <button class="action-btn primary mc-save-btn" type="button" data-handle="${escMkt(dev.handle)}" data-p="${p}">Save</button>
      </div>
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
    <p class="section-desc">Your marketplace identity, your listings, their pricing in credits, and the release review pipeline.</p>

    <section class="mkt-dt-section">
      <h3>Developer profiles</h3>
      <p class="settings-hint" style="margin:0 0 12px;">One profile per organization OR per person — apps you publish carry whichever profile your org uses.</p>
      <div class="mc-profiles-host"><div class="crud-empty">Loading…</div></div>
    </section>

    <section class="mkt-dt-section">
      <h3>Your listings</h3>
      ${apps.length
        ? `<div class="mkt-console-apps">${apps.map((a) => consoleAppHtml(a, details.get(a.slug) ?? null)).join("")}</div>`
        : `<p class="settings-hint">No published apps yet — build a Glyphh app and list it from Apps → the app → Marketplace tab.</p>`}
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

/** The create-profile form, mounted under the cards when "Create" is hit. */
function createFormHtml(scope: "personal" | "org"): string {
  return `
    <div class="mkt-console-card" id="mc-create-card">
      <h4>Create your ${scope === "org" ? "organization" : "personal"} developer profile</h4>
      <label class="settings-label">Scope</label>
      <select id="mc-new-scope" class="settings-input">
        <option value="org"${scope === "org" ? " selected" : ""}>Organization — the whole org publishes under it</option>
        <option value="personal"${scope === "personal" ? " selected" : ""}>Personal — just you</option>
      </select>
      <label class="settings-label">Handle <span style="color:var(--text-2);font-weight:400;">— kebab-case, globally unique, permanent</span></label>
      <input id="mc-new-handle" class="settings-input" placeholder="acme-tools" spellcheck="false" autocomplete="off" pattern="[a-z0-9-]+" />
      <label class="settings-label">Display name</label>
      <input id="mc-new-name" class="settings-input" placeholder="Acme Tools" spellcheck="false" />
      <label class="settings-label">Bio <span style="color:var(--text-2);font-weight:400;">(optional)</span></label>
      <textarea id="mc-new-bio" class="settings-input" rows="3" spellcheck="true"></textarea>
      <label class="settings-label">Website <span style="color:var(--text-2);font-weight:400;">(optional)</span></label>
      <input id="mc-new-website" class="settings-input" placeholder="https://…" spellcheck="false" />
      <label class="settings-label">Support email <span style="color:var(--text-2);font-weight:400;">— support falls to the developer</span></label>
      <input id="mc-new-support" class="settings-input" placeholder="help@…" spellcheck="false" />
      <div id="mc-new-error" class="crud-form-error hidden" style="margin-top:8px;"></div>
      <div class="settings-actions" style="margin-top:10px;display:flex;gap:8px;">
        <button id="mc-new-cancel" class="action-btn" type="button">Cancel</button>
        <button id="mc-new-save" class="action-btn primary" type="button">Create profile</button>
      </div>
    </div>`;
}

/**
 * The developer-profile SECTION — the org + personal cards, the create form,
 * and all their wiring — rendered into `host`. Shared by the marketplace
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
  catch (err) { meError = err instanceof Error ? err.message : String(err); }

  host.innerHTML = `
    ${meError ? `<div class="crud-form-error">${escMkt(meError)}</div>` : ""}
    <div class="mkt-console-profiles">
      ${profileCardHtml("org", me.org)}
      ${profileCardHtml("personal", me.personal)}
    </div>
    <div class="mc-create-host"></div>`;

  // Create profile (org OR personal — the choice is explicit at creation).
  host.querySelectorAll<HTMLButtonElement>(".mc-create-btn").forEach((b) => {
    b.addEventListener("click", () => {
      const formHost = host.querySelector<HTMLElement>(".mc-create-host");
      if (!formHost) return;
      formHost.innerHTML = createFormHtml(b.dataset.scope === "personal" ? "personal" : "org");
      formHost.querySelector("#mc-new-cancel")?.addEventListener("click", () => { formHost.innerHTML = ""; });
      formHost.querySelector("#mc-new-save")?.addEventListener("click", async () => {
        const val = (id: string) => (formHost.querySelector(`#${id}`) as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement | null)?.value.trim() || "";
        const errEl = formHost.querySelector<HTMLElement>("#mc-new-error");
        errEl?.classList.add("hidden");
        const handle = val("mc-new-handle");
        const displayName = val("mc-new-name");
        if (!/^[a-z0-9][a-z0-9-]*$/.test(handle) || !displayName) {
          if (errEl) { errEl.textContent = "A kebab-case handle and a display name are required."; errEl.classList.remove("hidden"); }
          return;
        }
        const res = await mkt.devCreate({
          scope: val("mc-new-scope") === "personal" ? "personal" : "org",
          handle,
          displayName,
          ...(val("mc-new-bio") ? { bio: val("mc-new-bio") } : {}),
          ...(val("mc-new-website") ? { website: val("mc-new-website") } : {}),
          ...(val("mc-new-support") ? { supportEmail: val("mc-new-support") } : {}),
        });
        if (res.ok) opts.onChange();
        else if (errEl) { errEl.textContent = res.error; errEl.classList.remove("hidden"); }
      });
      formHost.scrollIntoView({ block: "nearest", behavior: "smooth" });
    });
  });

  // Edit an existing profile.
  host.querySelectorAll<HTMLButtonElement>(".mc-save-btn").forEach((b) => {
    b.addEventListener("click", async () => {
      const p = b.dataset.p!;
      const val = (id: string) => (host.querySelector(`#${p}-${id}`) as HTMLInputElement | HTMLTextAreaElement | null)?.value.trim() ?? "";
      const status = host.querySelector<HTMLElement>(`#${p}-status`);
      if (status) status.textContent = "Saving…";
      const res = await mkt.devUpdate(b.dataset.handle!, {
        displayName: val("name") || undefined,
        bio: val("bio") || null,
        website: val("website") || null,
        supportEmail: val("support") || null,
      });
      if (status) status.textContent = res.ok ? "Saved ✓" : "";
      if (!res.ok) note(host, res.error);
    });
  });
  host.querySelectorAll<HTMLButtonElement>(".mc-view-btn").forEach((b) => {
    b.addEventListener("click", () => opts.onView(b.dataset.handle!));
  });

  // Avatar upload (file input → bytes → the write path; sniffed server-side).
  host.querySelectorAll<HTMLButtonElement>(".mc-avatar-pick").forEach((b) => {
    const file = host.querySelector<HTMLInputElement>(`#${b.dataset.p}-avatar-file`);
    if (!file) return;
    b.addEventListener("click", () => file.click());
    file.addEventListener("change", async () => {
      const f = file.files?.[0];
      file.value = "";
      if (!f) return;
      if (f.size > 512 * 1024) { note(host, "That image is over 512 KB — pick a smaller one."); return; }
      const bytes = new Uint8Array(await f.arrayBuffer());
      const res = await mkt.devAvatar(b.dataset.handle!, bytes);
      if (res.ok) opts.onChange();
      else note(host, res.error);
    });
  });
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
