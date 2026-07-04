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
 *   - rpa.*  {app, ...}          → drive the app's webview by CSS selector
 *
 * Each handler returns plain JSON-serializable data; the relay-client wraps
 * thrown errors into `{ok:false,error}` frames automatically.
 */

import type { WebContents } from "electron";
import type { McpManager } from "./mcp-manager.js";
import { registerRelayHandler } from "./relay-client.js";
import {
  openAppWindow, focusAppWindow, closeAppWindow, listAppWindows, getAppWebContents,
} from "./app-window-manager.js";
import { resolveAppSpec, openLayoutByName } from "./app-resolver.js";
import { listInstalledAppTools, callAppTool, installGlyphhAppBundle, installGlyphhAppBundleFromBase64 } from "./glyphh-app-host.js";
import { connectorStatus } from "./glyphh-app-services.js";
import fs from "fs";
import os from "os";

interface Deps {
  getMcpManager: () => McpManager | null;
}

/** Pull the live webview WebContents for an app, or throw. */
function getLiveWc(app: string): WebContents {
  const wc = getAppWebContents(app);
  if (!wc) throw new Error(`app not open (or has no web view): ${app} — open it with panels.open first`);
  return wc;
}

/** Stringify a value for executeJavaScript injection without breaking quotes. */
function jsLiteral(value: string): string {
  return JSON.stringify(value);
}

function appParam(params: unknown): string {
  const p = params as { app?: string; panelId?: string; id?: string } | null;
  return String(p?.app || p?.panelId || p?.id || "");
}

export function installRelayHandlers(deps: Deps): void {
  const { getMcpManager } = deps;

  // ── panels — one native window per app ─────────────────

  registerRelayHandler("panels.list", () => listAppWindows());

  registerRelayHandler("panels.open", async (params) => {
    const spec = await resolveAppSpec(appParam(params));
    openAppWindow(spec);
    return { app: spec.slug, name: spec.name, opened: true };
  });

  registerRelayHandler("panels.switch", (params) => {
    const app = appParam(params);
    if (!app) throw new Error("panels.switch requires { app }");
    if (!focusAppWindow(app)) throw new Error(`app window not open: ${app}`);
    return { app, switched: true };
  });

  registerRelayHandler("panels.close", (params) => {
    const app = appParam(params);
    if (!app) throw new Error("panels.close requires { app }");
    if (!closeAppWindow(app)) throw new Error(`app window not open: ${app}`);
    return { app, closed: true };
  });

  // ── layouts — server-defined grids of apps ─────────────

  registerRelayHandler("layouts.open", async (params) => {
    const p = params as { name?: string; mode?: string } | null;
    const name = String(p?.name || "").trim();
    if (!name) throw new Error("layouts.open requires { name }");
    const mode = p?.mode === "screen" ? "screen" : "window";
    return openLayoutByName(name, mode);
  });

  // ── rpa — drive an app's webview ────────────────────────

  // Click an element matched by a CSS selector. Throws if the element doesn't
  // exist or isn't visible (offsetParent === null catches `display:none`).
  registerRelayHandler("rpa.click", async (params) => {
    const p = params as { selector?: string } | null;
    const app = appParam(params);
    const selector = String(p?.selector || "");
    if (!app || !selector) throw new Error("rpa.click requires { app, selector }");
    const wc = getLiveWc(app);
    const result = await wc.executeJavaScript(`
      (function(){
        var el = document.querySelector(${jsLiteral(selector)});
        if (!el) return { ok: false, error: "no match for selector" };
        if (el.offsetParent === null && getComputedStyle(el).position !== "fixed") {
          return { ok: false, error: "element not visible" };
        }
        el.click();
        return { ok: true };
      })()
    `, true);
    if (!result || !result.ok) throw new Error(result?.error || "click failed");
    return { clicked: true };
  });

  // Set the value of an input/textarea and dispatch input/change so frameworks
  // pick up the new value. Falls back to focus + execCommand for editable divs.
  registerRelayHandler("rpa.type", async (params) => {
    const p = params as { selector?: string; text?: string } | null;
    const app = appParam(params);
    const selector = String(p?.selector || "");
    const text = String(p?.text ?? "");
    if (!app || !selector) throw new Error("rpa.type requires { app, selector, text }");
    const wc = getLiveWc(app);
    const result = await wc.executeJavaScript(`
      (function(){
        var el = document.querySelector(${jsLiteral(selector)});
        if (!el) return { ok: false, error: "no match for selector" };
        var t = ${jsLiteral(text)};
        if (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT") {
          var setter = Object.getOwnPropertyDescriptor(el.__proto__, "value")?.set;
          if (setter) setter.call(el, t); else el.value = t;
          el.dispatchEvent(new Event("input", { bubbles: true }));
          el.dispatchEvent(new Event("change", { bubbles: true }));
          return { ok: true };
        }
        if (el.isContentEditable) {
          el.focus();
          document.execCommand("selectAll", false, undefined);
          document.execCommand("insertText", false, t);
          return { ok: true };
        }
        return { ok: false, error: "element is not an input or contenteditable" };
      })()
    `, true);
    if (!result || !result.ok) throw new Error(result?.error || "type failed");
    return { typed: true };
  });

  // Read visible text or a specific attribute from a matched element.
  registerRelayHandler("rpa.read", async (params) => {
    const p = params as { selector?: string; attr?: string } | null;
    const app = appParam(params);
    const selector = String(p?.selector || "");
    const attr = p?.attr ? String(p.attr) : "";
    if (!app || !selector) throw new Error("rpa.read requires { app, selector }");
    const wc = getLiveWc(app);
    const result = await wc.executeJavaScript(`
      (function(){
        var el = document.querySelector(${jsLiteral(selector)});
        if (!el) return { ok: false, error: "no match for selector" };
        var attrName = ${jsLiteral(attr)};
        if (attrName) return { ok: true, value: el.getAttribute(attrName) };
        if ("value" in el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA")) {
          return { ok: true, value: (el).value };
        }
        return { ok: true, value: (el.innerText || el.textContent || "").trim() };
      })()
    `, true);
    if (!result || !result.ok) throw new Error(result?.error || "read failed");
    return { value: result.value };
  });

  // Capture a screenshot of the app's webview as a base64 PNG.
  registerRelayHandler("rpa.screenshot", async (params) => {
    const app = appParam(params);
    if (!app) throw new Error("rpa.screenshot requires { app }");
    const wc = getLiveWc(app);
    const image = await wc.capturePage();
    if (image.isEmpty()) throw new Error("capturePage returned empty image");
    return { dataUrl: image.toDataURL() };
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
