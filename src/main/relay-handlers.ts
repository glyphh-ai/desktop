/**
 * relay-handlers — window management + RPA primitives exposed through the
 * relay (the server-hosted MCP surface Claude and other LLMs call).
 *
 * 5b Panel Manager model: every "panel" is an app in its own native OS
 * window (app-window-manager). Tools are keyed by app slug:
 *   - panels.open  {app}         → open "browser" / "terminal" / a saved app
 *   - panels.add {name,url,slug?} / panels.remove {app} → the saved-tab library
 *   - models.available           → the caller's models + what each is FOR
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
import { addSavedTab, removeSavedTab } from "./saved-tabs.js";
import { getClient } from "./glyphh-client.js";
import { gatewayCreds } from "./gateway-token.js";
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

  // The saved-tab LIBRARY itself (his order, 2026-09-23): the agent could list
  // and open tabs but not add or remove them. Same rules as the Tabs page.
  registerRelayHandler("panels.add", async (params) => {
    const p = (params ?? {}) as { name?: string; url?: string; slug?: string };
    return addSavedTab(p);
  });
  registerRelayHandler("panels.remove", async (params) => removeSavedTab(appParam(params)));

  // ── models — WHAT THIS USER CAN CALL, AND WHAT FOR ─────
  // His order, 2026-09-23: "the agent needs tools to be able to list the
  // available models and what they are registered for". Without it an agent
  // asked for an image went looking for provider keys in the OS keychain
  // instead of asking Glyphh which model does images and calling the gateway.
  // The SERVER answers (not the gateway's own /v1/models): public names, the
  // org's allow-list applied, the auto-router collapsed.
  registerRelayHandler("models.available", async () => {
    type Row = {
      name: string; providerSlug: string; modality: string; source?: string; autoRouter?: boolean;
      contextWindow?: number | null; maxOutputTokens?: number | null;
      inputUsdPerMTok?: number; outputUsdPerMTok?: number;
    };
    const rows = await getClient().models.available() as Row[];
    const creds = await gatewayCreds().catch(() => null);
    // `modality` IS the registration: chat, embedding, image_generation,
    // video_generation, … An agent picks by it rather than guessing from a name.
    const models = rows.map((m) => ({
      model: m.name,
      provider: m.autoRouter ? "auto" : m.providerSlug,
      mode: m.modality,
      lane: m.source === "local" ? "own-login" : "gateway",
      ...(m.contextWindow ? { contextWindow: m.contextWindow } : {}),
      ...(m.maxOutputTokens ? { maxOutputTokens: m.maxOutputTokens } : {}),
      ...(m.inputUsdPerMTok ? { inputUsdPerMTok: m.inputUsdPerMTok } : {}),
      ...(m.outputUsdPerMTok ? { outputUsdPerMTok: m.outputUsdPerMTok } : {}),
    }));
    const byMode: Record<string, string[]> = {};
    for (const m of models) (byMode[m.mode] ??= []).push(m.model);
    return {
      // The door: an OpenAI-shaped endpoint. /v1/chat/completions for chat,
      // /v1/images/generations for image_generation, and so on — the key is
      // the gateway key this desktop already holds.
      endpoint: creds?.baseUrl ?? null,
      authenticated: !!creds?.token,
      byMode,
      models,
    };
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
