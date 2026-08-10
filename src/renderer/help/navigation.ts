/**
 * Help overlay — open/close, section switching, nav wiring.
 */

import { closeHelp, getHelpOverlay, getHelpTransitioning, setHelpTransitioning, guardWebviewsForModal } from "./shared.js";
import { hidePanelsForModal, restorePanelsForModal } from "../yo-modal.js";
import { loadDashboard, initDashboardEvents } from "./dashboard.js";
import { loadLayouts, initLayoutsEvents } from "./layouts.js";
import { loadApps, initApps } from "./apps.js";
import { loadSettings, initSettings, loadBilling, loadProfile, loadOrg, loadMembers, loadWorkspacesPanel } from "./settings.js";
import { loadDrips, initDripsEvents } from "./drips.js";
import { loadLoops, initLoopsEvents } from "./loops.js";
import { loadSkillsLibrary, initSkillsLibraryEvents } from "./skills-library.js";
import { loadAgents, initAgentsEvents } from "./agents.js";
import { initSkills } from "./skills.js";
import { loadCode, initCode, wireGlobalDotCommands } from "./code.js";
import { loadConnections, initConnections } from "./connections.js";
import { loadDocs, loadSupport, loadAbout } from "./docs.js";
import { loadModelsAdmin } from "./models-admin.js";

const overlay = getHelpOverlay();
const sections = document.querySelectorAll<HTMLDivElement>(".help-section");

// ── Open / close ─────────────────────────────────────────

export function openHelp() {
  if (getHelpTransitioning()) return;
  setHelpTransitioning(true);
  setTimeout(() => { setHelpTransitioning(false); }, 300);
  window.glyphh.panelsHide();
  overlay.classList.remove("hidden");
  window.glyphh.refreshAuth().catch(() => {});
  loadActiveSection();
}

export function openSettings(sub?: string) {
  // Settings is a modal overlay now — it no longer swaps the workbench for a
  // full-page section. The user-menu "Settings"/"Account" and every deep link
  // land here.
  openSettingsModal(sub);
}

export function isHelpOpen(): boolean {
  return !overlay.classList.contains("hidden");
}

// ── Navigation ───────────────────────────────────────────

export function resetEditors() {
  const le = document.getElementById("layout-editor");
  if (le && !le.classList.contains("hidden")) {
    le.classList.add("hidden");
    document.getElementById("layouts-list")?.classList.remove("hidden");
    document.getElementById("layouts-toolbar")?.classList.remove("hidden");
  }
  const re = document.getElementById("rip-editor");
  if (re && !re.classList.contains("hidden")) {
    re.classList.add("hidden");
    document.getElementById("rips-list")?.classList.remove("hidden");
    document.getElementById("rips-toolbar")?.classList.remove("hidden");
  }
  const de = document.getElementById("drip-editor");
  if (de && !de.classList.contains("hidden")) {
    de.classList.add("hidden");
    document.getElementById("drips-list")?.classList.remove("hidden");
    document.getElementById("drips-toolbar")?.classList.remove("hidden");
  }
  const ad = document.getElementById("app-detail");
  if (ad && !ad.classList.contains("hidden")) {
    ad.classList.add("hidden");
    document.getElementById("apps-list")?.classList.remove("hidden");
    document.getElementById("apps-toolbar")?.classList.remove("hidden");
    const preview = document.getElementById("app-preview") as HTMLElement & { src: string } | null;
    if (preview) preview.src = "about:blank";
  }
  const af = document.getElementById("app-add-form");
  if (af && !af.classList.contains("hidden")) {
    af.classList.add("hidden");
    document.getElementById("apps-list")?.classList.remove("hidden");
    document.getElementById("apps-toolbar")?.classList.remove("hidden");
  }
}


function activeSection(): string {
  // The rail's single source of section truth — set by switchToSection.
  return document.body.dataset.railSection || "guide";
}

