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
    // ── @-mention summon ─────────────────────────────────────────────────
    // "@<provider-alias>-<model-alias> prompt…" + Enter in ANY shell input
    // opens the ghost overlay on that model with a fresh session and the
    // prompt seeded (e.g. "@an-fable ship it"). The alias table is cached
    // from main so matching is SYNCHRONOUS — Enter is consumed only when the
    // mention actually resolves; everything else passes through untouched.
    // Registered in EVERY home window, the ghost included — a mention typed in
    // the ghost's composer re-summons it on the new model with a new session.
    if ((window.glyphh as unknown as { mentionCatalog?: unknown }).mentionCatalog) {
      let mentionPairs: Record<string, string> | null = null;
      const loadMentions = () => {
        void window.glyphh.mentionCatalog?.().then((r) => { if (r?.ok && r.pairs) mentionPairs = r.pairs; }).catch(() => {});
      };
      loadMentions();
      document.addEventListener("keydown", (e) => {
        if (e.key !== "Enter" || e.isComposing || e.shiftKey) return;
        const t = e.target as HTMLElement;
        const field = t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement;
        if (!field && !t.isContentEditable) return;
        const raw = field ? (t as HTMLInputElement | HTMLTextAreaElement).value : (t.textContent || "");
        const m = raw.trim().match(/^@([^\s-]+)-(\S+)(?:\s+([\s\S]*))?$/);
        if (!m) return;
        if (!mentionPairs) { loadMentions(); return; } // table still loading — let this Enter pass
        const modelId = mentionPairs[`${m[1].toLowerCase()}-${m[2].toLowerCase()}`];
        if (!modelId) return; // not a known alias pair — normal send
        e.preventDefault();
        e.stopImmediatePropagation();
        if (field) {
          (t as HTMLInputElement | HTMLTextAreaElement).value = "";
          t.dispatchEvent(new Event("input", { bubbles: true }));
        } else {
          t.textContent = "";
        }
        void window.glyphh.ghostSummon?.(modelId, (m[3] || "").trim());
      }, true);
    }
    // GHOST MODE (?solo=ghost): the coding agent as a translucent overlay over
    // whatever app is in front — a floating glass card on a dim, blurred backdrop
    // that lets the app behind show through. A global hotkey toggles the window;
    // Esc or a backdrop click asks main to dismiss it.
    if (solo === "ghost") {
      document.documentElement.setAttribute("data-home-scope", "ghost");
      document.documentElement.setAttribute("data-ghost", "1");
      // Which frost variant main gave this window (real OS material vs CSS fake).
      document.documentElement.setAttribute("data-ghost-frost", params.get("gfrost") === "css" ? "css" : "os");
      const style = document.createElement("style");
      style.textContent = `
        [data-home-scope] #app-rail, [data-home-scope] #code-rail-splitter, [data-home-scope] #page-top, [data-home-scope] #panel-wc, [data-home-scope] #shell-drag-strip { display: none !important; }
        /* JUST THE AGENT (his fix, 2026-08-28): the ghost is the agent
           attached to the bottom of the target app, exactly as it attaches
           to the bottom of the Glyphh window — its normal center-anchor
           card over the frost. The workbench (wall, dock, rails, panels)
           never renders here. */
        [data-ghost="1"] .code-workbench, [data-ghost="1"] #code-wb-edge,
        [data-ghost="1"] #echo-dock-layer, [data-ghost="1"] .echo-dock-hotstrip { display: none !important; }
        /* Ghost: the WINDOW itself is the card — a mostly-transparent frosted
           panel floating over the active app (no full-screen dim backdrop). */
        :root[data-ghost="1"], [data-ghost="1"] body { background: transparent !important; overflow: hidden !important; }
        [data-ghost="1"] .code-root {
          position: fixed; inset: 0; z-index: 1;
          border-radius: 10px; overflow: hidden;
          border: 1px solid rgba(255, 255, 255, 0.12);
          /* OS-frost variant: a real material (vibrancy/acrylic) blurs the app
             behind, so the scrim is a tint over it — dark enough that white
             apps behind don't wash out the transcript. */
          background: rgba(8, 6, 12, 0.55) !important;
          animation: ghost-in 0.16s ease both;
        }
        /* CSS-frost variant ("Reduce transparency" on, or no material): the OS
           can't blur, so FAKE the frost — fine noise + soft tinted gradients
           over a see-through dark veil. Fuzzy-looking, app still readable. */
        [data-ghost-frost="css"] .code-root {
          background:
            url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='140' height='140'><filter id='n'><feTurbulence type='fractalNoise' baseFrequency='0.85' numOctaves='2' stitchTiles='stitch'/><feColorMatrix type='saturate' values='0'/><feComponentTransfer><feFuncA type='linear' slope='0.06'/></feComponentTransfer></filter><rect width='140' height='140' filter='url(%23n)'/></svg>"),
            radial-gradient(120% 90% at 18% 0%, rgba(90, 70, 140, 0.16), transparent 58%),
            radial-gradient(110% 90% at 100% 100%, rgba(50, 40, 90, 0.14), transparent 60%),
            rgba(10, 8, 16, 0.72) !important;
        }
        /* let the frosted glass show through the agent's own opaque surfaces */
        [data-ghost="1"] .code-workbench { margin-top: 38px; }
        [data-ghost="1"] .code-workbench, [data-ghost="1"] .ws-right-rails, [data-ghost="1"] .ws-right-rail,
        [data-ghost="1"] .ws-rail-slot, [data-ghost="1"] .ws-rail-slot-body, [data-ghost="1"] .code-agent { background: transparent !important; }
        @keyframes ghost-in { from { opacity: 0; transform: scale(0.99); } to { opacity: 1; transform: scale(1); } }
        /* thin top strip to drag the panel over the app, + a close button */
        #ghost-drag { position: fixed; top: 0; left: 0; right: 40px; height: 16px; z-index: 140; -webkit-app-region: drag; }
        #ghost-close { position: fixed; top: 8px; right: 10px; z-index: 150; width: 26px; height: 26px; border-radius: 7px; display: flex; align-items: center; justify-content: center; cursor: pointer; color: rgba(255, 255, 255, 0.72); background: rgba(255, 255, 255, 0.08); border: 1px solid rgba(255, 255, 255, 0.14); -webkit-app-region: no-drag; }
        #ghost-close:hover { background: rgba(255, 255, 255, 0.18); color: #fff; }
        #ghost-cc {
          position: fixed; top: 8px; left: 50%; transform: translateX(-50%); z-index: 150;
          width: 26px; height: 26px; border-radius: 7px;
          display: flex; align-items: center; justify-content: center; cursor: pointer;
          color: rgba(255, 255, 255, 0.72); background: rgba(255, 255, 255, 0.08);
          border: 1px solid rgba(255, 255, 255, 0.14); -webkit-app-region: no-drag;
        }
        #ghost-cc:hover { background: rgba(255, 255, 255, 0.18); color: #fff; }
        #ghost-snap {
          position: fixed; top: 8px; left: 10px; z-index: 150;
          display: flex; gap: 4px; -webkit-app-region: no-drag;
        }
        #ghost-snap button {
          width: 24px; height: 24px; border-radius: 6px; padding: 0;
          display: flex; align-items: center; justify-content: center; cursor: pointer;
          color: rgba(255, 255, 255, 0.62); background: rgba(255, 255, 255, 0.08);
          border: 1px solid rgba(255, 255, 255, 0.14);
        }
        #ghost-snap button:hover { background: rgba(255, 255, 255, 0.18); color: #fff; }
        #ghost-snap button.on { color: #fff; border-color: rgba(255, 255, 255, 0.45); }
        /* Resize grips — a transparent frameless window gets no reliable
           native edge zones, so the overlay paints its own (right, bottom,
           corner) and drives the window size over IPC. */
        .ghost-grip { position: fixed; z-index: 320; -webkit-app-region: no-drag; }
        #ghost-grip-e { top: 16px; right: 0; bottom: 12px; width: 10px; cursor: ew-resize; }
        #ghost-grip-s { left: 12px; right: 12px; bottom: 0; height: 8px; cursor: ns-resize; }
        #ghost-grip-se { right: 0; bottom: 0; width: 16px; height: 16px; cursor: nwse-resize; }`;
      document.head.appendChild(style);
      const close = () => (window.glyphh as unknown as { ghostClose?: () => void }).ghostClose?.();
      const drag = document.createElement("div");
      drag.id = "ghost-drag";
      document.body.appendChild(drag);
      const closeBtn = document.createElement("div");
      closeBtn.id = "ghost-close";
      closeBtn.title = "Close (Esc)";
      closeBtn.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><line x1="6" y1="6" x2="18" y2="18"/><line x1="18" y1="6" x2="6" y2="18"/></svg>`;
      closeBtn.addEventListener("click", close);
      document.body.appendChild(closeBtn);
      // Snap the ghost over a HALF of the target app — or the whole thing.
      // The pick persists (main re-applies it on the next summon).
      const snapWrap = document.createElement("div");
      snapWrap.id = "ghost-snap";
      const R = (x: number, y: number, w: number, h: number, fill = false): string =>
        `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="1.5"${fill ? ` fill="currentColor" stroke="none"` : ""}/>`;
      const SNAPS: Array<{ half: string; title: string; inner: string }> = [
        { half: "full", title: "Cover the whole app", inner: R(4, 5, 16, 14) },
        { half: "left", title: "Left half", inner: R(4, 5, 16, 14) + R(4, 5, 8, 14, true) },
        { half: "right", title: "Right half", inner: R(4, 5, 16, 14) + R(12, 5, 8, 14, true) },
        { half: "top", title: "Top half", inner: R(4, 5, 16, 14) + R(4, 5, 16, 7, true) },
        { half: "bottom", title: "Bottom half", inner: R(4, 5, 16, 14) + R(4, 12, 16, 7, true) },
      ];
      const ghostSnapApi = window.glyphh as unknown as { ghostSnap?: (h: string) => Promise<{ ok: boolean; half?: string }> };
      for (const sn of SNAPS) {
        const b = document.createElement("button");
        b.type = "button";
        b.title = sn.title;
        b.dataset.half = sn.half;
        b.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6">${sn.inner}</svg>`;
        b.addEventListener("click", () => {
          void ghostSnapApi.ghostSnap?.(sn.half).then((r) => {
            if (!r?.ok) return;
            snapWrap.querySelectorAll("button").forEach((x) => x.classList.toggle("on", x === b));
          });
        });
        snapWrap.appendChild(b);
      }
      document.body.appendChild(snapWrap);
      // Reflect the persisted snap as the active button on open.
      void window.glyphh.getPreference?.("ghostSnapHalf", "full").then((h) => {
        snapWrap.querySelectorAll<HTMLButtonElement>("button").forEach((x) => x.classList.toggle("on", x.dataset.half === h));
      }).catch(() => { /* default: none highlighted */ });
      // Grip drag → window resize. Bounds are read once at pointerdown and the
      // target size is absolute (start + delta), so IPC latency can't compound
      // into drift; moves are throttled to one in-flight call.
      const ghostApi = window.glyphh as unknown as {
        ghostBounds?: () => Promise<{ width: number; height: number } | null>;
        ghostResize?: (size: { width?: number; height?: number }) => Promise<{ ok: boolean }>;
      };
      const addGrip = (id: string, east: boolean, south: boolean): void => {
        const g = document.createElement("div");
        g.id = id;
        g.className = "ghost-grip";
        g.addEventListener("pointerdown", (e) => {
          e.preventDefault();
          g.setPointerCapture(e.pointerId);
          const sx = e.screenX, sy = e.screenY;
          void ghostApi.ghostBounds?.().then((start) => {
            if (!start) return;
            let inFlight = false;
            let next: { width?: number; height?: number } | null = null;
            const send = (size: { width?: number; height?: number }): void => {
              if (inFlight) { next = size; return; }
              inFlight = true;
              void ghostApi.ghostResize?.(size).then(() => {
                inFlight = false;
                if (next) { const n = next; next = null; send(n); }
              });
            };
            const onMove = (ev: PointerEvent): void => send({
              ...(east ? { width: start.width + (ev.screenX - sx) } : {}),
              ...(south ? { height: start.height + (ev.screenY - sy) } : {}),
            });
            const onUp = (): void => {
              g.removeEventListener("pointermove", onMove);
              g.removeEventListener("pointerup", onUp);
              g.removeEventListener("pointercancel", onUp);
            };
            g.addEventListener("pointermove", onMove);
            g.addEventListener("pointerup", onUp);
            g.addEventListener("pointercancel", onUp);
          });
        });
        document.body.appendChild(g);
      };
      addGrip("ghost-grip-e", true, false);
      addGrip("ghost-grip-s", false, true);
      addGrip("ghost-grip-se", true, true);
      document.addEventListener("keydown", (e) => { if (e.key === "Escape") { e.preventDefault(); close(); } });
      document.title = "Glyphh Ghost";
      gotoSection("code");
      // THE AGENT PRESENTS EXACTLY AS IT DOES OVER A COVERED WALL (his spec,
      // 2026-08-28: "just like it does in the glyphh echo panel"): docked to
      // the bottom, collapsed to the composer, expanding on hover/focus —
      // all of it the echo-wall-hidden styling and whatever the user's
      // settings configure, not a ghost-specific presentation. The target
      // app behind the glass IS the covering panel, so the class simply
      // states the truth; the workbench's own sync (which sees no panels
      // here) would strip it, so a body-class observer holds it on.
      document.body.classList.add("echo-wall-hidden");
      new MutationObserver(() => {
        if (!document.body.classList.contains("echo-wall-hidden")) document.body.classList.add("echo-wall-hidden");
      }).observe(document.body, { attributes: true, attributeFilter: ["class"] });
      // Summon context ("@an-fable ship it"): once the agent mounts, start a
      // fresh session with the prompt seeded and select the mentioned model on
      // the current loop's primary role.
      const gmodel = params.get("gmodel") || "";
      const gprompt = params.get("gprompt") || "";
      if (gmodel || gprompt) {
        let stries = 0;
        const applySummon = () => {
          const sess = (window as unknown as { __agentSessions?: { startNew: () => void } }).__agentSessions;
          if ((!document.querySelector(".code-input") || !sess) && stries++ < 120) { requestAnimationFrame(applySummon); return; }
          if (gprompt) seedNewSession(gprompt);
          else sess?.startNew();
          if (gmodel) void (window as unknown as { __agentUseModel?: (m: string) => Promise<boolean> }).__agentUseModel?.(gmodel);
        };
        applySummon();
      }
      // Land ready to type: focus the agent's composer as soon as it mounts,
      // so the hotkey → prompt flow needs zero clicks. The immediate focus can
      // lose to the window's own focus dance (the OS is still handing focus to
      // the overlay while the DOM mounts), so re-assert shortly after and every
      // time the ghost window itself gains focus.
      const focusComposer = () => document.querySelector<HTMLElement>(".code-input")?.focus();
      let ftries = 0;
      const focusInput = () => {
        const inp = document.querySelector<HTMLElement>(".code-input");
        if (inp) { inp.focus(); setTimeout(focusComposer, 250); }
        else if (ftries++ < 90) requestAnimationFrame(focusInput);
      };
      focusInput();
      window.addEventListener("focus", () => setTimeout(focusComposer, 0));
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
