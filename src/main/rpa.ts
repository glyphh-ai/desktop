/**
 * rpa.ts — drive an open workbench app panel: click, type, read the DOM,
 * screenshot, evaluate. The panels are <webview>s that live in the RENDERER,
 * but their webContents are reachable from main by id — the renderer registers
 * each panel's `slug → webContentsId` on dom-ready (rpaRegister) and clears it
 * on close (rpaUnregister). These handlers resolve the live webContents and act
 * on it directly, no renderer round-trip.
 *
 * Registered on the SHARED handler registry, so the attach socket and the
 * loopback local-MCP server both expose `rpa.*` identically.
 */

import { webContents, type WebContents } from "electron";
import { registerRelayHandler } from "./relay-client.js";

/** slug → the panel webview's webContents id (set by the renderer). */
const targets = new Map<string, number>();

export function registerRpaTarget(slug: string, wcId: number): void {
  if (slug && Number.isInteger(wcId)) targets.set(slug, wcId);
}
export function unregisterRpaTarget(slug: string): void {
  targets.delete(slug);
}
/** Reverse lookup: which panel slug owns this webContents (null if none). */
export function slugForWebContents(wcId: number): string | null {
  for (const [slug, id] of targets) { if (id === wcId) return slug; }
  return null;
}

function str(params: unknown, key: string): string {
  const v = (params as Record<string, unknown> | null)?.[key];
  return typeof v === "string" ? v : "";
}
function num(params: unknown, key: string): number | undefined {
  const v = (params as Record<string, unknown> | null)?.[key];
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

/** Resolve the live webContents for a panel slug, or throw a clear error. */
function target(params: unknown): WebContents {
  const slug = str(params, "app") || str(params, "slug") || str(params, "panelId");
  if (!slug) throw new Error("rpa needs { app } — the panel slug (from panels.list)");
  const id = targets.get(slug);
  const wc = id !== undefined ? webContents.fromId(id) : undefined;
  if (!wc || wc.isDestroyed()) throw new Error(`panel not open: ${slug} — open it with panels.open first`);
  return wc;
}

/** JSON-safe string literal for injection into executeJavaScript. */
const q = (s: string): string => JSON.stringify(s);

export function installRpaHandlers(): void {
  // Click — a CSS selector (clicked in-page) or absolute x/y coords (real
  // input event, so canvas/native handlers fire).
  registerRelayHandler("rpa.click", async (params) => {
    const wc = target(params);
    const selector = str(params, "selector");
    const x = num(params, "x"), y = num(params, "y");
    if (selector) {
      const hit = await wc.executeJavaScript(
        `(() => { const el = document.querySelector(${q(selector)}); if (!el) return false; el.scrollIntoView({block:'center'}); el.click(); return true; })()`,
      );
      if (!hit) throw new Error(`no element matched ${selector}`);
      return { clicked: selector };
    }
    if (x !== undefined && y !== undefined) {
      wc.sendInputEvent({ type: "mouseDown", x, y, button: "left", clickCount: 1 });
      wc.sendInputEvent({ type: "mouseUp", x, y, button: "left", clickCount: 1 });
      return { clicked: { x, y } };
    }
    throw new Error("rpa.click needs { selector } or { x, y }");
  });

  // Type — focus a selector (if given), set its value + fire input/change so
  // frameworks notice, then optionally submit.
  registerRelayHandler("rpa.type", async (params) => {
    const wc = target(params);
    const selector = str(params, "selector");
    const text = str(params, "text");
    const submit = (params as Record<string, unknown> | null)?.submit === true;
    if (!selector) throw new Error("rpa.type needs { selector, text }");
    const ok = await wc.executeJavaScript(
      `(() => { const el = document.querySelector(${q(selector)}); if (!el) return false;
        el.focus();
        if ('value' in el) { el.value = ${q(text)}; el.dispatchEvent(new Event('input',{bubbles:true})); el.dispatchEvent(new Event('change',{bubbles:true})); }
        else { el.textContent = ${q(text)}; }
        ${submit ? "const f = el.form; if (f) f.requestSubmit ? f.requestSubmit() : f.submit();" : ""}
        return true; })()`,
    );
    if (!ok) throw new Error(`no element matched ${selector}`);
    return { typed: selector, submit };
  });

  // Read — a selector's text (default innerText) or the whole page text/html.
  registerRelayHandler("rpa.read", async (params) => {
    const wc = target(params);
    const selector = str(params, "selector");
    const as = str(params, "as") || "text"; // text | html
    const expr = selector
      ? `(() => { const el = document.querySelector(${q(selector)}); return el ? (${as === "html" ? "el.outerHTML" : "el.innerText"}) : null; })()`
      : (as === "html" ? "document.documentElement.outerHTML" : "document.body ? document.body.innerText : ''");
    const out = await wc.executeJavaScript(expr);
    if (out === null) throw new Error(`no element matched ${selector}`);
    return { as, value: String(out ?? "").slice(0, 500_000) };
  });

  // Screenshot — the panel's current frame as a PNG data URL.
  registerRelayHandler("rpa.screenshot", async (params) => {
    const wc = target(params);
    const img = await wc.capturePage();
    return { dataUrl: `data:image/png;base64,${img.toPNG().toString("base64")}` };
  });

  // Navigate the panel to a URL.
  registerRelayHandler("rpa.goto", async (params) => {
    const wc = target(params);
    const url = str(params, "url");
    if (!/^https?:\/\//i.test(url)) throw new Error("rpa.goto needs an http(s) { url }");
    await wc.loadURL(url);
    return { url: wc.getURL() };
  });

  // Evaluate arbitrary JS in the panel and return the (JSON-serializable)
  // result. Powerful — same trust boundary as the rest of attach (self only).
  registerRelayHandler("rpa.eval", async (params) => {
    const wc = target(params);
    const js = str(params, "js") || str(params, "script");
    if (!js) throw new Error("rpa.eval needs { js }");
    const result = await wc.executeJavaScript(`(async () => { return (${js}); })()`);
    return { result };
  });
}