export function loadActiveSection(explicit?: string) {
  const sec = explicit || activeSection();
  if (sec === "dashboard") void loadDashboard();
  else if (sec === "loops") void loadLoops();
  else if (sec === "skills") void loadSkillsLibrary();
  else if (sec === "agents") void loadAgents();
  else if (sec === "layouts") loadLayouts();
  else if (sec === "apps") loadApps();
  else if (sec === "code") loadCode();
  else if (sec === "connections") void loadConnections();
  else if (sec === "settings") loadSettings();
  else if (sec === "docs") loadDocs();
  else if (sec === "support") loadSupport();
}

/**
 * Navigate to a section (and optional sub-panel). Driven by the app's
 * left-rail nav; `body.dataset.railSection` is the single source of section
 * truth. (The old #help-nav sidebar — hidden but load-bearing — is deleted.)
 */
export function gotoSection(section: string, sub?: string): void {
  const moved = SECTION_ALIAS[section];
  if (moved) { section = moved.section; sub = sub || moved.sub; }
  // Settings is a MODAL now — intercept before the workbench section swap so
  // the user-menu item, the "models" alias, and any deep link all open the
  // overlay instead of replacing the workspace with a full-page section.
  if (section === "settings") {
    void window.glyphh.setPreference?.("homeLastSection", "settings");
    void window.glyphh.setPreference?.("homeLastSub", sub || "");
    openSettingsModal(sub);
    return;
  }
  // Docs lives INSIDE the settings modal now (a "docs" sub-panel), not its own
  // full-page section — open the modal on it and apply the optional topic.
  if (section === "docs") {
    void window.glyphh.setPreference?.("homeLastSection", "settings");
    void window.glyphh.setPreference?.("homeLastSub", "docs");
    openSettingsModal("docs");
    if (sub) showDocPanel(sub);
    return;
  }
  // Content sections need the window body — if Glyphh is collapsed to the
  // rail, expand it (the workspace apps slide back right).
  if (["apps", "connections", "layouts", "settings"].includes(section)) {
    void window.glyphh.railCollapseSet?.(false);
  }
  void window.glyphh.setPreference?.("homeLastSection", section);
  void window.glyphh.setPreference?.("homeLastSub", sub || "");
  // 2.5.0 shell: every section IS a workbench panel — opening one replaces
  // the workspace with just that panel; "code" is the agent surface. The
  // loader runs via __wbSectionLoad once the panel's DOM mounts.
  resetEditors();
  document.body.dataset.railSection = section;
  const w = window as unknown as { __initCodeWorkbench?: () => void; __wbOpenSection?: (s: string) => void };
  w.__initCodeWorkbench?.();
  let tries = 0;
  const go = (): void => {
    if (w.__wbOpenSection) w.__wbOpenSection(section);
    else if (tries++ < 40) { requestAnimationFrame(go); return; }
    // Settings and docs return early above (both open as the settings modal);
    // no remaining section here carries a deep-link sub through the workbench.
  };
  go();
}

// ── Settings modal ───────────────────────────────────────
//
// Settings is a centered modal overlay (A1), not a full-page workbench
// section. The two-column .settings-layout DOM is MOVED out of its hidden
// .help-section pen into the modal on open and moved back on close — so the
// panels keep their exact ids/classes and every existing loader (billing,
// members, workspaces, models, …) and the admin-only role-gating work
// untouched wherever the layout currently lives.

/** The layout's resting place — the section it lives in when the modal is
 *  closed. Captured on first open so it can be parked back precisely. */
let settingsHomePen: HTMLElement | null = null;
let settingsModalWebviewsGuarded = false;
let settingsModalPanelsHidden = false;

function selectSettingsSub(sub: string): void {
  const target = settingsSubAlias(sub);
  const navBtns = document.querySelectorAll<HTMLButtonElement>(".settings-nav .settings-nav-item");
  const panels = document.querySelectorAll<HTMLDivElement>(".settings-panels .settings-panel");
  navBtns.forEach((n) => n.classList.toggle("active", n.dataset.sub === target));
  panels.forEach((p) => p.classList.toggle("active", p.dataset.sub === target));
  const panelsWrap = document.querySelector<HTMLElement>(".settings-modal-body .settings-panels");
  if (panelsWrap) panelsWrap.scrollTop = 0;
  // A deep link must POPULATE the panel too — an empty Billing page because
  // nobody clicked the tab is the same bug as not loading it.
  loadSettingsSub(target);
}

