/**
 * Settings section — model config, toggles, remote relay.
 */

import { confirmAction } from "./shared.js";
import { loadUsageChart, loadUsageMetrics, loadUsageMembers } from "./dashboard.js";
import { initBilling, loadBilling } from "./settings-billing.js";
import { initProfile, loadProfile } from "./settings-profile.js";
import { initOrg, loadOrg } from "./settings-org.js";
import { initMembers, loadMembers } from "./settings-members.js";
import { initWorkspaces, loadWorkspacesPanel } from "./settings-workspaces.js";

// The account panels are big enough to own their own modules; Settings just
// initialises them and re-exports their loaders for navigation.ts.
export { loadBilling, loadProfile, loadOrg, loadMembers, loadWorkspacesPanel };

// ── Settings ─────────────────────────────────────────────

// General has no footer Save — every control in it (compaction guidance,
// toggles) owns its own save.

const toggleAutoUpdate = document.getElementById("toggle-auto-update") as HTMLInputElement;

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
  initOrg();
  initMembers();
  initWorkspaces();
  // Compaction guidance retired (2026-08-22) — it advised the agent's context
  // compaction; the agent is gone.

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

  // Browser homepage + app-panel URL bar retired (2026-08-22) — the Browser
  // tool died with the dev-tools cut.

  // Echo Agent panel transparency — applied LIVE while sliding (the CSS var
  // drives the caret panel), persisted on release.
  // TEXT transparency — its own var, independent of the panel's.
  // Max panel height (vh) — how tall the agent panel may grow.

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


async function loadSettings() {
  // Settings › Usage owns the usage chart + metric cards now.
  void loadUsageChart();
  void loadUsageMetrics();
  void loadUsageMembers();
  // Account's profile form and the org section sit under the same panel as the
  // identity header, so they load with Settings rather than waiting on a
  // sub-nav click. loadOrg hides its section unless the caller is an org admin.
  void loadProfile();
  void loadOrg();
  // Members hides its own nav item unless the caller is an org admin, so this
  // has to run on Settings open, not only when the tab is clicked.
  void loadMembers();
  // Workspaces hides its own nav item unless the caller is an org admin.
  void loadWorkspacesPanel();

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
}

/** MCP is its own top-level dashboard tab (data-section="mcp"). navigation.ts
 *  calls this on section open to refresh relay + expose state. */
export function loadMcp(): void { mcpSectionRefresh(); }

export { loadSettings, initSettings };
