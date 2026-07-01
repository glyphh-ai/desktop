/**
 * Apps section — apps list + all tabs (dashboard, panel, connection, mcp).
 */

import {
  paginate, renderPaginationBar, confirmAction, clearInvalid,
  formatBytes, relativeTime, buildPaginationBar, cssVar, closeHelp,
} from "./shared.js";

declare const Chart: any;

// ── Apps (unified: apps + MCP + connections) ────────────

let appsPage = 0;
const appsList = document.getElementById("apps-list")!;
const appDetail = document.getElementById("app-detail")!;
const appAddForm = document.getElementById("app-add-form")!;
const mcpAddForm = document.getElementById("mcp-add-form")!;
const appDetailId = document.getElementById("app-detail-id") as HTMLInputElement;
const appDetailName = document.getElementById("app-detail-name") as HTMLInputElement;
const appDetailUrl = document.getElementById("app-detail-url") as HTMLInputElement;
const appForceWeb = document.getElementById("app-detail-force-web") as HTMLInputElement;
const appSearchInput = document.getElementById("app-search") as HTMLInputElement;
const appConnectStatus = document.getElementById("app-connect-status")!;
const appCommandsList = document.getElementById("app-commands-list")!;
const appMapCommand = document.getElementById("app-map-command")!;
const appPreview = document.getElementById("app-preview") as HTMLElement & {
  src: string;
  partition: string;
  getWebContentsId: () => number;
  reload: () => void;
};
const appsToolbar = document.getElementById("apps-toolbar")!;
const appFormError = document.getElementById("app-form-error")!;
const appDetailHeading = document.getElementById("app-detail-heading")!;

let currentAppId = "";
let activeAppTab: "panel" | "connection" | "mcp" = "panel";
let connectorSearchOffset = 0;

interface PanelApp {
  id: string;
  name: string;
  url?: string;
  connectedSlug?: string;
  forceWeb?: boolean;
  commands?: Record<string, { selector: string; action: string; description: string }>;
  connection?: { pipedreamSlug: string; accountId?: string; healthy?: boolean };
  mcp?: { transport: "stdio" | "sse" | "streamable-http"; command?: string; args?: string[]; env?: Record<string, string>; url?: string; headers?: Record<string, string>; oauth?: { clientId: string; clientSecret: string; tokenUrl: string; scope?: string }; enabled: boolean };
}

let panelApps: PanelApp[] = [];

async function loadApps() {
  appDetail.classList.add("hidden");
  appAddForm.classList.add("hidden");
  mcpAddForm.classList.add("hidden");

  document.getElementById("apps-pro-gate")!.classList.add("hidden");
  appsList.classList.remove("hidden");
  appsToolbar.classList.remove("hidden");

  try {
    const apps = await window.yo.appsList();
    panelApps = apps
      .filter((a) => a.url)
      .map((a) => ({
        id: a.id, name: a.name, url: a.url,
        connectedSlug: a.connectedSlug, forceWeb: a.forceWeb,
        commands: a.commands, connection: a.connection, mcp: a.mcp,
      }));
  } catch { panelApps = []; }

  document.getElementById("apps-limit-msg")!.classList.add("hidden");

  renderAppsList();
}

function renderAppsList() {
  const query = appSearchInput.value.trim().toLowerCase();

  const filtered = query
    ? panelApps.filter((a) => a.name.toLowerCase().includes(query) || (a.url || "").toLowerCase().includes(query))
    : panelApps;

  appsList.className = "app-grid";

  if (panelApps.length === 0) {
    appsList.innerHTML = `<div class="crud-empty">No apps yet. Click "+ New" to add one.</div>`;
    return;
  }
  if (filtered.length === 0) {
    appsList.innerHTML = `<div class="crud-empty">No apps matching "${query}"</div>`;
    return;
  }

  const { items: pageApps, state } = paginate(filtered, appsPage);
  appsPage = state.page;
  appsList.innerHTML = "";

  for (const app of pageApps) {
    const isInternal = app.url?.startsWith("yo://");
    const hasUrl = app.url && !isInternal;
    const faviconUrl = hasUrl
      ? `https://www.google.com/s2/favicons?domain=${new URL(app.url!).hostname}&sz=64`
      : "";
    const initial = app.name.charAt(0).toUpperCase();

    const badges: string[] = [];
    if (app.mcp && !app.url) badges.push(`<span class="app-card-badge">MCP</span>`);
    if (app.connection?.accountId) badges.push(`<span class="app-card-badge badge-connection">API</span>`);

    const card = document.createElement("div");
    card.className = "app-card";
    card.innerHTML = `
      ${badges.join("")}
      <div class="app-card-icon">
        ${faviconUrl
          ? `<img src="${faviconUrl}" onerror="this.style.display='none';this.nextElementSibling.style.display='flex'" /><span class="app-card-initial" style="display:none">${initial}</span>`
          : `<span class="app-card-initial">${initial}</span>`}
      </div>
      <div class="app-card-name">${app.name}</div>
      <div class="app-card-id">${app.id}</div>`;

    card.addEventListener("click", () => openPanelAppDetail(app));
    appsList.appendChild(card);
  }

  appsList.appendChild(renderPaginationBar(state, (p) => { appsPage = p; renderAppsList(); }));
}

// ── Tab switching ────────────────────────────────────────

function switchAppTab(tab: string) {
  activeAppTab = tab as typeof activeAppTab;
  document.querySelectorAll<HTMLButtonElement>(".app-detail-tab").forEach(btn => {
    btn.classList.toggle("active", btn.dataset.tab === tab);
  });
  document.querySelectorAll<HTMLElement>(".app-tab-left").forEach(el => {
    el.classList.toggle("active", el.dataset.tab === tab);
  });
  document.querySelectorAll<HTMLElement>(".app-tab-right").forEach(el => {
    el.classList.toggle("active", el.dataset.tab === tab);
  });
  if (tab === "panel") loadPanelTab();
  if (tab === "connection") loadConnectionTab();
  if (tab === "mcp") loadMcpTab();
}


