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
/** slug → the Tabs page's RPA preview of that tab (2026-10-08). It is the page
 *  the user is looking at while it is on screen, so Pick, Test and the agents'
 *  rpa_* tools act on it first; the renderer drops it the moment it leaves the
 *  screen and the work panel (if any) is the target again. Kept apart from
 *  `targets` so neither one's close ever unregisters the other. */
const previews = new Map<string, number>();

export interface RpaTargetOpts { preview?: boolean }

export function registerRpaTarget(slug: string, wcId: number, opts?: RpaTargetOpts): void {
  if (slug && Number.isInteger(wcId)) (opts?.preview ? previews : targets).set(slug, wcId);
}
export function unregisterRpaTarget(slug: string, opts?: RpaTargetOpts): void {
  (opts?.preview ? previews : targets).delete(slug);
}
/** Reverse lookup: which panel slug owns this webContents (null if none). */
export function slugForWebContents(wcId: number): string | null {
  for (const map of [previews, targets]) {
    for (const [slug, id] of map) { if (id === wcId) return slug; }
  }
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
  const wc = liveTarget(slug) ?? (BROWSER_NAMES.has(slug) ? [...BROWSER_NAMES].map(liveTarget).find(Boolean) : undefined);
  if (!wc) throw new Error(`panel not open: ${slug} — open it with panels.open first`);
  return wc;
}

/** The browser answers to both names (his report, 2026-09-29): panels_open
 *  hands back "browser", while the tabbed Browser panel registers as
 *  "preview", so every rpa_goto on "browser" said it was not open. */
const BROWSER_NAMES = new Set(["browser", "preview"]);
function liveTarget(slug: string): WebContents | undefined {
  for (const map of [previews, targets]) {
    const id = map.get(slug);
    const wc = id !== undefined ? webContents.fromId(id) : undefined;
    if (wc && !wc.isDestroyed()) return wc;
  }
  return undefined;
}

/** Whether a panel is up and drivable, by the name the agent uses. */
export function panelIsLive(slug: string): boolean {
  return !!liveTarget(slug) || (BROWSER_NAMES.has(slug) && [...BROWSER_NAMES].some((n) => !!liveTarget(n)));
}

/** Navigate a live panel. */
export async function panelGoto(slug: string, url: string): Promise<string> {
  if (!/^https?:\/\//i.test(url)) throw new Error("a panel opens http(s) addresses only");
  const wc = target({ app: slug });
  await wc.loadURL(url);
  return wc.getURL();
}

/** JSON-safe string literal for injection into executeJavaScript. */
const q = (s: string): string => JSON.stringify(s);

// ── Panel read cores — shared by the relay handlers (programs) and the
// agent's read_panel tool (glyphh-agent-tools). One implementation, two
// callers, so the agent and the RPA surface can never drift apart. ──

/** The open, registered panels — slug plus whether the webContents is live. */
export function rpaTargetSlugs(): string[] {
  const out: string[] = [];
  for (const [slug, id] of targets) {
    const wc = webContents.fromId(id);
    if (wc && !wc.isDestroyed()) out.push(slug);
  }
  return out;
}

/** A panel's text or HTML — the whole page, or one selector's subtree. */
export async function panelRead(slug: string, selector?: string, as: "text" | "html" = "text"): Promise<string> {
  const wc = target({ app: slug });
  const expr = selector
    ? `(() => { const el = document.querySelector(${q(selector)}); return el ? (${as === "html" ? "el.outerHTML" : "el.innerText"}) : null; })()`
    : (as === "html" ? "document.documentElement.outerHTML" : "document.body ? document.body.innerText : ''");
  const out = await wc.executeJavaScript(expr);
  if (out === null) throw new Error(`no element matched ${selector}`);
  return String(out ?? "").slice(0, 500_000);
}

/** A panel's current frame as PNG bytes. */
export async function panelScreenshot(slug: string): Promise<Buffer> {
  const wc = target({ app: slug });
  const img = await wc.capturePage();
  return img.toPNG();
}

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
    const slug = str(params, "app") || str(params, "slug") || str(params, "panelId");
    const as = (str(params, "as") || "text") as "text" | "html";
    const value = await panelRead(slug, str(params, "selector") || undefined, as);
    return { as, value };
  });

  // Screenshot — the panel's current frame as a PNG data URL.
  registerRelayHandler("rpa.screenshot", async (params) => {
    const slug = str(params, "app") || str(params, "slug") || str(params, "panelId");
    const png = await panelScreenshot(slug);
    return { dataUrl: `data:image/png;base64,${png.toString("base64")}` };
  });

  // The live webContents id behind a panel name — for the mapping runner
  // (rpa-map.ts), which waits on selectors and runs the picker in the page.
  registerRelayHandler("rpa.target", async (params) => ({ id: target(params).id }));

  // Navigate the panel to a URL.
  registerRelayHandler("rpa.goto", async (params) => {
    const url = str(params, "url");
    if (!/^https?:\/\//i.test(url)) throw new Error("rpa.goto needs an http(s) { url }");
    return { url: await panelGoto(str(params, "app") || str(params, "slug") || str(params, "panelId"), url) };
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
