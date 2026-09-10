/**
 * cli-agents.ts — the AGENTS section: CLI pre-configs (Claude first).
 *
 * A card per agent (icon + name + command); clicking a card opens the inline
 * editor; ▶ Open plays the pre-config into a terminal card on the workbench
 * (code-workbench's __wbOpenAgentCli). Storage is main's ~/.glyphh/agents
 * store via the cli-agents-* IPC; saves announce "glyphh:cli-agents-changed"
 * so the echo wall and the layout editor pick up new tiles/cells live.
 */

import { paginate, renderPaginationBar, confirmAction } from "./shared.js";

interface CliAgent { id: string; name: string; cli: "claude" | "codex" | "gemini" | "copilot" | "cursor" | "custom"; icon: string; cmd: string; mcp: boolean; cwd: string; keepAlive: boolean; apiKey: { name: string; hint: string } | null; command: string }

/** The CLIs' public web marks — the brand icons their agents wear. */
const CLI_MARK_URLS: Record<string, string> = {
  claude: "https://claude.ai/favicon.ico",
  codex: "https://openai.com/favicon.ico",
  gemini: "https://gemini.google.com/favicon.ico",
  copilot: "https://github.com/favicon.ico",
  cursor: "https://cursor.com/favicon.ico",
};

const api = () => (window as unknown as { glyphh?: {
  cliAgentsList?: () => Promise<{ ok: boolean; agents: CliAgent[]; error?: string }>;
  cliAgentsSave?: (input: { id?: string; name: string; icon?: string; cmd: string; mcp?: boolean; cli?: string; cwd?: string; keepAlive?: boolean; apiKeyOn?: boolean; apiKeyName?: string; apiKeyValue?: string }) => Promise<{ ok: boolean; agent?: CliAgent; error?: string }>;
  cliAgentsDelete?: (id: string) => Promise<{ ok: boolean; error?: string }>;
  layoutsPickFolder?: () => Promise<string | null>;
  webIconFetch?: (url: string) => Promise<string>;
} }).glyphh ?? {};

/** Marks ride the main process (web-icon-fetch → data URL, cached) — a
 *  direct remote <img> doesn't render from the desktop page. */
const markCache = new Map<string, string>();
async function cliMark(cli: string): Promise<string> {
  const url = CLI_MARK_URLS[cli];
  if (!url) return "";
  if (!markCache.has(url)) markCache.set(url, (await api().webIconFetch?.(url).catch(() => "")) || "");
  return markCache.get(url) || "";
}

let all: CliAgent[] = [];
let editing: CliAgent | null = null;
let listPage = 0;

const el = <T extends HTMLElement = HTMLElement>(id: string): T | null => document.getElementById(id) as T | null;
const esc = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const announce = (): void => { window.dispatchEvent(new CustomEvent("glyphh:cli-agents-changed")); };

function showList(): void {
  el("cagent-editor")?.classList.add("hidden");
  el("cagents-list")?.classList.remove("hidden");
  el("cagents-toolbar")?.classList.remove("hidden");
}

function showEditor(agent: CliAgent | null): void {
  editing = agent;
  el("cagents-list")?.classList.add("hidden");
  el("cagents-toolbar")?.classList.add("hidden");
  const ed = el("cagent-editor");
  ed?.classList.remove("hidden");
  el("cagent-form-error")?.classList.add("hidden");
  (el<HTMLInputElement>("cagent-name")!).value = agent?.name ?? "";
  (el<HTMLSelectElement>("cagent-cli")!).value = agent?.cli ?? "claude";
  (el<HTMLInputElement>("cagent-icon")!).value = agent?.icon ?? "";
  // The Claude case is one click: a new agent lands pre-filled.
  (el<HTMLInputElement>("cagent-cmd")!).value = agent?.cmd ?? "claude";
  (el<HTMLInputElement>("cagent-folder-input")!).value = agent?.cwd ?? "";
  (el<HTMLInputElement>("cagent-mcp")!).checked = agent ? agent.mcp : true;
  (el<HTMLInputElement>("cagent-keepalive")!).checked = agent ? agent.keepAlive !== false : true;
  // API key: WRITE-ONLY. The value field starts empty; a stored key shows
  // its first/last glimpse in the hint so the user knows WHICH key it is.
  (el<HTMLInputElement>("cagent-apikey-on")!).checked = !!agent?.apiKey;
  (el<HTMLInputElement>("cagent-apikey-name")!).value = agent?.apiKey?.name ?? "";
  (el<HTMLInputElement>("cagent-apikey-value")!).value = "";
  const kh = el("cagent-apikey-hint");
  if (kh) kh.textContent = agent?.apiKey ? `set: ${agent.apiKey.hint} — type to replace` : "";
  syncApiKeyRow();
  syncCliRow();
  el("cagent-open-btn")?.classList.toggle("hidden", !agent);
  el("cagent-delete-btn")?.classList.toggle("hidden", !agent);
  const head = el("cagent-detail-head");
  if (head) head.innerHTML = `<div class="edit-head-name">${agent ? esc(agent.name) : "New agent"}</div>`;
  paintPreview();
}