// ── Panel tab ────────────────────────────────────────────

let panelLoaded = false;

function loadPanelTab() {
  const app = panelApps.find((a) => a.id === currentAppId);
  if (!app) return;
  if (!app.url) {
    document.getElementById("app-commands-list")!.innerHTML = `<div class="inline-empty">No URL configured for this app. Add a URL on the Dashboard tab to enable panel features.</div>`;
    return;
  }
  if (!panelLoaded) {
    appPreview.partition = "persist:yo";
    appPreview.src = app.url;
    panelLoaded = true;
  }
  refreshCommands();
}

// ── Connection tab ───────────────────────────────────────

async function loadConnectionTab() {
  const app = panelApps.find((a) => a.id === currentAppId);
  if (!app) return;

  const gate = document.getElementById("connection-upgrade-gate")!;
  const statusEl = document.getElementById("app-connection-status")!;
  const listEl = document.getElementById("app-connected-list")!;
  const toolsEl = document.getElementById("app-connection-tools")!;
  const noToolsEl = document.getElementById("app-connection-no-tools")!;
  const browseEl = document.querySelector<HTMLElement>(".connection-browse")!;

  // App connections (Pipedream) are a paid-tier feature — lock for Free users.
  if (!(await window.yo.hasMcpAccess())) {
    gate.classList.remove("hidden");
    statusEl.innerHTML = "";
    listEl.innerHTML = "";
    toolsEl.innerHTML = "";
    noToolsEl.classList.add("hidden");
    browseEl.classList.add("hidden");
    return;
  }
  gate.classList.add("hidden");

  // Left: this app's connection
  listEl.innerHTML = "";
  const isConnected = !!app.connection?.accountId;

  if (app.connection && isConnected) {
    // Connected — show status + disconnect, hide browse grid
    browseEl.classList.add("hidden");
    statusEl.innerHTML = `
      <div class="connection-status">
        <span class="connection-status-dot connected"></span>
        <div class="connection-status-info">
          <div class="connection-status-name">${app.connection.pipedreamSlug}</div>
          <div class="connection-status-meta">Connected${app.connection.healthy === false ? " (unhealthy)" : ""}</div>
        </div>
        <button class="action-btn danger" id="app-conn-disconnect" style="height:28px;font-size:12px;">Disconnect</button>
      </div>`;

    document.getElementById("app-conn-disconnect")?.addEventListener("click", async () => {
      if (!app.connection?.accountId) return;
      const btn = document.getElementById("app-conn-disconnect") as HTMLButtonElement;
      btn.disabled = true;
      btn.textContent = "Disconnecting...";
      await window.yo.connectorsDisconnect(app.connection.accountId);
      // Also remove the connection from the app so it clears properly
      await window.yo.appsRemoveConnection(app.id);
      const apps = await window.yo.appsList();
      reloadPanelApps(apps);
      loadConnectionTab();
    });
  } else {
    // Not connected — show browse grid to pick an app
    statusEl.innerHTML = "";
    browseEl.classList.remove("hidden");
    connectorSearchOffset = 0;
    const searchInput = document.getElementById("app-connector-search") as HTMLInputElement;
    if (searchInput) searchInput.value = "";
    loadConnectorGrid();
  }

  // Right: tools for this app's connection
  toolsEl.innerHTML = "";
  noToolsEl.classList.add("hidden");
  if (isConnected && app.connection?.pipedreamSlug) {
    await loadConnectionTools(app.connection.pipedreamSlug);
  } else {
    noToolsEl.textContent = "Connect an app to see its tools.";
    noToolsEl.classList.remove("hidden");
  }
}

async function loadConnectionTools(slug: string) {
  const toolsEl = document.getElementById("app-connection-tools")!;
  const noToolsEl = document.getElementById("app-connection-no-tools")!;
  toolsEl.innerHTML = "";
  noToolsEl.textContent = "Loading tools…";
  noToolsEl.classList.remove("hidden");

  // Tools come from yo-server's flat connector catalog (keyed by pipedream
  // app slug), surfaced via connectors-list-tools. Filter to this app's slug.
  let tools: Array<{ slug: string; name: string; description: string }> = [];
  try {
    tools = await window.yo.connectorsListTools();
  } catch (err) {
    console.error("[connection-tools] list failed:", err);
  }
  const appTools = tools.filter((t) => t.slug === slug);

  if (appTools.length === 0) {
    noToolsEl.textContent = "No tools available for this app yet.";
    noToolsEl.classList.remove("hidden");
    return;
  }

  noToolsEl.classList.add("hidden");
  for (const tool of appTools) {
    const row = document.createElement("div");
    row.className = "crud-card";
    row.innerHTML = `
      <div class="crud-card-info">
        <span class="crud-card-name" style="font-family:var(--font-mono);font-size:11px;">${tool.name}</span>
        <span class="crud-card-meta">${tool.description || ""}</span>
      </div>`;
    toolsEl.appendChild(row);
  }
}

