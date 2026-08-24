/**
 * Settings section — model config, toggles, remote relay.
 */

import { confirmAction } from "./shared.js";
import { loadUsageChart, loadUsageMetrics, loadUsageMembers, paintDashGreeting } from "./dashboard.js";
import { initBilling, loadBilling, closeBuyForm, openBuyForm } from "./settings-billing.js";
import { initProfile, loadProfile } from "./settings-profile.js";
import { initMembers, loadMembers } from "./settings-members.js";
import { initWorkspaces, loadWorkspacesPanel } from "./settings-workspaces.js";

// The account panels are big enough to own their own modules; Settings just
// initialises them and re-exports their loaders for navigation.ts.
export { loadBilling, loadProfile, loadMembers, loadWorkspacesPanel };

// ── Settings ─────────────────────────────────────────────

// General has no footer Save — every control in it (compaction guidance,
// toggles) owns its own save.

const toggleAutoUpdate = document.getElementById("toggle-auto-update") as HTMLInputElement;
const settingsBrowserHome = document.getElementById("settings-browser-home") as HTMLSelectElement;
const settingsBrowserHomeUrl = document.getElementById("settings-browser-home-url") as HTMLInputElement;
const browserHomeCustomRow = document.getElementById("browser-home-custom-row")!;

// MCP is now its own top-level dashboard tab (data-section="mcp"). The relay
// refreshers live inside initSettings' scope, so initSettings assigns this hook
// and loadMcp() (called by navigation on section open) invokes it.
let mcpSectionRefresh: () => void = () => {};

/** Settings → Desktop: live attach status (ported from the platform's Settings →
 *  Desktop page). Polls attach.status() through the SDK handle on web; on the
 *  desktop build the machine IS this app, so it reports attached locally. */
function initDesktopPanel(): void {
  const dot = document.getElementById("desktop-attach-dot");
  const title = document.getElementById("desktop-attach-title");
  const sub = document.getElementById("desktop-attach-sub");
  const get = document.getElementById("desktop-attach-get");
  if (!dot || !title || !sub) return;

  const sdk = (window as unknown as { glyphhSdk?: { attach?: { status?: () => Promise<{ attached?: boolean; machines?: Array<{ app?: string; version?: string; capabilities?: string[] }> }> } } }).glyphhSdk;
  const isWeb = typeof document !== "undefined" && document.documentElement.classList.contains("glyphh-web");

  const paint = (attached: boolean, machine?: { app?: string; version?: string; capabilities?: string[] }) => {
    dot.className = `connection-status-dot ${attached ? "connected" : "disconnected"}`;
    title.textContent = attached ? "Desktop attached" : "No desktop attached";
    sub.textContent = attached
      ? `${machine?.app || "glyphh-desktop"} ${machine?.version || ""} · ${(machine?.capabilities?.length || 0)} capabilities`.trim()
      : "Open the Glyphh desktop app and sign in — it connects on its own.";
    get?.classList.toggle("hidden", attached);
  };

  if (!isWeb) {
    // On the desktop build this IS the machine.
    paint(true, { app: "glyphh-desktop" });
    return;
  }
  const refresh = () => {
    void sdk?.attach?.status?.()
      .then((st) => paint(!!st?.attached, st?.machines?.[0]))
      .catch(() => paint(false));
  };
  refresh();
  // Attach state flips when the desktop app opens/closes — poll while visible.
  setInterval(() => { if (!document.hidden) refresh(); }, 5000);
}

