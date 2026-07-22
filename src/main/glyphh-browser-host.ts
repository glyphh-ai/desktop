/**
 * glyphh-browser-host — the RunnerHost `browser` provider: headless browser
 * pages a loop/skill PROGRAM drives via `ctx.browser()`. Each page is an
 * off-screen BrowserWindow (sandboxed, imageless), keyed by an opaque pageId.
 * Works with the app window closed (background mode) — no renderer, no visible
 * panel. This is deterministic, program-owned automation; it never touches the
 * user's live workbench panels.
 *
 * Pages are auto-destroyed when a run ends (closeAllBrowserPages) so a program
 * that forgets to close leaks nothing.
 */

import { BrowserWindow } from "electron";

const q = (s: string): string => JSON.stringify(s);

export interface BrowserHost {
  open(url?: string): Promise<{ pageId: string }>;
  act(pageId: string, action: string, params: Record<string, unknown>): Promise<unknown>;
  close(pageId: string): Promise<void>;
}

/**
 * A per-RUN browser host: its pages are isolated from other concurrent runs,
 * and `closeAll()` (called in the run's finally) tears down anything the
 * program left open. Pass `host` to runProgram as `{ browser: host }`.
 */
export function createBrowserHost(): { host: BrowserHost; closeAll: () => void } {
  const pages = new Map<string, BrowserWindow>();
  let seq = 0;

  const win = (pageId: string): BrowserWindow => {
    const w = pages.get(pageId);
    if (!w || w.isDestroyed()) throw new Error(`browser page ${pageId} is closed`);
    return w;
  };

  const host: BrowserHost = {
    async open(url?: string): Promise<{ pageId: string }> {
      const w = new BrowserWindow({
        show: false,
        webPreferences: { offscreen: true, javascript: true, images: false, sandbox: true, contextIsolation: true },
      });
      const pageId = `pg${(++seq).toString(36)}`;
      pages.set(pageId, w);
      if (url) {
        if (!/^https?:\/\//i.test(url)) throw new Error("browser.open needs an http(s) url");
        await w.loadURL(url);
      }
      return { pageId };
    },

    async act(pageId: string, action: string, params: Record<string, unknown>): Promise<unknown> {
      const wc = win(pageId).webContents;
    const sel = typeof params.selector === "string" ? params.selector : "";
    switch (action) {
      case "goto": {
        const url = String(params.url ?? "");
        if (!/^https?:\/\//i.test(url)) throw new Error("goto needs an http(s) url");
        await wc.loadURL(url);
        return { url: wc.getURL() };
      }
      case "click": {
        if (!sel) throw new Error("click needs { selector }");
        const hit = await wc.executeJavaScript(
          `(() => { const el = document.querySelector(${q(sel)}); if (!el) return false; el.scrollIntoView({block:'center'}); el.click(); return true; })()`,
        );
        if (!hit) throw new Error(`no element matched ${sel}`);
        return { clicked: sel };
      }
      case "type": {
        if (!sel) throw new Error("type needs { selector, text }");
        const text = String(params.text ?? "");
        const submit = params.submit === true;
        const ok = await wc.executeJavaScript(
          `(() => { const el = document.querySelector(${q(sel)}); if (!el) return false;
            el.focus();
            if ('value' in el) { el.value = ${q(text)}; el.dispatchEvent(new Event('input',{bubbles:true})); el.dispatchEvent(new Event('change',{bubbles:true})); }
            else { el.textContent = ${q(text)}; }
            ${submit ? "const f = el.form; if (f) f.requestSubmit ? f.requestSubmit() : f.submit();" : ""}
            return true; })()`,
        );
        if (!ok) throw new Error(`no element matched ${sel}`);
        return { typed: sel };
      }
      case "read": {
        const as = params.as === "html" ? "html" : "text";
        const expr = sel
          ? `(() => { const el = document.querySelector(${q(sel)}); return el ? (${as === "html" ? "el.outerHTML" : "el.innerText"}) : null; })()`
          : (as === "html" ? "document.documentElement.outerHTML" : "document.body ? document.body.innerText : ''");
        const out = await wc.executeJavaScript(expr);
        if (out === null) throw new Error(`no element matched ${sel}`);
        return String(out ?? "").slice(0, 500_000);
      }
      case "screenshot": {
        const img = await wc.capturePage();
        return { dataUrl: `data:image/png;base64,${img.toPNG().toString("base64")}` };
      }
      default:
        throw new Error(`unknown browser action: ${action}`);
    }
  },

    async close(pageId: string): Promise<void> {
      const w = pages.get(pageId);
      if (w && !w.isDestroyed()) w.destroy();
      pages.delete(pageId);
    },
  };

  const closeAll = (): void => {
    for (const w of pages.values()) { if (!w.isDestroyed()) w.destroy(); }
    pages.clear();
  };

  return { host, closeAll };
}
