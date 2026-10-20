/**
 * relay-handlers — window management + RPA primitives exposed through the
 * relay (the server-hosted MCP surface Claude and other LLMs call).
 *
 * 5b Panel Manager model: every "panel" is an app in its own native OS
 * window (app-window-manager). Tools are keyed by app slug:
 *   - panels.open  {app}         → open "browser" / "terminal" / a saved app
 *   - panels.add {name,url,slug?} / panels.remove {app} → the saved-tab library
 *   - models.available           → the user's models + what each is FOR
 *   - panels.list                → open app windows
 *   - panels.switch/close {app}  → focus / close an app's window
 *   - layouts.open {name, mode}  → a server layout, either tiled inside one
 *     window ("window") or as real OS windows tiling the screen ("screen")
 *
 * Each handler returns plain JSON-serializable data; the relay-client wraps
 * thrown errors into `{ok:false,error}` frames automatically.
 */

import { registerRelayHandler } from "./relay-client.js";
import { installAgentRelayHandlers } from "./agent-tools.js";
import { openAppByRef, openBrowserAt, openLayoutByName, listOpenAppWindows, focusOpenApp, closeOpenApp, openSettingsPage } from "./app-resolver.js";
import { fetchOrgApps } from "./org-apps.js";
import { panelGoto, panelIsLive } from "./rpa.js";
import { addSavedTab, removeSavedTab } from "./saved-tabs.js";
import { readStoredProviders } from "./providers.js";

interface Deps {
}

const PANEL_OPEN_WAIT_MS = 10_000;

async function waitFor(ready: () => boolean, ms: number): Promise<boolean> {
  const until = Date.now() + ms;
  while (!ready()) {
    if (Date.now() >= until) return false;
    await new Promise((r) => setTimeout(r, 150));
  }
  return true;
}

function appParam(params: unknown): string {
  const p = params as { app?: string; panelId?: string; id?: string } | null;
  return String(p?.app || p?.panelId || p?.id || "");
}