async function loadConnectorGrid(search?: string) {
  const grid = document.getElementById("app-connector-grid")!;
  const loadMore = document.getElementById("app-connector-load-more")!;

  try {
    const { apps, hasMore } = await window.yo.connectorsGetApps(search, connectorSearchOffset);
    if (connectorSearchOffset === 0) grid.innerHTML = "";

    for (const app of apps) {
      const card = document.createElement("div");
      card.className = "connector-card";
      const initial = app.name.charAt(0).toUpperCase();
      card.innerHTML = `
        ${app.icon
          ? `<img class="connector-card-icon" src="${app.icon}" onerror="this.outerHTML='<span class=\\'connector-card-initial\\'>${initial}</span>'" />`
          : `<span class="connector-card-initial">${initial}</span>`}
        <div class="connector-card-info">
          <div class="connector-card-name">${app.name}</div>
        </div>`;
      card.addEventListener("click", async () => {
        const nameEl = card.querySelector(".connector-card-name")!;
        nameEl.textContent = "Connecting...";
        // Set the pipedream slug on the current app FIRST so syncAccountsToApps can find it
        const currentApp = panelApps.find((a) => a.id === currentAppId);
        if (currentApp) {
          await window.yo.appsSetConnection(currentApp.id, app.id);
        }
        const result = await window.yo.connectorsConnect(app.id);
        if (!result.ok) {
          nameEl.textContent = result.error || "Connection failed";
          // Remove the connection we just set since connect failed
          if (currentApp) await window.yo.appsRemoveConnection(currentApp.id);
          setTimeout(() => { nameEl.textContent = app.name; }, 3000);
          return;
        }
        const allApps = await window.yo.appsList();
        reloadPanelApps(allApps);
        loadConnectionTab();
      });
      grid.appendChild(card);
    }

    loadMore.classList.toggle("hidden", !hasMore);
  } catch {
    if (connectorSearchOffset === 0) grid.innerHTML = `<div class="crud-empty" style="grid-column:1/-1;">Could not load apps. Check your connection.</div>`;
  }
}

// ── MCP tab ──────────────────────────────────────────────

async function loadMcpTab() {
  const app = panelApps.find((a) => a.id === currentAppId);
  if (!app) return;

  const mcpGate = document.getElementById("mcp-tab-upgrade-gate")!;
  const statusRow = document.getElementById("app-mcp-status-row")!;

  // MCP is a paid-tier feature — lock the whole tab for Free users.
  const mcpSiblings = document.querySelectorAll<HTMLElement>(".app-tab-left[data-tab='mcp'] > :not(#mcp-tab-upgrade-gate)");
  if (!(await window.yo.hasMcpAccess())) {
    mcpGate.classList.remove("hidden");
    mcpSiblings.forEach(el => el.classList.add("hidden"));
    return;
  }
  mcpGate.classList.add("hidden");
  mcpSiblings.forEach(el => el.classList.remove("hidden"));

  const statusBadge = document.getElementById("app-mcp-status")!;
  const connectBtn = document.getElementById("app-mcp-connect") as HTMLButtonElement;
  const disconnectBtn = document.getElementById("app-mcp-disconnect") as HTMLButtonElement;
  const transportSelect = document.getElementById("app-mcp-transport") as HTMLSelectElement;
  const commandInput = document.getElementById("app-mcp-command") as HTMLInputElement;
  const argsInput = document.getElementById("app-mcp-args") as HTMLInputElement;
  const envInput = document.getElementById("app-mcp-env") as HTMLTextAreaElement;
  const urlInput = document.getElementById("app-mcp-url") as HTMLInputElement;

  if (!app.mcp) {
    statusBadge.className = "mcp-status-badge status-disconnected";
    statusBadge.textContent = "not configured";
    connectBtn.classList.add("hidden");
    disconnectBtn.classList.add("hidden");
    transportSelect.value = "stdio";
    commandInput.value = "";
    argsInput.value = "";
    envInput.value = "";
    urlInput.value = "";
    (document.getElementById("app-mcp-client-id") as HTMLInputElement).value = "";
    const secretReset = document.getElementById("app-mcp-client-secret") as HTMLInputElement;
    secretReset.value = "";
    secretReset.placeholder = "OAuth client secret";
    (document.getElementById("app-mcp-token-url") as HTMLInputElement).value = "";
    (document.getElementById("app-mcp-scope") as HTMLInputElement).value = "";
    updateMcpFields();

    const toolsTable = document.getElementById("app-mcp-tools-table")!;
    const noTools = document.getElementById("app-mcp-no-tools")!;
    toolsTable.classList.add("hidden");
    noTools.classList.remove("hidden");
    noTools.textContent = "Configure and save an MCP server to discover tools.";
    return;
  }

  // Get live status from MCP manager
  const servers = await window.yo.mcpGetServers();
  const server = servers.find((s) => s.config.id === currentAppId);
  const status = server?.status || "disconnected";

  statusBadge.className = `mcp-status-badge status-${status}`;
  statusBadge.textContent = status + (server?.error ? `: ${server.error}` : "");
  connectBtn.classList.toggle("hidden", status === "connected" || status === "connecting");
  disconnectBtn.classList.toggle("hidden", status !== "connected");

  // Populate config form
  transportSelect.value = app.mcp.transport;
  commandInput.value = app.mcp.command || "";
  argsInput.value = (app.mcp.args || []).join(" ");
  envInput.value = app.mcp.env ? Object.entries(app.mcp.env).map(([k, v]) => `${k}=${v}`).join("\n") : "";
  urlInput.value = app.mcp.url || "";

  // OAuth fields. Never populate the secret into the DOM — only hint that one
  // is saved so the user knows they can leave it blank to keep it.
  const oauth = app.mcp.oauth;
  (document.getElementById("app-mcp-client-id") as HTMLInputElement).value = oauth?.clientId || "";
  (document.getElementById("app-mcp-token-url") as HTMLInputElement).value = oauth?.tokenUrl || "";
  (document.getElementById("app-mcp-scope") as HTMLInputElement).value = oauth?.scope || "";
  const secretInput = document.getElementById("app-mcp-client-secret") as HTMLInputElement;
  secretInput.value = "";
  secretInput.placeholder = oauth ? "•••••• (saved — re-enter to change)" : "OAuth client secret";
  updateMcpFields();

  // Tools table (right panel)
  const toolsBody = document.getElementById("app-mcp-tools-body")!;
  const toolsTable = document.getElementById("app-mcp-tools-table")!;
  const noTools = document.getElementById("app-mcp-no-tools")!;
  const tools = server?.tools || [];

  if (tools.length === 0) {
    toolsTable.classList.add("hidden");
    noTools.classList.remove("hidden");
  } else {
    toolsTable.classList.remove("hidden");
    noTools.classList.add("hidden");
    toolsBody.innerHTML = "";

    for (const tool of tools) {
      const tr = document.createElement("tr");
      tr.className = "tool-row";
      const currentOverride = await window.yo.mcpGetToolOverride(currentAppId, tool.name);
      tr.innerHTML = `
        <td class="tool-td-name">${tool.name}</td>
        <td class="tool-td-desc">${tool.description || ""}</td>
        <td class="tool-td-perm">
          <select class="tool-perm-select" data-tool="${tool.name}">
            <option value="default"${currentOverride === "default" ? " selected" : ""}>Default</option>
            <option value="auto"${currentOverride === "auto" ? " selected" : ""}>Auto</option>
            <option value="ask"${currentOverride === "ask" ? " selected" : ""}>Ask</option>
          </select>
        </td>`;
      toolsBody.appendChild(tr);
    }

    toolsBody.querySelectorAll<HTMLSelectElement>(".tool-perm-select").forEach(sel => {
      sel.addEventListener("change", () => {
        window.yo.mcpSetToolOverride(currentAppId, sel.dataset.tool!, sel.value);
      });
    });
  }
}

