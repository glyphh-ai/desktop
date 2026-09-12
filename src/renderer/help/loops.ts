/**
 * loops.ts — the LOOPS section: CLI pre-configs (Claude first).
 *
 * THE CLI IS THE LOOP (his architecture, 2026-09-11: "i don't want to own
 * the loop... it should be the cli"). Glyphh owns no agent-loop logic; a
 * Loop here is a named config for someone else's CLI.
 *
 * A card per loop (icon + name + command); clicking a card opens the inline
 * editor; ▶ Open plays the pre-config into a terminal card on the workbench
 * (code-workbench's __wbOpenAgentCli). Storage is main's ~/.glyphh/loops
 * store via the cli-agents-* IPC; saves announce "glyphh:cli-agents-changed"
 * so the echo wall and the layout editor pick up new tiles/cells live.
 *
 * The cli-agents-* channel + method names are the UNDER-THE-HOOD spelling
 * and stay: these really are CLI agent configs. Only the surface is "Loop".
 */

import { paginate, renderPaginationBar, confirmAction } from "./shared.js";

interface CliAgent { id: string; name: string; cli: "claude" | "codex" | "gemini" | "copilot" | "cursor" | "custom"; icon: string; cmd: string; model: string; mcp: boolean; cwd: string; session: "keep" | "new" | "last"; apiKey: { name: string; hint: string } | null; command: string }

/** The CLIs' public web marks — the brand icons their agents wear. */
const CLI_MARK_URLS: Record<string, string> = {
  claude: "https://claude.ai/favicon.ico",
  codex: "https://openai.com/favicon.ico",
  gemini: "https://www.google.com/s2/favicons?domain=gemini.google.com&sz=64",
  copilot: "https://github.com/favicon.ico",
  cursor: "https://cursor.com/favicon.ico",
};

