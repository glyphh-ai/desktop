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

import { escapeHtml, confirmAction } from "./shared.js";

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

function setError(msg: string): void {
  const el = $("mcp-error");
  if (!el) return;
  el.textContent = msg;
  el.classList.toggle("hidden", !msg);
}

function render(clients: McpClientRow[]): void {
  const list = $("mcp-clients-list");
  const empty = $("mcp-clients-empty");
  if (!list) return;
  empty?.classList.toggle("hidden", clients.length > 0);
  list.innerHTML = "";
  for (const c of clients) {
    const row = document.createElement("div");
    row.className = "a4-row";
    const since = c.createdAt ? new Date(c.createdAt).toLocaleDateString() : "";
    const used = c.lastUsedAt ? new Date(c.lastUsedAt).toLocaleDateString() : "never";
    row.innerHTML = `<span class="a4-row-main"><span class="a4-row-name">${escapeHtml(c.clientName || c.clientId)}</span><span class="a4-row-sub">${since ? `Connected ${escapeHtml(since)} · ` : ""}Last used ${escapeHtml(used)}</span></span><button class="action-btn danger" type="button">Revoke</button>`;
    row.querySelector("button")!.addEventListener("click", async () => {
      if (!(await confirmAction({
        title: `Revoke “${c.clientName || c.clientId}”?`,
        body: "This client immediately loses access to your Glyphh. You can reconnect it any time by approving it again.",
        confirmLabel: "Revoke",
        danger: true,
      }))) return;
      try { await transport()!.revoke(c.grantId); await loadMcpPanel(); }
      catch (e) { setError((e as Error).message); }
    });
    list.appendChild(row);
  }
}

export async function loadMcpPanel(): Promise<void> {
  setError("");
  const t = transport();
  if (!t) { render([]); setError(NO_TRANSPORT); return; }
  try { render(await t.list()); }
  catch (e) { render([]); setError(`Couldn't load your connected clients — ${(e as Error).message}`); }
}

export function initMcpPanel(): void {
  if (wired) return;
  wired = true;
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
