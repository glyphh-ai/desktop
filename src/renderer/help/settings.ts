/**
 * Settings section — model config, toggles, MCP expose, tool overrides.
 */

// ── Settings ─────────────────────────────────────────────

const settingsSaveBtn = document.getElementById("settings-save") as HTMLButtonElement;
const settingsStatus = document.getElementById("settings-status")!;

const toggleAutoUpdate = document.getElementById("toggle-auto-update") as HTMLInputElement;
const mcpExposeStatus = document.getElementById("mcp-expose-status")!;
const mcpExposePort = document.getElementById("mcp-expose-port") as HTMLInputElement;
const mcpExposeTokensEl = document.getElementById("mcp-expose-tokens")!;
const settingsTimezone = document.getElementById("settings-timezone") as HTMLSelectElement;
const settingsBrowserHome = document.getElementById("settings-browser-home") as HTMLSelectElement;
const settingsBrowserHomeUrl = document.getElementById("settings-browser-home-url") as HTMLInputElement;
const browserHomeCustomRow = document.getElementById("browser-home-custom-row")!;

async function refreshMcpExposeStatus() {
  const status = await window.yo.mcpExposeStatus();
  const port = status.port || parseInt(mcpExposePort.value, 10) || 7860;
  if (status.running) {
    mcpExposeStatus.textContent = `Running on http://127.0.0.1:${port}`;
    mcpExposeStatus.style.color = "var(--text)";
  } else {
    mcpExposeStatus.textContent = "Starting...";
    mcpExposeStatus.style.color = "var(--text-2)";
  }
  const configEl = document.getElementById("mcp-expose-config-example");
  if (configEl) {
    configEl.textContent = `{
  "mcpServers": {
    "glyphh": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "http://127.0.0.1:${port}/sse", "--header", "Authorization: Bearer <your-token>"]
    }
  }
}`;
  }
}

async function renderMcpTokens() {
  const tokens = await window.yo.mcpExposeGetTokens();
  mcpExposeTokensEl.innerHTML = "";
  if (tokens.length === 0) {
    mcpExposeTokensEl.innerHTML = '<span style="font-size:11px;color:var(--text-2);">No tokens yet. Generate one to connect an external tool.</span>';
    return;
  }
  for (const t of tokens) {
    const row = document.createElement("div");
    row.style.cssText = "display:flex;align-items:center;gap:8px;margin-bottom:6px;padding:6px 10px;background:var(--surface-2);border-radius:6px;";

    const label = document.createElement("span");
    label.style.cssText = "flex:1;font-size:12px;color:var(--text);";
    label.textContent = t.label || "Untitled";

    const created = document.createElement("span");
    created.style.cssText = "font-size:11px;color:var(--text-2);font-family:'SF Mono','Fira Code',monospace;";
    created.textContent = new Date(t.createdAt).toLocaleDateString();

    const expiresMs = new Date(t.expiresAt).getTime();
    const isNever = expiresMs > new Date("9990-01-01").getTime();
    const daysLeft = Math.ceil((expiresMs - Date.now()) / 86400000);
    const expires = document.createElement("span");
    expires.style.cssText = `font-size:11px;font-family:'SF Mono','Fira Code',monospace;color:${!isNever && daysLeft <= 7 ? "var(--danger)" : "var(--text-2)"};`;
    expires.textContent = isNever ? "Never expires" : `Expires ${new Date(t.expiresAt).toLocaleDateString()}`;

    const copy = document.createElement("button");
    copy.className = "action-btn";
    copy.style.cssText = "font-size:10px;padding:2px 8px;";
    copy.textContent = "Copy";
    copy.addEventListener("click", () => {
      window.yo.copyToClipboard(t.token);
      copy.textContent = "Copied";
      setTimeout(() => { copy.textContent = "Copy"; }, 1500);
    });

    const revoke = document.createElement("button");
    revoke.className = "action-btn danger";
    revoke.style.cssText = "font-size:10px;padding:2px 8px;";
    revoke.textContent = "Revoke";
    revoke.addEventListener("click", async () => {
      await window.yo.mcpExposeRevokeToken(t.token);
      await renderMcpTokens();
    });

    row.appendChild(label);
    row.appendChild(created);
    row.appendChild(expires);
    row.appendChild(copy);
    row.appendChild(revoke);
    mcpExposeTokensEl.appendChild(row);
  }
}