/** The env var each CLI expects its key in — pre-populates the Variable
 *  field when Pass API key turns on (editable; custom starts blank). */
const CLI_KEY_NAMES: Record<string, string> = {
  claude: "ANTHROPIC_API_KEY",
  codex: "OPENAI_API_KEY",
  gemini: "GEMINI_API_KEY",
  copilot: "GITHUB_TOKEN",
  cursor: "CURSOR_API_KEY",
};

/** Branded CLIs wear their own marks — the emoji field is for custom ones. */
function syncCliRow(): void {
  const cli = el<HTMLSelectElement>("cagent-cli")?.value ?? "claude";
  el("cagent-icon-row")?.classList.toggle("hidden", cli in CLI_MARK_URLS);
  // The Variable field follows the CLI unless the user typed their own.
  const nameEl = el<HTMLInputElement>("cagent-apikey-name");
  if (nameEl) {
    const cur = nameEl.value.trim();
    if (!cur || Object.values(CLI_KEY_NAMES).includes(cur)) nameEl.value = CLI_KEY_NAMES[cli] ?? "";
  }
}

function syncApiKeyRow(): void {
  const on = el<HTMLInputElement>("cagent-apikey-on")?.checked === true;
  el("cagent-apikey-fields")?.classList.toggle("hidden", !on);
}

function paintPreview(): void {
  const preview = el("cagent-cmd-preview");
  if (!preview) return;
  const cmd = (el<HTMLInputElement>("cagent-cmd")?.value ?? "").trim();
  const mcp = el<HTMLInputElement>("cagent-mcp")?.checked !== false;
  if (!cmd) { preview.textContent = ""; return; }
  preview.textContent = `runs: ${cmd}${mcp ? ' --mcp-config "~/.glyphh/agents/<agent>/mcp.json"' : ""}`;
}

const AGENT_CARD_GLYPH = `<svg viewBox="0 0 24 24" fill="none" style="width:26px;height:26px"><path d="M12 2.2v2.6" style="fill:none;stroke:#a21caf;stroke-width:1.8"/><circle cx="12" cy="2.6" r="1.3" style="fill:#d946ef"/><rect x="2" y="10" width="2" height="4.5" rx="1" style="fill:#a21caf"/><rect x="20" y="10" width="2" height="4.5" rx="1" style="fill:#a21caf"/><rect x="4" y="6" width="16" height="12.5" rx="3.5" style="fill:#d946ef"/><circle cx="9" cy="11.4" r="1.7" style="fill:#ffffff"/><circle cx="15" cy="11.4" r="1.7" style="fill:#ffffff"/><rect x="8.6" y="15" width="6.8" height="1.7" rx="0.85" style="fill:#f5d0fe"/></svg>`;

/** The SAME shape Apps/Workspaces render: a card grid, 15 to a page (his
 *  rule, 2026-09-10). Click edits; double-click (or the editor's ▶) opens. */
function renderList(): void {
  const list = el("cagents-list");
  if (!list) return;
  const q = (el<HTMLInputElement>("cagent-search")?.value ?? "").trim().toLowerCase();
  const filtered = q ? all.filter((a) => a.name.toLowerCase().includes(q) || a.cmd.toLowerCase().includes(q)) : all;
  list.innerHTML = "";
  if (!filtered.length) {
    list.innerHTML = q
      ? `<div class="crud-empty">No agents matching "${esc(q)}"</div>`
      : `<div class="crud-empty">No agents yet — <b>+ New</b> pre-wires Claude in two fields.</div>`;
    return;
  }
  const { items, state } = paginate(filtered, listPage);
  listPage = state.page;
  const grid = document.createElement("div");
  grid.className = "app-grid";
  for (const a of items) {
    const card = document.createElement("div");
    card.className = "app-card cagent-card";
    card.dataset.id = a.id;
    card.innerHTML = `
      <div class="app-card-icon"${a.cli in CLI_MARK_URLS ? ` data-role="cagent-mark" data-cli="${esc(a.cli)}"` : ""}>${a.cli in CLI_MARK_URLS
        ? AGENT_CARD_GLYPH
        : a.icon ? `<span class="cagent-card-emoji">${esc(a.icon)}</span>` : AGENT_CARD_GLYPH}</div>
      <div class="app-card-name">${esc(a.name)}</div>
      <div class="app-card-id" style="font-family:ui-monospace,monospace;">${esc(a.cmd)}${a.mcp ? " · glyphh tools" : ""}</div>`;
    grid.appendChild(card);
  }
  list.appendChild(grid);
  // Branded cards swap the placeholder glyph for their fetched mark.
  grid.querySelectorAll<HTMLElement>('[data-role="cagent-mark"]').forEach((elm) => {
    void cliMark(elm.dataset.cli || "").then((data) => {
      if (data) elm.innerHTML = `<img class="cagent-card-mark" src="${data}" alt="" />`;
    });
  });
  if (state.totalPages > 1) {
    list.appendChild(renderPaginationBar(state, (p) => { listPage = p; renderList(); }));
  }
}

async function refresh(): Promise<void> {
  const r = await api().cliAgentsList?.().catch(() => null);
  all = r?.ok ? r.agents : [];
  renderList();
}