function updateMcpFields() {
  const transport = (document.getElementById("app-mcp-transport") as HTMLSelectElement).value;
  document.getElementById("app-mcp-stdio-fields")!.classList.toggle("hidden", transport !== "stdio");
  // The URL field is shared by SSE and streamable-http.
  document.getElementById("app-mcp-sse-fields")!.classList.toggle("hidden", transport !== "sse" && transport !== "streamable-http");
  document.getElementById("app-mcp-oauth-fields")!.classList.toggle("hidden", transport !== "streamable-http");
}

async function saveMcpConfig() {
  const transport = (document.getElementById("app-mcp-transport") as HTMLSelectElement).value as "stdio" | "sse" | "streamable-http";
  const statusEl = document.getElementById("app-mcp-save-status")!;

  const app = panelApps.find((a) => a.id === currentAppId);

  const config: Record<string, unknown> = { transport, enabled: false };
  if (transport === "stdio") {
    const command = (document.getElementById("app-mcp-command") as HTMLInputElement).value.trim();
    if (!command) { statusEl.textContent = "Command required"; return; }
    config.command = command;
    const args = (document.getElementById("app-mcp-args") as HTMLInputElement).value.trim();
    if (args) config.args = args.split(/\s+/);
    const envText = (document.getElementById("app-mcp-env") as HTMLTextAreaElement).value.trim();
    if (envText) {
      const env: Record<string, string> = {};
      for (const line of envText.split("\n")) {
        const eq = line.indexOf("=");
        if (eq > 0) env[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
      }
      config.env = env;
    }
  } else if (transport === "streamable-http") {
    const url = (document.getElementById("app-mcp-url") as HTMLInputElement).value.trim();
    if (!url) { statusEl.textContent = "URL required"; return; }
    config.url = url;

    const clientId = (document.getElementById("app-mcp-client-id") as HTMLInputElement).value.trim();
    const clientSecret = (document.getElementById("app-mcp-client-secret") as HTMLInputElement).value.trim();
    const tokenUrl = (document.getElementById("app-mcp-token-url") as HTMLInputElement).value.trim();
    const scope = (document.getElementById("app-mcp-scope") as HTMLInputElement).value.trim();

    // The client secret never reaches the renderer (apps-ipc redacts it). A
    // blank secret means "keep the one already on disk" — the main process
    // preserves it (see app-connector preserveOAuthSecret). So a previously
    // configured server can be edited without re-typing the secret.
    const hadOauth = !!app?.mcp?.oauth;
    const anyOauth = clientId || clientSecret || tokenUrl || hadOauth;
    if (anyOauth) {
      if (!clientId || !tokenUrl) {
        statusEl.textContent = "client id and token URL are required for OAuth";
        return;
      }
      if (!clientSecret && !hadOauth) {
        statusEl.textContent = "client secret is required for OAuth";
        return;
      }
      // clientSecret may be "" here when editing — main keeps the saved value.
      const oauth: Record<string, string> = { clientId, clientSecret, tokenUrl };
      if (scope) oauth.scope = scope;
      config.oauth = oauth;
    }
    // No oauth fields → valid unauthenticated streamable-http server (url only).
  } else {
    const url = (document.getElementById("app-mcp-url") as HTMLInputElement).value.trim();
    if (!url) { statusEl.textContent = "URL required"; return; }
    config.url = url;
  }

  await window.yo.appsSetMcp(currentAppId, config as any);
  if (app?.mcp) {
    await window.yo.mcpUpdateServer(currentAppId, config);
  } else {
    await window.yo.mcpAddServer({ id: currentAppId, name: app?.name || currentAppId, ...config });
  }
  if (app) app.mcp = config as any;
  statusEl.textContent = "Saved";
  setTimeout(() => { statusEl.textContent = ""; loadMcpTab(); }, 1000);
}


async function openPanelAppDetail(app: PanelApp) {
  currentAppId = app.id;
  panelLoaded = false;
  connectorSearchOffset = 0;

  // Populate dashboard fields
  appDetailId.value = app.id;
  appDetailName.value = app.name;
  appDetailUrl.value = app.url || "";
  appForceWeb.checked = !!app.forceWeb;
  appConnectStatus.textContent = "";
  appMapCommand.classList.add("hidden");
  appDetailHeading.textContent = app.name;

  // All tabs always visible
  document.querySelectorAll<HTMLButtonElement>(".app-detail-tab").forEach(btn => {
    btn.classList.remove("tab-hidden");
  });

  // Show detail, hide grid
  appsList.classList.add("hidden");
  appsToolbar.classList.add("hidden");
  appAddForm.classList.add("hidden");
  mcpAddForm.classList.add("hidden");
  appDetail.classList.remove("hidden");

  switchAppTab("panel");
}

async function refreshCommands() {
  const apps = await window.yo.appsList();
  const app = apps.find((a) => a.id === currentAppId);
  const commands = app?.commands || {};
  const keys = Object.keys(commands);

  if (keys.length === 0) {
    appCommandsList.innerHTML = `<div class="inline-empty">No commands mapped. Click "Pick Element" to add one.</div>`;
    return;
  }

  appCommandsList.innerHTML = keys.map((key) => {
    const cmd = commands[key];
    return `<div class="command-row" data-key="${key}">
      <span class="command-key">${key}</span>
      <span class="command-desc">${cmd.description || cmd.action}</span>
      <span class="command-selector" title="${cmd.selector}">${cmd.selector.length > 40 ? cmd.selector.slice(0, 40) + "…" : cmd.selector}</span>
      <div class="command-actions">
        <button class="action-btn command-edit-btn" title="Edit">Edit</button>
        <button class="action-btn command-test-btn" title="Test">Test</button>
        <button class="action-btn danger command-remove-btn" title="Remove">×</button>
      </div>
    </div>`;
  }).join("");

  appCommandsList.querySelectorAll(".command-edit-btn").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const key = (btn.closest(".command-row") as HTMLElement).dataset.key!;
      const cmd = commands[key];
      if (!cmd) return;
      openMappingForm(key, cmd.selector, cmd.action, cmd.description || "", (cmd as any).text);
    });
  });

  appCommandsList.querySelectorAll(".command-remove-btn").forEach((btn) => {
    btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      const key = (btn.closest(".command-row") as HTMLElement).dataset.key!;
      await window.yo.appsRemoveCommand(currentAppId, key);
      refreshCommands();
    });
  });

  appCommandsList.querySelectorAll(".command-test-btn").forEach((btn) => {
    btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      const key = (btn.closest(".command-row") as HTMLElement).dataset.key!;
      const wcId = getPreviewWebContentsId();
      const result = await window.yo.appsTestCommand(currentAppId, key, wcId);
      appConnectStatus.textContent = result ? `Test ${key}: ${result.slice(0, 80)}` : `Test ${key}: executed`;
      setTimeout(() => { appConnectStatus.textContent = ""; }, 3000);
    });
  });
}