// ── BYOK provider keys (Phase 1 of THE-PIVOT-BYOK) ──────────

interface ProviderRow {
  id: string;
  label: string;
  hint: string;
  keyExample: string;
  keysUrl: string;
}

const PROVIDER_ROWS: ProviderRow[] = [
  { id: "anthropic",   label: "Anthropic (Claude)",     hint: "Claude chat outside the agent loop and read-only swarm agents on Claude.", keyExample: "sk-ant-…",  keysUrl: "https://console.anthropic.com/settings/keys" },
  { id: "openai",      label: "OpenAI",                 hint: "GPT-4 / GPT-5 across swarm agents and direct chat.",                       keyExample: "sk-proj-…", keysUrl: "https://platform.openai.com/api-keys" },
  { id: "google",      label: "Google AI (Gemini)",     hint: "Gemini family models in swarm agents and direct chat.",                    keyExample: "AIza…",     keysUrl: "https://aistudio.google.com/apikey" },
  { id: "xai",         label: "xAI (Grok)",             hint: "Grok models in read-only swarm agents and direct chat.",                   keyExample: "xai-…",     keysUrl: "https://console.x.ai" },
  { id: "perplexity",  label: "Perplexity",             hint: "Perplexity search-grounded models in read-only swarm agents.",             keyExample: "pplx-…",    keysUrl: "https://www.perplexity.ai/settings/api" },
];

