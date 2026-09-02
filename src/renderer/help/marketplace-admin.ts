/**
 * marketplace-admin.ts — the platform-admin REVIEW DESK (#mkt-admin):
 *
 *   • Release queue — submitted + in-review releases; begin review (claim),
 *     approve (auto-promotes live), reject with notes the author reads.
 *   • App reports — the malicious-report triage queue: claim / resolve /
 *     dismiss, with one-click listing suspension.
 *   • Flagged reviews — app AND developer review moderation: restore or
 *     remove from readers.
 *
 * The server enforces super_admin on every route — this page only renders the
 * desk; a non-admin who lands here reads the server's own refusal.
 */

import { confirmAction, promptAction } from "./shared.js";
import {
  mkt, mktIsPlatformAdmin, escMkt, mktStarRow, mktDate,
  type MktQueueRelease, type MktReport, type MktFlaggedReview,
} from "./marketplace-data.js";
import { showMktView, openMktDetail } from "./marketplace.js";
import { openMktDeveloper } from "./marketplace-dev.js";

type AdminTab = "queue" | "library" | "apps" | "reports" | "reviews" | "dev-reviews";
let adminTab: AdminTab = "queue";
let reportFilter: "open" | "reviewing" | "resolved" | "dismissed" | undefined;

const adminEl = (): HTMLElement => document.getElementById("mkt-admin")!;

