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
  // Screen layout — dock mode picker (fraction comes from dragging the edge).
  const slPicker = document.getElementById("screen-layout-picker");
  if (slPicker) {
    const paintSl = (mode: string) => {
      slPicker.querySelectorAll<HTMLElement>(".layout-mode-btn").forEach((b) =>
        b.classList.toggle("active", b.dataset.mode === mode));
    };
    void window.yo.screenLayoutGet?.().then((sl) => paintSl(sl?.mode || "full")).catch(() => paintSl("full"));
    slPicker.addEventListener("click", (e) => {
      const btn = (e.target as HTMLElement).closest<HTMLElement>(".layout-mode-btn");
      if (!btn) return;
      const mode = btn.dataset.mode || "full";
      paintSl(mode);
      void window.yo.screenLayoutSet?.({ mode });
    });
  }

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
    // Enable/disable toggle — lets the user turn the cloud relay off (e.g. to
    // use only the local server). Flips the pref, then bounces the WS.
    const relayToggle = document.getElementById("relay-enabled-toggle") as HTMLInputElement | null;
    if (relayToggle) {
      relayToggle.checked = (await window.yo.getPreference("relayEnabled", true)) as boolean;
      relayToggle.addEventListener("change", async () => {
        await window.yo.setPreference("relayEnabled", relayToggle.checked);
        await window.yo.relayReconnect();
        void refreshRelayStatus();
      });
    }
    renderRelayConfig();
    void refreshRelayStatus();
    void refreshRelayTokens();
    setInterval(refreshRelayStatus, 3_000);
  })();

  // ── Org-wide guardrails (Settings > Security). org_admin only; non-admins
  // see the read-only note. Server-authoritative via /api/org/guardrails. ──
  void (async () => {
    const acct = await window.yo.getAccountInfo();
    const role = acct?.role || "";
    if (role !== "org_admin" && role !== "super_admin") return; // note stays, form hidden
    document.getElementById("security-admin-note")?.classList.add("hidden");
    document.getElementById("security-guardrails")?.classList.remove("hidden");

    // input id → guardrails_policy key
    const FIELD_MAP: Array<[string, string]> = [
      ["org-gr-max-input", "maxInputTokens"],
      ["org-gr-max-output", "maxOutputTokens"],
      ["org-gr-window", "windowSeconds"],
      ["org-gr-window-tokens", "windowTokens"],
      ["org-gr-window-calls", "windowCalls"],
      ["org-gr-concurrent", "maxConcurrent"],
    ];
    const inputEl = (id: string) => document.getElementById(id) as HTMLInputElement | null;

    // Reasonable defaults, prefilled when the org has no saved value — matches
    // the per-app Guardrails defaults and stays under the server floor.
    const DEFAULT_GUARDRAILS: Record<string, number> = {
      maxInputTokens: 16000, maxOutputTokens: 4000, windowSeconds: 60,
      windowTokens: 200000, windowCalls: 100, maxConcurrent: 4,
    };
    const loaded = await window.yo.orgGuardrailsGet();
    const policy = (loaded.ok && loaded.policy) ? loaded.policy : {};
    for (const [id, key] of FIELD_MAP) {
      const el = inputEl(id);
      if (el) el.value = String(typeof policy[key] === "number" ? policy[key] : DEFAULT_GUARDRAILS[key]);
    }

    const statusEl = document.getElementById("org-gr-status");
    document.getElementById("org-gr-save")?.addEventListener("click", async () => {
      const policy: Record<string, number> = {};
      for (const [id, key] of FIELD_MAP) {
        const raw = (inputEl(id)?.value ?? "").trim();
        if (raw === "") continue;                     // blank = no limit for that field
        const n = Math.max(0, Math.floor(Number(raw)));
        if (Number.isFinite(n)) policy[key] = n;
      }
      const value = Object.keys(policy).length ? policy : null;
      if (statusEl) statusEl.textContent = "Saving…";
      const r = await window.yo.orgGuardrailsSet(value);
      if (statusEl) {
        statusEl.textContent = r.ok ? "Saved ✓" : (r.error || "Save failed");
        setTimeout(() => { if (statusEl.textContent === "Saved ✓") statusEl.textContent = ""; }, 3000);
      }
    });
  })();

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
    const s = await window.yo.localMcpStatus();
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
    const tokens = await window.yo.localMcpTokensList();
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
        if (!(await confirmAction(`Revoke "${t.label || "this token"}"? Local tools using it will stop working.`))) return;
        await window.yo.localMcpTokensRevoke(t.id);
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
      const enabled = (await window.yo.getPreference("localMcpEnabled", false)) as boolean;
      localMcpToggle.checked = enabled;
      setLocalMcpBodyVisible(enabled);
      await refreshLocalMcp();
      await renderLocalMcpTokens();
    })();

    localMcpToggle.addEventListener("change", async () => {
      const on = localMcpToggle.checked;
      setLocalMcpBodyVisible(on);
      const res = await window.yo.localMcpSetEnabled(on);
      if (!res.ok && res.error) {
        if (localMcpStatusEl) {
          localMcpStatusEl.textContent = res.error;
          localMcpStatusEl.style.color = "#d44a4a";
        }
        localMcpToggle.checked = false;
        setLocalMcpBodyVisible(false);
        return;
      }
      await refreshLocalMcp();
    });

    document.getElementById("local-mcp-port-save")?.addEventListener("click", async () => {
      const port = parseInt(localMcpPortInput?.value || "", 10);
      const res = await window.yo.localMcpSetPort(port);
      if (!res.ok && res.error) {
        if (localMcpStatusEl) {
          localMcpStatusEl.textContent = res.error;
          localMcpStatusEl.style.color = "#d44a4a";
        }
        return;
      }
      await refreshLocalMcp();
    });

    document.getElementById("local-mcp-gen-token")?.addEventListener("click", async () => {
      const label = localMcpLabelInput?.value.trim() || "default";
      const res = await window.yo.localMcpTokensCreate(label);
      if (localMcpLabelInput) localMcpLabelInput.value = "";
      if (localMcpNewTokenBox && localMcpNewTokenValue) {
        localMcpNewTokenValue.textContent = res.token;
        localMcpNewTokenBox.classList.remove("hidden");
      }
      void renderLocalMcpTokens();
    });

    document.getElementById("local-mcp-copy-token")?.addEventListener("click", () => {
      const val = localMcpNewTokenValue?.textContent || "";
      window.yo.copyToClipboard(val);
      const btn = document.getElementById("local-mcp-copy-token") as HTMLButtonElement;
      btn.textContent = "Copied";
      setTimeout(() => { btn.textContent = "Copy"; }, 2000);
    });

    document.getElementById("local-mcp-copy-config")?.addEventListener("click", () => {
      const val = localMcpConfigEl?.textContent || "";
      window.yo.copyToClipboard(val);
      const btn = document.getElementById("local-mcp-copy-config") as HTMLButtonElement;
      btn.textContent = "Copied";
      setTimeout(() => { btn.textContent = "Copy"; }, 2000);
    });
  }

  // Expose the MCP refreshers so the MCP tab can refresh on open.
  mcpSectionRefresh = () => {
    void refreshRelayStatus();
    void refreshRelayTokens();
    void refreshLocalMcp();
    void renderLocalMcpTokens();
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

  // (Glyphh Skill export moved to its own Skills page — see help/skills.ts.)

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
  mcpSectionWrap.classList.remove("hidden");

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
