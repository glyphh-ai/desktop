/**
 * Help overlay — open/close, section switching, nav wiring.
 */

import { closeHelp, getHelpOverlay, getHelpTransitioning, setHelpTransitioning, guardWebviewsForModal } from "./shared.js";
import { hidePanelsForModal, restorePanelsForModal } from "../yo-modal.js";
import { loadDashboard, initDashboardEvents } from "./dashboard.js";
import { loadLayouts, initLayoutsEvents } from "./layouts.js";
import { loadApps, initApps } from "./apps.js";
import { loadMarketplaceSection, initMarketplace } from "./marketplace.js";
import { loadSettings, initSettings, loadBilling, loadProfile, loadOrg, loadMembers, loadWorkspacesPanel } from "./settings.js";
import { loadDrips, initDripsEvents } from "./drips.js";
import { loadLoops, initLoopsEvents } from "./loops.js";
import { loadSkillsLibrary, initSkillsLibraryEvents } from "./skills-library.js";
import { loadAgents, initAgentsEvents } from "./agents.js";
import { initSkills } from "./skills.js";
import { loadCode, initCode, wireGlobalDotCommands } from "./code.js";
import { wireDipWatcher } from "./dip-watch.js";
import { loadConnections, initConnections } from "./connections.js";
import { loadDocs, loadSupport, loadAbout } from "./docs.js";
import { loadModelsAdmin } from "./models-admin.js";
import { loadFiles, initFiles } from "./files.js";
import { loadApiKeys, initApiKeys } from "./settings-apikeys.js";
import { loadSupportPanel, initSupportPanel } from "./settings-support.js";
import { loadRuntime } from "./settings-runtime.js";
import { loadGuardrails, initGuardrails } from "./settings-guardrails.js";
import { loadOrgPanel, initOrgPanel } from "./settings-org-panel.js";
import { loadAdminModels, loadAdminPlans, loadAdminUsage, loadAdminOrgs } from "./settings-admin.js";
import { loadVoiceSettings } from "./settings-voice.js";

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
    // Web-surface preview (iframe + fallback card) — created per-app by apps.ts.
    document.getElementById("app-preview-frame")?.remove();
    document.getElementById("app-preview-fallback")?.remove();
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
  else if (sec === "files") void loadFiles();
  else if (sec === "apps") loadApps();
  else if (sec === "marketplace") loadMarketplaceSection();
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
  // "workspaces" IS the layouts section (the product word) — .dip workspaces
  // and .dip layouts land in the same place (his rule, 2026-08-19).
  if (section === "workspaces") section = "layouts";
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
  // "Customize" — the rail's app-settings entry. Opens the modal on the app-
  // config anchor ("app" → appearance via SETTINGS_SUB_ALIAS).
  if (section === "app") {
    openSettingsModal("app");
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
  // Apps + Connections (A2), Loops + Skills + Agents (A3), and Layouts moved
  // INTO the settings modal — each is a settings sub-panel now, not a full-page
  // rail section. (The rail keeps its Layouts quick-launch tray, which opens a
  // layout directly rather than this management page.)
  // Apps / Connections / Workspaces are WORKBENCH sections now (the rail's
  // panels); only the management-shaped pages (loops/skills/agents) stay in
  // the settings modal.
  if (["apps", "marketplace", "connections", "layouts", "agents"].includes(section)) {
    (window as unknown as { __wbOpenSection?: (s: string) => void }).__wbOpenSection?.(section);
    return;
  }
  if (["loops", "skills"].includes(section)) {
    void window.glyphh.setPreference?.("homeLastSection", "settings");
    void window.glyphh.setPreference?.("homeLastSub", section);
    openSettingsModal(section);
    return;
  }
  // Content sections need the window body — if Glyphh is collapsed to the
  // rail, expand it (the workspace apps slide back right).
  if (["files"].includes(section)) {
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
  // Direct children of the MAIN settings nav/panels only — never the docs
  // topics nav or its .docs-panels, which share the .settings-nav-item /
  // .settings-panels class names.
  const navBtns = document.querySelectorAll<HTMLButtonElement>(".settings-nav:not(.docs-nav) > .settings-nav-item");
  const panels = document.querySelectorAll<HTMLDivElement>(".settings-modal-body > .settings-layout > .settings-panels > .settings-panel");
  navBtns.forEach((n) => n.classList.toggle("active", n.dataset.sub === target));
  panels.forEach((p) => p.classList.toggle("active", p.dataset.sub === target));
  const panelsWrap = document.querySelector<HTMLElement>(".settings-modal-body > .settings-layout > .settings-panels");
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
  // Park every adopted section body (docs + the whole-node sections) back into
  // its own hidden section FIRST, so the settings layout below doesn't carry
  // any of them back into the settings pen.
  parkSettingsDocs();
  for (const s of Object.keys(SETTINGS_SECTIONS)) parkSettingsSection(s);
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
  if (e.key !== "Escape") return;
  e.preventDefault();
  e.stopPropagation();
  // STAGED escape: fullscreen reverts to the normal size first; a second Esc
  // (or the X) closes the modal.
  const panel = document.querySelector<HTMLElement>(".settings-modal-panel.fullscreen");
  if (panel) {
    panel.classList.remove("fullscreen");
    const maxBtn = panel.querySelector<HTMLElement>(".settings-modal-max");
    if (maxBtn) {
      maxBtn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/><line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/></svg>`;
      maxBtn.setAttribute("aria-label", "Expand settings to full screen");
    }
    return;
  }
  closeSettingsModal();
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

  // Expand / collapse — toggles the panel between its normal size and full
  // screen (see .settings-modal-panel.fullscreen). Session-local by design:
  // nothing is persisted, and closing the modal (which removes the overlay)
  // resets it. The side-by-side editors are %/flex based, so they simply get
  // the extra room.
  const EXPAND_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/><line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/></svg>`;
  const COLLAPSE_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="4 14 10 14 10 20"/><polyline points="20 10 14 10 14 4"/><line x1="14" y1="10" x2="21" y2="3"/><line x1="3" y1="21" x2="10" y2="14"/></svg>`;
  const maxBtn = document.createElement("button");
  maxBtn.type = "button";
  maxBtn.className = "settings-modal-close settings-modal-max";
  maxBtn.setAttribute("aria-label", "Expand settings to full screen");
  maxBtn.innerHTML = EXPAND_SVG;
  maxBtn.addEventListener("click", () => {
    const full = panel.classList.toggle("fullscreen");
    maxBtn.innerHTML = full ? COLLAPSE_SVG : EXPAND_SVG;
    maxBtn.setAttribute("aria-label", full ? "Exit full screen" : "Expand settings to full screen");
  });

  const body = document.createElement("div");
  body.className = "settings-modal-body";
  // Adopt the real two-column layout — same nodes, so every loader + the
  // admin-only nav gating keep working exactly as before.
  body.appendChild(layout);

  panel.appendChild(maxBtn);
  panel.appendChild(closeBtn);
  panel.appendChild(body);
  overlay.appendChild(backdrop);
  overlay.appendChild(panel);
  document.body.appendChild(overlay);

  document.addEventListener("keydown", onSettingsModalKey, true);

  // Populate the whole panel set + admin gating, then reveal the requested sub.
  loadSettings();
  gateAdminSubs();
  selectSettingsSub(sub || "general");
}

/** Hide the admin-only surfaces for non-admins on modal open — the SAME rule
 *  Members/Workspaces use (their own loaders gate on the eager loadSettings()
 *  call). The old Organization/Runtime/Guardrails TABS live as groups on
 *  Billing/General now, so the gate toggles those groups instead of nav
 *  entries. Each loader re-asserts the gate + the admin-only body message. */
function gateAdminSubs(): void {
  void window.glyphh.getAccountInfo?.().then((info) => {
    const admin = !!info?.role && ["org_admin", "super_admin"].includes(info.role);
    for (const id of ["general-runtime-group", "general-guardrails-group", "billing-org-group"]) {
      document.getElementById(id)?.classList.toggle("hidden", !admin);
    }
    // The Platform group (the super-admin console — Catalog / Plans / Usage /
    // Orgs) is a TIER above the org-admin gate: super_admin only. The server
    // enforces the role on every route regardless — this only hides the nav.
    // The platform axis is the REAL gate (bootstrap seeds the admin as an
    // org_admin member with is_platform_admin=true); role kept as fallback.
    const superAdmin = (info as { isPlatformAdmin?: boolean } | null)?.isPlatformAdmin === true || info?.role === "super_admin";
    document.querySelectorAll<HTMLElement>(".settings-nav:not(.docs-nav) > .nav-super")
      .forEach((el) => el.classList.toggle("hidden", !superAdmin));
  }).catch(() => { /* signed out — items stay hidden (they start hidden) */ });
}

/**
 * Retired sub-panels, pointed at wherever they went. A saved nav app or a
 * remembered `homeLastSub` that names "organization" must still land somewhere
 * — without this, every nav item and panel deactivates and Settings opens
 * blank.
 */
const SETTINGS_SUB_ALIAS: Record<string, string> = {
  // "Customize" (the rail's app-settings entry) opens the modal on Appearance —
  // the app-level customization panel (themes, browser). General/Appearance/
  // Drips/Desktop/MCP are the app-config subs; Appearance is the natural anchor.
  app: "appearance",
  // Organization / Runtime / Guardrails retired as tabs — Organization lives
  // in Billing (folded under the Plan bar); Runtime + Guardrails live on
  // General (the Sessions group and the folded Guardrails group).
  organization: "billing",
  runtime: "general",
  guardrails: "general",
};

/** Retired top-level sections, redirected to the Settings sub-panel that
 *  absorbed them — a rail item or `homeLastSection` naming "models" must not
 *  open a section that no longer exists. */
const SECTION_ALIAS: Record<string, { section: string; sub: string }> = {
  models: { section: "settings", sub: "models" },
};
const settingsSubAlias = (sub: string): string => {
  const target = SETTINGS_SUB_ALIAS[sub] || sub;
  // MCP is a desktop-machine feature — a browser tab has no machine to run the
  // 127.0.0.1 server on. The nav item + panel are CSS-hidden on web; any stale
  // deep link (saved nav app, remembered homeLastSub) lands on General instead.
  if (target === "mcp" && document.documentElement.classList.contains("glyphh-web")) return "general";
  return target;
};

/** Settings sub-panels that fetch on show. Shared by the sub-nav click handler
 *  and gotoSection's deep-link path so both populate identically. */
function loadSettingsSub(sub: string): void {
  // General carries the Sessions (runtime region) + Guardrails groups now —
  // both fetch on show, exactly as their retired tabs did.
  if (sub === "general") { void loadRuntime(); void loadGuardrails(); }
  else if (sub === "support") void loadSupportPanel();
  else if (sub === "about") loadAbout();
  else if (sub === "drips") loadDrips();
  // Billing also hosts the folded Organization group (the retired tab) — its
  // loader fires with the panel, like the invoice fold's data does.
  else if (sub === "billing") { void loadBilling(); void loadOrgPanel(); }
  // Organization is ALSO folded into Account (org admins only), so Account
  // still loads the org section; the standalone Organization panel (A4) is its
  // own sub below.
  else if (sub === "account") { void loadProfile(); void loadOrg(); }
  else if (sub === "members") void loadMembers();
  else if (sub === "workspaces") void loadWorkspacesPanel();
  else if (sub === "models") loadModelsAdmin();
  // The Platform group — the super-admin console (settings-admin.ts). Each
  // loader re-checks the role and paints an honest gate; the server enforces.
  else if (sub === "padmin-models") loadAdminModels();
  else if (sub === "padmin-plans") loadAdminPlans();
  else if (sub === "padmin-usage") loadAdminUsage();
  else if (sub === "padmin-orgs") loadAdminOrgs();
  else if (sub === "apikeys") void loadApiKeys();
  else if (sub === "voice") void loadVoiceSettings();
  else if (sub === "docs") { mountSettingsDocs(); loadDocs(); }
  else if (sub === "apps") { mountSettingsSection("apps"); loadApps(); }
  else if (sub === "connections") { mountSettingsSection("connections"); void loadConnections(); }
  else if (sub === "loops") { mountSettingsSection("loops"); void loadLoops(); }
  else if (sub === "skills") { mountSettingsSection("skills"); void loadSkillsLibrary(); }
  else if (sub === "agents") { mountSettingsSection("agents"); void loadAgents(); }
  else if (sub === "layouts") { mountSettingsSection("layouts"); void loadLayouts(); }
  // Artifacts adopts the FILES section (the gallery page) — same page, second door.
  else if (sub === "artifacts") { mountSettingsSection("files"); void loadFiles(); }
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

// ── Whole-section in-modal adoption (A2 apps/connections, A3 loops/skills/
//    agents) ────────────
//
// Same move-not-clone discipline. Unlike docs (whose CSS keys off .docs-panel
// classes), these layouts are styled through selectors scoped to
// `.help-section[data-section=X]` and its DIRECT children — so moving only the
// children out would break those rules. Instead the WHOLE `.help-section` node
// is moved into the panel host and given `.active` (so its full-height flex +
// detail-pane CSS still applies), then parked straight back into #page-body on
// close. Its `data-section` never triggers the workbench, since nothing routes
// these sections there anymore.
const SETTINGS_SECTIONS: Record<string, { host: string }> = {
  apps: { host: "settings-apps-host" },
  connections: { host: "settings-connections-host" },
  loops: { host: "settings-loops-host" },
  skills: { host: "settings-skills-host" },
  agents: { host: "settings-agents-host" },
  layouts: { host: "settings-layouts-host" },
  files: { host: "settings-files-host" },
};

/** Where a moved section lives when NOT adopted (the hidden #page-body pen),
 *  captured on first mount so it can be parked back precisely. */
const settingsSectionPen: Record<string, HTMLElement | null> = {};

/** Adopt the whole .help-section[data-section=X] node into its settings-modal
 *  host and activate it. Idempotent — a no-op once already adopted. */
function mountSettingsSection(section: string): void {
  const cfg = SETTINGS_SECTIONS[section];
  if (!cfg) return;
  const host = document.getElementById(cfg.host);
  const sec = document.querySelector<HTMLElement>(`.help-section[data-section='${section}']`);
  if (!host || !sec) return;
  if (sec.parentElement === host) { sec.classList.add("active"); return; }
  settingsSectionPen[section] = sec.parentElement as HTMLElement | null;
  sec.classList.add("active");
  host.appendChild(sec);
}

/** Park a section's node back into its hidden #page-body pen and deactivate it. */
function parkSettingsSection(section: string): void {
  const cfg = SETTINGS_SECTIONS[section];
  if (!cfg) return;
  const host = document.getElementById(cfg.host);
  const sec = host?.querySelector<HTMLElement>(`.help-section[data-section='${section}']`);
  const pen = settingsSectionPen[section];
  if (sec && pen) { sec.classList.remove("active"); pen.appendChild(sec); }
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
  // (The header's Glyphh mark is gone — no logo in the chrome cluster.)
  // The code section is the permanent shell now — always active.
  document.querySelector(`.help-section[data-section="code"]`)?.classList.add("active");
  document.body.dataset.railSection ||= "code";

  // Settings sub-nav — the buttons live inside the .settings-layout that gets
  // MOVED into the settings modal on open, so bind by data-attr (not by
  // section-scoped selectors that break once the layout leaves the section)
  // and re-query the panel set at click time from wherever the layout now is.
  // Scope to the MAIN settings nav's own direct items — NOT the docs topics
  // nav (`.settings-nav.docs-nav`), whose buttons are also `.settings-nav-item`
  // and would otherwise double-bind and wipe the active state on a topic click.
  const settingsSubNav = document.querySelectorAll<HTMLButtonElement>(".settings-nav:not(.docs-nav) > .settings-nav-item");
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
      document.querySelectorAll(".settings-nav:not(.docs-nav) > .settings-nav-item").forEach((n) => n.classList.remove("active"));
      document.querySelectorAll(".settings-panels > .settings-panel").forEach((p) => p.classList.remove("active"));
      btn.classList.add("active");
      const target = document.querySelector(`.settings-panels > .settings-panel[data-sub="${sub}"]`);
      if (target) target.classList.add("active");
      loadSettingsSub(sub);
    });
  });

  docsSubNav.forEach((btn) => {
    btn.addEventListener("click", () => { showDocPanel(btn.dataset.doc!); });
  });

  // ── App rail (Code-primary surface) ─────────────────────────────────────
  // Three rail links — Connections / Apps / Layouts — each opens the SETTINGS
  // MODAL at its section (the pages live in the modal; the rail is otherwise
  // + New session and Recents only).
  // Rail items open IN THE WORKBENCH (section cards) — the rail is the
  // workspace's front door, and Settings stays a small preferences surface.
  // "artifacts" is the files section's rail name.
  const RAIL_WB_SECTIONS: Record<string, string> = { apps: "apps", marketplace: "marketplace", connections: "connections", layouts: "layouts", artifacts: "files" };
  document.querySelectorAll<HTMLButtonElement>(".app-rail-nav-item[data-settings-sub]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const sub = btn.dataset.settingsSub!;
      const wb = RAIL_WB_SECTIONS[sub];
      if (wb) (window as unknown as { __wbOpenSection?: (s: string) => void }).__wbOpenSection?.(wb);
      else openSettingsModal(sub);
    });
  });
  // The More fly-out — second-tier rail destinations, every one a WORKBENCH
  // surface (Scheduled Tasks is the hidden tasks view; Agents a section card).
  const MORE_ITEMS: Array<{ label: string; icon: string; open: () => void }> = [
    { label: "Scheduled Tasks", icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/><polyline points="9 15 11 17 15 13"/></svg>`,
      open: () => (window as unknown as { __wbOpenTool?: (v: string) => void }).__wbOpenTool?.("tasks") },
    { label: "Agents", icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="7" width="16" height="12" rx="2"/><path d="M12 7V4"/><circle cx="12" cy="3" r="1"/><circle cx="9" cy="12" r="1"/><circle cx="15" cy="12" r="1"/><path d="M9 16h6"/></svg>`,
      open: () => (window as unknown as { __wbOpenSection?: (s: string) => void }).__wbOpenSection?.("agents") },
  ];
  const moreToggle = document.getElementById("rail-more-toggle");
  let moreMenu: HTMLDivElement | null = null;
  const closeMore = (): void => { moreMenu?.remove(); moreMenu = null; moreToggle?.classList.remove("open"); document.removeEventListener("click", onMoreOutside, true); };
  const onMoreOutside = (ev: MouseEvent): void => {
    if (!(ev.target as HTMLElement).closest("#rail-more-menu, #rail-more-toggle")) closeMore();
  };
  moreToggle?.addEventListener("click", (e) => {
    e.stopPropagation();
    if (moreMenu) { closeMore(); return; }
    const menu = document.createElement("div");
    menu.id = "rail-more-menu";
    menu.className = "code-menu rail-more-menu";
    for (const it of MORE_ITEMS) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "app-rail-nav-item";
      b.innerHTML = `${it.icon}<span>${it.label}</span>`;
      b.addEventListener("click", () => { closeMore(); it.open(); });
      menu.appendChild(b);
    }
    document.body.appendChild(menu);
    moreMenu = menu;
    const r = moreToggle.getBoundingClientRect();
    menu.style.left = `${r.right + 6}px`;
    menu.style.top = `${Math.min(r.top, window.innerHeight - menu.offsetHeight - 8)}px`;
    moreToggle.classList.add("open");
    setTimeout(() => document.addEventListener("click", onMoreOutside, true), 0);
  });
  // (Artifacts rides the same data-settings-sub path — every rail link opens
  // the settings modal; the files PAGE stays reachable via gotoSection for
  // other callers, and closing the modal parks the adopted node back.)

  // The "More" fly-out (Loops / Skills / Agents) was removed in A3 — those
  // sections live in the Settings modal now, so the rail no longer carries a
  // More toggle or its dynamic menu.

  // User area — dropdown opens upward: Settings / Account / Logout.
  const GEAR_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>`;
  const USER_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>`;
  const LOGOUT_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>`;
  const userBtn = document.getElementById("app-rail-user-btn");
  let userMenu: HTMLDivElement | null = null;
  let userMenuAnchor: HTMLElement | null = null;
  const closeUserMenu = () => { userMenu?.remove(); userMenu = null; userMenuAnchor = null; };
  /** The account dropdown — Docs / Settings / Account / Logout. ANCHOR-aware:
   *  opens upward from a bottom-of-screen anchor (the retired rail button)
   *  and downward from a top one. (No visible opener today — the retired
   *  rail button keeps the binding; Settings/Account run through the dock's
   *  gear → settings modal.) */
  const openUserMenu = (anchor: HTMLElement): void => {
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
    const r = anchor.getBoundingClientRect();
    const openUp = r.top > window.innerHeight / 2;
    const top = openUp
      ? Math.max(8, r.top - m.offsetHeight - 6)
      : Math.min(r.bottom + 6, window.innerHeight - m.offsetHeight - 8);
    m.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - m.offsetWidth - 8))}px`;
    m.style.top = `${top}px`;
    userMenu = m;
    userMenuAnchor = anchor;
  };
  userBtn?.addEventListener("click", (e) => {
    e.stopPropagation();
    openUserMenu(userBtn);
  });
  document.addEventListener("mousedown", (e) => {
    if (userMenu && !userMenu.contains(e.target as Node) && !userMenuAnchor?.contains(e.target as Node)) closeUserMenu();
  });
  // The wall's dock gear lands here (the workbench bundle can't import this
  // module): open the SETTINGS MODAL — gotoSection("settings") is the modal
  // path. Account/Logout live inside it.
  (window as unknown as { __glyphhOpenSettings?: () => void }).__glyphhOpenSettings = () => gotoSection("settings");
  // Fill the user name from account info (email fallback) — and REFILL on
  // every account update, so logging out and back in as a different user
  // repaints it instead of showing the previous identity all run.
  const fillRailUser = (info: { email?: string; firstName?: string; lastName?: string } | null): void => {
    const nameEl = document.getElementById("app-rail-user-name");
    if (!nameEl) return;
    nameEl.textContent = info
      ? (info.firstName ? `${info.firstName} ${info.lastName || ""}`.trim() : info.email) || "Account"
      : "Account";
  };
  void window.glyphh.getAccountInfo?.().then(fillRailUser).catch(() => { /* signed out — placeholder stays */ });
  window.glyphh.onAccountUpdated?.(fillRailUser);

  // Initialize all section event handlers. Each init is ISOLATED — one panel
  // throwing (a moved element, a missing id after a refactor) must not kill
  // every init after it in the chain (that's how "the button isn't wired"
  // bugs happen silently).
  const boot = (name: string, fn: () => void): void => {
    try { fn(); } catch (err) { console.error(`[init] ${name} failed:`, err); }
  };
  boot("dashboard", initDashboardEvents);
  boot("settings", initSettings);
  boot("apps", initApps);
  boot("marketplace", initMarketplace);
  boot("connections", initConnections);
  boot("layouts", initLayoutsEvents);
  boot("files", initFiles);
  // A4 settings panels — wire their controls once at boot (idempotent).
  boot("apikeys", initApiKeys);
  boot("support", initSupportPanel);
  boot("guardrails", initGuardrails);
  boot("org", initOrgPanel);
  boot("drips", initDripsEvents);
  boot("loops", initLoopsEvents);
  boot("skills-library", initSkillsLibraryEvents);
  boot("agents", initAgentsEvents);
  boot("skills", initSkills);
  boot("code", initCode);
  boot("dot-commands", wireGlobalDotCommands);
  // Typing the exact `.dip` sequence ANYWHERE (agent input, any field, or no
  // field at all) opens the drip picker — see help/dip-watch.ts.
  wireDipWatcher();
  // The shell steers sections too (the first-run walkthrough lands on Home).
  window.glyphh.onGotoSection?.((section) => {
    // "settings:account" → section + sub-panel (the nav apps use this).
    const [sec, sub] = String(section).split(":");
    gotoSection(sec, sub || undefined);
  });
}