function getPreviewWebContentsId(): number | undefined {
  try { return appPreview.getWebContentsId(); } catch { return undefined; }
}

async function pickElement() {
  if (!currentAppId) return;
  const pickLabel = document.getElementById("app-pick-label");
  const setPickLabel = (txt: string) => { if (pickLabel) pickLabel.textContent = txt; };
  const wcId = getPreviewWebContentsId();
  if (!wcId) {
    setPickLabel("Preview not ready");
    setTimeout(() => setPickLabel("Pick Element"), 2000);
    return;
  }

  setPickLabel("Picking…");

  // Lock the close buttons while picking. Guard against any that no longer
  // exist (#help-close is gone since Home became a panel, not an overlay) —
  // touching a null element here used to throw and abort the whole picker.
  const closeBtns = ["help-close", "app-detail-close"]
    .map((id) => document.getElementById(id))
    .filter((el): el is HTMLElement => el !== null);
  const lockCloseBtns = (locked: boolean) => {
    for (const el of closeBtns) {
      (el as HTMLButtonElement).disabled = locked;
      el.style.opacity = locked ? "0.3" : "";
    }
  };
  lockCloseBtns(true);

  const picked = await new Promise<{
    selector: string; tag: string; text: string; isEditable: boolean; isClickable: boolean;
  } | null>((resolve) => {
    window.yo.onPickerResult((result) => {
      resolve(result);
    });
    window.yo.startPicker(wcId);
  });

  lockCloseBtns(false);
  setPickLabel("Pick Element");

  if (!picked) {
    appMapCommand.classList.add("hidden");
    return;
  }

  const action = picked.isEditable ? "setValue" : picked.isClickable ? "click" : "extractText";
  const info = `<${picked.tag}>` +
    `${picked.text ? ' "' + picked.text.slice(0, 60) + '"' : ""}` +
    `${picked.isEditable ? " [editable]" : ""}${picked.isClickable ? " [clickable]" : ""}`;

  document.getElementById("map-element-info")!.textContent = info;
  openMappingForm("", picked.selector, action, "", picked.text);
}

let mappingText = "";

function openMappingForm(key: string, selector: string, action: string, description: string, text?: string) {
  document.getElementById("map-selector")!.textContent = selector;
  mappingText = text ?? "";

  const keySelect = document.getElementById("map-command-key") as HTMLSelectElement;
  const customKeyInput = document.getElementById("map-custom-key") as HTMLInputElement;
  const actionSelect = document.getElementById("map-action") as HTMLSelectElement;
  const descInput = document.getElementById("map-description") as HTMLInputElement;

  // Check if key matches a preset option
  const presetOption = keySelect.querySelector(`option[value="${key}"]`);
  if (key && presetOption) {
    keySelect.value = key;
    customKeyInput.classList.add("hidden");
  } else if (key) {
    keySelect.value = "__custom__";
    customKeyInput.value = key;
    customKeyInput.classList.remove("hidden");
  } else {
    keySelect.value = "";
    customKeyInput.value = "";
    customKeyInput.classList.add("hidden");
  }

  actionSelect.value = action;
  descInput.value = description;
  appMapCommand.classList.remove("hidden");
}

async function saveMapping() {
  const keySelect = document.getElementById("map-command-key") as HTMLSelectElement;
  const customKeyInput = document.getElementById("map-custom-key") as HTMLInputElement;
  const actionSelect = document.getElementById("map-action") as HTMLSelectElement;
  const descInput = document.getElementById("map-description") as HTMLInputElement;
  const selector = document.getElementById("map-selector")!.textContent || "";

  let key = keySelect.value;
  if (key === "__custom__") {
    key = customKeyInput.value.trim().toLowerCase().replace(/[^a-z0-9-]/g, "");
    if (!key) { customKeyInput.focus(); return; }
  }
  if (!key || !selector) return;

  const mapping: Record<string, string> = {
    selector,
    action: actionSelect.value,
    description: descInput.value.trim() || key,
  };
  if (mappingText) mapping.text = mappingText;
  await window.yo.appsSetCommand(currentAppId, key, mapping as any);

  appMapCommand.classList.add("hidden");
  appConnectStatus.textContent = `Mapped: ${key}`;
  setTimeout(() => { appConnectStatus.textContent = ""; }, 2000);
  refreshCommands();
}


