/**
 * Home app — entry point for the home.html section panels (loaded as
 * home.html?section=<slug> for each system-app tab: Apps / Layouts / Drips /
 * Skills / Settings / About). Runs in a dedicated BrowserView with the full
 * window.glyphh API.
 */

import { initHelp, gotoSection, openSettingsModal } from "./help/index.js";
import { seedNewSession } from "./help/code.js";
import { initSearchClears } from "./search-clear.js";
import { installAutofillGuard } from "./autofill-guard.js";

// Theme: the inline script in home.html applied localStorage theme synchronously.
// Here we re-fetch the authoritative value from main and keep localStorage in sync.
function applyTheme(theme: string) {
  const resolved = theme === "system"
    ? (window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark")
    : theme;
  document.documentElement.setAttribute("data-theme", resolved);
  try { localStorage.setItem("yoTheme", theme); } catch {}
}

window.glyphh.getTheme?.().then(applyTheme).catch(() => {});
window.glyphh.onThemeChanged?.(applyTheme);

// React to system dark/light changes when theme = "system"
window.matchMedia("(prefers-color-scheme: light)").addEventListener("change", async () => {
  try {
    const theme = await window.glyphh.getTheme();
    if (theme === "system") applyTheme(theme);
  } catch {}
});

initHelp();
initSearchClears();
installAutofillGuard();
window.glyphh.refreshAuth?.().catch(() => {});

// Full-bleed chrome — the panel covers the titlebar strip, so it owns the
// window controls and the command button (page-top, left of which sits the
// rail toggle wired by code.ts).
document.getElementById("panel-btn-close")?.addEventListener("click", () => window.glyphh.windowClose());
document.getElementById("panel-btn-minimize")?.addEventListener("click", () => window.glyphh.windowMinimize());
document.getElementById("panel-btn-maximize")?.addEventListener("click", () => window.glyphh.windowMaximize());
// Pick the startup section. Priority: ?section=<slug> in the URL (system-app
// panel mounted as its own section) → the user's configured default
// ("homeStartupSection", blank = "last viewed") → the last section → dashboard.
void (async () => {
  // System-app panels (yo://apps, yo://layouts, …) load home.html with a
  // ?section=<slug> query. When set, this panel is locked to that section.
  try {
    const params = new URLSearchParams(window.location.search);
    // PLATFORM shell (web-only — platform.glyphh.ai's /platform route serves
    // home.html; Electron loads home.html from disk, so this pathname never
    // matches there and the branch is inert on desktop). The workbench/echo
    // never shows: the existing settings surface opens as THE PAGE — the
    // settings modal, restyled full-bleed by body.platform-shell (rail left
    // with a collapse toggle, content right, no close/backdrop — styles.css
    // "Platform shell (web)"). All panel loaders, the org-admin gating and
    // the super-admin (gateAdminSubs) nav-gating run untouched inside it.
    if (/^\/platform\/?$/.test(window.location.pathname)) {
      document.documentElement.setAttribute("data-home-scope", "platform");
      document.body.classList.add("platform-shell");
      const style = document.createElement("style");
      style.textContent = `
        [data-home-scope] #app-rail, [data-home-scope] #code-rail-splitter, [data-home-scope] #page-top, [data-home-scope] #panel-wc, [data-home-scope] #shell-drag-strip { display: none !important; }
        [data-home-scope="platform"] #help-overlay { display: none !important; }`;
      document.head.appendChild(style);
      document.title = "Platform — Glyphh";
      // The boot veil (body.wb-booting) is lifted by the wall-settle loop in
      // the DEFAULT boot path, which this branch returns before — drop it now
      // or this page keeps the opaque booting state forever.
      document.body.classList.remove("wb-booting");
      // Rail collapse state persists per browser (chevron toggle below).
      try {
        if (localStorage.getItem("glyphhPlatformRail") === "collapsed") {
          document.body.classList.add("platform-rail-collapsed");
        }
      } catch { /* private mode — starts expanded */ }
      // Open the settings surface as the page. ?sub=<panel> deep-links a
      // specific panel (billing, members, padmin-orgs, …); default General.
      openSettingsModal(params.get("sub") || "usage");
      // Rail collapse chevron — pinned to the rail's top edge of the shell.
      const railBtn = document.createElement("button");
      railBtn.type = "button";
      railBtn.id = "platform-rail-toggle";
      railBtn.className = "settings-modal-close";
      // The LEFT-RAIL icon (a sidebar glyph, same both ways) — not a chevron.
      railBtn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><line x1="9" y1="3" x2="9" y2="21"/></svg>`;
      const paintRailBtn = () => {
        const collapsed = document.body.classList.contains("platform-rail-collapsed");
        railBtn.setAttribute("aria-label", collapsed ? "Expand navigation" : "Collapse navigation");
        railBtn.title = collapsed ? "Expand navigation" : "Collapse navigation";
      };
      paintRailBtn();
      railBtn.addEventListener("click", () => {
        const collapsed = document.body.classList.toggle("platform-rail-collapsed");
        try { localStorage.setItem("glyphhPlatformRail", collapsed ? "collapsed" : "open"); } catch { /* */ }
        paintRailBtn();
      });
      // Rail HEADER (his spec, 2026-08-24): wordmark + the rail toggle to its
      // right; collapsed shows the MASCOT. No surface switch: the Builder
      // opens from the Apps row's launcher (new tab) and carries "← Platform".
      // Build the head ONCE, then keep it mounted as the nav's PREVIOUS
      // SIBLING (in the rail container, not inside .settings-nav). The
      // org-admin gating (gateAdminSubs) rebuilds the nav's children async —
      // anything INSIDE the nav gets wiped a beat after insert (the bug: it
      // showed then vanished). A sibling survives that; an observer re-mounts
      // it if the whole nav element is ever replaced.
      const buildRailHead = (): HTMLElement => {
        const head = document.createElement("div");
        head.id = "platform-rail-head";
        // Wordmark when expanded, the MASCOT when collapsed (CSS swaps them);
        // the rail toggle rides to the RIGHT of the logo, in the head row.
        head.innerHTML = `<img id="platform-brand" src="brand/glyphh-logo-text-black.png" alt="Glyphh" draggable="false" /><img id="platform-mascot" src="brand/glyphh-mark.png" alt="" draggable="false" />`;
        head.appendChild(railBtn);
        return head;
      };
      // The Apps row's far-right launcher: open the Builder in a NEW TAB
      // without switching the row itself (the row still opens the Apps panel).
      document.getElementById("apps-builder-launch")?.addEventListener("click", (ev) => {
        ev.stopPropagation();
        ev.preventDefault();
        window.open("/home", "_blank", "noopener");
      });
      // ── Rail-bottom USER CHIP (his spec, 2026-08-24): first name with the
      // plan under it; its popup menu carries Docs / Support / About (their
      // rail rows are hidden in the platform shell — .not-platform). Fixed to
      // the shell's bottom-left, so nav rebuilds can never wipe it. The menu
      // items click the (hidden) nav rows, so panel switching stays the one
      // existing path.
      {
        const chip = document.createElement("div");
        chip.id = "platform-user-chip";
        chip.innerHTML = `
          <button type="button" id="platform-user-btn">
            <span id="platform-user-avatar"></span>
            <span id="platform-user-meta">
              <span id="platform-user-name">—</span>
              <span id="platform-user-plan"></span>
            </span>
          </button>
          <div id="platform-user-menu" class="hidden" role="menu"></div>`;
        document.body.appendChild(chip);
        const menu = chip.querySelector<HTMLElement>("#platform-user-menu")!;
        for (const [label, sub] of [["Docs", "docs"], ["Support", "support"], ["About", "about"]] as const) {
          const b = document.createElement("button");
          b.type = "button";
          b.textContent = label;
          b.setAttribute("role", "menuitem");
          b.addEventListener("click", () => {
            menu.classList.add("hidden");
            document.querySelector<HTMLElement>(`#settings-modal .settings-nav-item[data-sub="${sub}"]`)?.click();
          });
          menu.appendChild(b);
        }
        // Log out closes the web session and returns to the login shell.
        {
          const sep = document.createElement("div");
          sep.className = "menu-sep";
          menu.appendChild(sep);
          const out = document.createElement("button");
          out.type = "button";
          out.textContent = "Log out";
          out.className = "menu-danger";
          out.setAttribute("role", "menuitem");
          out.addEventListener("click", async () => {
            menu.classList.add("hidden");
            const api = (window as unknown as { glyphh?: { logout?: () => Promise<void> } }).glyphh;
            try { await api?.logout?.(); } catch { /* tokens cleared best-effort */ }
            window.location.assign("/");
          });
          menu.appendChild(out);
        }
        chip.querySelector("#platform-user-btn")?.addEventListener("click", (ev) => {
          ev.stopPropagation();
          menu.classList.toggle("hidden");
        });
        document.addEventListener("click", () => menu.classList.add("hidden"));
        type AccountInfo = { firstName?: string; email?: string; tier?: string } | null;
        const glyphhApi = (window as unknown as { glyphh?: { getAccountInfo?: () => Promise<AccountInfo> } }).glyphh;
        void glyphhApi?.getAccountInfo?.().then((info) => {
          if (!info) return;
          const first = (info.firstName || "").trim() || (info.email || "").split("@")[0] || "—";
          const tier = (info.tier || "free").toLowerCase();
          chip.querySelector("#platform-user-name")!.textContent = first;
          chip.querySelector("#platform-user-plan")!.textContent = `${tier.charAt(0).toUpperCase()}${tier.slice(1)} plan`;
          chip.querySelector("#platform-user-avatar")!.textContent = first.charAt(0).toUpperCase();
        }).catch(() => { /* chip stays a dash — the shell still works */ });
      }
      const railHead = buildRailHead();
      // MUST scope to #settings-modal: the document holds a SECOND
      // .settings-nav inside #help-overlay, which this page force-hides — a
      // bare querySelector(".settings-nav") finds THAT one first and the head
      // mounts into an invisible tree (the bug: everything "worked" headless,
      // rendered 0×0 on screen).
      const platformNav = (): Element | null =>
        document.querySelector("#settings-modal .settings-nav");
      const mountRailHead = (): boolean => {
        const nav = platformNav();
        if (!nav || !nav.parentElement) return false;
        if (railHead.isConnected) return true;
        nav.parentElement.insertBefore(railHead, nav);   // ABOVE the nav, as a sibling
        return true;
      };
      let railTries = 0;
      const railGo = (): void => {
        if (mountRailHead()) {
          // Keep it mounted across nav rebuilds / replacement.
          const rail = platformNav()?.parentElement;
          if (rail) new MutationObserver(() => { if (!railHead.isConnected) mountRailHead(); }).observe(rail, { childList: true });
          return;
        }
        if (railTries++ < 120) requestAnimationFrame(railGo);
      };
      railGo();
      return;
    }
    // Standalone TOOL window (?solo=tool:<ViewKind>) — a desktop layout tiles
    // workbench tools as their own OS windows. The full home page loads, but
    // only the workbench shows, booted with exactly one slot.
    const solo = params.get("solo");
    // Standalone TOOL window (?solo=tool:<ViewKind>) — a desktop layout tiles
    // workbench tools as their own OS windows.
    if (solo && solo.startsWith("tool:")) {
      document.documentElement.setAttribute("data-home-scope", "solo-tool");
      const style = document.createElement("style");
      // NOTE: hide only the agent at its HOME position (.code-root > …) — the
      // Coding Agent slot REPARENTS the live .code-agent into the workbench,
      // and it must stay visible there. The workbench takes the full window.
      style.textContent = `
        [data-home-scope] #app-rail, [data-home-scope] #code-rail-splitter, [data-home-scope] #page-top, [data-home-scope] #panel-wc, [data-home-scope] #shell-drag-strip { display: none !important; }
        [data-home-scope="solo-tool"] .code-root > .code-agent, [data-home-scope="solo-tool"] #code-wb-edge { display: none !important; }
        [data-home-scope="solo-tool"] .code-workbench { flex: 1 1 auto !important; border-left: none !important; }
        [data-home-scope="solo-tool"] .ws-right-rails { width: 100% !important; }
        [data-home-scope="solo-tool"] .ws-right-rail { flex: 1 1 auto !important; width: auto !important; }`;
      document.head.appendChild(style);
      gotoSection("code");
      const SOLO_LABELS: Record<string, string> = {
        preview: "Browser", coding: "Glyphh", diff: "Diff", monaco: "Editor",
        files: "Files", plan: "Plan", terminal: "Terminal",
      };
      const kind = solo.slice(5);
      const soloLabel = SOLO_LABELS[kind] || kind;
      // The agent's own window is just "Glyphh" — never "Glyphh — Glyphh".
      document.title = soloLabel === "Glyphh" ? "Glyphh" : `${soloLabel} — Glyphh`;
      const payload = {
        cols: 1, colWidths: [], rowHeights: [],
        cells: [{ slug: solo, name: SOLO_LABELS[kind] || kind, url: "", glyphh: false, col: 0, row: 0, tool: kind }],
      };
      // The workbench boots on the code section's first load — poll for it
      // (same pattern as openLayoutInWorkbench).
      const w = window as unknown as { __wbOpenLayout?: (l: typeof payload) => void };
      let tries = 0;
      const go = () => {
        if (w.__wbOpenLayout) w.__wbOpenLayout(payload);
        else if (tries++ < 40) requestAnimationFrame(go);
      };
      go();
      return;
    }
    const urlSection = params.get("section");
    if (urlSection) {
      document.documentElement.setAttribute("data-home-scope", urlSection);
      // Hide the left rail when this panel is locked to a single section —
      // it's mounted as its own app (yo://<slug>), so no in-rail switching.
      const style = document.createElement("style");
      // Locked panels sit below the real titlebar — hide the full-bleed
      // chrome (rail, splitter, page-top strip, panel window controls).
      style.textContent = `[data-home-scope] #app-rail, [data-home-scope] #code-rail-splitter, [data-home-scope] #page-top, [data-home-scope] #panel-wc, [data-home-scope] #shell-drag-strip { display: none !important; }`;
      document.head.appendChild(style);
      gotoSection(urlSection);
      return;
    }
  } catch { /* fall through */ }
  // Every restart lands on the COMMAND CENTER — the bare wall, no agent (his
  // rule, 2026-08-18). initCode's boot raises it (openCommandCenter); calling
  // gotoSection("agent") here would open the agent card via
  // openSectionInWorkbench("agent") → openChat, which is exactly the
  // agent-on-boot he keeps seeing. (?section / ?solo panels above are system
  // windows, not normal boots.)
  // Lift the boot veil only once the WALL is actually up — its bare first
  // paint was the flash between splash and Home.
  let veilTries = 0;
  let settled = 0;
  const lift = (): void => {
    // The launcher is UP when a page grid has rendered its icons. Wait until
    // it is present AND stable for ~10 frames so the first visible frame is
    // the settled command center, then lift.
    const wall = document.querySelector(".echo-pages .echo-page-grid");
    const up = !!wall && wall.getClientRects().length > 0;
    settled = up ? settled + 1 : 0;
    if (settled >= 10 || veilTries++ > 360) {
      document.body.classList.remove("wb-booting");
      return;
    }
    requestAnimationFrame(lift);
  };
  lift();
})();