const api = () => (window as unknown as { glyphh?: {
  cliAgentsList?: () => Promise<{ ok: boolean; agents: CliAgent[]; error?: string }>;
  cliAgentsSave?: (input: { id?: string; name: string; icon?: string; cmd: string; mcp?: boolean; cli?: string; cwd?: string; session?: string; model?: string; apiKeyOn?: boolean; apiKeyName?: string; apiKeyValue?: string }) => Promise<{ ok: boolean; agent?: CliAgent; error?: string }>;
  cliAgentsDelete?: (id: string) => Promise<{ ok: boolean; error?: string }>;
  cliAgentsKeyDelete?: (id: string) => Promise<{ ok: boolean; error?: string }>;
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
  el("loop-editor")?.classList.add("hidden");
  el("loops-list")?.classList.remove("hidden");
  el("loops-toolbar")?.classList.remove("hidden");
}

function showEditor(agent: CliAgent | null): void {
  editing = agent;
  el("loops-list")?.classList.add("hidden");
  el("loops-toolbar")?.classList.add("hidden");
  const ed = el("loop-editor");
  ed?.classList.remove("hidden");
  el("loop-form-error")?.classList.add("hidden");
  (el<HTMLInputElement>("loop-name")!).value = agent?.name ?? "";
  (el<HTMLSelectElement>("loop-cli")!).value = agent?.cli ?? "claude";
  (el<HTMLInputElement>("loop-icon")!).value = agent?.icon ?? "";
  // The Claude case is one click: a new agent lands pre-filled.
  (el<HTMLInputElement>("loop-cmd")!).value = agent?.cmd ?? "claude";
  (el<HTMLInputElement>("loop-folder-input")!).value = agent?.cwd ?? "";
  (el<HTMLInputElement>("loop-mcp")!).checked = agent ? agent.mcp : true;
  (el<HTMLSelectElement>("loop-session")!).value = agent?.session ?? "keep";
  (el<HTMLSelectElement>("loop-permission")!).value = (agent as { permission?: string } | null)?.permission ?? "ask";
  // API key: WRITE-ONLY. The value field starts empty; a stored key shows
  // its first/last glimpse in the hint so the user knows WHICH key it is.
  (el<HTMLInputElement>("loop-apikey-on")!).checked = !!agent?.apiKey;
  (el<HTMLInputElement>("loop-apikey-name")!).value = agent?.apiKey?.name ?? "";
  (el<HTMLInputElement>("loop-apikey-value")!).value = "";
  const kh = el("loop-apikey-hint");
  if (kh) kh.textContent = agent?.apiKey ? `Current Key: ${agent.apiKey.hint}` : "";
  el("loop-apikey-current")?.classList.toggle("hidden", !agent?.apiKey);
  syncApiKeyRow();
  syncCliRow();
  paintModelRow(agent?.model ?? "");
  el("loop-open-btn")?.classList.toggle("hidden", !agent);
  el("loop-delete-btn")?.classList.toggle("hidden", !agent);
  const head = el("loop-detail-head");
  if (head) head.innerHTML = `<div class="edit-head-name">${agent ? esc(agent.name) : "New loop"}</div>`;
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

/** A governed model, as the server's effective set hands it over. */
interface CatalogModel { id: string; name: string; providerSlug?: string; pickerVisible?: boolean }
let models: CatalogModel[] = [];

/** Vendor → the catalog's provider slug. Claude's models come from Anthropic
 *  as a PROVIDER on the server; an unrecognized CLI (custom, or one proxied
 *  through the router) gets the whole list rather than an empty one. */
const CLI_PROVIDER: Record<string, string> = { claude: "anthropic", codex: "openai", gemini: "google" };

/** The server's effective set — catalog ∩ provider-enabled ∩ (org-supported,
 *  only on a governance plan) ∩ the caller's role grant. All of that is
 *  resolved server-side; this just renders what comes back. */
async function loadModels(): Promise<void> {
  const r = await (window.glyphh as unknown as { workspacesModelCatalog?: () => Promise<{ ok: boolean; models?: CatalogModel[] }> })
    .workspacesModelCatalog?.().catch(() => null);
  models = (r?.ok ? r.models ?? [] : []).filter((m) => m.pickerVisible !== false);
}

/** Paint the Model dropdown for whichever CLI is selected. */
function paintModelRow(selected: string): void {
  const sel = el<HTMLSelectElement>("loop-model");
  if (!sel) return;
  const cli = el<HTMLSelectElement>("loop-cli")?.value ?? "claude";
  const want = CLI_PROVIDER[cli];
  const pool = want ? models.filter((m) => m.providerSlug === want) : models;
  const list = pool.length ? pool : models;
  sel.innerHTML = "";
  const auto = document.createElement("option");
  auto.value = "";
  auto.textContent = "The CLI's default";
  sel.appendChild(auto);
  for (const m of list) {
    const opt = document.createElement("option");
    opt.value = m.id;
    opt.textContent = m.name || m.id;
    sel.appendChild(opt);
  }
  // A model the org has since stopped supporting still shows its binding
  // rather than silently snapping the loop to something else.
  if (selected && !list.some((m) => m.id === selected)) {
    const opt = document.createElement("option");
    opt.value = selected;
    opt.textContent = `${selected} (not available)`;
    sel.appendChild(opt);
  }
  sel.value = selected || "";
}

/** Branded CLIs wear their own marks — the emoji field is for custom ones. */
function syncCliRow(): void {
  const cli = el<HTMLSelectElement>("loop-cli")?.value ?? "claude";
  el("loop-icon-row")?.classList.toggle("hidden", cli in CLI_MARK_URLS);
  // The model list follows the CLI's vendor.
  paintModelRow(el<HTMLSelectElement>("loop-model")?.value ?? "");
  // The Variable field follows the CLI unless the user typed their own.
  const nameEl = el<HTMLInputElement>("loop-apikey-name");
  if (nameEl) {
    const cur = nameEl.value.trim();
    if (!cur || Object.values(CLI_KEY_NAMES).includes(cur)) nameEl.value = CLI_KEY_NAMES[cli] ?? "";
  }
}

function syncApiKeyRow(): void {
  const on = el<HTMLInputElement>("loop-apikey-on")?.checked === true;
  el("loop-apikey-fields")?.classList.toggle("hidden", !on);
}

function paintPreview(): void {
  const preview = el("loop-cmd-preview");
  if (!preview) return;
  const cmd = (el<HTMLInputElement>("loop-cmd")?.value ?? "").trim();
  const cli = el<HTMLSelectElement>("loop-cli")?.value ?? "claude";
  const mcp = el<HTMLInputElement>("loop-mcp")?.checked !== false;
  if (!cmd) { preview.textContent = ""; return; }
  // Honest per-CLI wiring note — claude takes a flag; codex takes -c
  // overrides; gemini/copilot/cursor get their settings files written.
  const wiring = !mcp ? ""
    : cli === "claude" ? ' --mcp-config "~/.glyphh/loops/<loop>/mcp.json"'
    : cli === "codex" ? " -c mcp_servers.glyphh.… (composed at open)"
    : cli === "custom" ? "  (mcp.json written beside the loop)"
    : "  (glyphh added to the CLI's own MCP settings at open)";
  preview.textContent = `runs: ${cmd}${wiring}`;
}

const AGENT_CARD_GLYPH = `<svg viewBox="0 0 24 24" fill="none" style="width:26px;height:26px"><path d="M12 2.2v2.6" style="fill:none;stroke:#a21caf;stroke-width:1.8"/><circle cx="12" cy="2.6" r="1.3" style="fill:#d946ef"/><rect x="2" y="10" width="2" height="4.5" rx="1" style="fill:#a21caf"/><rect x="20" y="10" width="2" height="4.5" rx="1" style="fill:#a21caf"/><rect x="4" y="6" width="16" height="12.5" rx="3.5" style="fill:#d946ef"/><circle cx="9" cy="11.4" r="1.7" style="fill:#ffffff"/><circle cx="15" cy="11.4" r="1.7" style="fill:#ffffff"/><rect x="8.6" y="15" width="6.8" height="1.7" rx="0.85" style="fill:#f5d0fe"/></svg>`;

/** The SAME shape Apps/Workspaces render: a card grid, 15 to a page (his
 *  rule, 2026-09-10). Click edits; double-click (or the editor's ▶) opens. */
function renderList(): void {
  const list = el("loops-list");
  if (!list) return;
  const q = (el<HTMLInputElement>("loop-search")?.value ?? "").trim().toLowerCase();
  const filtered = q ? all.filter((a) => a.name.toLowerCase().includes(q) || a.cmd.toLowerCase().includes(q)) : all;
  list.innerHTML = "";
  if (!filtered.length) {
    list.innerHTML = q
      ? `<div class="crud-empty">No loops matching "${esc(q)}"</div>`
      : `<div class="crud-empty">No loops yet — <b>+ New</b> pre-wires Claude in two fields.</div>`;
    return;
  }
  const { items, state } = paginate(filtered, listPage);
  listPage = state.page;
  const grid = document.createElement("div");
  grid.className = "app-grid";
  for (const a of items) {
    const card = document.createElement("div");
    card.className = "app-card loop-card";
    card.dataset.id = a.id;
    card.innerHTML = `
      <div class="app-card-icon"${a.cli in CLI_MARK_URLS ? ` data-role="loop-mark" data-cli="${esc(a.cli)}"` : ""}>${a.cli in CLI_MARK_URLS
        ? AGENT_CARD_GLYPH
        : a.icon ? `<span class="loop-card-emoji">${esc(a.icon)}</span>` : AGENT_CARD_GLYPH}</div>
      <div class="app-card-name">${esc(a.name)}</div>
      <div class="app-card-id" style="font-family:ui-monospace,monospace;">${esc(a.cmd)}${a.mcp ? " · glyphh tools" : ""}</div>`;
    grid.appendChild(card);
  }
  list.appendChild(grid);
  // Branded cards swap the placeholder glyph for their fetched mark.
  grid.querySelectorAll<HTMLElement>('[data-role="loop-mark"]').forEach((elm) => {
    void cliMark(elm.dataset.cli || "").then((data) => {
      if (data) elm.innerHTML = `<img class="loop-card-mark" src="${data}" alt="" />`;
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

export function loadLoops(): void {
  showList();
  // The governed catalog rides along — the Model field is a dropdown over
  // the effective set, not a slug anyone can mistype.
  void loadModels();
  void refresh();
}

export function initLoopsEvents(): void {
  el("loop-new-btn")?.addEventListener("click", () => showEditor(null));
  el("loops-refresh-btn")?.addEventListener("click", () => loadLoops());
  el("loop-back-link")?.addEventListener("click", () => { showList(); });
  el<HTMLInputElement>("loop-search")?.addEventListener("input", renderList);
  el<HTMLInputElement>("loop-cmd")?.addEventListener("input", paintPreview);
  el<HTMLInputElement>("loop-mcp")?.addEventListener("change", paintPreview);
  el<HTMLInputElement>("loop-apikey-on")?.addEventListener("change", () => { syncApiKeyRow(); syncCliRow(); });
  el("loop-apikey-delete")?.addEventListener("click", () => {
    if (!editing?.apiKey) return;
    const doomed = editing;
    void confirmAction({
      title: `Remove the stored ${doomed.apiKey!.name}?`,
      body: "The key file is deleted from disk; the loop opens without it until a new key is saved.",
      confirmLabel: "Remove",
      danger: true,
    }).then((yes) => {
      if (!yes) return;
      void api().cliAgentsKeyDelete?.(doomed.id).then((r) => {
        if (!r?.ok) return;
        announce();
        void refresh().then(() => {
          const fresh = all.find((a) => a.id === doomed.id) ?? null;
          if (editing?.id === doomed.id) showEditor(fresh);
        });
      });
    });
  });
  el<HTMLSelectElement>("loop-cli")?.addEventListener("change", () => {
    syncCliRow();
    // Picking a branded CLI seeds the command if the field is empty or still
    // the OTHER brand's default.
    const cli = el<HTMLSelectElement>("loop-cli")?.value ?? "claude";
    const cmd = el<HTMLInputElement>("loop-cmd");
    const CLI_DEFAULT_CMDS: Record<string, string> = { claude: "claude", codex: "codex", gemini: "gemini", copilot: "copilot", cursor: "cursor-agent" };
    if (cmd && cli in CLI_DEFAULT_CMDS) {
      const cur = cmd.value.trim();
      if (!cur || Object.values(CLI_DEFAULT_CMDS).includes(cur)) cmd.value = CLI_DEFAULT_CMDS[cli];
    }
    paintPreview();
  });
  const pickFolder = (): void => {
    void api().layoutsPickFolder?.().then((dir) => {
      if (dir) { const f = el<HTMLInputElement>("loop-folder-input"); if (f) f.value = dir; }
    });
  };
  el("loop-folder-pick")?.addEventListener("click", pickFolder);
  // The readonly field IS the picker — clicking it opens the dialog too.
  el("loop-folder-input")?.addEventListener("click", pickFolder);
  el("loop-folder-clear")?.addEventListener("click", () => {
    const f = el<HTMLInputElement>("loop-folder-input"); if (f) f.value = "";
  });

  el("loops-list")?.addEventListener("click", (ev) => {
    const card = (ev.target as HTMLElement).closest<HTMLElement>(".loop-card");
    if (!card?.dataset.id) return;
    const agent = all.find((a) => a.id === card.dataset.id);
    if (agent) showEditor(agent);
  });
  el("loops-list")?.addEventListener("dblclick", (ev) => {
    const card = (ev.target as HTMLElement).closest<HTMLElement>(".loop-card");
    if (!card?.dataset.id) return;
    (window as unknown as { __wbOpenAgentCli?: (id: string) => void }).__wbOpenAgentCli?.(card.dataset.id);
  });

  el("loop-save-btn")?.addEventListener("click", () => {
    const err = el("loop-form-error");
    const input = {
      ...(editing ? { id: editing.id } : {}),
      name: el<HTMLInputElement>("loop-name")?.value ?? "",
      cli: el<HTMLSelectElement>("loop-cli")?.value ?? "claude",
      icon: el<HTMLInputElement>("loop-icon")?.value ?? "",
      cmd: el<HTMLInputElement>("loop-cmd")?.value ?? "",
      cwd: el<HTMLInputElement>("loop-folder-input")?.value ?? "",
      model: el<HTMLSelectElement>("loop-model")?.value ?? "",
      mcp: el<HTMLInputElement>("loop-mcp")?.checked !== false,
      session: el<HTMLSelectElement>("loop-session")?.value ?? "keep",
      permission: el<HTMLSelectElement>("loop-permission")?.value ?? "ask",
      apiKeyOn: el<HTMLInputElement>("loop-apikey-on")?.checked === true,
      apiKeyName: el<HTMLInputElement>("loop-apikey-name")?.value ?? "",
      // Only a TYPED value travels — empty means keep what's stored.
      apiKeyValue: el<HTMLInputElement>("loop-apikey-value")?.value ?? "",
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

  el("loop-cancel-btn")?.addEventListener("click", () => { showList(); });
  el("loop-delete-btn")?.addEventListener("click", () => {
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

  el("loop-open-btn")?.addEventListener("click", () => {
    if (!editing) return;
    (window as unknown as { __wbOpenAgentCli?: (id: string) => void }).__wbOpenAgentCli?.(editing.id);
  });
}