function closeAppDetail() {
  appPreview.src = "about:blank";
  panelLoaded = false;
  appMapCommand.classList.add("hidden");
  appDetail.classList.add("hidden");
  appsList.classList.remove("hidden");
  appsToolbar.classList.remove("hidden");
  loadApps();
}

function reloadPanelApps(apps: Array<PanelApp>) {
  panelApps = apps
    .filter((a) => a.url)
    .map((a) => ({
      id: a.id, name: a.name, url: a.url,
      connectedSlug: a.connectedSlug, forceWeb: a.forceWeb,
      commands: a.commands, connection: a.connection, mcp: a.mcp,
    }));
}

// When a browser tab is "Create App"'d, the originating tab id is stashed here
// so the save handler can convert that tab into the new app.
let pendingOriginTab: string | null = null;

/**
 * Open the New App form, prefilled. Used by the browser-tab "Create App"
 * deep-link. Clicks the + New button to open the form, then fills the fields.
 */
export function openNewAppForm(url = "", name = "", tabId: string | null = null): void {
  pendingOriginTab = tabId;
  document.getElementById("apps-add-btn")?.click(); // opens + clears the form
  const nameInput = document.getElementById("app-add-name") as HTMLInputElement | null;
  const slugInput = document.getElementById("app-add-slug") as HTMLInputElement | null;
  const urlInput = document.getElementById("app-add-url") as HTMLInputElement | null;
  if (!nameInput || !urlInput) return;
  let host = "";
  try { host = new URL(url).hostname.replace(/^www\./, ""); } catch { /* noop */ }
  const finalName = name || host || "";
  nameInput.value = finalName;
  if (slugInput) slugInput.value = finalName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  urlInput.value = url;
  nameInput.focus();
}

