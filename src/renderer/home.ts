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
      // specific panel (billing, members, padmin-orgs, …); the platform LANDS
      // on the Dashboard (his rule, 2026-08-25).
      openSettingsModal(params.get("sub") || "dash");
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
      // A Stripe return (/billing → 302 /platform?success=1|topup=1) lands
      // on the Billing tab, so the outcome is visible where the purchase
      // started. Params stripped so a reload doesn't re-open it.
      {
        const q = new URLSearchParams(window.location.search);
        if (q.has("success") || q.has("topup") || q.has("billing")) {
          window.setTimeout(() => {
            document.querySelector<HTMLElement>('#settings-modal .settings-nav-item[data-sub="billing"], .settings-nav-item[data-sub="billing"]')?.click();
          }, 600);
          try { window.history.replaceState(null, "", "/platform"); } catch { /* cosmetic */ }
        }
      }
      // The SURFACE TABS (his spec, 2026-08-27): a literal two-tab control
      // at the top of the rail — Dashboard | Desktop, word + icon each. On
      // the platform the Dashboard tab is the active surface; Desktop flips
      // to the command center in the SAME tab. (Replaces the Apps row's old
      // new-tab Builder launcher.)
      document.getElementById("rail-tab-dashboard")?.addEventListener("click", () => {
        openSettingsModal("dash");
      });
      document.getElementById("rail-tab-desktop")?.addEventListener("click", () => {
        window.location.assign("/home");
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
        // Theme — the platform answers to exactly three modes (his spec,
        // 2026-08-25): light, dark (default), system. Icon row up top.
        {
          const row = document.createElement("div");
          row.className = "menu-theme-row";
          const MODES: Array<[string, string, string]> = [
            ["light", "Light", `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="4.4"/><path d="M12 2.5v2.4M12 19.1v2.4M2.5 12h2.4M19.1 12h2.4M5 5l1.7 1.7M17.3 17.3 19 19M19 5l-1.7 1.7M6.7 17.3 5 19"/></svg>`],
            ["dark", "Dark", `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.5 14.5A8.5 8.5 0 1 1 9.5 3.5a7 7 0 0 0 11 11z"/></svg>`],
          ];
          const mark = (mode: string): void => {
            row.querySelectorAll("button").forEach((b) => b.classList.toggle("active", b.dataset.mode === mode));
          };
          for (const [mode, label, icon] of MODES) {
            const b = document.createElement("button");
            b.type = "button";
            b.dataset.mode = mode;
            b.title = label;
            b.setAttribute("aria-label", `${label} theme`);
            b.innerHTML = icon;
            b.addEventListener("click", (ev) => {
              ev.stopPropagation();
              const resolved = mode === "system"
                ? (window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark")
                : mode;
              document.documentElement.setAttribute("data-theme", resolved);
              void window.glyphh.setTheme(mode);
              mark(mode);
            });
            row.appendChild(b);
          }
          // Current mode — anything beyond the three (a desktop theme) shows
          // as no selection; dark is the default when unset.
          void window.glyphh.getTheme?.().then((t) => mark(t || "dark")).catch(() => mark("dark"));
          menu.appendChild(row);
          const sep = document.createElement("div");
          sep.className = "menu-sep";
          menu.appendChild(sep);
        }
        const MENU_ICONS: Record<string, string> = {
          account: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="8" r="4"/><path d="M4.5 20.5a7.5 7.5 0 0 1 15 0"/></svg>`,
          docs: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/></svg>`,
          support: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9.5"/><circle cx="12" cy="12" r="4"/><path d="M5.3 5.3 9.2 9.2M14.8 14.8l3.9 3.9M18.7 5.3l-3.9 3.9M9.2 14.8l-3.9 3.9"/></svg>`,
        };
        for (const [label, sub] of [["Account", "account"], ["Docs", "docs"], ["Support", "support"]] as const) {
          const b = document.createElement("button");
          b.type = "button";
          b.innerHTML = `${MENU_ICONS[sub]}<span></span>`;
          (b.lastElementChild as HTMLElement).textContent = label;
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
          out.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 21H6a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg><span>Log out</span>`;
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
        type AccountInfo = { firstName?: string; email?: string; tier?: string; avatarUrl?: string } | null;
        const glyphhApi = (window as unknown as { glyphh?: { getAccountInfo?: () => Promise<AccountInfo> } }).glyphh;
        void glyphhApi?.getAccountInfo?.().then((info) => {
          if (!info) return;
          const first = (info.firstName || "").trim() || (info.email || "").split("@")[0] || "—";
          const tier = (info.tier || "free").toLowerCase();
          chip.querySelector("#platform-user-name")!.textContent = first;
          chip.querySelector("#platform-user-plan")!.textContent = `${tier.charAt(0).toUpperCase()}${tier.slice(1)} plan`;
          const face = chip.querySelector("#platform-user-avatar") as HTMLElement;
          const avatar = (info as { avatarUrl?: string } | null)?.avatarUrl || "";
          if (avatar) {
            face.innerHTML = "";
            const img = document.createElement("img");
            img.alt = "";
            img.addEventListener("error", () => { face.textContent = first.charAt(0).toUpperCase(); });
            img.src = avatar;
            face.appendChild(img);
          } else {
            face.textContent = first.charAt(0).toUpperCase();
          }
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
    // ATTACHED AGENT window (?solo=agent) — the real Echo agent floating over
    // ANOTHER window's bottom band (agent-dock.ts sizes/positions this window;
    // the native helper tracks the frontmost window). The full home page
    // loads, but only the agent paints, over a transparent page. The foreign
    // window plays the role cards play in Echo: the wall is permanently
    // "covered", so the agent tucks and hover-reveals exactly as it does over
    // panels — and the lock (echoAgentLock) pins it up, same control, same pref.
    if (solo === "agent") {
      document.documentElement.setAttribute("data-home-scope", "agent-dock");
      const style = document.createElement("style");
      style.textContent = `
        [data-home-scope] #app-rail, [data-home-scope] #code-rail-splitter, [data-home-scope] #page-top, [data-home-scope] #panel-wc, [data-home-scope] #shell-drag-strip { display: none !important; }
        /* THE APP IS THE FRAME (his call, 2026-08-28): the whole workbench
           runs here — the dock parks at the top (the body-level portal it
           already uses), the agent rides the bottom, and panels opened from
           the dock render inside the attached app's bounds, the app standing
           in for the Electron window. Every SURFACE goes transparent so the
           app shows through wherever a panel isn't; the wall's tiles are
           already gone via echo-wall-hidden, and its canvas is cut. */
        [data-home-scope="agent-dock"] .code-workbench,
        [data-home-scope="agent-dock"] .ws-right-rails,
        [data-home-scope="agent-dock"] .ws-right-rail,
        [data-home-scope="agent-dock"] .ws-rail-slot,
        [data-home-scope="agent-dock"] .ws-rail-slot-body,
        [data-home-scope="agent-dock"] .ws-echo-body,
        [data-home-scope="agent-dock"] .echo-veil,
        [data-home-scope="agent-dock"] .echo-stage { background: transparent !important; }
        /* OPENING THE CC over the attached app (his spec, 2026-08-28): a
           mildly transparent THEME wash over the whole window so the wall
           reads — the app dims behind it instead of fighting the tiles. */
        [data-home-scope="agent-dock"] .ws-echo-body:has(.echo-cards.echo-shadow) {
          background: color-mix(in srgb, var(--bg) 82%, transparent) !important;
        }
        [data-home-scope="agent-dock"] .echo-stage canvas { display: none !important; }
        [data-home-scope="agent-dock"], [data-home-scope="agent-dock"] body,
        [data-home-scope="agent-dock"] #home-root, [data-home-scope="agent-dock"] #help-overlay,
        [data-home-scope="agent-dock"] #help-layout, [data-home-scope="agent-dock"] #help-content,
        [data-home-scope="agent-dock"] #page-body, [data-home-scope="agent-dock"] .help-section,
        [data-home-scope="agent-dock"] #section-code, [data-home-scope="agent-dock"] .code-root {
          background: transparent !important; box-shadow: none !important; }`;
      document.head.appendChild(style);
      document.title = "Glyphh";
      // The boot veil (body.wb-booting) is lifted by the wall-settle loop in
      // the DEFAULT boot path, which this branch returns before — drop it now
      // or this window keeps the opaque booting state forever.
      document.body.classList.remove("wb-booting");
      // Assert the covered state NOW — syncWallVisibility only re-runs when
      // cards open/close, which never happens in this window.
      document.body.classList.add("echo-wall-covered");
      // …and -hidden: the tuck (the pill sliding away until hovered) keys off
      // THIS class — covered alone leaves the agent pinned open.
      document.body.classList.add("echo-wall-hidden");
      // The dock starts tucked no matter the setting (attached mode only) —
      // syncWallVisibility keeps enforcing it, this covers the first paint.
      document.body.classList.add("echo-dock-tucked");
      gotoSection("code");
      // Click-through: only the agent's own surfaces take the mouse — a
      // POSITIVE scope; everything else forwards to the app beneath.
      // (.code-menu / #code-history / .confirm-overlay are the pill's
      // popovers that mount at body level, outside .code-agent.)
      // The dock, its parked bar, open cards, panels and their seams take the
      // mouse; the transparent field between them forwards to the app.
      const HIT = ".code-agent, .code-menu, #code-history, .confirm-overlay, dialog, "
        + ".echo-topbar, #echo-dock-layer, .echo-card, .echo-div, "
        + ".echo-dock-hotstrip, .code-drop-up, .echo-folder-modal, .echo-page-arrow";
      let ignoring = true;
      document.addEventListener("mousemove", (e) => {
        // The CC up over the app = the whole window is Glyphh's (the theme
        // wash is showing) — every pixel is interactive until it closes.
        const ccUp = !!document.querySelector(".echo-cards.echo-shadow");
        const el = document.elementFromPoint(e.clientX, e.clientY);
        const interactive = ccUp || (!!el && !!(el as HTMLElement).closest(HIT));
        if (interactive === ignoring) {
          ignoring = !interactive;
          window.glyphh.agentDockIgnoreMouse?.(ignoring);
        }
      }, { passive: true });
      return;
    }
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
  // The same surface tabs as the platform rail, Desktop side active here.
  const a = document.createElement("div");
  a.id = "builder-back-platform";
  a.className = "rail-surface-tabs rail-surface-tabs-floating";
  a.innerHTML =
    '<button id="float-tab-dashboard" type="button" class="rail-surface-tab" title="The platform dashboard">' +
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="9" rx="1.5"/><rect x="14" y="3" width="7" height="5" rx="1.5"/><rect x="14" y="12" width="7" height="9" rx="1.5"/><rect x="3" y="16" width="7" height="5" rx="1.5"/></svg><span>Dashboard</span></button>' +
    '<button type="button" class="rail-surface-tab active"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="2.5" y="4" width="19" height="12.5" rx="2"/><line x1="8.5" y1="20.5" x2="15.5" y2="20.5"/><line x1="12" y1="16.5" x2="12" y2="20.5"/></svg><span>Desktop</span></button>';
  a.querySelector("#float-tab-dashboard")?.addEventListener("click", () => window.location.assign("/platform"));
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
