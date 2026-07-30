/**
 * Home app — entry point for the home.html section panels (loaded as
 * home.html?section=<slug> for each system-app tab: Apps / Layouts / Drips /
 * Skills / Settings / About). Runs in a dedicated BrowserView with the full
 * window.yo API.
 */

import { initHelp, gotoSection } from "./help/index.js";
import { openCommandCenter, seedNewSession } from "./help/code.js";
import { initSearchClears } from "./search-clear.js";

// Theme: the inline script in home.html applied localStorage theme synchronously.
// Here we re-fetch the authoritative value from main and keep localStorage in sync.
function applyTheme(theme: string) {
  const resolved = theme === "system"
    ? (window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark")
    : theme;
  document.documentElement.setAttribute("data-theme", resolved);
  try { localStorage.setItem("yoTheme", theme); } catch {}
}

window.yo.getTheme?.().then(applyTheme).catch(() => {});
window.yo.onThemeChanged?.(applyTheme);

// React to system dark/light changes when theme = "system"
window.matchMedia("(prefers-color-scheme: light)").addEventListener("change", async () => {
  try {
    const theme = await window.yo.getTheme();
    if (theme === "system") applyTheme(theme);
  } catch {}
});

initHelp();
initSearchClears();
window.yo.refreshAuth?.().catch(() => {});

// Full-bleed chrome — the panel covers the titlebar strip, so it owns the
// window controls and the command button (page-top, left of which sits the
// rail toggle wired by code.ts).
document.getElementById("panel-btn-close")?.addEventListener("click", () => window.yo.windowClose());
document.getElementById("panel-btn-minimize")?.addEventListener("click", () => window.yo.windowMinimize());
document.getElementById("panel-btn-maximize")?.addEventListener("click", () => window.yo.windowMaximize());
// Pick the startup section. Priority: ?section=<slug> in the URL (system-app
// panel mounted as its own section) → the user's configured default
// ("homeStartupSection", blank = "last viewed") → the last section → dashboard.
void (async () => {
  // System-app panels (yo://apps, yo://layouts, …) load home.html with a
  // ?section=<slug> query. When set, this panel is locked to that section.
  try {
    const params = new URLSearchParams(window.location.search);
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
    {
      let mentionPairs: Record<string, string> | null = null;
      const loadMentions = () => {
        void window.yo.mentionCatalog?.().then((r) => { if (r?.ok && r.pairs) mentionPairs = r.pairs; }).catch(() => {});
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
        void window.yo.ghostSummon?.(modelId, (m[3] || "").trim());
      }, true);
    }
    // Command-center DESKTOP OVERLAY host (?solo=cc): a transparent
    // fullscreen window whose only content is the command center.
    if (solo === "cc") {
      document.documentElement.setAttribute("data-home-scope", "solo-cc");
      (window as unknown as { __ccOverlayHost?: boolean }).__ccOverlayHost = true;
      const style = document.createElement("style");
      style.textContent = `
        [data-home-scope] #app-rail, [data-home-scope] #code-rail-splitter, [data-home-scope] #page-top, [data-home-scope] #panel-wc, [data-home-scope] #shell-drag-strip { display: none !important; }
        [data-home-scope="solo-cc"] .code-root { display: none !important; }
        :root[data-home-scope="solo-cc"], [data-home-scope="solo-cc"] body { background: transparent !important; }
        [data-home-scope="solo-cc"] .command-center { background: rgba(0,0,0,.45); }`;
      document.head.appendChild(style);
      openCommandCenter();
      // The overlay lives exactly as long as the switcher: Esc or picking an
      // item removes #command-center from the DOM — close the window with it.
      document.addEventListener("keydown", (e) => { if (e.key === "Escape") window.close(); });
      let seen = false;
      const mo = new MutationObserver(() => {
        if (document.getElementById("command-center")) seen = true;
        else if (seen) { mo.disconnect(); window.close(); }
      });
      mo.observe(document.body, { childList: true });
      return;
    }
    // GHOST MODE (?solo=ghost): the coding agent as a translucent overlay over
    // whatever app is in front — a floating glass card on a dim, blurred backdrop
    // that lets the app behind show through. A global hotkey toggles the window;
    // Esc or a backdrop click asks main to dismiss it.
    if (solo === "ghost") {
      document.documentElement.setAttribute("data-home-scope", "solo-tool");
      document.documentElement.setAttribute("data-ghost", "1");
      // Which frost variant main gave this window (real OS material vs CSS fake).
      document.documentElement.setAttribute("data-ghost-frost", params.get("gfrost") === "css" ? "css" : "os");
      const style = document.createElement("style");
      style.textContent = `
        [data-home-scope] #app-rail, [data-home-scope] #code-rail-splitter, [data-home-scope] #page-top, [data-home-scope] #panel-wc, [data-home-scope] #shell-drag-strip { display: none !important; }
        [data-home-scope="solo-tool"] .code-root > .code-agent, [data-home-scope="solo-tool"] #code-wb-edge { display: none !important; }
        [data-home-scope="solo-tool"] .code-workbench { flex: 1 1 auto !important; border-left: none !important; }
        [data-home-scope="solo-tool"] .ws-right-rails { width: 100% !important; }
        /* NO forced rail flex here (unlike a single-tool window): the ghost
           hosts MULTIPLE rails — width:auto!important overrode the computed
           rail widths and let a fresh editor swallow the pane. */
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
      const close = () => (window.yo as unknown as { ghostClose?: () => void }).ghostClose?.();
      const drag = document.createElement("div");
      drag.id = "ghost-drag";
      document.body.appendChild(drag);
      const closeBtn = document.createElement("div");
      closeBtn.id = "ghost-close";
      closeBtn.title = "Close (Esc)";
      closeBtn.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><line x1="6" y1="6" x2="18" y2="18"/><line x1="18" y1="6" x2="6" y2="18"/></svg>`;
      closeBtn.addEventListener("click", close);
      document.body.appendChild(closeBtn);
      // Command center from inside the ghost — centered over the pane's top.
      const ccBtn = document.createElement("div");
      ccBtn.id = "ghost-cc";
      ccBtn.title = "Command center (⌘⇧Space)";
      ccBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/></svg>`;
      ccBtn.addEventListener("click", () => openCommandCenter({ forceInline: true }));
      document.body.appendChild(ccBtn);
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
      const ghostSnapApi = window.yo as unknown as { ghostSnap?: (h: string) => Promise<{ ok: boolean; half?: string }> };
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
      void window.yo.getPreference?.("ghostSnapHalf", "full").then((h) => {
        snapWrap.querySelectorAll<HTMLButtonElement>("button").forEach((x) => x.classList.toggle("on", x.dataset.half === h));
      }).catch(() => { /* default: none highlighted */ });
      // Grip drag → window resize. Bounds are read once at pointerdown and the
      // target size is absolute (start + delta), so IPC latency can't compound
      // into drift; moves are throttled to one in-flight call.
      const ghostApi = window.yo as unknown as {
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
      // The CODING tile's × dismisses the WHOLE overlay (closing just the agent
      // would leave an empty ghost) — capture phase so the slot handler can't
      // run first. Other slots' × close normally: just that panel.
      document.addEventListener("click", (e) => {
        const btn = (e.target as HTMLElement).closest?.(".slot-close");
        if (!btn) return;
        const slot = (btn as HTMLElement).closest(".ws-rail-slot");
        if (slot?.querySelector(".ws-coding-body, .code-agent")) { e.preventDefault(); e.stopPropagation(); close(); }
      }, true);
      document.title = "Glyphh Ghost";
      gotoSection("code");
      const payload = {
        cols: 1, colWidths: [], rowHeights: [],
        cells: [{ slug: "tool:coding", name: "Coding Agent", url: "", glyphh: false, col: 0, row: 0, tool: "coding" }],
      };
      const w = window as unknown as { __wbOpenLayout?: (l: typeof payload) => void };
      let tries = 0;
      const go = () => { if (w.__wbOpenLayout) w.__wbOpenLayout(payload); else if (tries++ < 40) requestAnimationFrame(go); };
      go();
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
        preview: "Browser", coding: "Coding Agent", diff: "Diff", monaco: "Editor",
        files: "Files", plan: "Plan", terminal: "Terminal",
      };
      const kind = solo.slice(5);
      document.title = `${SOLO_LABELS[kind] || kind} — Glyphh`;
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
  // 2.5.0: the app loads into the HOME screen at startup. Period.
  gotoSection("dashboard");
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

  btn.addEventListener("click", () => { window.yo.updateInstall?.(); });

  window.yo.onUpdateStatus?.((info) => {
    if (info.status === "ready") show(info.version || "");
    else if (info.status === "restarting" || info.status === "none") btn.classList.add("hidden");
  });

  // Panels mount after boot — ask main whether an update is already waiting.
  const pending = await window.yo.getUpdateStatus?.();
  if (pending?.ready) show(pending.version);
})();
