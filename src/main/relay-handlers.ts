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

import { registerRelayHandler } from "./relay-client.js";
import { openAppByRef, openLayoutByName, listOpenAppWindows, focusOpenApp, closeOpenApp } from "./app-resolver.js";
import { fetchOrgApps } from "./org-apps.js";
import { listInstalledAppTools, callAppTool, installGlyphhAppBundle, installGlyphhAppBundleFromBase64 } from "./glyphh-app-host.js";
import { connectorStatus } from "./glyphh-app-services.js";
import fs from "fs";
import os from "os";

interface Deps {
}

function appParam(params: unknown): string {
  const p = params as { app?: string; panelId?: string; id?: string } | null;
  return String(p?.app || p?.panelId || p?.id || "");
}

export function installRelayHandlers(deps: Deps): void {

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

  registerRelayHandler("panels.open", async (params) => {
    const r = await openAppByRef(appParam(params));
    return { app: r.slug, name: r.name, opened: true };
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

  // ── layouts — server-defined grids of apps ─────────────

  registerRelayHandler("layouts.open", async (params) => {
    const p = params as { name?: string } | null;
    const name = String(p?.name || "").trim();
    if (!name) throw new Error("layouts.open requires { name }");
    return openLayoutByName(name);
  });

  // ── Local MCP servers are retired — custom MCP connections execute
  // server-side and surface through the connector lane (connector_list_tools /
  // connector_call_tool). The local_mcp_* relay contract stays answerable so
  // older callers get an empty list / a pointer instead of a dead socket.

  registerRelayHandler("mcp.list_tools", () => []);

  registerRelayHandler("mcp.call_tool", async () => {
    throw new Error("local MCP servers are retired — custom MCP connections run server-side; use connector_call_tool");
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
