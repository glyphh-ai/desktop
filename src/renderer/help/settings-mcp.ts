/**
 * settings-mcp.ts — Settings › MCP.
 *
 * The CLOUD connection surface: the endpoint an external MCP client (Claude,
 * Cursor, any MCP-capable IDE) connects to, the OAuth clients currently
 * holding access (list + revoke), and the skill export. The old panel here
 * configured a LOCAL 127.0.0.1 server — that server is gone; everything on
 * this panel is about api.glyphh.ai/mcp.
 *
 * Transport — settings-apikeys.ts's pattern, the one transport for BOTH
 * surfaces (the renderer never holds an SDK client):
 *   • web     — window.glyphhSdk.http (checked FIRST; on web window.glyphh is
 *               a Proxy that fabricates any method, so the SDK handle must
 *               win). No typed SDK resource covers /api/me/mcp-clients yet,
 *               so this uses the authed-HTTP escape hatch.
 *   • desktop — window.glyphh.mcpClientsList / mcpClientsRevoke → the
 *               MAIN-process SDK client (settings-ipc.ts).
 * Neither present → an honest "not available on this build" message.
 */

import { escapeHtml, confirmAction, paginate, renderPaginationBar } from "./shared.js";
import { kebabCell, ROW_MENU_ICONS } from "./lib-editor.js";

export interface McpClientRow {
  grantId: string;
  clientId: string;
  clientName: string;
  createdAt: string;
  lastUsedAt: string | null;
}

interface SdkHttp {
  get?: <T>(path: string) => Promise<T>;
  del?: <T>(path: string) => Promise<T>;
}
interface DesktopMcpIpc {
  mcpClientsList?: () => Promise<McpClientRow[]>;
  mcpClientsRevoke?: (clientId: string) => Promise<{ ok: boolean; error?: string }>;
}

interface McpTransport {
  list(): Promise<McpClientRow[]>;
  revoke(grantId: string): Promise<void>;
}

const NO_TRANSPORT = "MCP connections aren't available on this build.";

function isWeb(): boolean {
  return !!(window as unknown as { __GLYPHH_WEB__?: boolean }).__GLYPHH_WEB__;
}

function transport(): McpTransport | null {
  if (isWeb()) {
    const h = (window as unknown as { glyphhSdk?: { http?: SdkHttp } }).glyphhSdk?.http;
    if (!h?.get || !h.del) return null;
    // Method-call syntax on `h` keeps `this` bound — the SDK's AuthedHttp
    // reaches for private state and a detached method throws (settings-api.ts's
    // `need()` lesson).
    return {
      list: async () => (await h.get!<{ grants: McpClientRow[] }>("/api/oauth/grants")).grants ?? [],
      revoke: async (grantId) => { await h.del!(`/api/oauth/grants/${encodeURIComponent(grantId)}`); },
    };
  }
  const g = (window as unknown as { glyphh?: DesktopMcpIpc }).glyphh;
  if (!g?.mcpClientsList || !g.mcpClientsRevoke) return null;
  return {
    list: () => g.mcpClientsList!(),
    revoke: async (clientId) => {
      const r = await g.mcpClientsRevoke!(clientId);
      if (!r?.ok) throw new Error(r?.error || "Could not revoke.");
    },
  };
}

const $ = (id: string) => document.getElementById(id);
let wired = false;
let clients: McpClientRow[] = [];
let query = "";
const PAGE_SIZE = 15;
let page = 0;

function setError(msg: string): void {
  const el = $("mcp-error");
  if (!el) return;
  el.textContent = msg;
  el.classList.toggle("hidden", !msg);
}

const fmtDay = (iso: string | null | undefined): string =>
  iso ? new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }) : "—";

/** The console-style client table: Client, Connected, Last used, kebab
 *  (Revoke → confirm) — the API-keys grammar. Search + pagination on top. */