function initApps() {
  // Upgrade gates (App connections / MCP) open the platform to manage the plan,
  // the same way Settings → Account → Manage Account does.
  document.querySelectorAll<HTMLElement>(".tab-upgrade-btn").forEach((btn) => {
    btn.addEventListener("click", () => { void window.yo.execCommand(`dip ${window.yo.platformUrl}`); });
  });

  const addNameInput = document.getElementById("app-add-name") as HTMLInputElement;
  const addSlugInput = document.getElementById("app-add-slug") as HTMLInputElement;
  const addUrlInput = document.getElementById("app-add-url") as HTMLInputElement;
  // URL → live preview sync in the detail form. Editing the URL field
  // navigates the embedded panel preview to the new address so the user
  // sees their change without having to Save + reopen. Debounced to ride
  // out fast typing; only fires for well-formed URLs.
  let urlSyncTimer: ReturnType<typeof setTimeout> | null = null;
  appDetailUrl?.addEventListener("input", () => {
    if (urlSyncTimer) clearTimeout(urlSyncTimer);
    urlSyncTimer = setTimeout(() => {
      const u = appDetailUrl.value.trim();
      if (!u) return;
      let normalized = u;
      try { normalized = new URL(u).toString(); } catch { return; /* not yet a full URL */ }
      if (appPreview && appPreview.src !== normalized) {
        appPreview.partition = "persist:yo";
        appPreview.src = normalized;
        panelLoaded = true;
      }
    }, 400);
  });

  // Slug helpers
  const slugify = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  let slugTouched = false;
  addSlugInput?.addEventListener("input", () => { slugTouched = addSlugInput.value.trim().length > 0; });
  addNameInput?.addEventListener("input", () => {
    if (!slugTouched) addSlugInput.value = slugify(addNameInput.value);
  });

  // + New — opens the simple App add form (name → auto-slug → URL).
  // The old "Add App | Add MCP Server" dropdown is gone; the form
  // already lets the user wire MCP in the detail view after creating.
  document.getElementById("apps-add-btn")!.addEventListener("click", () => {
    addNameInput.value = "";
    addSlugInput.value = "";
    slugTouched = false;
    addUrlInput.value = "";
    appFormError.classList.add("hidden");
    appsList.classList.add("hidden");
    appsToolbar.classList.add("hidden");
    appAddForm.classList.remove("hidden");
    addNameInput.focus();
  });

  // MCP add form transport toggle
  document.getElementById("mcp-add-transport")!.addEventListener("change", () => {
    const transport = (document.getElementById("mcp-add-transport") as HTMLSelectElement).value;
    document.getElementById("mcp-add-stdio-fields")!.classList.toggle("hidden", transport !== "stdio");
    document.getElementById("mcp-add-sse-fields")!.classList.toggle("hidden", transport !== "sse");
  });

  // MCP add form save
  document.getElementById("mcp-add-save")!.addEventListener("click", async () => {
    const name = (document.getElementById("mcp-add-name") as HTMLInputElement).value.trim();
    const transport = (document.getElementById("mcp-add-transport") as HTMLSelectElement).value as "stdio" | "sse";
    const errEl = document.getElementById("mcp-form-error")!;

    if (!name) { errEl.textContent = "Name required"; errEl.classList.remove("hidden"); return; }

    const mcpConfig: Record<string, unknown> = { transport, enabled: false };
    if (transport === "stdio") {
      const command = (document.getElementById("mcp-add-command") as HTMLInputElement).value.trim();
      if (!command) { errEl.textContent = "Command required"; errEl.classList.remove("hidden"); return; }
      mcpConfig.command = command;
      const args = (document.getElementById("mcp-add-args") as HTMLInputElement).value.trim();
      if (args) mcpConfig.args = args.split(/\s+/);
      const envText = (document.getElementById("mcp-add-env") as HTMLTextAreaElement).value.trim();
      if (envText) {
        const env: Record<string, string> = {};
        for (const line of envText.split("\n")) {
          const eq = line.indexOf("=");
          if (eq > 0) env[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
        }
        mcpConfig.env = env;
      }
    } else {
      const url = (document.getElementById("mcp-add-url") as HTMLInputElement).value.trim();
      if (!url) { errEl.textContent = "URL required"; errEl.classList.remove("hidden"); return; }
      mcpConfig.url = url;
    }

    const id = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/-+$/, "");
    await window.yo.appsAdd(id, name);
    await window.yo.appsSetMcp(id, mcpConfig as any);
    await window.yo.mcpAddServer({ id, name, ...mcpConfig } as any);

    mcpAddForm.classList.add("hidden");
    const apps = await window.yo.appsList();
    reloadPanelApps(apps);
    const created = panelApps.find((a) => a.id === id);
    if (created) openPanelAppDetail(created);
    else loadApps();
  });

  // MCP add form cancel
  document.getElementById("mcp-add-cancel")!.addEventListener("click", () => loadApps());
  document.getElementById("mcp-add-cancel-btn")!.addEventListener("click", () => loadApps());

  // App add form save
  document.getElementById("app-add-save")!.addEventListener("click", async () => {
    let valid = true;
    const name = addNameInput.value.trim();
    const url = addUrlInput.value.trim();
    const slugInput = addSlugInput.value.trim();
    if (!name) { addNameInput.classList.add("invalid"); clearInvalid(addNameInput); valid = false; }
    if (!url) { addUrlInput.classList.add("invalid"); clearInvalid(addUrlInput); valid = false; }
    if (!valid) {
      appFormError.textContent = "Name and URL are required.";
      appFormError.classList.remove("hidden");
      return;
    }
    const id = slugInput ? slugify(slugInput) : slugify(name);
    if (!id) {
      addSlugInput.classList.add("invalid"); clearInvalid(addSlugInput);
      appFormError.textContent = "Slug must contain at least one letter or number.";
      appFormError.classList.remove("hidden");
      return;
    }
    const RESERVED = new Set(["yo", "sup", "dip", "drip", "peace", "council", "vibe"]);
    if (RESERVED.has(id)) {
      addSlugInput.classList.add("invalid"); clearInvalid(addSlugInput);
      appFormError.textContent = `"${id}" is a reserved command. Pick a different slug.`;
      appFormError.classList.remove("hidden");
      return;
    }
    // Uniqueness check — apps and vibes share one namespace.
    const existing = await window.yo.appsList();
    if (existing.some((a) => a.id === id)) {
      addSlugInput.classList.add("invalid"); clearInvalid(addSlugInput);
      appFormError.textContent = `Slug "${id}" is already taken. Pick a different one.`;
      appFormError.classList.remove("hidden");
      return;
    }
    await window.yo.appsAdd(id, name, url);
    // Force-web / do-not-record are set from the app's detail screen now; new
    // apps already default to capture-off in app-connector.add.
    // If this app was created from a browser tab, convert that tab into it.
    if (pendingOriginTab) { window.yo.convertTabToApp(pendingOriginTab, id); pendingOriginTab = null; }
    appAddForm.classList.add("hidden");
    const apps = await window.yo.appsList();
    reloadPanelApps(apps);
    const created = panelApps.find((a) => a.id === id);
    if (created) openPanelAppDetail(created);
    else loadApps();
  });

  // App detail back button
  document.getElementById("app-detail-close")!.addEventListener("click", () => closeAppDetail());

  // App detail "Open app" — opens the app as a panel (same path .dip uses)
  // and closes the Settings overlay so the panel is visible.
  document.getElementById("app-detail-open")!.addEventListener("click", () => {
    if (!currentAppId) return;
    void window.yo.execCommand(`dip ${currentAppId}`);
    closeAppDetail();
  });

  // Panel tab: "Pick Element" — start the element picker on the app preview.
  document.getElementById("app-pick-btn")?.addEventListener("click", () => { void pickElement(); });

  // Panel tab: command mapping form — Save / Cancel were never wired, so a
  // captured command had no way to persist.
  document.getElementById("map-save-btn")?.addEventListener("click", () => { void saveMapping(); });
  document.getElementById("map-cancel-btn")?.addEventListener("click", () => {
    appMapCommand.classList.add("hidden");
  });
  // Reveal the custom-key input when "+ custom command" is chosen.
  document.getElementById("map-command-key")?.addEventListener("change", (e) => {
    const sel = e.target as HTMLSelectElement;
    const custom = document.getElementById("map-custom-key") as HTMLInputElement;
    custom.classList.toggle("hidden", sel.value !== "__custom__");
    if (sel.value === "__custom__") custom.focus();
  });

  // App add form cancel
  document.getElementById("app-add-cancel")!.addEventListener("click", () => { pendingOriginTab = null; loadApps(); });
  document.getElementById("app-add-cancel-btn")!.addEventListener("click", () => { pendingOriginTab = null; loadApps(); });

  // Tab buttons
  document.querySelectorAll<HTMLButtonElement>(".app-detail-tab").forEach(btn => {
    btn.addEventListener("click", () => switchAppTab(btn.dataset.tab!));
  });

  // Dashboard save
  document.getElementById("app-dash-save")!.addEventListener("click", async () => {
    if (!currentAppId) return;
    const newId = appDetailId.value.trim().toLowerCase().replace(/[^a-z0-9_-]/g, "-");
    if (newId && newId !== currentAppId) {
      const ok = await window.yo.appsUpdateId(currentAppId, newId);
      if (ok) currentAppId = newId;
    }
    const name = appDetailName.value.trim();
    const url = appDetailUrl.value.trim();
    if (name) await window.yo.appsUpdateName(currentAppId, name);
    if (url) await window.yo.appsUpdateUrl(currentAppId, url);
    await window.yo.appsUpdateForceWeb(currentAppId, appForceWeb.checked);

    closeAppDetail();
  });

  // Dashboard cancel
  document.getElementById("app-dash-cancel")!.addEventListener("click", () => closeAppDetail());

  // Delete
  document.getElementById("app-detail-delete")!.addEventListener("click", async () => {
    if (!currentAppId) return;
    const confirmed = await confirmAction(`Delete app "${appDetailName.value}"?`);
    if (!confirmed) return;
    await window.yo.appsRemove(currentAppId);
    closeAppDetail();
  });

  // Export the current app as a .yoapp bundle (main shows the save dialog).
  document.getElementById("app-detail-export")?.addEventListener("click", async () => {
    if (!currentAppId) return;
    const btn = document.getElementById("app-detail-export") as HTMLButtonElement;
    const prev = btn.textContent;
    btn.disabled = true;
    btn.textContent = "Exporting…";
    try {
      const res = await window.yo.appExport(currentAppId);
      btn.textContent = res?.ok ? "Exported ✓" : (res?.error === "Canceled" ? prev : "Export failed");
    } catch {
      btn.textContent = "Export failed";
    } finally {
      setTimeout(() => { btn.disabled = false; btn.textContent = prev; }, 1800);
    }
  });

  // Import a .yoapp bundle (main shows the open dialog) → reload the apps list.
  document.getElementById("apps-import-btn")?.addEventListener("click", async () => {
    const btn = document.getElementById("apps-import-btn") as HTMLButtonElement;
    const prev = btn.textContent;
    btn.disabled = true;
    btn.textContent = "Importing…";
    try {
      const res = await window.yo.appImport();
      if (res?.ok) {
        btn.textContent = "Imported ✓";
        await loadApps();
      } else {
        btn.textContent = res?.error === "Canceled" ? (prev || "Import app") : "Import failed";
      }
    } catch {
      btn.textContent = "Import failed";
    } finally {
      setTimeout(() => { btn.disabled = false; btn.textContent = prev || "Import app"; }, 1800);
    }
  });

  // MCP tab: transport toggle, save, connect, disconnect
  document.getElementById("app-mcp-transport")!.addEventListener("change", updateMcpFields);
  document.getElementById("app-mcp-save")!.addEventListener("click", saveMcpConfig);

  document.getElementById("app-mcp-connect")!.addEventListener("click", async () => {
    if (!currentAppId) return;
    const btn = document.getElementById("app-mcp-connect") as HTMLButtonElement;
    btn.disabled = true;
    btn.textContent = "Connecting...";
    const result = await window.yo.mcpConnectServer(currentAppId);
    btn.disabled = false;
    btn.textContent = "Connect";
    if (result.ok) loadMcpTab();
    else {
      const badge = document.getElementById("app-mcp-status")!;
      badge.className = "mcp-status-badge status-error";
      badge.textContent = `error: ${result.error}`;
    }
  });

  document.getElementById("app-mcp-disconnect")!.addEventListener("click", async () => {
    if (!currentAppId) return;
    await window.yo.mcpDisconnectServer(currentAppId);
    loadMcpTab();
  });

  document.getElementById("app-mcp-server-override")!.addEventListener("change", (e) => {
    if (!currentAppId) return;
    window.yo.mcpSetServerOverride(currentAppId, (e.target as HTMLSelectElement).value);
    loadMcpTab();
  });

  // Connection tab: connector search
  document.getElementById("app-connector-search")!.addEventListener("input", (e) => {
    connectorSearchOffset = 0;
    loadConnectorGrid((e.target as HTMLInputElement).value.trim() || undefined);
  });

  document.getElementById("app-connector-load-more")!.addEventListener("click", () => {
    connectorSearchOffset += 20;
    const search = (document.getElementById("app-connector-search") as HTMLInputElement).value.trim() || undefined;
    loadConnectorGrid(search);
  });

  appSearchInput.addEventListener("input", () => { appsPage = 0; renderAppsList(); });

  // MCP changed event — refresh MCP tab if viewing
  window.yo.onMcpChanged(() => {
    if (!appDetail.classList.contains("hidden") && activeAppTab === "mcp" && currentAppId) {
      loadMcpTab();
    }
  });

  // Connectors changed event — refresh connection tab if viewing
  window.yo.onConnectorsChanged(async () => {
    if (!appDetail.classList.contains("hidden") && activeAppTab === "connection" && currentAppId) {
      const apps = await window.yo.appsList();
      reloadPanelApps(apps);
      loadConnectionTab();
    }
  });

  // Apps dir changed on disk (e.g. an app dropped into ~/yo/apps) — refresh the
  // registry list live when it's the visible view, so new apps appear without a
  // restart. Skip while a detail/form is open to avoid yanking the user away.
  window.yo.onAppsChanged(() => {
    if (!appsList.classList.contains("hidden") && appDetail.classList.contains("hidden") && appAddForm.classList.contains("hidden")) {
      loadApps();
    }
  });

  // Draggable split divider
  const divider = document.getElementById("app-builder-divider")!;
  const controls = document.querySelector(".app-builder-controls") as HTMLElement;
  let dragging = false;
  let startX = 0;
  let startW = 0;

  divider.addEventListener("mousedown", (e) => {
    dragging = true;
    startX = e.clientX;
    startW = controls.offsetWidth;
    divider.classList.add("dragging");
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    e.preventDefault();
  });

  document.addEventListener("mousemove", (e) => {
    if (!dragging) return;
    const w = Math.max(200, Math.min(800, startW + (e.clientX - startX)));
    controls.style.width = w + "px";
  });

  document.addEventListener("mouseup", () => {
    if (!dragging) return;
    dragging = false;
    divider.classList.remove("dragging");
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
  });
}

export { loadApps, initApps, closeAppDetail, pickElement, saveMapping };
