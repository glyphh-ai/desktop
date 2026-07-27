/**
 * Help overlay — open/close, section switching, nav wiring.
 */

import { closeHelp, getHelpOverlay, getHelpTransitioning, setHelpTransitioning } from "./shared.js";
import { loadDashboard, initDashboardEvents } from "./dashboard.js";
import { loadLayouts, initLayoutsEvents } from "./layouts.js";
import { loadApps, initApps, openNewAppForm } from "./apps.js";
import { loadSettings, initSettings } from "./settings.js";
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
  window.yo.panelsHide();
  overlay.classList.remove("hidden");
  window.yo.refreshAuth().catch(() => {});
  loadActiveSection();
}

export function openSettings(sub?: string) {
  switchToSection("settings");
  if (sub) {
    const settingsNavItems = document.querySelectorAll<HTMLButtonElement>(".help-section[data-section='settings'] .settings-nav-item");
    const settingsPanels = document.querySelectorAll<HTMLDivElement>(".help-section[data-section='settings'] .settings-panel");
    settingsNavItems.forEach((n) => n.classList.toggle("active", n.dataset.sub === sub));
    settingsPanels.forEach((p) => p.classList.toggle("active", p.dataset.sub === sub));
  }
  openHelp();
}

export function isHelpOpen(): boolean {
  return !overlay.classList.contains("hidden");
}