// ── "← Platform" (web Builder only) ─────────────────────────────────────────
// The Builder opens from the platform's Apps-row launcher in a NEW TAB; this
// fixed top-left link is the way back. Renders ONLY under the web bridge
// (window.__GLYPHH_WEB__) and never on /platform itself; on desktop
// (Electron) nothing mounts, and the mobile app never loads this bundle.
void (() => {
  if (!(window as unknown as { __GLYPHH_WEB__?: boolean }).__GLYPHH_WEB__) return;
  if (/^\/platform\/?$/.test(window.location.pathname)) return;
  if (document.getElementById("builder-back-platform")) return;
  const a = document.createElement("a");
  a.id = "builder-back-platform";
  a.href = "/platform";
  a.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg><span>Platform</span>`;
  document.body.appendChild(a);
})();

// ── Pending-update badge (bottom-right, every page) ─────────────────────────
// Shows once an update has downloaded; stays until the user restarts into it
// or dismisses it. Dismissal is per version and main rebroadcasts it, so
// dismissing in one panel hides it in all of them.
void (async () => {
  const btn = document.getElementById("app-rail-relaunch");
  const text = document.getElementById("app-rail-relaunch-text");
  if (!btn || !text) return;

  const show = (v: string) => {
    text.textContent = v ? `Relaunch to update — v${v}` : "Relaunch to update";
    btn.title = v ? `Relaunch to finish updating to v${v}` : "Relaunch to finish updating";
    btn.classList.remove("hidden");
  };

  btn.addEventListener("click", () => { window.glyphh.updateInstall?.(); });

  window.glyphh.onUpdateStatus?.((info) => {
    if (info.status === "ready") show(info.version || "");
    else if (info.status === "restarting" || info.status === "none") btn.classList.add("hidden");
  });

  // Panels mount after boot — ask main whether an update is already waiting.
  const pending = await window.glyphh.getUpdateStatus?.();
  if (pending?.ready) show(pending.version);
})();