async function renderProviderKeys() {
  const container = document.getElementById("provider-keys-list");
  if (!container) return;
  const status = await window.yo.providerKeysList();
  const byId = new Map(status.map((s) => [s.provider, s]));
  const allModels = await window.yo.providerModelsGetAll().catch(() => ({} as Record<string, { default: string; models: string[] }>));
  container.innerHTML = "";

  for (const row of PROVIDER_ROWS) {
    const s = byId.get(row.id);
    const card = document.createElement("div");
    card.style.cssText = "background:var(--surface-2);border-radius:8px;padding:12px 14px;border:1px solid var(--border);";

    // Header row: label + status badge
    const head = document.createElement("div");
    head.style.cssText = "display:flex;align-items:center;justify-content:space-between;margin-bottom:6px;";
    const label = document.createElement("div");
    label.style.cssText = "font-weight:600;";
    label.textContent = row.label;
    const badge = document.createElement("span");
    badge.style.cssText = "font-size:11px;padding:2px 8px;border-radius:4px;font-weight:500;";
    if (!s?.configured) {
      badge.textContent = "not set";
      badge.style.background = "var(--surface-3)";
      badge.style.color = "var(--text-3)";
    } else if (s.lastTestOk === false) {
      badge.textContent = "invalid";
      badge.style.background = "rgba(212,74,74,0.18)";
      badge.style.color = "#d44a4a";
    } else if (s.lastTestOk) {
      badge.textContent = "verified";
      badge.style.background = "rgba(140, 59, 242,0.18)";
      badge.style.color = "var(--text)";
    } else {
      badge.textContent = "configured";
      badge.style.background = "rgba(165,165,255,0.18)";
      badge.style.color = "var(--text-2)";
    }
    head.appendChild(label);
    head.appendChild(badge);
    card.appendChild(head);

    // Hint
    const hint = document.createElement("div");
    hint.style.cssText = "font-size:12px;color:var(--text-3);margin-bottom:8px;";
    hint.textContent = row.hint;
    card.appendChild(hint);

    // Link to the provider's API-keys page — opens in-yo (browser tab), not external.
    const keyLink = document.createElement("a");
    keyLink.textContent = "Get API key ↗";
    keyLink.href = "#";
    keyLink.style.cssText = "font-size:12px;color:var(--accent);text-decoration:none;font-weight:500;margin-bottom:10px;display:inline-block;";
    keyLink.addEventListener("click", (e) => {
      e.preventDefault();
      void window.yo.execCommand(`dip ${row.keysUrl}`);
    });
    card.appendChild(keyLink);

    // Input + buttons
    const inputRow = document.createElement("div");
    inputRow.style.cssText = "display:flex;gap:6px;align-items:center;";
    const input = document.createElement("input");
    input.type = "password";
    input.className = "settings-input";
    input.placeholder = s?.configured ? "•••••••• (configured — paste to replace)" : row.keyExample;
    input.style.cssText = "flex:1;font-family:var(--font-mono, monospace);";
    inputRow.appendChild(input);

    const saveBtn = document.createElement("button");
    saveBtn.className = "action-btn primary";
    saveBtn.textContent = "Save";
    saveBtn.addEventListener("click", async () => {
      const key = input.value.trim();
      if (!key) return;
      saveBtn.disabled = true;
      const r = await window.yo.providerKeysSet(row.id, key);
      saveBtn.disabled = false;
      input.value = "";
      if (!r.ok) { alert(`Save failed: ${r.error || "unknown"}`); return; }
      await renderProviderKeys();
    });
    inputRow.appendChild(saveBtn);

    let testRespEl: HTMLElement | null = null;
    if (s?.configured) {
      // Live test: send a real prompt and show the model's reply (or the error).
      testRespEl = document.createElement("div");
      testRespEl.style.cssText = "display:none;margin-top:8px;font-size:12px;border-radius:6px;padding:8px 10px;white-space:pre-wrap;line-height:1.5;font-family:var(--font-mono, monospace);";

      const testPromptBtn = document.createElement("button");
      testPromptBtn.className = "action-btn primary";
      testPromptBtn.textContent = "Send test";
      testPromptBtn.title = "Send a one-shot prompt to this provider and show the response";
      testPromptBtn.addEventListener("click", async () => {
        const re = testRespEl!;
        testPromptBtn.disabled = true;
        const prev = testPromptBtn.textContent;
        testPromptBtn.textContent = "Sending…";
        re.style.display = "block";
        re.style.background = "var(--surface-3)";
        re.style.color = "var(--text-2)";
        re.style.border = "1px solid var(--border)";
        re.textContent = `Contacting ${row.label}…`;
        let r: { ok: boolean; text?: string; model?: string; error?: string };
        try { r = await window.yo.providerKeysTestPrompt(row.id); }
        catch (e) { r = { ok: false, error: e instanceof Error ? e.message : String(e) }; }
        testPromptBtn.disabled = false;
        testPromptBtn.textContent = prev;
        if (r.ok) {
          re.style.background = "var(--accent-bg)";
          re.style.color = "var(--text)";
          re.style.border = "1px solid var(--accent)";
          re.textContent = `✓ ${r.model}\n\n${r.text}`;
        } else {
          re.style.background = "rgba(212,74,74,0.12)";
          re.style.color = "#d44a4a";
          re.style.border = "1px solid #d44a4a";
          re.textContent = `✗ ${r.model || row.id} failed:\n\n${r.error || "unknown error"}`;
        }
      });
      inputRow.appendChild(testPromptBtn);

      const removeBtn = document.createElement("button");
      removeBtn.className = "action-btn danger";
      removeBtn.textContent = "Remove";
      removeBtn.addEventListener("click", async () => {
        if (!confirm(`Remove the saved ${row.label} key?`)) return;
        await window.yo.providerKeysRemove(row.id);
        await renderProviderKeys();
      });
      inputRow.appendChild(removeBtn);
    }

    card.appendChild(inputRow);
    if (testRespEl) card.appendChild(testRespEl);

    // ── Editable model catalog (so users can fix/add models as providers change) ──
    const cfg = allModels[row.id] || { default: "", models: [] };
    const details = document.createElement("details");
    details.style.cssText = "margin-top:10px;";
    const summary = document.createElement("summary");
    summary.style.cssText = "cursor:pointer;font-size:12px;color:var(--text-2);user-select:none;";
    summary.textContent = `Models (${cfg.models.length}) — default: ${cfg.default || "none"}`;
    details.appendChild(summary);

    const inner = document.createElement("div");
    inner.style.cssText = "margin-top:8px;display:flex;flex-direction:column;gap:6px;";
    const ta = document.createElement("textarea");
    ta.className = "settings-input";
    ta.style.cssText = "min-height:84px;font-family:var(--font-mono, monospace);font-size:12px;";
    ta.placeholder = "one model id per line";
    ta.value = cfg.models.join("\n");
    const defLabel = document.createElement("label");
    defLabel.className = "settings-label";
    defLabel.textContent = "Default model";
    const defSel = document.createElement("select");
    defSel.className = "settings-input";
    defSel.style.width = "auto";
    const fillDefSel = () => {
      const models = ta.value.split("\n").map((m) => m.trim()).filter(Boolean);
      defSel.innerHTML = "";
      for (const m of models) { const o = document.createElement("option"); o.value = m; o.textContent = m; defSel.appendChild(o); }
      defSel.value = models.includes(cfg.default) ? cfg.default : (models[0] || "");
    };
    fillDefSel();
    ta.addEventListener("input", fillDefSel);

    const mStatus = document.createElement("span");
    mStatus.style.cssText = "font-size:11px;color:var(--text-3);";
    const saveModelsBtn = document.createElement("button");
    saveModelsBtn.className = "action-btn primary";
    saveModelsBtn.textContent = "Save models";
    saveModelsBtn.addEventListener("click", async () => {
      const models = ta.value.split("\n").map((m) => m.trim()).filter(Boolean);
      await window.yo.providerModelsSet(row.id, models, defSel.value);
      mStatus.textContent = "Saved ✓";
      await renderProviderKeys();
    });
    const resetModelsBtn = document.createElement("button");
    resetModelsBtn.className = "action-btn";
    resetModelsBtn.textContent = "Reset to defaults";
    resetModelsBtn.addEventListener("click", async () => {
      await window.yo.providerModelsReset(row.id);
      await renderProviderKeys();
    });
    const mBtnRow = document.createElement("div");
    mBtnRow.style.cssText = "display:flex;gap:6px;align-items:center;";
    mBtnRow.append(saveModelsBtn, resetModelsBtn, mStatus);

    inner.append(
      (() => { const l = document.createElement("label"); l.className = "settings-label"; l.textContent = "Available models (one per line)"; return l; })(),
      ta, defLabel, defSel, mBtnRow,
    );
    details.appendChild(inner);
    card.appendChild(details);

    // Last-test detail line (failures only)
    if (s?.lastTestOk === false && s.lastTestError) {
      const err = document.createElement("div");
      err.style.cssText = "font-size:11px;color:#d44a4a;margin-top:8px;font-family:var(--font-mono, monospace);";
      err.textContent = `last test: ${s.lastTestError}`;
      card.appendChild(err);
    }

    container.appendChild(card);
  }
}


