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
  initOrg();
  initMembers();
  initWorkspaces();
  document.getElementById("glyphh-agent-compact-save")?.addEventListener("click", () => {
    const wcp = document.getElementById("glyphh-agent-compact-prompt") as HTMLTextAreaElement | null;
    const status = document.getElementById("glyphh-agent-compact-status");
    void Promise.resolve(window.glyphh.setPreference?.("glyphhCompactionPrompt", (wcp?.value || "").trim())).then(() => {
      if (status) { status.textContent = "Saved."; setTimeout(() => { status.textContent = ""; }, 1800); }
    });
  });

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

  if (localMcpSection && localMcpToggle) {
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
  // Glyphh: standing compaction guidance + training capture
  const wcp = document.getElementById("glyphh-agent-compact-prompt") as HTMLTextAreaElement | null;
  if (wcp) wcp.value = String((await window.glyphh.getPreference?.("glyphhCompactionPrompt", "")) || "");

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
}

/** MCP is its own top-level dashboard tab (data-section="mcp"). navigation.ts
 *  calls this on section open to refresh relay + expose state. */
export function loadMcp(): void { mcpSectionRefresh(); }

export { loadSettings, initSettings };