/** Deep-link: open the Apps section and the New App form, prefilled. */
export function openNewAppDeepLink(data: { url?: string; name?: string; tabId?: string }): void {
  switchToSection("apps");
  loadApps();
  openNewAppForm(data.url || "", data.name || "", data.tabId ?? null);
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

function switchToSection(sectionId: string) {
  resetEditors();
  // The active section drives the rail's single highlight: on the agent
  // (code) the current session highlights in Recents; on any other section
  // the nav item highlights and the Recents highlight is suppressed (CSS).
  document.body.dataset.railSection = sectionId;
  sections.forEach((s) => s.classList.remove("active"));
  const section = document.querySelector(`.help-section[data-section="${sectionId}"]`) as HTMLElement;
  if (section) section.classList.add("active");
  // App rail: highlight the active nav item (Home / Connections / …). The
  // agent (code) is the base — no nav item is active while it's showing.
  document.querySelectorAll<HTMLButtonElement>(".app-rail-nav-item").forEach((b) =>
    b.classList.toggle("active", b.dataset.section === sectionId));
}

function activeSection(): string {
  // The rail's single source of section truth — set by switchToSection.
  return document.body.dataset.railSection || "guide";
}

export function loadActiveSection(explicit?: string) {
  const sec = explicit || activeSection();
  if (sec === "dashboard") void loadDashboard();
  else if (sec === "drips") loadDrips();
  else if (sec === "loops") void loadLoops();
  else if (sec === "skills") void loadSkillsLibrary();
  else if (sec === "agents") void loadAgents();
  else if (sec === "layouts") loadLayouts();
  else if (sec === "apps") loadApps();
  else if (sec === "code") loadCode();
  else if (sec === "connections") void loadConnections();
  else if (sec === "models") loadModelsAdmin();
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
  // Content sections need the window body — if Glyphh is collapsed to the
  // rail, expand it (the workspace apps slide back right).
  if (["apps", "connections", "layouts", "drips", "settings"].includes(section)) {
    void window.yo.railCollapseSet?.(false);
  }
  // Remember the last section the user viewed so the app reopens here next
  // launch (unless a fixed startup page is set in Settings).
  void window.yo.setPreference?.("homeLastSection", section);
  void window.yo.setPreference?.("homeLastSub", sub || "");
  switchToSection(section);
  if (section === "docs") {
    loadDocs();
    if (sub) showDocPanel(sub);
  } else if (section === "settings") {
    loadSettings();
    if (sub) {
      const navBtns = document.querySelectorAll<HTMLButtonElement>(
        ".help-section[data-section='settings'] .settings-nav-item");
      const panels = document.querySelectorAll<HTMLDivElement>(
        ".help-section[data-section='settings'] .settings-panel");
      navBtns.forEach((n) => n.classList.toggle("active", n.dataset.sub === sub));
      panels.forEach((p) => p.classList.toggle("active", p.dataset.sub === sub));
    }
  } else {
    loadActiveSection(section);
  }
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

  const settingsSubNav = document.querySelectorAll<HTMLButtonElement>(".help-section[data-section='settings'] .settings-nav-item");
  const settingsSubPanels = document.querySelectorAll<HTMLDivElement>(".help-section[data-section='settings'] .settings-panel");
  settingsSubNav.forEach((btn) => {
    btn.addEventListener("click", () => {
      // Docs has its own topics nav, so it opens as its own section.
      const jump = btn.dataset.jump;
      if (jump) {
        switchToSection(jump);
        loadActiveSection();
        return;
      }
      const sub = btn.dataset.sub!;
      settingsSubNav.forEach((n) => n.classList.remove("active"));
      settingsSubPanels.forEach((p) => p.classList.remove("active"));
      btn.classList.add("active");
      const target = document.querySelector(`.help-section[data-section='settings'] .settings-panel[data-sub="${sub}"]`);
      if (target) target.classList.add("active");
      // Support & About live inside Settings now — populate their dynamic bits.
      if (sub === "support") loadSupport();
      else if (sub === "about") loadAbout();
    });
  });

  docsSubNav.forEach((btn) => {
    btn.addEventListener("click", () => { showDocPanel(btn.dataset.doc!); });
  });

  // Docs has its own topics nav, so it can't show the Settings menu — give it
  // a breadcrumb back to Settings instead.
  document.getElementById("docs-back-settings")?.addEventListener("click", () => {
    gotoSection("settings", "general");
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
  const MORE_ITEMS: Array<{ section: string; label: string; icon: string }> = [
    { section: "drips", label: "Drips", icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2.69l5.66 5.66a8 8 0 1 1-11.31 0z"/></svg>` },
    { section: "loops", label: "Loops", icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 2.1l4 4-4 4"/><path d="M3 12.2v-2a4 4 0 0 1 4-4h12.8"/><path d="M7 21.9l-4-4 4-4"/><path d="M21 11.8v2a4 4 0 0 1-4 4H4.2"/></svg>` },
    { section: "skills", label: "Skills", icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2l2.4 4.9 5.4.8-3.9 3.8.9 5.4-4.8-2.5-4.8 2.5.9-5.4L4.2 7.7l5.4-.8z"/></svg>` },
    { section: "agents", label: "Agents", icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="7" width="16" height="12" rx="2"/><path d="M12 7V4"/><circle cx="12" cy="3" r="1"/><circle cx="9" cy="12" r="1"/><circle cx="15" cy="12" r="1"/><path d="M9 16h6"/></svg>` },
    { section: "models", label: "Models", icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><polyline points="3.27 6.96 12 12.01 20.73 6.96"/><line x1="12" y1="22.08" x2="12" y2="12"/></svg>` },
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
    for (const it of MORE_ITEMS) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "app-rail-nav-item" + (activeSection() === it.section ? " active" : "");
      b.innerHTML = `${it.icon}<span>${it.label}</span>`;
      b.addEventListener("click", () => { closeMore(); gotoSection(it.section); });
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
    mk("Logout", LOGOUT_SVG, () => { void window.yo.logout(); }, true);
    document.body.appendChild(m);
    const r = userBtn.getBoundingClientRect();
    m.style.left = `${r.left}px`;
    m.style.top = `${Math.max(8, r.top - m.offsetHeight - 6)}px`;
    userMenu = m;
  });
  document.addEventListener("mousedown", (e) => {
    if (userMenu && !userMenu.contains(e.target as Node) && e.target !== userBtn) closeUserMenu();
  });
  // Fill the user name from account info (email fallback).
  void window.yo.getAccountInfo?.().then((info) => {
    const nameEl = document.getElementById("app-rail-user-name");
    if (nameEl && info) {
      nameEl.textContent =
        (info.firstName ? `${info.firstName} ${info.lastName || ""}`.trim() : info.email) || "Account";
    }
  }).catch(() => { /* signed out — keep the placeholder */ });

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
  window.yo.onGotoSection?.((section) => gotoSection(section));
}