export function loadCliAgents(): void {
  showList();
  void refresh();
}

export function initCliAgentsEvents(): void {
  el("cagent-new-btn")?.addEventListener("click", () => showEditor(null));
  el("cagent-back-link")?.addEventListener("click", () => { showList(); });
  el<HTMLInputElement>("cagent-search")?.addEventListener("input", renderList);
  el<HTMLInputElement>("cagent-cmd")?.addEventListener("input", paintPreview);
  el<HTMLInputElement>("cagent-mcp")?.addEventListener("change", paintPreview);
  el<HTMLInputElement>("cagent-apikey-on")?.addEventListener("change", () => { syncApiKeyRow(); syncCliRow(); });
  el<HTMLSelectElement>("cagent-cli")?.addEventListener("change", () => {
    syncCliRow();
    // Picking a branded CLI seeds the command if the field is empty or still
    // the OTHER brand's default.
    const cli = el<HTMLSelectElement>("cagent-cli")?.value ?? "claude";
    const cmd = el<HTMLInputElement>("cagent-cmd");
    const CLI_DEFAULT_CMDS: Record<string, string> = { claude: "claude", codex: "codex", gemini: "gemini", copilot: "copilot", cursor: "cursor-agent" };
    if (cmd && cli in CLI_DEFAULT_CMDS) {
      const cur = cmd.value.trim();
      if (!cur || Object.values(CLI_DEFAULT_CMDS).includes(cur)) cmd.value = CLI_DEFAULT_CMDS[cli];
    }
    paintPreview();
  });
  const pickFolder = (): void => {
    void api().layoutsPickFolder?.().then((dir) => {
      if (dir) { const f = el<HTMLInputElement>("cagent-folder-input"); if (f) f.value = dir; }
    });
  };
  el("cagent-folder-pick")?.addEventListener("click", pickFolder);
  // The readonly field IS the picker — clicking it opens the dialog too.
  el("cagent-folder-input")?.addEventListener("click", pickFolder);
  el("cagent-folder-clear")?.addEventListener("click", () => {
    const f = el<HTMLInputElement>("cagent-folder-input"); if (f) f.value = "";
  });

  el("cagents-list")?.addEventListener("click", (ev) => {
    const card = (ev.target as HTMLElement).closest<HTMLElement>(".cagent-card");
    if (!card?.dataset.id) return;
    const agent = all.find((a) => a.id === card.dataset.id);
    if (agent) showEditor(agent);
  });
  el("cagents-list")?.addEventListener("dblclick", (ev) => {
    const card = (ev.target as HTMLElement).closest<HTMLElement>(".cagent-card");
    if (!card?.dataset.id) return;
    (window as unknown as { __wbOpenAgentCli?: (id: string) => void }).__wbOpenAgentCli?.(card.dataset.id);
  });

  el("cagent-save-btn")?.addEventListener("click", () => {
    const err = el("cagent-form-error");
    const input = {
      ...(editing ? { id: editing.id } : {}),
      name: el<HTMLInputElement>("cagent-name")?.value ?? "",
      cli: el<HTMLSelectElement>("cagent-cli")?.value ?? "claude",
      icon: el<HTMLInputElement>("cagent-icon")?.value ?? "",
      cmd: el<HTMLInputElement>("cagent-cmd")?.value ?? "",
      cwd: el<HTMLInputElement>("cagent-folder-input")?.value ?? "",
      mcp: el<HTMLInputElement>("cagent-mcp")?.checked !== false,
      keepAlive: el<HTMLInputElement>("cagent-keepalive")?.checked !== false,
      apiKeyOn: el<HTMLInputElement>("cagent-apikey-on")?.checked === true,
      apiKeyName: el<HTMLInputElement>("cagent-apikey-name")?.value ?? "",
      // Only a TYPED value travels — empty means keep what's stored.
      apiKeyValue: el<HTMLInputElement>("cagent-apikey-value")?.value ?? "",
    };
    void api().cliAgentsSave?.(input).then((r) => {
      if (!r?.ok) {
        if (err) { err.textContent = r?.error ?? "save failed"; err.classList.remove("hidden"); }
        return;
      }
      announce();
      void refresh().then(showList);
    });
  });

  el("cagent-cancel-btn")?.addEventListener("click", () => { showList(); });
  el("cagent-delete-btn")?.addEventListener("click", () => {
    if (!editing) return;
    const doomed = editing;
    void confirmAction({
      title: `Delete agent "${doomed.name}"?`,
      body: "Its card leaves the wall and any workspace cells stop resolving. Saved terminal sessions close.",
      confirmLabel: "Delete",
      danger: true,
    }).then((yes) => {
      if (!yes) return;
      void api().cliAgentsDelete?.(doomed.id).then((r) => {
        if (!r?.ok) return;
        announce();
        void refresh().then(showList);
      });
    });
  });

  el("cagent-open-btn")?.addEventListener("click", () => {
    if (!editing) return;
    (window as unknown as { __wbOpenAgentCli?: (id: string) => void }).__wbOpenAgentCli?.(editing.id);
  });
}