function initSettings() {
  settingsSaveBtn.addEventListener("click", saveSettings);

  // Render BYOK provider keys when the Providers sub-tab is opened.
  // The settings nav already toggles `.active` on the panel; we just
  // re-render on every nav click so status is fresh.
  document.querySelectorAll<HTMLButtonElement>(".settings-nav-item").forEach((btn) => {
    btn.addEventListener("click", () => {
      if (btn.getAttribute("data-sub") === "providers") {
        void renderProviderKeys();
      }
    });
  });

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

  // Marketplace registration is auto-managed: any joinable jammer keeps
  // it on; zero joinable jammers means it auto-withdraws. The Settings
  // panel only renders the resulting status (read-only).

  // MCP Expose — port save
  document.getElementById("mcp-expose-port-save")!.addEventListener("click", async () => {
    const port = parseInt(mcpExposePort.value, 10);
    if (port >= 1024 && port <= 65535) {
      window.yo.setPreference("mcpExposePort", port);
      await refreshMcpExposeStatus();
    }
  });
  document.getElementById("mcp-expose-gen-token")!.addEventListener("click", async () => {
    const labelInput = document.getElementById("mcp-expose-token-label") as HTMLInputElement;
    const ttlSelect = document.getElementById("mcp-expose-token-ttl") as HTMLSelectElement;
    const label = labelInput.value.trim() || "default";
    const ttlDays = parseInt(ttlSelect.value, 10);
    const result = await window.yo.mcpExposeGenToken(label, ttlDays);
    labelInput.value = "";
    // Show the new token in the highlighted box
    const newTokenBox = document.getElementById("mcp-expose-new-token")!;
    const newTokenValue = document.getElementById("mcp-expose-new-token-value")!;
    newTokenValue.textContent = result.token;
    newTokenBox.classList.remove("hidden");
    await renderMcpTokens();
  });

  // One-click Configure — generates a fresh token and merges our MCP server
  // into that tool's own config file.
  const mcpConfigureStatus = document.getElementById("mcp-configure-status");
  document.querySelectorAll<HTMLButtonElement>("#mcp-configure-buttons [data-mcp-client]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const client = btn.dataset.mcpClient!;
      const label = btn.textContent || client;
      btn.disabled = true;
      if (mcpConfigureStatus) { mcpConfigureStatus.textContent = `Configuring ${label}…`; mcpConfigureStatus.style.color = "var(--text-2)"; }
      try {
        const result = await window.yo.mcpConfigureClient(client);
        if (mcpConfigureStatus) {
          if (result.ok) {
            mcpConfigureStatus.textContent = `${label} configured — ${result.configPath}. Restart it to apply.`;
            mcpConfigureStatus.style.color = "var(--text)";
          } else {
            mcpConfigureStatus.textContent = `${label}: ${result.error || "failed to configure"}`;
            mcpConfigureStatus.style.color = "var(--danger, #e0483d)";
          }
        }
        await renderMcpTokens();
      } finally {
        btn.disabled = false;
      }
    });
  });

  // Copy new token
  document.getElementById("mcp-expose-copy-token")!.addEventListener("click", () => {
    const val = document.getElementById("mcp-expose-new-token-value")!.textContent || "";
    window.yo.copyToClipboard(val);
    const btn = document.getElementById("mcp-expose-copy-token") as HTMLButtonElement;
    btn.textContent = "Copied";
    setTimeout(() => { btn.textContent = "Copy"; }, 2000);
  });

  // Copy config example
  document.getElementById("mcp-expose-copy-config")!.addEventListener("click", () => {
    const val = document.getElementById("mcp-expose-config-example")!.textContent || "";
    window.yo.copyToClipboard(val);
    const btn = document.getElementById("mcp-expose-copy-config") as HTMLButtonElement;
    btn.textContent = "Copied";
    setTimeout(() => { btn.textContent = "Copy"; }, 2000);
  });

  // ── Remote Relay wiring (org-admin only) ──────────────────
  const relaySection = document.getElementById("relay-section");
  const relayEnabledToggle = document.getElementById("relay-enabled-toggle") as HTMLInputElement;
  const relayStatusText = document.getElementById("relay-status-text");
  const relayConfigExample = document.getElementById("relay-config-example");
  const relayTokensList = document.getElementById("relay-tokens-list");
  const relayNewTokenBox = document.getElementById("relay-new-token");
  const relayNewTokenValue = document.getElementById("relay-new-token-value");
  const relayLabelInput = document.getElementById("relay-token-label") as HTMLInputElement;

  function renderRelayConfig(): void {
    const relayUrl = `${window.yo.serverUrl}/mcp`;
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
      if (!confirm(`Revoke "${t.label || "this token"}"? External tools using it will stop working.`)) return;
      const res = await window.yo.relayTokensRevoke(t.id);
      if ("error" in res) { alert(`Could not revoke: ${res.error}`); return; }
      void refreshRelayTokens();
    });
    return row;
  }

  function escapeHtmlLocal(s: string): string {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
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

  relayEnabledToggle.addEventListener("change", async () => {
    window.yo.setPreference("relayEnabled", relayEnabledToggle.checked);
    await window.yo.relayReconnect();
    void refreshRelayStatus();
  });

  document.getElementById("relay-gen-token")!.addEventListener("click", async () => {
    const label = relayLabelInput.value.trim() || "default";
    const res = await window.yo.relayTokensCreate(label);
    if ("error" in res) { alert(`Could not create token: ${res.error}`); return; }
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

    const enabled = await window.yo.getPreference("relayEnabled", false) as boolean;
    relayEnabledToggle.checked = !!enabled;
    renderRelayConfig();
    void refreshRelayStatus();
    void refreshRelayTokens();
    setInterval(refreshRelayStatus, 3_000);
  })();

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
  document.getElementById("mcp-expose-new-token")?.classList.add("hidden");
  mcpExposePort.value = String(await window.yo.getPreference("mcpExposePort", 7860));
  await refreshMcpExposeStatus();
  await renderMcpTokens();

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

/** Providers is now its own top-level dashboard tab (data-section="providers").
 *  navigation.ts calls this when that section opens. */
export function loadProviders(): void { void renderProviderKeys(); }

export { loadSettings, initSettings };
