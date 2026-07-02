/**
 * Settings section — model config, toggles, remote relay.
 */

import { confirmAction } from "./shared.js";

// ── Settings ─────────────────────────────────────────────

const settingsSaveBtn = document.getElementById("settings-save") as HTMLButtonElement;
const settingsStatus = document.getElementById("settings-status")!;

const toggleAutoUpdate = document.getElementById("toggle-auto-update") as HTMLInputElement;
const settingsTimezone = document.getElementById("settings-timezone") as HTMLSelectElement;
const settingsBrowserHome = document.getElementById("settings-browser-home") as HTMLSelectElement;
const settingsBrowserHomeUrl = document.getElementById("settings-browser-home-url") as HTMLInputElement;
const browserHomeCustomRow = document.getElementById("browser-home-custom-row")!;

// MCP is now its own top-level dashboard tab (data-section="mcp"). The relay
// refreshers live inside initSettings' scope, so initSettings assigns this hook
// and loadMcp() (called by navigation on section open) invokes it.
let mcpSectionRefresh: () => void = () => {};

function initSettings() {
  settingsSaveBtn.addEventListener("click", saveSettings);

  // Theme picker
  const themePicker = document.getElementById("theme-picker");
  if (themePicker) {
    window.yo.getTheme().then((theme) => {
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
      window.yo.setTheme(theme);
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
    window.yo.setPreference("autoUpdate", toggleAutoUpdate.checked);
    showRelaunch();
  });


  // ── MCP relay wiring (org-admin only). The relay is the only MCP surface,
  // so there is no enable toggle — it connects whenever the account is
  // eligible, and this section just shows status + connection config. ──
  const relaySection = document.getElementById("relay-section");
  const relayStatusText = document.getElementById("relay-status-text");
  const relayConfigExample = document.getElementById("relay-config-example");
  const relayTokensList = document.getElementById("relay-tokens-list");
  const relayNewTokenBox = document.getElementById("relay-new-token");
  const relayNewTokenValue = document.getElementById("relay-new-token-value");
  const relayLabelInput = document.getElementById("relay-token-label") as HTMLInputElement;

  function renderRelayConfig(): void {
    const relayUrl = `${window.yo.serverUrl}/mcp`;
    const endpointEl = document.getElementById("relay-endpoint");
    if (endpointEl) endpointEl.textContent = `POST ${relayUrl}`;
    if (relayConfigExample) {
      relayConfigExample.textContent = `{
  "mcpServers": {
    "yo-relay": {
      "type": "http",
      "url": "${relayUrl}",
      "headers": {
        "Authorization": "Bearer <your-token>"
      }
    }
  }
}`;
    }
    const claudeCmd = document.getElementById("relay-claude-cmd");
    if (claudeCmd) {
      claudeCmd.textContent =
        `claude mcp add --transport http yo-relay ${relayUrl} --header "Authorization: Bearer <your-token>"`;
    }
  }

  async function refreshRelayStatus(): Promise<void> {
    if (!relayStatusText) return;
    const s = await window.yo.relayStatus();
    const label = !s.signedIn ? "Sign in first."
      : !s.enabled ? "Disabled."
      : s.state === "connected" ? `Connected to ${new URL(window.yo.serverUrl).host}`
      : s.state === "connecting" ? "Connecting…"
      : s.state === "disconnected" ? "Disconnected — retrying"
      : "Off";
    relayStatusText.textContent = label;
    relayStatusText.style.color = s.state === "connected" ? "var(--accent)" : "var(--text-3)";
  }

  function tokenRow(t: { id: string; label: string; createdAt: string; expiresAt: string }): HTMLElement {
    const row = document.createElement("div");
    row.style.cssText = "display:flex;align-items:center;gap:8px;padding:6px 10px;background:var(--surface-2);border:1px solid var(--border-2);border-radius:6px;margin-bottom:4px;font-size:12px;";
    const created = t.createdAt ? new Date(t.createdAt).toLocaleDateString() : "";
    const expires = t.expiresAt ? new Date(t.expiresAt).toLocaleDateString() : "";
    row.innerHTML = `
      <span style="flex:1;color:var(--text);">${escapeHtmlLocal(t.label || "(unnamed)")}</span>
      <span style="color:var(--text-3);font-size:11px;">${created} → ${expires}</span>
      <button class="action-btn danger" data-revoke="${escapeHtmlLocal(t.id)}" style="font-size:11px;padding:3px 10px;">Revoke</button>`;
    row.querySelector("[data-revoke]")!.addEventListener("click", async () => {
      if (!(await confirmAction(`Revoke "${t.label || "this token"}"? External tools using it will stop working.`))) return;
      const res = await window.yo.relayTokensRevoke(t.id);
      if ("error" in res) { flashRelayError(`Could not revoke: ${res.error}`); return; }
      void refreshRelayTokens();
    });
    return row;
  }

  function escapeHtmlLocal(s: string): string {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  /** Transient inline error for the relay-token section — no native popups. */
  function flashRelayError(msg: string): void {
    if (!relayTokensList) return;
    const el = document.createElement("div");
    el.style.cssText = "font-size:12px;color:#d44a4a;margin-bottom:6px;";
    el.textContent = msg;
    relayTokensList.prepend(el);
    setTimeout(() => el.remove(), 4000);
  }

  async function refreshRelayTokens(): Promise<void> {
    if (!relayTokensList) return;
    relayTokensList.innerHTML = "";
    const res = await window.yo.relayTokensList();
    if ("error" in res) {
      relayTokensList.innerHTML = `<div style="font-size:12px;color:var(--text-3);">Could not load tokens: ${escapeHtmlLocal(res.error)}</div>`;
      return;
    }
    const tokens = res as Array<{ id: string; label: string; createdAt: string; expiresAt: string }>;
    if (tokens.length === 0) {
      relayTokensList.innerHTML = `<div style="font-size:12px;color:var(--text-3);">No tokens yet — generate one below.</div>`;
      return;
    }
    for (const t of tokens) relayTokensList.appendChild(tokenRow(t));
  }

  document.getElementById("relay-gen-token")!.addEventListener("click", async () => {
    const label = relayLabelInput.value.trim() || "default";
    const res = await window.yo.relayTokensCreate(label);
    if ("error" in res) { flashRelayError(`Could not create token: ${res.error}`); return; }
    relayLabelInput.value = "";
    if (relayNewTokenBox && relayNewTokenValue) {
      relayNewTokenValue.textContent = res.token;
      relayNewTokenBox.classList.remove("hidden");
    }
    void refreshRelayTokens();
  });

  document.getElementById("relay-copy-new-token")!.addEventListener("click", () => {
    const val = relayNewTokenValue?.textContent || "";
    window.yo.copyToClipboard(val);
    const btn = document.getElementById("relay-copy-new-token") as HTMLButtonElement;
    btn.textContent = "Copied";
    setTimeout(() => { btn.textContent = "Copy"; }, 2000);
  });

  document.getElementById("relay-install-claude")!.addEventListener("click", async () => {
    const token = relayNewTokenValue?.textContent || "";
    if (!token) return;
    const btn = document.getElementById("relay-install-claude") as HTMLButtonElement;
    const status = document.getElementById("relay-install-status");
    btn.disabled = true;
    btn.textContent = "Installing…";
    const res = await window.yo.relayInstallClaude(token);
    btn.disabled = false;
    btn.textContent = "Install in Claude code";
    if (status) {
      status.style.display = "block";
      if ("error" in res) {
        status.textContent = `✗ ${res.error}`;
        status.style.color = "var(--danger)";
      } else {
        status.textContent = `✓ Installed to ${res.path}`;
        status.style.color = "var(--text)";
      }
    }
  });

  document.getElementById("relay-copy-config")!.addEventListener("click", () => {
    const val = relayConfigExample?.textContent || "";
    window.yo.copyToClipboard(val);
    const btn = document.getElementById("relay-copy-config") as HTMLButtonElement;
    btn.textContent = "Copied";
    setTimeout(() => { btn.textContent = "Copy"; }, 2000);
  });

  document.getElementById("relay-copy-claude-cmd")!.addEventListener("click", () => {
    const val = document.getElementById("relay-claude-cmd")?.textContent || "";
    window.yo.copyToClipboard(val);
    const btn = document.getElementById("relay-copy-claude-cmd") as HTMLButtonElement;
    btn.textContent = "Copied";
    setTimeout(() => { btn.textContent = "Copy"; }, 2000);
  });

  // Gate the whole subsection to org_admin / super_admin. Non-admins see
  // nothing (the platform UI is also admin-only, so this is consistent).
  void (async () => {
    const acct = await window.yo.getAccountInfo();
    const role = acct?.role || "";
    const allowed = role === "org_admin" || role === "super_admin";
    if (!allowed) return;                              // leave .hidden
    relaySection?.classList.remove("hidden");
    renderRelayConfig();
    void refreshRelayStatus();
    void refreshRelayTokens();
    setInterval(refreshRelayStatus, 3_000);
  })();

  // Expose the MCP refreshers so the MCP tab can refresh on open.
  mcpSectionRefresh = () => {
    void refreshRelayStatus();
    void refreshRelayTokens();
  };

  // Show URL Bar toggle removed — only the Browser panel shows a URL bar
  // now; everything else (Agent, Plan, Workbench, internal yo://) doesn't.

  // Timezone — persists to the user's server profile (shared with platform).
  settingsTimezone.addEventListener("change", () => {
    void window.yo.userTimezoneSet(settingsTimezone.value);
  });

  // Browser homepage
  settingsBrowserHome.addEventListener("change", () => {
    const val = settingsBrowserHome.value;
    browserHomeCustomRow.classList.toggle("hidden", val !== "custom");
    if (val !== "custom") {
      window.yo.setPreference("browserHomepage", val);
    }
  });
  settingsBrowserHomeUrl.addEventListener("change", () => {
    const url = settingsBrowserHomeUrl.value.trim();
    if (url) {
      window.yo.setPreference("browserHomepage", "custom");
      window.yo.setPreference("browserHomepageUrl", url);
    }
  });

  // Relaunch button
  document.getElementById("settings-relaunch-btn")?.addEventListener("click", () => {
    window.yo.relaunch();
  });

  // Export a Glyphh skill for an external LLM (Claude / Gemini / OpenAI).
  const exportSkillStatus = document.getElementById("export-skill-status");
  for (const btn of Array.from(document.querySelectorAll<HTMLButtonElement>("[id^='export-skill-']"))) {
    const provider = btn.dataset.provider;
    if (!provider) continue;
    btn.addEventListener("click", async () => {
      if (exportSkillStatus) { exportSkillStatus.textContent = "Saving…"; exportSkillStatus.style.color = "var(--text-3)"; }
      const res = await window.yo.exportGlyphhSkill(provider);
      if (!exportSkillStatus) return;
      if (res.ok) {
        exportSkillStatus.textContent = `Saved ${res.path}`;
        exportSkillStatus.style.color = "var(--text-2)";
      } else if (res.error !== "Canceled") {
        exportSkillStatus.textContent = `✗ ${res.error}`;
        exportSkillStatus.style.color = "var(--danger)";
      } else {
        exportSkillStatus.textContent = "";
      }
    });
  }

  // Manage Account — open the platform inside the app (a panel tab), the same
  // way the left-rail Platform button does (.dip <platformUrl>).
  document.getElementById("account-dashboard-btn")?.addEventListener("click", () => {
    void window.yo.execCommand(`dip ${window.yo.platformUrl}`);
  });

  // Refresh plan status — after an in-app upgrade/downgrade the cached session
  // tier is stale until the next heartbeat (or re-login). This forces a fresh
  // heartbeat and repaints the Plan value, no re-auth needed.
  document.getElementById("account-refresh-tier")?.addEventListener("click", async () => {
    const btn = document.getElementById("account-refresh-tier");
    const tierEl = document.getElementById("account-tier");
    btn?.classList.add("spinning");
    try {
      const r = await window.yo.refreshAuth();
      if (tierEl && r?.tier) {
        tierEl.textContent = r.tier;
        tierEl.className = `license-value ${r.tier !== "free" ? "active" : ""}`;
      }
    } catch { /* offline — leave the current value */ }
    finally { setTimeout(() => btn?.classList.remove("spinning"), 400); }
  });

  // Sign out
  document.getElementById("account-logout-btn")?.addEventListener("click", async () => {
    document.getElementById("help-overlay")!.classList.add("hidden");
    await window.yo.logout();
  });
}


async function loadSettings() {
  settingsStatus.textContent = "";
  const accountInfo = await window.yo.getAccountInfo();

  // Account info
  const emailEl = document.getElementById("account-email")!;
  const nameEl = document.getElementById("account-name")!;
  const orgEl = document.getElementById("account-org")!;
  const tierEl = document.getElementById("account-tier")!;

  if (accountInfo) {
    emailEl.textContent = accountInfo.email;
    nameEl.textContent = `${accountInfo.firstName} ${accountInfo.lastName}`;
    orgEl.textContent = accountInfo.orgName;
    tierEl.textContent = accountInfo.tier || "free";
    tierEl.className = `license-value ${accountInfo.tier !== "free" ? "active" : ""}`;
  } else {
    emailEl.textContent = "Not signed in";
    nameEl.textContent = "—";
    orgEl.textContent = "—";
    tierEl.textContent = "—";
  }

  // Load toggle states
  toggleAutoUpdate.checked = await window.yo.getPreference("autoUpdate", true) as boolean;

  const mcpSectionWrap = document.getElementById("mcp-section-wrap")!;
  const mcpProGate = document.getElementById("mcp-pro-gate")!;
  mcpSectionWrap.classList.remove("hidden");
  mcpProGate.classList.add("hidden");

  // Timezone dropdown — same option list as the platform's Settings > Profile
  // page (Intl.supportedValuesOf), value read from the user's server profile
  // (users.timezone), not a local preference.
  try {
    const allTz = (Intl as any).supportedValuesOf("timeZone") as string[];
    settingsTimezone.innerHTML = "";
    for (const tz of allTz.includes("UTC") ? allTz : ["UTC", ...allTz]) {
      const opt = document.createElement("option");
      opt.value = tz;
      opt.textContent = tz.replace(/_/g, " ");
      settingsTimezone.appendChild(opt);
    }
  } catch {
    settingsTimezone.innerHTML = `<option value="UTC">UTC</option>`;
  }
  const serverTz = await window.yo.userTimezoneGet().catch(() => null);
  settingsTimezone.value = serverTz || "UTC";

  // Browser homepage
  const homePref = await window.yo.getPreference("browserHomepage", "claude") as string;
  settingsBrowserHome.value = homePref === "custom" ? "custom" : homePref;
  browserHomeCustomRow.classList.toggle("hidden", homePref !== "custom");
  if (homePref === "custom") {
    settingsBrowserHomeUrl.value = await window.yo.getPreference("browserHomepageUrl", "") as string;
  }
}

async function saveSettings() {
  // Model selection moved to Agent Defaults — General now only owns timezone +
  // toggles, which save inline via their own change handlers. The Save button
  // is kept as a no-op confirmation for now.
  settingsSaveBtn.disabled = true;
  settingsSaveBtn.textContent = "Saved!";
  settingsStatus.textContent = "Saved!";
  settingsStatus.className = "settings-success";
  setTimeout(() => {
    settingsSaveBtn.disabled = false;
    settingsSaveBtn.textContent = "Save";
  }, 1000);
}

/** MCP is its own top-level dashboard tab (data-section="mcp"). navigation.ts
 *  calls this on section open to refresh relay + expose state. */
export function loadMcp(): void { mcpSectionRefresh(); }

export { loadSettings, initSettings };