function note(msg: string): void {
  const el = adminEl();
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

export async function loadMktAdmin(): Promise<void> {
  showMktView("admin");
  const el = adminEl();
  el.innerHTML = `<button class="mkt-back">‹ Back to marketplace</button><div class="crud-empty">Loading…</div>`;
  el.querySelector(".mkt-back")?.addEventListener("click", () => showMktView("store"));

  // A KNOWN non-admin gets the honest gate; unknown loads and lets the
  // server's 403 speak (settings-admin's rule).
  if (await mktIsPlatformAdmin() === false) {
    el.innerHTML = `<button class="mkt-back">‹ Back to marketplace</button>
      <div class="crud-empty">The review desk is for platform admins.</div>`;
    el.querySelector(".mkt-back")?.addEventListener("click", () => showMktView("store"));
    return;
  }

  el.innerHTML = `
    <button class="mkt-back">‹ Back to marketplace</button>
    <nav class="mkt-crumbs">Marketplace<span class="sep">›</span><span class="cur">Review desk</span></nav>
    <h1 class="mkt-console-title">Review desk</h1>
    <p class="mkt-console-sub">Nothing ships without approval — every release and every update comes through here, and every report is taken seriously.</p>
    <div class="mkt-admin-tabs">
      <button class="mkt-scope${adminTab === "queue" ? " active" : ""}" data-atab="queue">Release queue</button>
      <button class="mkt-scope${adminTab === "library" ? " active" : ""}" data-atab="library">Skills &amp; loops</button>
      <button class="mkt-scope${adminTab === "reports" ? " active" : ""}" data-atab="reports">App reports</button>
      <button class="mkt-scope${adminTab === "apps" ? " active" : ""}" data-atab="apps">Apps</button>
      <button class="mkt-scope${adminTab === "reviews" ? " active" : ""}" data-atab="reviews">Flagged reviews</button>
      <button class="mkt-scope${adminTab === "dev-reviews" ? " active" : ""}" data-atab="dev-reviews">Flagged developer reviews</button>
    </div>
    <div id="mkt-admin-body"><div class="crud-empty">Loading…</div></div>`;

  el.querySelector(".mkt-back")?.addEventListener("click", () => showMktView("store"));
  el.querySelectorAll<HTMLButtonElement>("[data-atab]").forEach((b) => {
    b.addEventListener("click", () => {
      adminTab = b.dataset.atab as AdminTab;
      el.querySelectorAll("[data-atab]").forEach((x) => x.classList.toggle("active", x === b));
      void loadAdminTab();
    });
  });
  void loadAdminTab();
}

function adminBody(): HTMLElement | null {
  return document.getElementById("mkt-admin-body");
}

async function loadAdminTab(): Promise<void> {
  const body = adminBody();
  if (!body) return;
  body.innerHTML = `<div class="crud-empty">Loading…</div>`;
  try {
    if (adminTab === "queue") await renderQueue(body);
    else if (adminTab === "library") await renderLibraryQueue(body);
    else if (adminTab === "reports") await renderReports(body);
    else if (adminTab === "apps") await renderAdminApps(body);
    else if (adminTab === "reviews") await renderFlagged(body, "app");
    else await renderFlagged(body, "dev");
  } catch (err) {
    body.innerHTML = `<div class="crud-empty">${escMkt(err instanceof Error ? err.message : "Couldn't load the desk.")}</div>`;
  }
}

// ── Library queue (skills + loops, his order 2026-09-02) ──────────────────
// Same shape as releases: submitted → begin → approve/reject. The frozen
// content snapshot (prompt + program) IS what's being ruled on — it renders
// inline so the reviewer reads exactly what an install will copy.

async function renderLibraryQueue(body: HTMLElement): Promise<void> {
  const res = await window.glyphh.libraryAdminQueue?.();
  const queue = res?.ok ? res.queue : [];
  if (!queue.length) {
    body.innerHTML = `<div class="crud-empty">No skills or loops waiting for review.</div>`;
    return;
  }
  body.innerHTML = "";
  for (const l of queue) {
    const row = document.createElement("div");
    row.className = "mkt-admin-row";
    row.innerHTML = `
      <div class="mkt-admin-row-head">
        <b></b>
        <span class="lib-badge">${l.kind === "skill" ? "Skill" : "Loop"}</span>
        <span class="mkt-console-app-sub"></span>
        <span style="flex:1;"></span>
        <span class="mkt-console-app-sub">${escMkt(mktDate(l.submittedAt))}${l.submittedBy ? ` · ${escMkt(l.submittedBy)}` : ""}</span>
      </div>
      <p class="mkt-console-app-sub" style="margin:4px 0 8px;"></p>
      ${l.prompt ? `<details style="margin:0 0 8px;"><summary style="cursor:pointer;font-size:12px;color:var(--text-3);">Instructions</summary><pre class="lib-read-code" style="white-space:pre-wrap;"></pre></details>` : ""}
      ${l.code ? `<details style="margin:0 0 8px;"><summary style="cursor:pointer;font-size:12px;color:var(--text-3);">Program</summary><pre class="lib-read-code"></pre></details>` : ""}
      <div style="display:flex;gap:8px;">
        <button type="button" class="action-btn lq-reject" style="height:26px;font-size:12px;">Reject</button>
        <button type="button" class="action-btn primary lq-approve" style="height:26px;font-size:12px;">Approve &amp; list</button>
      </div>
      <div class="crud-form-error hidden lq-err" style="margin-top:6px;"></div>`;
    (row.querySelector(".mkt-admin-row-head b") as HTMLElement).textContent = l.name;
    (row.querySelector(".mkt-admin-row-head .mkt-console-app-sub") as HTMLElement).textContent = l.slug;
    (row.querySelector("p") as HTMLElement).textContent = l.description || "";
    const pres = row.querySelectorAll("details pre");
    if (l.prompt && pres[0]) (pres[0] as HTMLElement).textContent = l.prompt;
    if (l.code) ((l.prompt ? pres[1] : pres[0]) as HTMLElement | undefined)?.append(l.code);
    const rule = async (action: "approve" | "reject"): Promise<void> => {
      const r = await window.glyphh.libraryAdminReview?.(l.id, action);
      const err = row.querySelector(".lq-err") as HTMLElement;
      if (!r?.ok) { err.textContent = r?.error || `Couldn't ${action}.`; err.classList.remove("hidden"); return; }
      await renderLibraryQueue(body);
    };
    row.querySelector(".lq-approve")!.addEventListener("click", () => void rule("approve"));
    row.querySelector(".lq-reject")!.addEventListener("click", () => void rule("reject"));
    body.appendChild(row);
  }
}

// ── Release queue ─────────────────────────────────────────────────────────

async function renderQueue(body: HTMLElement): Promise<void> {
  const { releases } = await mkt.adminQueue();
  if (!releases.length) {
    body.innerHTML = `<div class="crud-empty">The queue is clear — nothing waiting for review.</div>`;
    return;
  }
  body.innerHTML = `<input id="mq-search" class="settings-input" type="text" placeholder="Filter the queue — app, slug, version…" spellcheck="false" style="max-width:340px;margin:0 0 12px;" />` +
    releases.map((r: MktQueueRelease) => `
    <div class="mkt-admin-row" data-id="${escMkt(r.id)}">
      <div class="mkt-admin-row-head">
        <button class="mkt-admin-app-link" type="button" data-slug="${escMkt(r.appSlug)}"><b>${escMkt(r.appName)}</b> <span class="mkt-console-app-sub">${escMkt(r.appSlug)}</span></button>
        <span class="release-version">v${escMkt(r.version)}</span>
        <span class="mkt-review-chip ${r.reviewStatus}">${r.reviewStatus === "in_review" ? "In review" : "Submitted"}</span>
        <span class="release-date">submitted ${escMkt(mktDate(r.submittedAt))}</span>
        <span style="flex:1;"></span>
        <button class="action-btn mq-source" type="button" data-id="${escMkt(r.id)}">Source</button>
        ${r.reviewStatus === "submitted" ? `<button class="action-btn mq-begin" type="button" data-id="${escMkt(r.id)}">Begin review</button>` : ""}
        <button class="action-btn primary mq-approve" type="button" data-id="${escMkt(r.id)}">Approve</button>
        <button class="action-btn danger mq-reject" type="button" data-id="${escMkt(r.id)}">Reject…</button>
      </div>
      ${r.submitNote ? `<div class="mkt-review-notes"><b>Note to reviewers:</b> ${escMkt(r.submitNote.slice(0, 600))}</div>` : ""}
      ${r.notes ? `<div class="mkt-review-notes"><b>Release notes:</b> ${escMkt(r.notes.slice(0, 400))}</div>` : ""}
      ${r.reviewRecommendations ? `
        <div class="mq-recs">
          <div class="mq-recs-head"><b>Review agent:</b> ${escMkt(r.reviewRecommendations.summary.slice(0, 600))}</div>
          <ul class="mq-recs-list">${r.reviewRecommendations.items.map((it) => `
            <li><span class="mkt-review-chip ${it.severity === "critical" ? "rejected" : it.severity === "warning" ? "in_review" : ""}">${escMkt(it.severity)}</span> <b>${escMkt(it.area)}</b> — ${escMkt(it.note)}</li>`).join("")}
          </ul>
          <button class="action-btn primary mq-acceptapprove" type="button" data-id="${escMkt(r.id)}">Accept & approve</button>
          <button class="action-btn mq-sendback" type="button" data-id="${escMkt(r.id)}">Accept recommendations & send back…</button>
        </div>` : ""}
      <div class="mq-source-host hidden"></div>
    </div>`).join("");

  // Queue filter (his rule, 2026-08-20).
  body.querySelector<HTMLInputElement>("#mq-search")?.addEventListener("input", (e) => {
    const q = (e.currentTarget as HTMLInputElement).value.trim().toLowerCase();
    body.querySelectorAll<HTMLElement>(".mkt-admin-row").forEach((row) => {
      row.classList.toggle("hidden", !!q && !row.textContent!.toLowerCase().includes(q));
    });
  });
  body.querySelectorAll<HTMLButtonElement>(".mkt-admin-app-link").forEach((b) => {
    b.addEventListener("click", () => void openMktDetail(b.dataset.slug!));
  });
  // SOURCE VIEWER (review policy): the submitted archive, tree + file pane.
  body.querySelectorAll<HTMLButtonElement>(".mq-source").forEach((b) => {
    b.addEventListener("click", async () => {
      const row = b.closest(".mkt-admin-row") as HTMLElement;
      const host = row.querySelector<HTMLElement>(".mq-source-host")!;
      if (!host.classList.toggle("hidden")) {
        if (host.dataset.loaded) return;
        host.dataset.loaded = "1";
        host.innerHTML = `<div class="inline-empty">Loading the archive…</div>`;
        try {
          const { files } = await mkt.adminSourceTree(b.dataset.id!);
          host.innerHTML = `
            <div class="mq-src">
              <div class="mq-src-tree">${files.map((f) => `<button class="mq-src-row" type="button" data-path="${escMkt(f.path)}"><span>${escMkt(f.path)}</span><i>${(f.size / 1024).toFixed(1)}k</i></button>`).join("") || `<div class="inline-empty">Empty archive.</div>`}</div>
              <pre class="mq-src-view"><span class="inline-empty">Pick a file.</span></pre>
            </div>`;
          const view = host.querySelector<HTMLElement>(".mq-src-view")!;
          host.querySelectorAll<HTMLButtonElement>(".mq-src-row").forEach((fb) => {
            fb.addEventListener("click", async () => {
              host.querySelectorAll(".mq-src-row").forEach((x) => x.classList.toggle("active", x === fb));
              view.textContent = "Loading…";
              try {
                const f = await mkt.adminSourceFile(b.dataset.id!, fb.dataset.path!);
                view.textContent = f.content;
              } catch (e) { view.textContent = (e as Error).message; }
            });
          });
        } catch (e) {
          host.innerHTML = `<div class="inline-empty">${escMkt((e as Error).message)}</div>`;
        }
      }
    });
  });
  // ACCEPT & APPROVE: promote live AND share the recommendations — advisory
  // feedback riding the green light.
  body.querySelectorAll<HTMLButtonElement>(".mq-acceptapprove").forEach((b) => {
    b.addEventListener("click", async () => {
      const r = releases.find((x) => x.id === b.dataset.id);
      const confirmed = await confirmAction({
        title: `Approve ${r?.appName ?? "this release"} v${r?.version ?? ""} and share the recommendations?`,
        body: "Approval promotes it LIVE, and the author also receives the review recommendations as advisory feedback.",
        confirmLabel: "Approve & share",
      });
      if (!confirmed) return;
      b.disabled = true;
      const res = await mkt.adminReview(b.dataset.id!, "approve", undefined, true);
      if (res.ok) void loadAdminTab();
      else { b.disabled = false; note(res.error); }
    });
  });
  // SEND-BACK: accept the agent's recommendations → reject + share, verbatim.
  body.querySelectorAll<HTMLButtonElement>(".mq-sendback").forEach((b) => {
    b.addEventListener("click", async () => {
      const r = releases.find((x) => x.id === b.dataset.id);
      const notes = await promptAction(
        "Send back with the agent's recommendations — the author sees them verbatim. Add a note of your own (optional).",
        r?.reviewRecommendations?.summary ?? "",
        "Anything to add…",
        "Send back",
      );
      if (notes === null) return;
      b.disabled = true;
      const res = await mkt.adminReview(b.dataset.id!, "reject", (notes || r?.reviewRecommendations?.summary || "See the attached recommendations.").trim(), true);
      if (res.ok) void loadAdminTab();
      else { b.disabled = false; note(res.error); }
    });
  });
  body.querySelectorAll<HTMLButtonElement>(".mq-begin").forEach((b) => {
    b.addEventListener("click", async () => {
      b.disabled = true;
      const res = await mkt.adminReview(b.dataset.id!, "begin");
      if (res.ok) void loadAdminTab();
      else { b.disabled = false; note(res.error); }
    });
  });
  body.querySelectorAll<HTMLButtonElement>(".mq-approve").forEach((b) => {
    b.addEventListener("click", async () => {
      const r = releases.find((x) => x.id === b.dataset.id);
      const confirmed = await confirmAction({
        title: `Approve ${r?.appName ?? "this release"} v${r?.version ?? ""}?`,
        body: "Approval promotes it LIVE — this exact build is what installers get from now on.",
        confirmLabel: "Approve & promote",
      });
      if (!confirmed) return;
      b.disabled = true;
      const res = await mkt.adminReview(b.dataset.id!, "approve");
      if (res.ok) void loadAdminTab();
      else { b.disabled = false; note(res.error); }
    });
  });
  body.querySelectorAll<HTMLButtonElement>(".mq-reject").forEach((b) => {
    b.addEventListener("click", async () => {
      const notes = await promptAction("Reject with notes — the author reads exactly this.", "", "What must change before resubmission…", "Reject");
      if (!notes?.trim()) return;
      b.disabled = true;
      const res = await mkt.adminReview(b.dataset.id!, "reject", notes.trim());
      if (res.ok) void loadAdminTab();
      else { b.disabled = false; note(res.error); }
    });
  });
}

// ── Admin app search: find ANY app; suspend (with a comment) / unsuspend ──

async function renderAdminApps(body: HTMLElement, q = ""): Promise<void> {
  const res = await mkt.adminAppSearch(q).catch(() => ({ apps: [] }));
  body.innerHTML = `
    <input id="ma-search" class="settings-input" type="text" placeholder="Search every app — name, slug, or publisher org…" value="${escMkt(q)}" spellcheck="false" style="max-width:380px;margin:0 0 12px;" />
    ${res.apps.length ? res.apps.map((a) => `
      <div class="mkt-admin-row" data-slug="${escMkt(a.slug)}">
        <div class="mkt-admin-row-head">
          <button class="mkt-admin-app-link" type="button" data-slug="${escMkt(a.slug)}"><b>${escMkt(a.name)}</b> <span class="mkt-console-app-sub">${escMkt(a.slug)}</span></button>
          <span class="mkt-console-app-sub">${escMkt(a.publisherOrg || "—")} · ${a.installs} install${a.installs === 1 ? "" : "s"}</span>
          <span class="mkt-listed-chip ${a.listed ? "on" : ""}">${a.listed ? "Listed" : "Not listed"}</span>
          ${a.suspended ? `<span class="mkt-review-chip rejected">Suspended</span>` : ""}
          <span style="flex:1;"></span>
          ${a.suspended
            ? `<button class="action-btn ma-unsuspend" type="button" data-slug="${escMkt(a.slug)}">Unsuspend</button>`
            : `<button class="action-btn danger ma-suspend" type="button" data-slug="${escMkt(a.slug)}">Take offline…</button>`}
        </div>
        ${a.suspended && a.suspendReason ? `<div class="mkt-review-notes"><b>Suspension reason:</b> ${escMkt(a.suspendReason)}</div>` : ""}
      </div>`).join("") : `<div class="crud-empty">${q ? "No apps match." : "Type to search every app on the platform."}</div>`}`;

  let t = 0;
  const search = body.querySelector<HTMLInputElement>("#ma-search")!;
  search.addEventListener("input", () => {
    window.clearTimeout(t);
    t = window.setTimeout(() => { void renderAdminApps(body, search.value.trim()).then(() => body.querySelector<HTMLInputElement>("#ma-search")?.focus()); }, 350);
  });
  body.querySelectorAll<HTMLButtonElement>(".mkt-admin-app-link").forEach((b) => {
    b.addEventListener("click", () => void openMktDetail(b.dataset.slug!));
  });
  // TAKE OFFLINE with a comment the developer reads on their listing.
  body.querySelectorAll<HTMLButtonElement>(".ma-suspend").forEach((b) => {
    b.addEventListener("click", async () => {
      const reason = await promptAction(
        `Take ${b.dataset.slug} offline — the developer reads exactly this on their listing.`,
        "", "Why it's coming down and what must change…", "Take offline");
      if (!reason?.trim()) return;
      b.disabled = true;
      const r = await mkt.adminSuspend(b.dataset.slug!, true, reason.trim());
      if (r.ok) void renderAdminApps(body, q);
      else { b.disabled = false; note(r.error); }
    });
  });
  body.querySelectorAll<HTMLButtonElement>(".ma-unsuspend").forEach((b) => {
    b.addEventListener("click", async () => {
      b.disabled = true;
      const r = await mkt.adminSuspend(b.dataset.slug!, false);
      if (r.ok) void renderAdminApps(body, q);
      else { b.disabled = false; note(r.error); }
    });
  });
}

// ── App reports ───────────────────────────────────────────────────────────

async function renderReports(body: HTMLElement): Promise<void> {
  const { reports } = await mkt.adminReports(reportFilter);
  const filters: Array<{ id: typeof reportFilter; label: string }> = [
    { id: undefined, label: "Open + reviewing" },
    { id: "resolved", label: "Resolved" },
    { id: "dismissed", label: "Dismissed" },
  ];
  const filterBar = `<div class="mkt-categories" style="margin:0 0 12px;">${filters.map((f) =>
    `<button class="mkt-cat${reportFilter === f.id ? " active" : ""}" data-rf="${f.id ?? ""}">${f.label}</button>`).join("")}</div>`;

  body.innerHTML = filterBar + (reports.length ? reports.map((r: MktReport) => `
    <div class="mkt-admin-row" data-id="${escMkt(r.id)}">
      <div class="mkt-admin-row-head">
        ${r.appSlug
          ? `<button class="mkt-admin-app-link" type="button" data-slug="${escMkt(r.appSlug)}"><b>${escMkt(r.appName || r.appSlug)}</b> <span class="mkt-console-app-sub">${escMkt(r.appSlug)}</span></button>`
          : `<b>${escMkt(r.appName || "(app deleted)")}</b>`}
        <span class="mkt-review-chip ${r.status === "open" ? "rejected" : r.status === "reviewing" ? "in_review" : "approved"}">${escMkt(r.status)}</span>
        <span class="release-date">${escMkt(mktDate(r.createdAt))}</span>
        <span style="flex:1;"></span>
        ${r.status === "open" ? `<button class="action-btn mr-claim" type="button" data-id="${escMkt(r.id)}">Claim</button>` : ""}
        ${r.status === "open" || r.status === "reviewing" ? `
          ${r.appSlug ? `<button class="action-btn danger mr-suspend" type="button" data-slug="${escMkt(r.appSlug)}">Suspend app</button>` : ""}
          <button class="action-btn primary mr-resolve" type="button" data-id="${escMkt(r.id)}">Resolve</button>
          <button class="action-btn mr-dismiss" type="button" data-id="${escMkt(r.id)}">Dismiss</button>` : ""}
      </div>
      <div class="mkt-review-notes"><b>${escMkt(r.reason)}</b>${r.detail ? ` — ${escMkt(r.detail)}` : ""}</div>
    </div>`).join("") : `<div class="crud-empty">No reports here.</div>`);

  body.querySelectorAll<HTMLButtonElement>("[data-rf]").forEach((b) => {
    b.addEventListener("click", () => {
      reportFilter = (b.dataset.rf || undefined) as typeof reportFilter;
      void loadAdminTab();
    });
  });
  body.querySelectorAll<HTMLButtonElement>(".mkt-admin-app-link").forEach((b) => {
    b.addEventListener("click", () => void openMktDetail(b.dataset.slug!));
  });
  const act = (sel: string, run: (id: string) => Promise<{ ok: boolean; error?: string } | { ok: true; data: unknown } | { ok: false; error: string }>) => {
    body.querySelectorAll<HTMLButtonElement>(sel).forEach((b) => {
      b.addEventListener("click", async () => {
        b.disabled = true;
        const res = await run(b.dataset.id!);
        if (res.ok) void loadAdminTab();
        else { b.disabled = false; note(("error" in res && res.error) || "Request failed"); }
      });
    });
  };
  act(".mr-claim", (id) => mkt.adminResolveReport(id, "reviewing"));
  act(".mr-resolve", async (id) => {
    const confirmed = await confirmAction({
      title: "Resolve this report?",
      body: "Resolve = the report was valid and has been acted on (suspension, takedown, or a fix).",
      confirmLabel: "Resolve",
    });
    return confirmed ? mkt.adminResolveReport(id, "resolved") : { ok: false, error: "" };
  });
  act(".mr-dismiss", async (id) => {
    const confirmed = await confirmAction({
      title: "Dismiss this report?",
      body: "Dismiss = reviewed and found not actionable.",
      confirmLabel: "Dismiss",
    });
    return confirmed ? mkt.adminResolveReport(id, "dismissed") : { ok: false, error: "" };
  });
  body.querySelectorAll<HTMLButtonElement>(".mr-suspend").forEach((b) => {
    b.addEventListener("click", async () => {
      const confirmed = await confirmAction({
        title: `Suspend ${b.dataset.slug}?`,
        body: "One click: hidden from browse and uninstallable immediately. Existing installs keep running. Lift it from the listing page.",
        confirmLabel: "Suspend",
        danger: true,
      });
      if (!confirmed) return;
      b.disabled = true;
      const res = await mkt.adminSuspend(b.dataset.slug!, true);
      if (res.ok) note(`${b.dataset.slug} suspended.`);
      else { b.disabled = false; note(res.error); }
    });
  });
}

// ── Flagged reviews (app + developer) ─────────────────────────────────────

async function renderFlagged(body: HTMLElement, kind: "app" | "dev"): Promise<void> {
  const { reviews } = kind === "app" ? await mkt.adminFlaggedReviews() : await mkt.adminFlaggedDevReviews();
  if (!reviews.length) {
    body.innerHTML = `<div class="crud-empty">No flagged ${kind === "app" ? "app" : "developer"} reviews.</div>`;
    return;
  }
  body.innerHTML = reviews.map((r: MktFlaggedReview) => `
    <div class="mkt-admin-row" data-id="${escMkt(r.id)}">
      <div class="mkt-admin-row-head">
        ${kind === "app"
          ? `<button class="mkt-admin-app-link" type="button" data-slug="${escMkt(r.appSlug || "")}"><b>${escMkt(r.appSlug || "?")}</b></button>`
          : `<button class="mkt-admin-app-link" type="button" data-handle="${escMkt(r.developerHandle || "")}"><b>@${escMkt(r.developerHandle || "?")}</b></button>`}
        ${mktStarRow(r.stars)}
        <span class="release-date">flagged ${escMkt(mktDate(r.reportedAt))}</span>
        <span style="flex:1;"></span>
        <button class="action-btn mf-restore" type="button" data-id="${escMkt(r.id)}">Restore</button>
        <button class="action-btn danger mf-remove" type="button" data-id="${escMkt(r.id)}">Remove</button>
      </div>
      ${r.body ? `<p class="mkt-review-body">${escMkt(r.body)}</p>` : ""}
      <div class="mkt-review-notes"><b>Report:</b> ${escMkt(r.reportReason || "(no reason given)")} · by ${escMkt(r.authorName || "a member")}</div>
    </div>`).join("");

  body.querySelectorAll<HTMLButtonElement>(".mkt-admin-app-link").forEach((b) => {
    b.addEventListener("click", () => {
      if (b.dataset.slug) void openMktDetail(b.dataset.slug);
      else if (b.dataset.handle) void openMktDeveloper(b.dataset.handle);
    });
  });
  const moderate = (sel: string, action: "restore" | "remove") => {
    body.querySelectorAll<HTMLButtonElement>(sel).forEach((b) => {
      b.addEventListener("click", async () => {
        if (action === "remove") {
          const confirmed = await confirmAction({
            title: "Remove this review from readers?",
            body: "It disappears from the listing and stops counting toward the rating. The audit trail keeps it.",
            confirmLabel: "Remove",
            danger: true,
          });
          if (!confirmed) return;
        }
        b.disabled = true;
        const res = kind === "app"
          ? await mkt.adminModerateReview(b.dataset.id!, action)
          : await mkt.adminModerateDevReview(b.dataset.id!, action);
        if (res.ok) void loadAdminTab();
        else { b.disabled = false; note(res.error); }
      });
    });
  };
  moderate(".mf-restore", "restore");
  moderate(".mf-remove", "remove");
}
