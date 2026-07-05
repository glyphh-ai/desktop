/**
 * relay-handlers — window management + RPA primitives exposed through the
 * relay (the server-hosted MCP surface Claude and other LLMs call).
 *
 * 5b Panel Manager model: every "panel" is an app in its own native OS
 * window (app-window-manager). Tools are keyed by app slug:
 *   - panels.open  {app}         → open "browser" / "terminal" / a saved app
 *   - panels.list                → open app windows
 *   - panels.switch/close {app}  → focus / close an app's window
 *   - layouts.open {name, mode}  → a server layout, either tiled inside one
 *     window ("window") or as real OS windows tiling the screen ("screen")
 *
 * Each handler returns plain JSON-serializable data; the relay-client wraps
 * thrown errors into `{ok:false,error}` frames automatically.
 */

import type { McpManager } from "./mcp-manager.js";
import { registerRelayHandler } from "./relay-client.js";
import { openAppByRef, openLayoutByName, listOpenAppWindows, focusOpenApp, closeOpenApp } from "./app-resolver.js";
import { listInstalledAppTools, callAppTool, installGlyphhAppBundle, installGlyphhAppBundleFromBase64 } from "./glyphh-app-host.js";
import { runLlmAppTool } from "./glyphh-app-llm.js";
import { connectorStatus } from "./glyphh-app-services.js";
import fs from "fs";
import os from "os";

interface Deps {
  getMcpManager: () => McpManager | null;
}

function appParam(params: unknown): string {
  const p = params as { app?: string; panelId?: string; id?: string } | null;
  return String(p?.app || p?.panelId || p?.id || "");
}