export function isSettingsModalOpen(): boolean {
  return !!document.getElementById("settings-modal");
}

export function closeSettingsModal(): void {
  const overlay = document.getElementById("settings-modal");
  if (!overlay) return;
  document.removeEventListener("keydown", onSettingsModalKey, true);
  // Park the adopted docs body back in its own hidden section FIRST, so the
  // settings layout below doesn't carry it back into the settings pen.
  parkSettingsDocs();
  // Park the shared .settings-layout DOM back in its hidden section pen so its
  // ids stay unique and it's ready to be re-adopted next open.
  const layout = overlay.querySelector<HTMLElement>(".settings-modal-body > .settings-layout");
  if (layout && settingsHomePen) settingsHomePen.appendChild(layout);
  overlay.remove();
  if (settingsModalWebviewsGuarded) { guardWebviewsForModal(false); settingsModalWebviewsGuarded = false; }
  restorePanelsForModal(settingsModalPanelsHidden);
  settingsModalPanelsHidden = false;
  try { window.glyphh.panelsShow?.(); } catch { /* */ }
}

function onSettingsModalKey(e: KeyboardEvent): void {
  if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); closeSettingsModal(); }
}

export function openSettingsModal(sub?: string): void {
  // Already open — just switch the sub-panel.
  if (isSettingsModalOpen()) { selectSettingsSub(sub || "general"); return; }

  const layout = document.querySelector<HTMLElement>(
    ".help-section[data-section='settings'] > .settings-layout") ??
    document.querySelector<HTMLElement>(".settings-nav:not(.docs-nav)")?.closest<HTMLElement>(".settings-layout") ??
    null;
  if (!layout) return;
  // Remember where the layout lives so it can be parked back on close.
  settingsHomePen = layout.parentElement as HTMLElement | null;

  // Freeze the workbench's <webview> panels — they composite ABOVE page HTML in
  // Electron, so without this the modal renders underneath the open apps and
  // can't be seen or clicked. Same guard the confirm/prompt modals use. The
  // capture-based freeze-frame is a best-effort extra for any legacy panels.
  guardWebviewsForModal(true);
  settingsModalWebviewsGuarded = true;
  void hidePanelsForModal().then((hidden) => { settingsModalPanelsHidden = hidden; });

  const overlay = document.createElement("div");
  overlay.id = "settings-modal";
  overlay.className = "yo-modal yo-settings-modal";

  const backdrop = document.createElement("div");
  backdrop.className = "yo-modal-backdrop";
  backdrop.addEventListener("click", () => closeSettingsModal());

  const panel = document.createElement("div");
  panel.className = "yo-modal-panel settings-modal-panel";
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-modal", "true");
  panel.setAttribute("aria-label", "Settings");

  const closeBtn = document.createElement("button");
  closeBtn.type = "button";
  closeBtn.className = "settings-modal-close";
  closeBtn.setAttribute("aria-label", "Close settings");
  closeBtn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>`;
  closeBtn.addEventListener("click", () => closeSettingsModal());

  const body = document.createElement("div");
  body.className = "settings-modal-body";
  // Adopt the real two-column layout — same nodes, so every loader + the
  // admin-only nav gating keep working exactly as before.
  body.appendChild(layout);

  panel.appendChild(closeBtn);
  panel.appendChild(body);
  overlay.appendChild(backdrop);
  overlay.appendChild(panel);
  document.body.appendChild(overlay);

  document.addEventListener("keydown", onSettingsModalKey, true);

  // Populate the whole panel set + admin gating, then reveal the requested sub.
  loadSettings();
  selectSettingsSub(sub || "general");
}

/**
 * Retired sub-panels, pointed at wherever they went. A saved nav app or a
 * remembered `homeLastSub` that names "organization" must still land somewhere
 * — without this, every nav item and panel deactivates and Settings opens
 * blank.
 */
const SETTINGS_SUB_ALIAS: Record<string, string> = { organization: "account" };

/** Retired top-level sections, redirected to the Settings sub-panel that
 *  absorbed them — a rail item or `homeLastSection` naming "models" must not
 *  open a section that no longer exists. */
const SECTION_ALIAS: Record<string, { section: string; sub: string }> = {
  models: { section: "settings", sub: "models" },
};
const settingsSubAlias = (sub: string): string => SETTINGS_SUB_ALIAS[sub] || sub;

/** Settings sub-panels that fetch on show. Shared by the sub-nav click handler
 *  and gotoSection's deep-link path so both populate identically. */
function loadSettingsSub(sub: string): void {
  if (sub === "support") loadSupport();
  else if (sub === "about") loadAbout();
  else if (sub === "drips") loadDrips();
  else if (sub === "billing") void loadBilling();
  // Organization is a section INSIDE Account now (org admins only), so it
  // loads with the profile rather than from a tab of its own.
  else if (sub === "account") { void loadProfile(); void loadOrg(); }
  else if (sub === "members") void loadMembers();
  else if (sub === "workspaces") void loadWorkspacesPanel();
  else if (sub === "models") loadModelsAdmin();
  else if (sub === "docs") { mountSettingsDocs(); loadDocs(); }
}

// ── Docs-in-modal adoption ───────────────────────────────
//
// Docs opens as a sub-panel of the settings modal rather than its own
// full-page section. Its body (the topics nav + content from sections/docs.html)
// is MOVED into the settings docs panel on show and parked back into its hidden
// .help-section on close — same move-not-clone discipline as .settings-layout,
// so its ids stay unique and loadDocs + the docs sub-nav bind unchanged.

/** Where the docs body lives when NOT adopted into the modal — captured on
 *  first mount so it can be parked back precisely. */
let docsHomePen: HTMLElement | null = null;

/** The docs body element — the inner two-column layout of the docs section. */
function docsBody(): HTMLElement | null {
  return document.querySelector<HTMLElement>(
    ".help-section[data-section='docs'] > .settings-layout") ??
    document.querySelector<HTMLElement>("#settings-docs-host > .settings-layout") ??
    document.querySelector<HTMLElement>(".docs-nav")?.closest<HTMLElement>(".settings-layout") ??
    null;
}

function mountSettingsDocs(): void {
  const host = document.getElementById("settings-docs-host");
  const body = docsBody();
  if (!host || !body) return;
  if (body.parentElement === host) return; // already adopted
  docsHomePen = body.parentElement as HTMLElement | null;
  host.appendChild(body);
}

function parkSettingsDocs(): void {
  const host = document.getElementById("settings-docs-host");
  const body = host?.querySelector<HTMLElement>(".settings-layout");
  if (body && docsHomePen) docsHomePen.appendChild(body);
}

// ── Docs inner sub-navigation ────────────────────────────

const docsSubNav = document.querySelectorAll<HTMLButtonElement>(".docs-nav .settings-nav-item");
const docsPanels = document.querySelectorAll<HTMLDivElement>(".docs-panel");

function showDocPanel(docId: string) {
  docsSubNav.forEach((n) => n.classList.toggle("active", n.dataset.doc === docId));
  docsPanels.forEach((p) => p.classList.toggle("active", p.dataset.doc === docId));
  const container = document.querySelector(".docs-panels");
  if (container) container.scrollTop = 0;
}

// ── Init ─────────────────────────────────────────────────

export function initHelp() {
  document.getElementById("help-close")?.addEventListener("click", closeHelp);

  // The workbench bundle can't import help modules — it calls this bridge
  // after mounting a section panel so the section's data actually loads.
  (window as unknown as { __wbSectionLoad?: (s: string) => void }).__wbSectionLoad =
    (section: string) => loadActiveSection(section);
  // The header's Glyphh mark opens the coding agent full screen.
  document.querySelector<HTMLElement>("#panel-wc .app-rail-mark")?.addEventListener("click", () => gotoSection("agent"));
  // The code section is the permanent shell now — always active.
  document.querySelector(`.help-section[data-section="code"]`)?.classList.add("active");
  document.body.dataset.railSection ||= "code";

  // Settings sub-nav — the buttons live inside the .settings-layout that gets
  // MOVED into the settings modal on open, so bind by data-attr (not by
  // section-scoped selectors that break once the layout leaves the section)
  // and re-query the panel set at click time from wherever the layout now is.
  const settingsSubNav = document.querySelectorAll<HTMLButtonElement>(".settings-nav .settings-nav-item");
  settingsSubNav.forEach((btn) => {
    btn.addEventListener("click", () => {
      // Docs has its own topics nav, so it opens as its own section — and the
      // settings modal must step aside for it.
      const jump = btn.dataset.jump;
      if (jump) {
        closeSettingsModal();
        gotoSection(jump);
        return;
      }
      const sub = btn.dataset.sub!;
      document.querySelectorAll(".settings-nav .settings-nav-item").forEach((n) => n.classList.remove("active"));
      document.querySelectorAll(".settings-panels .settings-panel").forEach((p) => p.classList.remove("active"));
      btn.classList.add("active");
      const target = document.querySelector(`.settings-panels .settings-panel[data-sub="${sub}"]`);
      if (target) target.classList.add("active");
      loadSettingsSub(sub);
    });
  });

  docsSubNav.forEach((btn) => {
    btn.addEventListener("click", () => { showDocPanel(btn.dataset.doc!); });
  });

  // ── App rail (Code-primary surface) ─────────────────────────────────────
  // The Home|Code switcher is gone: the agent (code) is the always-present
  // base, Home is a nav item like the rest, and clicking the ACTIVE section
  // returns to the agent — so every section toggles back to code.
  document.querySelectorAll<HTMLButtonElement>(".app-rail-nav-item").forEach((btn) => {
    if (!btn.dataset.section) return; // the More toggle is not a section
    btn.addEventListener("click", () => {
      gotoSection(btn.classList.contains("active") ? "code" : btn.dataset.section!);
    });
  });

  // ── "More" fly-out — everything but Home + Connections lives here, in a
  //    popup that opens to the RIGHT of the More button so the rail stays a
  //    short, tidy three-item column. ──
  // space: rail tabs that show the item (word list) — absent = all spaces
  const MORE_ITEMS: Array<{ section: string; label: string; icon: string; space?: string }> = [
    { section: "loops", label: "Loops", space: "code", icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 2.1l4 4-4 4"/><path d="M3 12.2v-2a4 4 0 0 1 4-4h12.8"/><path d="M7 21.9l-4-4 4-4"/><path d="M21 11.8v2a4 4 0 0 1-4 4H4.2"/></svg>` },
    { section: "skills", label: "Skills", icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2l2.4 4.9 5.4.8-3.9 3.8.9 5.4-4.8-2.5-4.8 2.5.9-5.4L4.2 7.7l5.4-.8z"/></svg>` },
    { section: "agents", label: "Agents", space: "code", icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="7" width="16" height="12" rx="2"/><path d="M12 7V4"/><circle cx="12" cy="3" r="1"/><circle cx="9" cy="12" r="1"/><circle cx="15" cy="12" r="1"/><path d="M9 16h6"/></svg>` },
  ];
  const moreToggle = document.getElementById("rail-more-toggle");
  let moreMenu: HTMLDivElement | null = null;
  // Capture phase, so a click ANYWHERE off the menu closes it even when the
  // clicked control stops propagation (the rail's open-page buttons do).
  const closeMore = (): void => { moreMenu?.remove(); moreMenu = null; document.removeEventListener("click", onMoreOutside, true); };
  const onMoreOutside = (ev: MouseEvent): void => {
    if (!(ev.target as HTMLElement).closest("#rail-more-menu, #rail-more-toggle")) closeMore();
  };
  const activeSection = (): string => document.body.dataset.railSection || "";
  moreToggle?.addEventListener("click", (e) => {
    e.stopPropagation();
    if (moreMenu) { closeMore(); return; }
    const menu = document.createElement("div");
    menu.id = "rail-more-menu";
    menu.className = "code-menu rail-more-menu";
    const space = document.body.dataset.railSpace || "chat";
    for (const it of MORE_ITEMS.filter((x) => !x.space || x.space.split(" ").includes(space))) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "app-rail-nav-item" + (activeSection() === it.section ? " active" : "");
      b.innerHTML = `${it.icon}<span>${it.label}</span>`;
      b.addEventListener("click", () => {
        closeMore();
        gotoSection(it.section);
      });
      menu.appendChild(b);
    }
    document.body.appendChild(menu);
    moreMenu = menu; // track it so closeMore() and the outside-click can remove it
    // Anchor to the RIGHT of the More button, top-aligned; nudge back on screen.
    const r = moreToggle.getBoundingClientRect();
    menu.style.left = `${r.right + 6}px`;
    menu.style.top = `${Math.min(r.top, window.innerHeight - menu.offsetHeight - 8)}px`;
    moreToggle.classList.add("open");
    setTimeout(() => document.addEventListener("click", onMoreOutside, true), 0);
  });
  // The More button highlights when one of its sections is the active one.
  const moreSections = new Set(MORE_ITEMS.map((i) => i.section));
  new MutationObserver(() => {
    moreToggle?.classList.toggle("active", moreSections.has(activeSection()));
    if (!moreMenu) moreToggle?.classList.remove("open");
  }).observe(document.body, { attributes: true, attributeFilter: ["data-rail-section"] });

  // User area — dropdown opens upward: Settings / Account / Logout.
  const GEAR_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>`;
  const USER_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>`;
  const LOGOUT_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>`;
  const userBtn = document.getElementById("app-rail-user-btn");
  let userMenu: HTMLDivElement | null = null;
  const closeUserMenu = () => { userMenu?.remove(); userMenu = null; };
  userBtn?.addEventListener("click", (e) => {
    e.stopPropagation();
    if (userMenu) { closeUserMenu(); return; }
    const m = document.createElement("div");
    m.className = "code-menu app-rail-user-menu";
    const mk = (label: string, icon: string, cb: () => void, danger = false) => {
      const b = document.createElement("button");
      b.className = "code-menu-item" + (danger ? " danger" : "");
      b.innerHTML = `${icon}<span></span>`;
      (b.querySelector("span") as HTMLElement).textContent = label;
      b.addEventListener("click", () => { closeUserMenu(); cb(); });
      m.appendChild(b);
    };
    const DOCS_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/></svg>`;
    mk("Docs", DOCS_SVG, () => gotoSection("docs"));
    mk("Settings", GEAR_SVG, () => gotoSection("settings"));
    mk("Account", USER_SVG, () => gotoSection("settings", "account"));
    mk("Logout", LOGOUT_SVG, () => { void window.glyphh.logout(); }, true);
    document.body.appendChild(m);
    const r = userBtn.getBoundingClientRect();
    m.style.left = `${r.left}px`;
    m.style.top = `${Math.max(8, r.top - m.offsetHeight - 6)}px`;
    userMenu = m;
  });
  document.addEventListener("mousedown", (e) => {
    if (userMenu && !userMenu.contains(e.target as Node) && e.target !== userBtn) closeUserMenu();
  });
  // Fill the user name from account info (email fallback) — and REFILL on
  // every account update, so logging out and back in as a different user
  // repaints the rail instead of showing the previous identity all run.
  const fillRailUser = (info: { email?: string; firstName?: string; lastName?: string } | null): void => {
    const nameEl = document.getElementById("app-rail-user-name");
    if (!nameEl) return;
    if (!info) { nameEl.textContent = "Account"; return; }
    nameEl.textContent =
      (info.firstName ? `${info.firstName} ${info.lastName || ""}`.trim() : info.email) || "Account";
  };
  void window.glyphh.getAccountInfo?.().then(fillRailUser).catch(() => { /* signed out — placeholder stays */ });
  window.glyphh.onAccountUpdated?.(fillRailUser);

  // Initialize all section event handlers
  initDashboardEvents();
  initSettings();
  initApps();
  initConnections();
  initLayoutsEvents();
  initDripsEvents();
  initLoopsEvents();
  initSkillsLibraryEvents();
  initAgentsEvents();
  initSkills();
  initCode();
  wireGlobalDotCommands();
  // The shell steers sections too (the first-run walkthrough lands on Home).
  window.glyphh.onGotoSection?.((section) => {
    // "settings:account" → section + sub-panel (the nav apps use this).
    const [sec, sub] = String(section).split(":");
    gotoSection(sec, sub || undefined);
  });
}
