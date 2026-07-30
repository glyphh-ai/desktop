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
  gotoSection("settings", sub);
  openHelp();
}

export function isHelpOpen(): boolean {
  return !overlay.classList.contains("hidden");
}

/** Deep-link: open the Apps section and the New App form, prefilled. */
export function openNewAppDeepLink(data: { url?: string; name?: string; tabId?: string }): void {
  gotoSection("apps");
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
  void window.yo.setPreference?.("homeLastSection", section);
  void window.yo.setPreference?.("homeLastSub", sub || "");
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
    if (!sub) return;
    if (section === "docs") showDocPanel(sub);
    else if (section === "settings") {
      const navBtns = document.querySelectorAll<HTMLButtonElement>(
        ".help-section[data-section='settings'] .settings-nav-item");
      const panels = document.querySelectorAll<HTMLDivElement>(
        ".help-section[data-section='settings'] .settings-panel");
      navBtns.forEach((n) => n.classList.toggle("active", n.dataset.sub === sub));
      panels.forEach((p) => p.classList.toggle("active", p.dataset.sub === sub));
    }
  };
  go();
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
  // The code section is the permanent shell now — always active.
  document.querySelector(`.help-section[data-section="code"]`)?.classList.add("active");
  document.body.dataset.railSection ||= "code";

  const settingsSubNav = document.querySelectorAll<HTMLButtonElement>(".help-section[data-section='settings'] .settings-nav-item");
  const settingsSubPanels = document.querySelectorAll<HTMLDivElement>(".help-section[data-section='settings'] .settings-panel");
  settingsSubNav.forEach((btn) => {
    btn.addEventListener("click", () => {
      // Docs has its own topics nav, so it opens as its own section.
      const jump = btn.dataset.jump;
      if (jump) {
        gotoSection(jump);
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

  // Docs has its own topics nav — the breadcrumb CLOSES the section (back to
  // the agent), it does not open the Settings menu.
  document.getElementById("docs-back-settings")?.addEventListener("click", () => {
    gotoSection("code");
  });

  // (2.5.0) The left rail is gone: nav lives on the command bar (nav apps),
  // account/logout live in Settings → Account, sessions in the agent panel.

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
  window.yo.onGotoSection?.((section) => {
    // "settings:account" → section + sub-panel (the nav apps use this).
    const [sec, sub] = String(section).split(":");
    gotoSection(sec, sub || undefined);
  });
}
