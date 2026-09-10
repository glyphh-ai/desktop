/**
 * cli-agents.ts — the AGENTS section: CLI pre-configs (Claude first).
 *
 * A card per agent (icon + name + command); clicking a card opens the inline
 * editor; ▶ Open plays the pre-config into a terminal card on the workbench
 * (code-workbench's __wbOpenAgentCli). Storage is main's ~/.glyphh/agents
 * store via the cli-agents-* IPC; saves announce "glyphh:cli-agents-changed"
 * so the echo wall and the layout editor pick up new tiles/cells live.
 */

interface CliAgent { id: string; name: string; icon: string; cmd: string; mcp: boolean; command: string }

const api = () => (window as unknown as { glyphh?: {
  cliAgentsList?: () => Promise<{ ok: boolean; agents: CliAgent[]; error?: string }>;
  cliAgentsSave?: (input: { id?: string; name: string; icon?: string; cmd: string; mcp?: boolean }) => Promise<{ ok: boolean; agent?: CliAgent; error?: string }>;
  cliAgentsDelete?: (id: string) => Promise<{ ok: boolean; error?: string }>;
} }).glyphh ?? {};

let all: CliAgent[] = [];
let editing: CliAgent | null = null;

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
  (el<HTMLInputElement>("cagent-icon")!).value = agent?.icon ?? "";
  // The Claude case is one click: a new agent lands pre-filled.
  (el<HTMLInputElement>("cagent-cmd")!).value = agent?.cmd ?? "claude";
  (el<HTMLInputElement>("cagent-mcp")!).checked = agent ? agent.mcp : true;
  el("cagent-open-btn")?.classList.toggle("hidden", !agent);
  el("cagent-delete-btn")?.classList.toggle("hidden", !agent);
  const head = el("cagent-detail-head");
  if (head) head.innerHTML = `<div class="edit-head-name">${agent ? esc(agent.name) : "New agent"}</div>`;
  paintPreview();
}

function paintPreview(): void {
  const preview = el("cagent-cmd-preview");
  if (!preview) return;
  const cmd = (el<HTMLInputElement>("cagent-cmd")?.value ?? "").trim();
  const mcp = el<HTMLInputElement>("cagent-mcp")?.checked !== false;
  if (!cmd) { preview.textContent = ""; return; }
  preview.textContent = `runs: ${cmd}${mcp ? ' --mcp-config "~/.glyphh/agents/<agent>/mcp.json"' : ""}`;
}

function renderList(): void {
  const list = el("cagents-list");
  if (!list) return;
  const q = (el<HTMLInputElement>("cagent-search")?.value ?? "").trim().toLowerCase();
  const rows = q ? all.filter((a) => a.name.toLowerCase().includes(q) || a.cmd.toLowerCase().includes(q)) : all;
  if (!rows.length) {
    list.innerHTML = `<div class="crud-empty">No agents yet — <b>+ New</b> pre-wires Claude in two fields.</div>`;
    return;
  }
  list.innerHTML = rows.map((a) => `
    <div class="crud-card cagent-card" data-id="${esc(a.id)}">
      <div class="crud-card-title">${a.icon ? `<span class="cagent-glyph">${esc(a.icon)}</span> ` : ""}${esc(a.name)}</div>
      <div class="crud-card-sub" style="font-family:ui-monospace,monospace;">${esc(a.cmd)}${a.mcp ? " · glyphh tools" : ""}</div>
      <div class="crud-card-actions"><button type="button" class="action-btn cagent-open" title="Open in a terminal">&#9654; Open</button></div>
    </div>`).join("");
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

  el("cagents-list")?.addEventListener("click", (ev) => {
    const card = (ev.target as HTMLElement).closest<HTMLElement>(".cagent-card");
    if (!card?.dataset.id) return;
    const agent = all.find((a) => a.id === card.dataset.id);
    if (!agent) return;
    if ((ev.target as HTMLElement).closest(".cagent-open")) {
      (window as unknown as { __wbOpenAgentCli?: (id: string) => void }).__wbOpenAgentCli?.(agent.id);
      return;
    }
    showEditor(agent);
  });

  el("cagent-save-btn")?.addEventListener("click", () => {
    const err = el("cagent-form-error");
    const input = {
      ...(editing ? { id: editing.id } : {}),
      name: el<HTMLInputElement>("cagent-name")?.value ?? "",
      icon: el<HTMLInputElement>("cagent-icon")?.value ?? "",
      cmd: el<HTMLInputElement>("cagent-cmd")?.value ?? "",
      mcp: el<HTMLInputElement>("cagent-mcp")?.checked !== false,
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

  el("cagent-delete-btn")?.addEventListener("click", () => {
    if (!editing) return;
    void api().cliAgentsDelete?.(editing.id).then((r) => {
      if (!r?.ok) return;
      announce();
      void refresh().then(showList);
    });
  });

  el("cagent-open-btn")?.addEventListener("click", () => {
    if (!editing) return;
    (window as unknown as { __wbOpenAgentCli?: (id: string) => void }).__wbOpenAgentCli?.(editing.id);
  });
}