function initSettings() {
  initDesktopPanel();
  // Billing / Organization / Account-profile own their wiring; they're
  // idempotent, so init here and let the sub-nav trigger their loads.
  initBilling();
  initProfile();
  initMembers();
  initWorkspaces();
  // Compaction guidance saves ITSELF — debounced while typing, immediately on
  // blur — with the standard "Saved" flash. No Save button (General's rule:
  // every control owns its own save).
  {
    const wcp = document.getElementById("glyphh-agent-compact-prompt") as HTMLTextAreaElement | null;
    const status = document.getElementById("glyphh-agent-compact-status");
    let timer = 0;
    const save = (): void => {
      if (!wcp) return;
      const value = wcp.value.trim();
      // The loader stamps the stored value into data-saved — an untouched (or
      // reverted) field neither writes nor flashes.
      if (value === (wcp.dataset.saved ?? "")) return;
      wcp.dataset.saved = value;
      void Promise.resolve(window.glyphh.setPreference?.("glyphhCompactionPrompt", value)).then(() => {
        if (status) {
          status.textContent = "Saved";
          status.className = "set-save-state success";
          setTimeout(() => { status.textContent = ""; }, 1600);
        }
      });
    };
    wcp?.addEventListener("input", () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(save, 700);
    });
    wcp?.addEventListener("blur", () => { window.clearTimeout(timer); save(); });
  }

  // The General tab's Guardrails group folds — same disclosure grammar as
  // Billing's Auto top-up / Invoices (aria-expanded bar + hidden body).
  {
    const toggle = document.getElementById("guardrails-fold-toggle");
    toggle?.addEventListener("click", () => {
      const open = toggle.getAttribute("aria-expanded") !== "true";
      toggle.setAttribute("aria-expanded", String(open));
      document.getElementById("guardrails-fold-body")?.classList.toggle("hidden", !open);
    });
  }

  // Theme picker
  const themePicker = document.getElementById("theme-picker");
  if (themePicker) {
    window.glyphh.getTheme().then((theme) => {
      themePicker.querySelectorAll(".theme-option").forEach((btn) => {
        btn.classList.toggle("active", btn.getAttribute("data-theme") === theme);
      });
    });
    themePicker.addEventListener("click", (e) => {
      const btn = (e.target as HTMLElement).closest(".theme-option") as HTMLElement | null;
      if (!btn) return;
      const theme = btn.getAttribute("data-theme")!;
      const resolved = theme === "system"
        ? (window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark")
        : theme;
      document.documentElement.setAttribute("data-theme", resolved);
      window.glyphh.setTheme(theme);
      themePicker.querySelectorAll(".theme-option").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
    });
  }

  // Service toggles — show relaunch bar when changed
  const showRelaunch = () => {
    const bar = document.getElementById("settings-relaunch")!;
    if (bar) bar.classList.remove("hidden");
  };
  toggleAutoUpdate.addEventListener("change", () => {
    window.glyphh.setPreference("autoUpdate", toggleAutoUpdate.checked);
    showRelaunch();
  });

  // Keep-running-in-the-background — applies immediately (tray + login item),
  // no relaunch needed.
  const bgToggle = document.getElementById("toggle-background-mode") as HTMLInputElement | null;
  if (bgToggle) {
    void window.glyphh.getBackgroundMode?.().then((on) => { bgToggle.checked = !!on; }).catch(() => {});
    bgToggle.addEventListener("change", () => {
      void window.glyphh.setBackgroundMode?.(bgToggle.checked).then((on) => { bgToggle.checked = !!on; }).catch(() => {});
    });
  }


  // The cloud relay (external LLMs driving this machine) was removed. Its
  // in-page helper survives — escapeHtmlLocal is reused by the token list below.
  function escapeHtmlLocal(s: string): string {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  // ── Local MCP server (127.0.0.1) — the no-cloud alternative. Available to
  // any user (it's purely local; no org/tier involved). ──
  const localMcpSection = document.getElementById("local-mcp-section");
  const localMcpToggle = document.getElementById("local-mcp-toggle") as HTMLInputElement | null;
  const localMcpStatusEl = document.getElementById("local-mcp-status");
  const localMcpBody = document.getElementById("local-mcp-body");
  const localMcpPortInput = document.getElementById("local-mcp-port") as HTMLInputElement | null;
  const localMcpConfigEl = document.getElementById("local-mcp-config");
  const localMcpTokensListEl = document.getElementById("local-mcp-tokens-list");
  const localMcpNewTokenBox = document.getElementById("local-mcp-new-token");
  const localMcpNewTokenValue = document.getElementById("local-mcp-new-token-value");
  const localMcpLabelInput = document.getElementById("local-mcp-token-label") as HTMLInputElement | null;

  function renderLocalMcpConfig(port: number): void {
    if (!localMcpConfigEl) return;
    localMcpConfigEl.textContent = `{
  "mcpServers": {
    "glyphh-local": {
      "type": "http",
      "url": "http://127.0.0.1:${port}/mcp",
      "headers": {
        "Authorization": "Bearer <your-token>"
      }
    }
  }
}`;
  }

  async function refreshLocalMcp(): Promise<void> {
    const s = await window.glyphh.localMcpStatus();
    if (localMcpStatusEl) {
      localMcpStatusEl.textContent = s.running ? `Running on http://127.0.0.1:${s.port}` : "Stopped.";
      localMcpStatusEl.style.color = s.running ? "var(--accent)" : "var(--text-3)";
    }
    if (localMcpPortInput && document.activeElement !== localMcpPortInput) localMcpPortInput.value = String(s.port);
    renderLocalMcpConfig(s.port);
  }

  async function renderLocalMcpTokens(): Promise<void> {
    if (!localMcpTokensListEl) return;
    localMcpTokensListEl.innerHTML = "";
    const tokens = await window.glyphh.localMcpTokensList();
    if (!tokens.length) {
      localMcpTokensListEl.innerHTML = `<div style="font-size:12px;color:var(--text-3);">No tokens yet — generate one below.</div>`;
      return;
    }
    for (const t of tokens) {
      const row = document.createElement("div");
      row.style.cssText = "display:flex;align-items:center;gap:8px;padding:6px 10px;background:var(--surface-2);border:1px solid var(--border-2);border-radius:6px;margin-bottom:4px;font-size:12px;";
      const created = t.createdAt ? new Date(t.createdAt).toLocaleDateString() : "";
      const expires = t.expiresAt ? new Date(t.expiresAt).toLocaleDateString() : "";
      row.innerHTML = `<span style="flex:1;color:var(--text);">${escapeHtmlLocal(t.label || "(unnamed)")}</span><span style="color:var(--text-3);font-size:11px;">${created} → ${expires}</span><button class="action-btn danger" data-revoke="${escapeHtmlLocal(t.id)}" style="font-size:11px;padding:3px 10px;">Revoke</button>`;
      row.querySelector("[data-revoke]")!.addEventListener("click", async () => {
        if (!(await confirmAction({
          title: `Revoke “${t.label || "this token"}”?`,
          body: "Local tools using it stop working immediately.",
          confirmLabel: "Revoke token",
          danger: true,
        }))) return;
        await window.glyphh.localMcpTokensRevoke(t.id);
        void renderLocalMcpTokens();
      });
      localMcpTokensListEl.appendChild(row);
    }
  }

  function setLocalMcpBodyVisible(on: boolean): void {
    if (localMcpBody) localMcpBody.style.display = on ? "" : "none";
  }

  // The local MCP server runs ON THIS MACHINE (127.0.0.1) — a browser tab has
  // no machine to run it on, and the web bridge has no localMcp* IPC (the
  // toggle threw). Keep the whole section hidden on web.
  const mcpOnWeb = typeof document !== "undefined" && document.documentElement.classList.contains("glyphh-web");
  if (localMcpSection && localMcpToggle && !mcpOnWeb) {
    localMcpSection.classList.remove("hidden");
    void (async () => {
      const enabled = (await window.glyphh.getPreference("localMcpEnabled", false)) as boolean;
      localMcpToggle.checked = enabled;
      setLocalMcpBodyVisible(enabled);
      await refreshLocalMcp();
      await renderLocalMcpTokens();
    })();

    localMcpToggle.addEventListener("change", async () => {
      const on = localMcpToggle.checked;
      setLocalMcpBodyVisible(on);
      const res = await window.glyphh.localMcpSetEnabled(on);
      if (!res.ok && res.error) {
        if (localMcpStatusEl) {
          localMcpStatusEl.textContent = res.error;
          localMcpStatusEl.style.color = "var(--danger)";
        }
        localMcpToggle.checked = false;
        setLocalMcpBodyVisible(false);
        return;
      }
      await refreshLocalMcp();
    });

    document.getElementById("local-mcp-port-save")?.addEventListener("click", async () => {
      const port = parseInt(localMcpPortInput?.value || "", 10);
      const res = await window.glyphh.localMcpSetPort(port);
      if (!res.ok && res.error) {
        if (localMcpStatusEl) {
          localMcpStatusEl.textContent = res.error;
          localMcpStatusEl.style.color = "var(--danger)";
        }
        return;
      }
      await refreshLocalMcp();
    });

    document.getElementById("local-mcp-gen-token")?.addEventListener("click", async () => {
      const label = localMcpLabelInput?.value.trim() || "default";
      const res = await window.glyphh.localMcpTokensCreate(label);
      if (localMcpLabelInput) localMcpLabelInput.value = "";
      if (localMcpNewTokenBox && localMcpNewTokenValue) {
        localMcpNewTokenValue.textContent = res.token;
        localMcpNewTokenBox.classList.remove("hidden");
      }
      void renderLocalMcpTokens();
    });

    document.getElementById("local-mcp-copy-token")?.addEventListener("click", () => {
      const val = localMcpNewTokenValue?.textContent || "";
      window.glyphh.copyToClipboard(val);
      const btn = document.getElementById("local-mcp-copy-token") as HTMLButtonElement;
      btn.textContent = "Copied";
      setTimeout(() => { btn.textContent = "Copy"; }, 2000);
    });

    document.getElementById("local-mcp-copy-config")?.addEventListener("click", () => {
      const val = localMcpConfigEl?.textContent || "";
      window.glyphh.copyToClipboard(val);
      const btn = document.getElementById("local-mcp-copy-config") as HTMLButtonElement;
      btn.textContent = "Copied";
      setTimeout(() => { btn.textContent = "Copy"; }, 2000);
    });
  }

  // Expose the MCP refreshers so the MCP tab can refresh on open.
  mcpSectionRefresh = () => {
    void refreshLocalMcp();
    void renderLocalMcpTokens();
  };

  // Show URL Bar toggle removed — only the Browser panel shows a URL bar
  // now; everything else (Agent, Plan, Workbench, internal yo://) doesn't.

  // Browser homepage
  settingsBrowserHome.addEventListener("change", () => {
    const val = settingsBrowserHome.value;
    browserHomeCustomRow.classList.toggle("hidden", val !== "custom");
    if (val !== "custom") {
      window.glyphh.setPreference("browserHomepage", val);
    }
  });
  settingsBrowserHomeUrl.addEventListener("change", () => {
    const url = settingsBrowserHomeUrl.value.trim();
    if (url) {
      window.glyphh.setPreference("browserHomepage", "custom");
      window.glyphh.setPreference("browserHomepageUrl", url);
    }
  });

  // Show the address bar on app panels by default (roams to the server, since
  // it's not device-local). The workbench listens for the change to apply it
  // to newly-opened panels live.
  const appUrlBar = document.getElementById("settings-app-urlbar") as HTMLInputElement | null;
  appUrlBar?.addEventListener("change", () => {
    void window.glyphh.setPreference("showAppUrlBar", appUrlBar.checked);
    document.dispatchEvent(new CustomEvent("glyphh:app-urlbar-default", { detail: appUrlBar.checked }));
  });

  // Dock auto-hide (default ON) — the echo surface re-reads on the event.
  {
    const t = document.getElementById("settings-autohide-dock") as HTMLInputElement | null;
    t?.addEventListener("change", () => {
      void Promise.resolve(window.glyphh.setPreference("echoAutoHideDock", t.checked)).then(() => {
        document.dispatchEvent(new CustomEvent("glyphh:echo-autohide-changed"));
      });
    });
  }
  // Echo Agent panel transparency — applied LIVE while sliding (the CSS var
  // drives the caret panel), persisted on release.
  {
    const o = document.getElementById("settings-echo-agent-opacity") as HTMLInputElement | null;
    const ov = document.getElementById("settings-echo-agent-opacity-val");
    const paint = (): void => {
      if (!o) return;
      document.documentElement.style.setProperty("--echo-agent-opacity", o.value);
      if (ov) ov.textContent = `${Math.round(Number(o.value) * 100)}%`;
    };
    o?.addEventListener("input", paint);
    o?.addEventListener("change", () => {
      paint();
      void window.glyphh.setPreference("echoAgentOpacity", Number(o.value));
    });
  }
  // TEXT transparency — its own var, independent of the panel's.
  {
    const t = document.getElementById("settings-echo-agent-text-opacity") as HTMLInputElement | null;
    const tv = document.getElementById("settings-echo-agent-text-opacity-val");
    const paint = (): void => {
      if (!t) return;
      document.documentElement.style.setProperty("--echo-agent-text-opacity", t.value);
      if (tv) tv.textContent = `${Math.round(Number(t.value) * 100)}%`;
    };
    t?.addEventListener("input", paint);
    t?.addEventListener("change", () => {
      paint();
      void window.glyphh.setPreference("echoAgentTextOpacity", Number(t.value));
    });
  }
  // Max panel height (vh) — how tall the agent panel may grow.
  {
    const m = document.getElementById("settings-echo-agent-max-h") as HTMLInputElement | null;
    const mv = document.getElementById("settings-echo-agent-max-h-val");
    const paint = (): void => {
      if (!m) return;
      document.documentElement.style.setProperty("--echo-agent-max-h", `${m.value}vh`);
      if (mv) mv.textContent = `${m.value}%`;
    };
    m?.addEventListener("input", paint);
    m?.addEventListener("change", () => {
      paint();
      void window.glyphh.setPreference("echoAgentMaxH", Number(m.value));
    });
  }

  // Command center: icon size (live CSS var) + apps per page (the launcher
  // re-reads on the event and re-chunks its pages).
  {
    const sz = document.getElementById("settings-echo-icon-size") as HTMLInputElement | null;
    const szv = document.getElementById("settings-echo-icon-size-val");
    const paintSz = (): void => {
      if (!sz) return;
      document.documentElement.style.setProperty("--echo-icon-size", `${sz.value}px`);
      if (szv) szv.textContent = `${sz.value}px`;
    };
    sz?.addEventListener("input", paintSz);
    sz?.addEventListener("change", () => {
      paintSz();
      void window.glyphh.setPreference("echoIconSize", Number(sz.value));
    });
    const pp = document.getElementById("settings-echo-per-page") as HTMLInputElement | null;
    const ppv = document.getElementById("settings-echo-per-page-val");
    const paintPp = (): void => { if (pp && ppv) ppv.textContent = pp.value; };
    pp?.addEventListener("input", paintPp);
    pp?.addEventListener("change", () => {
      paintPp();
      void Promise.resolve(window.glyphh.setPreference("echoIconsPerPage", Number(pp.value))).then(() => {
        document.dispatchEvent(new CustomEvent("glyphh:echo-autohide-changed"));
      });
    });
  }

  // Icon hover zoom — every icon in the app scales by this on hover.
  // Applied LIVE via the CSS var; persisted like every other preference.
  {
    const z = document.getElementById("settings-icon-zoom") as HTMLInputElement | null;
    const zv = document.getElementById("settings-icon-zoom-val");
    const paint = (): void => {
      if (!z) return;
      document.documentElement.style.setProperty("--icon-zoom", z.value);
      if (zv) zv.textContent = Number(z.value) <= 1 ? "Off" : `${Math.round((Number(z.value) - 1) * 100)}%`;
    };
    z?.addEventListener("input", paint);
    z?.addEventListener("change", () => {
      paint();
      void window.glyphh.setPreference("iconHoverZoom", Number(z.value));
    });
  }

  // Dock zoom (magnification strength; 1 = off) — same live re-read event.
  {
    const z = document.getElementById("settings-dock-zoom") as HTMLInputElement | null;
    const zv = document.getElementById("settings-dock-zoom-val");
    const paint = (): void => { if (z && zv) zv.textContent = Number(z.value) <= 1 ? "Off" : `${Math.round((Number(z.value) - 1) * 100)}%`; };
    z?.addEventListener("input", paint);
    z?.addEventListener("change", () => {
      paint();
      void Promise.resolve(window.glyphh.setPreference("echoDockZoom", Number(z.value))).then(() => {
        document.dispatchEvent(new CustomEvent("glyphh:echo-autohide-changed"));
      });
    });
  }

  // Interface sound volume (his ask, 2026-08-19) — pref uiSoundVolume 0..1,
  // server-backed like every pref (/api/me/prefs → db). Live: dragging updates
  // the running volume at once and plays a sample tick so the level is
  // audible while choosing it.
  {
    const z = document.getElementById("general-ui-sound") as HTMLInputElement | null;
    const zv = document.getElementById("general-ui-sound-val");
    const paint = (): void => { if (z && zv) zv.textContent = Number(z.value) <= 0 ? "Off" : `${z.value}%`; };
    const w = window as unknown as { __uiSoundSetVolume?: (v: number) => void; __uiSound?: (k: "tick" | "focus") => void };
    z?.addEventListener("input", () => {
      paint();
      w.__uiSoundSetVolume?.(Number(z.value) / 100);
      w.__uiSound?.("tick");
    });
    z?.addEventListener("change", () => {
      paint();
      void window.glyphh.setPreference("uiSoundVolume", Number(z.value) / 100);
    });
  }

  // WEB on a TOUCH device (tablet / iPad-as-Mac): the door back to the mobile
  // app — the twin of mobile's Appearance → "Desktop site" toggle. Flipping it
  // clears the glyphh_force_desktop escape hatch (which is what keeps a tablet
  // pinned to this layout) and lands on /m. Hidden everywhere else: Electron
  // has no mobile shell, and a fine-pointer desktop was never redirected.
  {
    const row = document.getElementById("settings-mobile-ui-row");
    const toggle = document.getElementById("settings-mobile-ui") as HTMLInputElement | null;
    const onWeb = !!(window as unknown as { __GLYPHH_WEB__?: boolean }).__GLYPHH_WEB__;
    let coarse = false;
    try { coarse = window.matchMedia("(pointer: coarse)").matches; } catch { /* keep hidden */ }
    if (row && toggle && onWeb && coarse) {
      row.classList.remove("hidden");
      toggle.addEventListener("change", () => {
        if (!toggle.checked) return;
        try { localStorage.removeItem("glyphh_force_desktop"); } catch { /* private mode */ }
        window.location.href = "/m";
      });
    }
  }

  // Relaunch button
  document.getElementById("settings-relaunch-btn")?.addEventListener("click", () => {
    window.glyphh.relaunch();
  });

  // (Glyphh Skill export moved to its own Skills page — see help/skills.ts.)

  // "Manage account" is gone from the identity header — this panel IS that
  // page, so a button opening the platform's copy of it was a loop.

  // Refresh plan status — after an in-app upgrade/downgrade the cached session
  // tier is stale until the next heartbeat (or re-login). This forces a fresh
  // heartbeat and repaints the Plan chip, no re-auth needed.
  document.getElementById("account-refresh-tier")?.addEventListener("click", async (ev) => {
    ev.stopPropagation();
    const btn = document.getElementById("account-refresh-tier");
    btn?.classList.add("spinning");
    try {
      const r = await window.glyphh.refreshAuth();
      if (r?.tier) paintPlanChip(r.tier);
    } catch { /* offline — leave the current value */ }
    finally { setTimeout(() => btn?.classList.remove("spinning"), 400); }
  });

  // Sign out
  document.getElementById("account-logout-btn")?.addEventListener("click", async () => {
    document.getElementById("help-overlay")!.classList.add("hidden");
    await window.glyphh.logout();
  });

}

/** The plan chip — highlighted only when the plan is a paid one. */
function paintPlanChip(tier?: string | null): void {
  const el = document.getElementById("account-tier");
  const chip = el?.closest(".acct-chip-plan");
  if (!el) return;
  el.textContent = tier || "—";
  chip?.classList.toggle("paid", !!tier && tier !== "free");
}


let uaWired = false;

/** The APP's Usage view (plan-limits look) — monthly allowance bar + reset,
 *  purchased credits, refresh, auto-top-up toggle. Platform skips it. */
async function loadUsageAppView(): Promise<void> {
  if (document.body.classList.contains("platform-shell")) return;
  const el = (id: string) => document.getElementById(id);
  if (!el("usage-app-view")) return;
  closeBuyForm();
  if (!uaWired) {
    uaWired = true;
    el("ua-refresh")?.addEventListener("click", () => void loadUsageAppView());
    // Buy usage credits → the shared Need-more-usage form (settings-billing
    // owns it; Billing opens the same one breadcrumbed ← Billing).
    el("ua-buy")?.addEventListener("click", () => openBuyForm("usage"));
    // Adjust limit → the in-tab spend-limit form (← Usage brings the page back).
    const showLimitForm = (on: boolean) => {
      el("ua-main")?.classList.toggle("hidden", on);
      el("ua-limit-form")?.classList.toggle("hidden", !on);
    };
    el("ua-adjust-limit")?.addEventListener("click", () => {
      void (async () => {
        const cap = Number(await window.glyphh.getPreference?.("billingMonthlyCapUsd", 0)) || 0;
        (el("ua-limit-input") as HTMLInputElement).value = cap > 0 ? String(cap) : "";
        showLimitForm(true);
        (el("ua-limit-input") as HTMLInputElement | null)?.focus();
      })();
    });
    el("ua-limit-back")?.addEventListener("click", () => showLimitForm(false));
    el("ua-limit-cancel")?.addEventListener("click", () => showLimitForm(false));
    el("ua-limit-save")?.addEventListener("click", () => {
      void (async () => {
        const cap = Math.max(0, Number((el("ua-limit-input") as HTMLInputElement).value) || 0);
        await window.glyphh.setPreference?.("billingMonthlyCapUsd", cap);
        const capEl = el("ua-cap");
        if (capEl) capEl.textContent = cap > 0 ? `$${cap.toLocaleString()}` : "Unlimited";
        showLimitForm(false);
      })();
    });
    const toggle = el("ua-autotopup") as HTMLInputElement | null;
    toggle?.addEventListener("change", () => {
      void (async () => {
        const api = window.glyphh as unknown as {
          billingAutotopupGet: () => Promise<{ enabled: boolean; thresholdCredits: number; topupCredits: number }>;
          billingAutotopupSet: (i: { enabled: boolean; thresholdCredits: number; topupCredits: number }) => Promise<{ ok: boolean }>;
        };
        try {
          const cfg = await api.billingAutotopupGet();
          await api.billingAutotopupSet({ ...cfg, enabled: toggle.checked });
        } catch { toggle.checked = !toggle.checked; }
        const st = el("ua-reload-state");
        if (st) st.textContent = toggle.checked ? "On" : "Off";
      })();
    });
  }
  const yo = window.glyphh as unknown as {
    billingStatus: () => Promise<{ tier: string; billingStatus: string }>;
    billingCredits: () => Promise<{ balance: number; allowance: number; grants: number; purchases: number }>;
    billingAutotopupGet: () => Promise<{ enabled: boolean; thresholdCredits: number; topupCredits: number }>;
    billingAutotopupSet: (i: { enabled: boolean; thresholdCredits: number; topupCredits: number }) => Promise<{ ok: boolean }>;
  };
  try {
    const [status, credits, topup] = await Promise.all([
      yo.billingStatus(),
      yo.billingCredits(),
      yo.billingAutotopupGet().catch(() => null),
    ]);
    const tier = (status?.tier || "free");
    const planEl = el("ua-plan");
    if (planEl) planEl.textContent = `Glyphh ${tier.charAt(0).toUpperCase()}${tier.slice(1)}`;
    // MICRO-credits on the wire. Used = the month's allowance minus what's
    // left of the grant lot; purchased credits sit in their own lot.
    const allowance = Math.max(0, credits?.allowance ?? 0);
    const grants = Math.max(0, credits?.grants ?? 0);
    const used = Math.max(0, allowance - grants);
    const pct = allowance > 0 ? Math.min(100, Math.round((used / allowance) * 100)) : 0;
    const fill = el("ua-month-fill");
    if (fill) fill.style.width = `${pct}%`;
    const pctEl = el("ua-month-pct");
    if (pctEl) pctEl.textContent = allowance > 0 ? `${pct}% used` : "—";
    const reset = new Date();
    reset.setMonth(reset.getMonth() + 1, 1);
    const resetEl = el("ua-month-reset");
    if (resetEl) resetEl.textContent = `Resets ${reset.toLocaleDateString(undefined, { month: "short", day: "numeric" })}`;
    const spentEl = el("ua-spent");
    if (spentEl) spentEl.textContent = `${Math.floor(used / 1_000_000).toLocaleString()} credits`;
    const spentReset = el("ua-spent-reset");
    if (spentReset) spentReset.textContent = resetEl?.textContent ?? "";
    const balEl = el("ua-balance");
    if (balEl) balEl.textContent = Math.floor((credits?.balance ?? 0) / 1_000_000).toLocaleString();
    const t = el("ua-autotopup") as HTMLInputElement | null;
    if (t && topup) t.checked = !!topup.enabled;
    const reload = el("ua-reload-state");
    if (reload) reload.textContent = topup?.enabled ? "On" : "Off";
    const cap = Number(await window.glyphh.getPreference?.("billingMonthlyCapUsd", 0)) || 0;
    const capEl = el("ua-cap");
    if (capEl) capEl.textContent = cap > 0 ? `$${cap.toLocaleString()}` : "Unlimited";
    const upd = el("ua-updated");
    if (upd) upd.textContent = `Last updated: ${new Date().toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}`;
  } catch { /* offline — the view keeps its dashes */ }
}

async function loadSettings() {
  // Settings › Usage owns the usage chart + metric cards now.
  paintDashGreeting();
  void loadUsageAppView();
  void loadUsageChart();
  void loadUsageMetrics();
  void loadUsageMembers();
  // Account's profile form loads with Settings rather than waiting on a
  // sub-nav click; the org record lives on Organization › General now and
  // loads there.
  void loadProfile();
  // Members hides its own nav item unless the caller is an org admin, so this
  // has to run on Settings open, not only when the tab is clicked.
  void loadMembers();
  // Workspaces hides its own nav item unless the caller is an org admin.
  void loadWorkspacesPanel();
  // Glyphh: standing compaction guidance + training capture
  const wcp = document.getElementById("glyphh-agent-compact-prompt") as HTMLTextAreaElement | null;
  if (wcp) {
    wcp.value = String((await window.glyphh.getPreference?.("glyphhCompactionPrompt", "")) || "");
    // Baseline for the auto-save (initSettings): unchanged content never writes.
    wcp.dataset.saved = wcp.value.trim();
  }

  // The Account header's ORG + PLAN chips. Name, email, role and the avatar
  // come from the server profile via loadProfile() — one painter each, so the
  // two loads can't race over the same element.
  const accountInfo = await window.glyphh.getAccountInfo();
  const orgEl = document.getElementById("account-org")!;
  orgEl.textContent = accountInfo?.orgName || "—";
  paintPlanChip(accountInfo?.tier);

  // Load toggle states
  toggleAutoUpdate.checked = await window.glyphh.getPreference("autoUpdate", true) as boolean;

  const mcpSectionWrap = document.getElementById("mcp-section-wrap")!;
  mcpSectionWrap.classList.remove("hidden");

  // Browser homepage
  const homePref = await window.glyphh.getPreference("browserHomepage", "claude") as string;
  settingsBrowserHome.value = homePref === "custom" ? "custom" : homePref;
  browserHomeCustomRow.classList.toggle("hidden", homePref !== "custom");
  if (homePref === "custom") {
    settingsBrowserHomeUrl.value = await window.glyphh.getPreference("browserHomepageUrl", "") as string;
  }
  const appUrlBar = document.getElementById("settings-app-urlbar") as HTMLInputElement | null;
  if (appUrlBar) appUrlBar.checked = await window.glyphh.getPreference("showAppUrlBar", true) as boolean;

  // Dock auto-hide — defaults ON; zoom defaults 20%.
  const ahDock = document.getElementById("settings-autohide-dock") as HTMLInputElement | null;
  if (ahDock) ahDock.checked = (await window.glyphh.getPreference("echoAutoHideDock", true)) !== false;
  const agTx = document.getElementById("settings-echo-agent-text-opacity") as HTMLInputElement | null;
  if (agTx) {
    const raw = Number(await window.glyphh.getPreference("echoAgentTextOpacity", 1));
    agTx.value = String(Number.isFinite(raw) ? Math.max(0.25, Math.min(1, raw)) : 1);
    const tv = document.getElementById("settings-echo-agent-text-opacity-val");
    if (tv) tv.textContent = `${Math.round(Number(agTx.value) * 100)}%`;
  }
  const agMh = document.getElementById("settings-echo-agent-max-h") as HTMLInputElement | null;
  if (agMh) {
    const raw = Number(await window.glyphh.getPreference("echoAgentMaxH", 76));
    agMh.value = String(Number.isFinite(raw) ? Math.max(20, Math.min(100, raw)) : 76);
    const mv = document.getElementById("settings-echo-agent-max-h-val");
    if (mv) mv.textContent = `${agMh.value}%`;
  }
  const agOp = document.getElementById("settings-echo-agent-opacity") as HTMLInputElement | null;
  if (agOp) {
    const raw = Number(await window.glyphh.getPreference("echoAgentOpacity", 0.92));
    agOp.value = String(Number.isFinite(raw) ? Math.max(0.25, Math.min(1, raw)) : 0.92);
    const ov = document.getElementById("settings-echo-agent-opacity-val");
    if (ov) ov.textContent = `${Math.round(Number(agOp.value) * 100)}%`;
  }
  const echoSz = document.getElementById("settings-echo-icon-size") as HTMLInputElement | null;
  if (echoSz) {
    const raw = Number(await window.glyphh.getPreference("echoIconSize", 76));
    echoSz.value = String(Number.isFinite(raw) ? Math.max(48, Math.min(104, raw)) : 76);
    const szv = document.getElementById("settings-echo-icon-size-val");
    if (szv) szv.textContent = `${echoSz.value}px`;
  }
  const echoPp = document.getElementById("settings-echo-per-page") as HTMLInputElement | null;
  if (echoPp) {
    const raw = Number(await window.glyphh.getPreference("echoIconsPerPage", 56));
    echoPp.value = String(Number.isFinite(raw) ? Math.max(16, Math.min(96, raw)) : 56);
    const ppv = document.getElementById("settings-echo-per-page-val");
    if (ppv) ppv.textContent = echoPp.value;
  }
  const iconZoom = document.getElementById("settings-icon-zoom") as HTMLInputElement | null;
  if (iconZoom) {
    const raw = Number(await window.glyphh.getPreference("iconHoverZoom", 1.08));
    iconZoom.value = String(Number.isFinite(raw) ? Math.max(1, Math.min(1.5, raw)) : 1.08);
    const zv = document.getElementById("settings-icon-zoom-val");
    if (zv) zv.textContent = Number(iconZoom.value) <= 1 ? "Off" : `${Math.round((Number(iconZoom.value) - 1) * 100)}%`;
  }
  const snd = document.getElementById("general-ui-sound") as HTMLInputElement | null;
  if (snd) {
    const raw = Number(await window.glyphh.getPreference("uiSoundVolume", 0.3));
    const v = Number.isFinite(raw) ? Math.max(0, Math.min(1, raw)) : 0.3;
    snd.value = String(Math.round(v * 100));
    const zv = document.getElementById("general-ui-sound-val");
    if (zv) zv.textContent = v <= 0 ? "Off" : `${Math.round(v * 100)}%`;
  }
  const zoom = document.getElementById("settings-dock-zoom") as HTMLInputElement | null;
  if (zoom) {
    const zRaw = Number(await window.glyphh.getPreference("echoDockZoom", 1.2));
    zoom.value = String(Number.isFinite(zRaw) ? Math.max(1, Math.min(1.5, zRaw)) : 1.2);
    const zv = document.getElementById("settings-dock-zoom-val");
    if (zv) zv.textContent = Number(zoom.value) <= 1 ? "Off" : `${Math.round((Number(zoom.value) - 1) * 100)}%`;
  }
}

/** MCP is its own top-level dashboard tab (data-section="mcp"). navigation.ts
 *  calls this on section open to refresh relay + expose state. */
export function loadMcp(): void { mcpSectionRefresh(); }

export { loadSettings, initSettings };