export function installRelayHandlers(deps: Deps): void {
  const { getMcpManager } = deps;

  // ── panels — one real OS window per app ─────────────────

  registerRelayHandler("panels.list", () => listOpenAppWindows());

  registerRelayHandler("panels.open", async (params) => {
    // openAppByRef mirrors the Apps page's full launch dispatch — web apps
    // (real browser windows), native apps, AND installed Glyphh apps
    // (capability windows, no url).
    const r = await openAppByRef(appParam(params));
    return { app: r.slug, name: r.name, opened: true };
  });

  registerRelayHandler("panels.switch", async (params) => {
    const app = appParam(params);
    if (!app) throw new Error("panels.switch requires { app }");
    if (!(await focusOpenApp(app))) throw new Error(`app window not open: ${app}`);
    return { app, switched: true };
  });

  registerRelayHandler("panels.close", async (params) => {
    const app = appParam(params);
    if (!app) throw new Error("panels.close requires { app }");
    // Tracked OS windows (browser/native) minimize — AX close isn't wired yet.
    if (!(await closeOpenApp(app))) throw new Error(`app window not open: ${app}`);
    return { app, closed: true };
  });

  // ── layouts — server-defined grids of apps ─────────────

  registerRelayHandler("layouts.open", async (params) => {
    const p = params as { name?: string } | null;
    const name = String(p?.name || "").trim();
    if (!name) throw new Error("layouts.open requires { name }");
    return openLayoutByName(name);
  });

  // ── Local MCP servers only — Pipedream-connected apps go via the ─
  // server-side connector path (relay's connector_list_tools /
  // connector_call_tool), not through here. getLocalTools filters those
  // out, so local_mcp_* never returns duplicates.

  registerRelayHandler("mcp.list_tools", () => {
    const mm = getMcpManager();
    if (!mm) return [];
    return mm.getLocalTools().map((t) => ({
      serverId: t.serverId,
      serverName: t.serverName,
      name: t.name,
      qualifiedName: t.qualifiedName,
      description: t.description,
      inputSchema: t.inputSchema,
    }));
  });

  registerRelayHandler("mcp.call_tool", async (params) => {
    const p = params as { serverId?: string; name?: string; args?: Record<string, unknown> } | null;
    const serverId = String(p?.serverId || "");
    const name = String(p?.name || "");
    if (!serverId || !name) throw new Error("mcp.call_tool requires { serverId, name }");
    const mm = getMcpManager();
    if (!mm) throw new Error("MCP manager not initialized");
    const result = await mm.callToolDirect(serverId, name, p?.args || {});
    return { result };
  });

  // ── Installed Glyphh apps — discover, invoke, deploy (GLYPHH-APP-SPEC §5) ─
  // Every installed app's declared MCP tools are discoverable + callable by any
  // relay consumer (Claude, etc.), so a user's LLM tools can orchestrate them.

  registerRelayHandler("apps.listTools", () => listInstalledAppTools());

  registerRelayHandler("apps.callTool", async (params) => {
    const p = params as { app?: string; tool?: string; args?: Record<string, unknown> } | null;
    const app = String(p?.app || "");
    const tool = String(p?.tool || "");
    if (!app || !tool) throw new Error("apps.callTool requires { app, tool }");
    return { result: await callAppTool(app, tool, p?.args || {}) };
  });

  // ── LLM apps — the per-app MCP endpoint's tools (send_prompt, use_tool, … ) ─
  // Forwarded by the server's scoped <slug>.glyphh.app/mcp server. The model
  // call runs here with the app's HOST-ONLY provider key; usage flows back so
  // the server can meter it against the app's guardrails.
  registerRelayHandler("apps.llmTool", async (params) => {
    const p = params as { app?: string; tool?: string; args?: Record<string, unknown>; provider?: string; model?: string | null; maxOutputTokens?: number | null } | null;
    const app = String(p?.app || "");
    const tool = String(p?.tool || "");
    if (!app || !tool) throw new Error("apps.llmTool requires { app, tool }");
    // Fold the server-supplied provider/model/guardrail cap into the tool args.
    const args: Record<string, unknown> = { ...(p?.args || {}) };
    if (p?.provider) args.provider = p.provider;
    if (p?.model != null) args.model = p.model;
    if (p?.maxOutputTokens != null) args.maxOutputTokens = p.maxOutputTokens;
    return runLlmAppTool(app, tool, args);
  });

  registerRelayHandler("apps.install", async (params) => {
    const p = params as { bundleBase64?: string; path?: string; url?: string } | null;
    let r: { ok: boolean; name?: string; updated?: boolean; error?: string; connectors?: string[] };
    if (p?.path) {
      // Preferred: the bundle is already on this machine — read it directly
      // instead of round-tripping megabytes of base64 through the LLM.
      const filePath = p.path.replace(/^~(?=$|\/)/, os.homedir());
      if (!fs.existsSync(filePath)) throw new Error(`bundle not found: ${filePath}`);
      r = await installGlyphhAppBundle(filePath);
    } else if (p?.url) {
      const res = await fetch(p.url);
      if (!res.ok) throw new Error(`bundle download failed: HTTP ${res.status}`);
      r = await installGlyphhAppBundleFromBase64(Buffer.from(await res.arrayBuffer()).toString("base64"));
    } else if (p?.bundleBase64) {
      r = await installGlyphhAppBundleFromBase64(String(p.bundleBase64));
    } else {
      throw new Error("apps.install requires { path } (a .glyphh on this machine), { url }, or { bundleBase64 }");
    }
    if (!r.ok) throw new Error(r.error || "install failed");

    // Surface missing required connections in the install result so the
    // caller (Claude etc.) tells the user immediately — the app's tools WILL
    // fail until those accounts are connected in Glyphh → Connections.
    let missing: string[] = [];
    if (r.connectors?.length) {
      try {
        const status = await connectorStatus(new Set(r.connectors));
        missing = status.filter((s) => !s.connected).map((s) => s.connector);
      } catch { /* status unknown — don't block the install result */ }
    }
    return {
      installed: r.name,
      updated: !!r.updated,
      requiredConnections: r.connectors ?? [],
      ...(missing.length ? {
        missingConnections: missing,
        warning: `This app will NOT work until these accounts are connected in Glyphh → Connections: ${missing.join(", ")}. Tell the user to connect them.`,
      } : {}),
    };
  });
}