function render(): void {
  const list = $("mcp-clients-list");
  const empty = $("mcp-clients-empty");
  if (!list) return;
  const q = query.toLowerCase();
  const shown = q ? clients.filter((c) => `${c.clientName || ""} ${c.clientId}`.toLowerCase().includes(q)) : clients;
  empty?.classList.toggle("hidden", shown.length > 0);
  if (empty) empty.textContent = clients.length === 0 ? "No MCP clients connected yet." : `No clients matching "${query}"`;
  list.innerHTML = "";
  if (!shown.length) return;

  const table = document.createElement("table");
  table.className = "lib-table";
  table.innerHTML = `<thead><tr><th>Client</th><th>Connected</th><th>Last used</th><th class="lib-row-kebab-cell"></th></tr></thead>`;
  const tbody = document.createElement("tbody");
  const pg = paginate(shown, page, PAGE_SIZE);
  page = pg.state.page;
  for (const c of pg.items) {
    const tr = document.createElement("tr");
    tr.innerHTML =
      `<td class="lib-table-name"><span class="mcp-client-name"></span></td>` +
      `<td class="lib-table-dim">${escapeHtml(fmtDay(c.createdAt))}</td>` +
      `<td class="lib-table-dim">${escapeHtml(c.lastUsedAt ? fmtDay(c.lastUsedAt) : "never")}</td>`;
    (tr.querySelector(".mcp-client-name") as HTMLElement).textContent = c.clientName || c.clientId;
    tr.appendChild(kebabCell(() => [
      { icon: ROW_MENU_ICONS.delete, label: "Revoke", danger: true, onClick: () => {
        void (async () => {
          if (!(await confirmAction({
            title: `Revoke “${c.clientName || c.clientId}”?`,
            body: "This client immediately loses access to your Glyphh. You can reconnect it any time by approving it again.",
            confirmLabel: "Revoke",
            danger: true,
          }))) return;
          try { await transport()!.revoke(c.grantId); await loadMcpPanel(); }
          catch (e) { setError((e as Error).message); }
        })();
      } },
    ]));
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  list.appendChild(table);
  if (pg.state.totalPages > 1) {
    list.appendChild(renderPaginationBar(pg.state, (p) => { page = p; render(); }));
  }
}

export async function loadMcpPanel(): Promise<void> {
  setError("");
  const t = transport();
  if (!t) { clients = []; render(); setError(NO_TRANSPORT); return; }
  try { clients = await t.list(); }
  catch (e) { clients = []; setError(`Couldn't load your connected clients — ${(e as Error).message}`); }
  render();
}

export function initMcpPanel(): void {
  if (wired) return;
  wired = true;
  $("mcp-clients-search")?.addEventListener("input", () => {
    query = (($("mcp-clients-search") as HTMLInputElement | null)?.value || "").trim();
    page = 0;
    render();
  });
  const input = $("mcp-endpoint") as HTMLInputElement | null;
  const apiUrl = (window.glyphh as unknown as { apiUrl?: unknown }).apiUrl;
  if (input && typeof apiUrl === "string" && apiUrl) input.value = `${apiUrl.replace(/\/$/, "")}/mcp`;
  $("mcp-endpoint-copy")?.addEventListener("click", async () => {
    const input = $("mcp-endpoint") as HTMLInputElement | null;
    const val = input?.value || "";
    if (!val) return;
    // Browser-native first (works on web), desktop IPC and select+execCommand
    // as fallbacks — settings-apikeys.ts's copy ladder.
    let copied = false;
    try { await navigator.clipboard.writeText(val); copied = true; } catch { /* permission/insecure context */ }
    if (!copied) {
      const ipc = (window as unknown as { glyphh?: { copyToClipboard?: (s: string) => void } }).glyphh?.copyToClipboard;
      if (ipc) { void ipc(val); copied = true; }
    }
    if (!copied && input) { input.focus(); input.select(); copied = document.execCommand("copy"); }
    const btn = $("mcp-endpoint-copy") as HTMLButtonElement | null;
    if (btn) { btn.textContent = copied ? "Copied" : "Select + ⌘C"; setTimeout(() => { btn.textContent = "Copy"; }, 1800); }
  });
}
