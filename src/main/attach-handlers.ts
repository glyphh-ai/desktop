/**
 * attach-handlers — the capability methods the CLOUD can invoke on this machine
 * over the attach socket, beyond the panels/apps/layouts set that
 * relay-handlers already registers. Everything runs on-machine via the shared
 * registry (registerRelayHandler), so the loopback local-MCP server and the
 * attach socket expose an identical surface.
 *
 *   loops.run   {slug, input?}          → run a saved loop, return its output
 *   skills.run  {slug, input?}          → run a saved skill, return its output
 *   agents.run  {agentId, taskId}       → fire a standing agent's task now
 *   scrape.page {url, wait?}            → load a URL headlessly, return text/html/title
 */

import { BrowserWindow } from "electron";
import { registerRelayHandler } from "./relay-client.js";
import { runLoopBySlug, runSkillBySlug, runTaskNow } from "./agent-scheduler.js";

function str(params: unknown, key: string): string {
  const v = (params as Record<string, unknown> | null)?.[key];
  return typeof v === "string" ? v : "";
}
function obj(params: unknown, key: string): Record<string, unknown> {
  const v = (params as Record<string, unknown> | null)?.[key];
  return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
}

export function installAttachHandlers(): void {
  registerRelayHandler("loops.run", async (params) => {
    const slug = str(params, "slug");
    if (!slug) throw new Error("loops.run requires { slug }");
    return { slug, output: await runLoopBySlug(slug, obj(params, "input")) };
  });

  registerRelayHandler("skills.run", async (params) => {
    const slug = str(params, "slug");
    if (!slug) throw new Error("skills.run requires { slug }");
    return { slug, output: await runSkillBySlug(slug, obj(params, "input")) };
  });

  registerRelayHandler("agents.run", async (params) => {
    const agentId = str(params, "agentId");
    const taskId = str(params, "taskId");
    if (!agentId || !taskId) throw new Error("agents.run requires { agentId, taskId }");
    const r = await runTaskNow(agentId, taskId);
    if (!r.ok) throw new Error(r.error || "agent run failed");
    return { agentId, taskId, ran: true };
  });

  // Headless scrape: a hidden, sandboxed BrowserWindow loads the URL, we pull
  // text + title + html, then destroy it. No renderer or visible panel needed.
  registerRelayHandler("scrape.page", async (params) => {
    const url = str(params, "url");
    if (!/^https?:\/\//i.test(url)) throw new Error("scrape.page requires an http(s) { url }");
    const waitMs = Math.min(Math.max(Number((params as Record<string, unknown>)?.wait) || 0, 0), 15_000);
    const win = new BrowserWindow({
      show: false,
      webPreferences: { offscreen: true, javascript: true, images: false, sandbox: true, contextIsolation: true },
    });
    try {
      await win.loadURL(url);
      if (waitMs) await new Promise((r) => setTimeout(r, waitMs));
      const [title, text, html] = await Promise.all([
        win.webContents.executeJavaScript("document.title").catch(() => ""),
        win.webContents.executeJavaScript("document.body ? document.body.innerText : ''").catch(() => ""),
        win.webContents.executeJavaScript("document.documentElement.outerHTML").catch(() => ""),
      ]);
      return {
        url: win.webContents.getURL() || url,
        title: String(title || ""),
        text: String(text || "").slice(0, 200_000),
        html: String(html || "").slice(0, 500_000),
      };
    } finally {
      if (!win.isDestroyed()) win.destroy();
    }
  });
}