export function installRelayHandlers(deps: Deps): void {
  // The member's agents (make, read, update, delete) — agent-tools.ts.
  installAgentRelayHandlers();

  // Smoke-test handler — the loopback local-MCP relay_ping tool routes here.
  // (Formerly registered by relay-client's now-deleted initRelayClient.)
  registerRelayHandler("relay.ping", (params) => {
    const message = (params as { message?: string } | null | undefined)?.message ?? "ping";
    return { echoed: message, at: new Date().toISOString() };
  });

  // ── panels — workbench app panels beside the agent (OS windows retired) ──

  registerRelayHandler("panels.list", () => listOpenAppWindows());

  // The user's APP LIBRARY — what panels.open can open, not just what IS
  // open. Without this an agent asked about "gmail" can't discover the saved
  // Gmail app and falls back to driving the raw browser (his report,
  // 2026-09-10). Rows trim to what an agent needs to pick one.
  registerRelayHandler("panels.available", async () => {
    const rows = await fetchOrgApps().catch(() => []);
    return rows
      .filter((a) => !a.system && (a.url || a.execPath || a.appArchetype === "glyphh-app"))
      .map((a) => ({ app: a.slug, name: a.name, ...(a.url ? { url: a.url } : {}), kind: a.appArchetype || (a.url ? "web" : "native") }));
  });

  // AN OPEN IS REPORTED ONLY ONCE IT HAPPENED (his report, 2026-09-29: the
  // agent was told "opened" three times while nothing appeared). The command
  // to the workbench is fire-and-forget, so a web panel is waited for until it
  // is live and drivable; one that never shows up is an error, not a success.
  // A `url` opens it there in the same call, so "open the page" is one step.
  registerRelayHandler("panels.open", async (params) => {
    const url = String((params as { url?: unknown } | null)?.url ?? "").trim();
    if (url && !/^https?:\/\//i.test(url)) throw new Error("panels.open url must be http(s)");
    // The Browser at a URL takes the user's own path: a TAB at that address in
    // the Browser on screen, exactly as a click opens one.
    const browser = /^(browser|preview)$/i.test(appParam(params).trim());
    const r: { slug: string; name: string; panel?: boolean } = browser && url ? { ...openBrowserAt(url), panel: true } : await openAppByRef(appParam(params));
    if (!r.panel) return { app: r.slug, name: r.name, opened: true };
    if (!(await waitFor(() => panelIsLive(r.slug), PANEL_OPEN_WAIT_MS))) {
      throw new Error(`${r.name} did not open: no panel appeared within ${PANEL_OPEN_WAIT_MS / 1000}s. Nothing is showing, so do not tell the user it opened.`);
    }
    return { app: r.slug, name: r.name, opened: true, ...(url && !browser ? { url: await panelGoto(r.slug, url) } : url ? { url } : {}) };
  });

  registerRelayHandler("panels.switch", async (params) => {
    const app = appParam(params);
    if (!app) throw new Error("panels.switch requires { app }");
    focusOpenApp(app);
    return { app, switched: true };
  });

  registerRelayHandler("panels.close", async (params) => {
    const app = appParam(params);
    if (!app) throw new Error("panels.close requires { app }");
    closeOpenApp(app);
    return { app, closed: true };
  });

  // The saved-tab LIBRARY itself (his order, 2026-09-23): the agent could list
  // and open tabs but not add or remove them. Same rules as the Tabs page.
  registerRelayHandler("panels.add", async (params) => {
    const p = (params ?? {}) as { name?: string; url?: string; slug?: string };
    return addSavedTab(p);
  });
  registerRelayHandler("panels.remove", async (params) => removeSavedTab(appParam(params)));

  // ── models — WHAT THIS USER CAN CALL, AND WHAT FOR ─────
  // His order, 2026-09-23: "the agent needs tools to be able to list the
  // available models and what they are registered for". The user's own
  // providers answer (providers.ts): every model set up in Settings › Models,
  // by what it is for — chat (the agent), transcription (dictation) or
  // speech (reading replies aloud). An agent picks by `mode`, never a name.
  registerRelayHandler("models.available", () => {
    const { providers, models: rows } = readStoredProviders();
    const providerName = new Map(providers.map((p) => [p.id, p.name]));
    const models = rows.map((m) => ({
      model: m.id,
      name: m.label || m.model,
      provider: providerName.get(m.provider) ?? m.provider,
      mode: m.type,
    }));
    const byMode: Record<string, string[]> = {};
    for (const m of models) (byMode[m.mode] ??= []).push(m.model);
    return { byMode, models };
  });

  // ── layouts — server-defined grids of apps ─────────────

  registerRelayHandler("layouts.open", async (params) => {
    const p = params as { name?: string } | null;
    const name = String(p?.name || "").trim();
    if (!name) throw new Error("layouts.open requires { name }");
    return openLayoutByName(name);
  });

  // ── Settings — one door for the local MCP's settings_open AND the gateway's
  //    (server mcp_windows.py over the attach relay), so a page the cloud opens
  //    is the page the local tool opens.
  registerRelayHandler("settings.open", async (params) => {
    const page = String((params as { page?: unknown } | null)?.page ?? "").trim();
    if (!page) throw new Error("settings.open requires { page }");
    openSettingsPage(page);
    return { page, opened: true };
  });

  // ── Local MCP servers are retired — custom MCP connections execute
  // server-side and surface through the connector lane (connector_list_tools /
  // connector_call_tool). The local_mcp_* relay contract stays answerable so
  // older callers get an empty list / a pointer instead of a dead socket.

  registerRelayHandler("mcp.list_tools", () => []);

  registerRelayHandler("mcp.call_tool", async () => {
    throw new Error("local MCP servers are retired — custom MCP connections run server-side; use connector_call_tool");
  });

  // Installed Glyphh apps are cloud instances: the local MCP's app_install
  // rides apps.install (attach-handlers.ts) and its app_list_tools /
  // app_call_tool read the instances (app-instances.ts) — no registry lane.
}
