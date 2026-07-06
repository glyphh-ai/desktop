/**
 * Help overlay — open/close, section switching, nav wiring.
 */

import { closeHelp, getHelpOverlay, getHelpTransitioning, setHelpTransitioning } from "./shared.js";
import { loadDashboard, initDashboardEvents } from "./dashboard.js";
import { loadLayouts, initLayoutsEvents } from "./layouts.js";
import { loadApps, initApps, openNewAppForm } from "./apps.js";
import { loadSettings, initSettings } from "./settings.js";
import { loadDrips, initDripsEvents } from "./drips.js";
import { initSkills } from "./skills.js";
import { loadConnections, initConnections } from "./connections.js";
import { loadDocs, loadSupport, loadAbout } from "./docs.js";

const overlay = getHelpOverlay();
const navItems = document.querySelectorAll<HTMLButtonElement>(".help-nav-item");
const sections = document.querySelectorAll<HTMLDivElement>(".help-section");
const navSubItems = document.querySelectorAll<HTMLButtonElement>(".help-nav-sub-item");

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
    navSubItems.forEach((s) => s.classList.toggle("active", s.dataset.section === "settings" && s.dataset.sub === sub));
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
  document.getElementById("mcp-add-form")?.classList.add("hidden");
}

function switchToSection(sectionId: string) {
  resetEditors();
  navItems.forEach((n) => n.classList.remove("active"));
  sections.forEach((s) => s.classList.remove("active"));
  const navItem = document.querySelector(`.help-nav-item[data-section="${sectionId}"]`) as HTMLElement;
  const section = document.querySelector(`.help-section[data-section="${sectionId}"]`) as HTMLElement;
  if (navItem) navItem.classList.add("active");
  if (section) section.classList.add("active");
}

function collapseAllDropdowns() {
  navItems.forEach((n) => n.classList.remove("expanded"));
}

function activeSection(): string {
  return (document.querySelector(".help-nav-item.active") as HTMLElement)?.dataset.section || "guide";
}

export function loadActiveSection(explicit?: string) {
  // Prefer the explicitly-navigated section. Falling back to the active nav
  // item can resolve to "guide" for sections with no `help-nav-item`.
  const sec = explicit || activeSection();
  if (sec === "dashboard") void loadDashboard();
  else if (sec === "drips") loadDrips();
  else if (sec === "layouts") loadLayouts();
  else if (sec === "apps") loadApps();
  else if (sec === "connections") void loadConnections();
  else if (sec === "settings") loadSettings();
  else if (sec === "docs") loadDocs();
  else if (sec === "support") loadSupport();
  else if (sec === "about") loadAbout();
}

/**
 * Navigate to a section (and optional sub-panel). Driven by the app's
 * left-rail nav — the in-page `#help-nav` sidebar is hidden, but its buttons
 * stay in the DOM so `switchToSection` / `loadActiveSection` keep working.
 */
export function gotoSection(section: string, sub?: string): void {
  // Remember the last section the user viewed so the app reopens here next
  // launch (unless a fixed startup page is set in Settings).
  void window.yo.setPreference?.("homeLastSection", section);
  void window.yo.setPreference?.("homeLastSub", sub || "");
  collapseAllDropdowns();
  navSubItems.forEach((s) => s.classList.remove("active"));
  switchToSection(section);
  if (sub) {
    document
      .querySelector(`.help-nav-sub-item[data-section="${section}"][data-sub="${sub}"]`)
      ?.classList.add("active");
  }
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
  navSubItems.forEach((s) => s.classList.toggle("active", s.dataset.section === "docs" && s.dataset.sub === docId));
  const container = document.querySelector(".docs-panels");
  if (container) container.scrollTop = 0;
}

// ── Init ─────────────────────────────────────────────────

export function initHelp() {
  document.getElementById("help-close")?.addEventListener("click", closeHelp);

  document.getElementById("user-menu-platform")!.addEventListener("click", () => {
    closeHelp();
    window.yo.execCommand(`dip ${window.yo.platformUrl}`);
  });
  document.getElementById("user-menu-logout")!.addEventListener("click", async () => {
    overlay.classList.add("hidden");
    await window.yo.logout();
  });

  navItems.forEach((item) => {
    item.addEventListener("click", () => {
      if (item.classList.contains("has-sub")) {
        item.classList.toggle("expanded");
      } else {
        collapseAllDropdowns();
        navSubItems.forEach((s) => s.classList.remove("active"));
        switchToSection(item.dataset.section!);
        loadActiveSection();
      }
    });
  });

  navSubItems.forEach((sub) => {
    sub.addEventListener("click", () => {
      const sectionId = sub.dataset.section!;
      const subId = sub.dataset.sub!;
      collapseAllDropdowns();
      switchToSection(sectionId);
      navSubItems.forEach((s) => s.classList.remove("active"));
      sub.classList.add("active");

      if (sectionId === "docs") {
        loadDocs();
        showDocPanel(subId);
      } else if (sectionId === "settings") {
        loadActiveSection();
        const settingsNavItems = document.querySelectorAll<HTMLButtonElement>(".help-section[data-section='settings'] .settings-nav-item");
        const settingsPanels = document.querySelectorAll<HTMLDivElement>(".help-section[data-section='settings'] .settings-panel");
        settingsNavItems.forEach((n) => n.classList.toggle("active", n.dataset.sub === subId));
        settingsPanels.forEach((p) => p.classList.toggle("active", p.dataset.sub === subId));
      }
    });
  });

  const settingsSubNav = document.querySelectorAll<HTMLButtonElement>(".help-section[data-section='settings'] .settings-nav-item");
  const settingsSubPanels = document.querySelectorAll<HTMLDivElement>(".help-section[data-section='settings'] .settings-panel");
  settingsSubNav.forEach((btn) => {
    btn.addEventListener("click", () => {
      // Docs has its own topics nav, so it opens as its own section.
      const jump = btn.dataset.jump;
      if (jump) {
        collapseAllDropdowns();
        navSubItems.forEach((s) => s.classList.remove("active"));
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
      navSubItems.forEach((s) => s.classList.toggle("active", s.dataset.section === "settings" && s.dataset.sub === sub));
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

  // Initialize all section event handlers
  initDashboardEvents();
  initSettings();
  initApps();
  initConnections();
  initLayoutsEvents();
  initDripsEvents();
  initSkills();
}
