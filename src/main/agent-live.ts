/**
 * agent-live.ts — the app's live-run ledger, wired to Electron.
 *
 * Every renderer (the shell, the home view, every solo agent panel) hears the
 * whole list on `glyphh-agent:live` and can ask for it cold with
 * `glyphh-agent-live-list`. The rail's session rows pulse by it, and a click on
 * a running session finds the panel that hosts the run (senderId).
 *
 * `agent-panel-open` is the solo panel's way to ask the shell for ANOTHER agent
 * panel — a webview must not nest a webview, so the request goes up to main
 * and back down to the host document as `agent-panel:open`.
 */

import { ipcMain, type WebContents } from "electron";
import { broadcast, sendToHomeShell } from "./broadcast.js";
import { createAgentLiveRegistry, type LiveAgentRun } from "./agent-live-registry.js";
import { activateAgentPanel } from "./working-directory.js";
import { openSettingsPage } from "./app-resolver.js";

export type { LiveAgentRun } from "./agent-live-registry.js";

const registry = createAgentLiveRegistry((runs) => broadcast("glyphh-agent:live", runs));

// ── A RUN CAN CHANGE HANDS (his report, 2026-09-27: a running thread opened
// from the rail "isn't re-connecting to the stream"). A run's frames go to ONE
// webContents — the panel that started it. When another panel opens that
// thread it adopts the run: main re-points the frames at it, hands it the
// turn's text so far, and tells the old panel to let go. Each engine registers
// how to re-point its own run. ──
const turnText = new Map<string, string>();
/** `orphanOnly`: re-point ONLY when nobody live holds the run (the previous
 *  holder is gone) — the automatic retry from the ledger push must never steal
 *  a turn from the panel that is showing it. */
export type RebindOpts = { orphanOnly?: boolean };
type Rebinder = (chatId: string, sender: WebContents, opts: RebindOpts) => { rebound: boolean; previous: WebContents | null };
const rebinders: Rebinder[] = [];
export function registerRunRebinder(fn: Rebinder): void { rebinders.push(fn); }
/** The turn's streamed text so far, for a panel adopting it mid-turn. */
export function noteRunDelta(chatId: string, delta: string): void {
  if (!delta) return;
  turnText.set(chatId, (turnText.get(chatId) ?? "") + delta);
}

export const agentLive = {
  ...registry,
  start(run: Omit<LiveAgentRun, "startedAt" | "status">): void { turnText.delete(run.chatId); registry.start(run); },
  done(chatId: string, runId?: string): void { registry.done(chatId, runId); if (!registry.isRunning(chatId)) turnText.delete(chatId); },
};

export function registerAgentLiveIpc(): void {
  ipcMain.handle("glyphh-agent-live-list", () => agentLive.list());
  ipcMain.handle("glyphh-agent-run-adopt", (e, p: { chatId?: string; orphanOnly?: boolean } | undefined) => {
    const chatId = String(p?.chatId ?? "");
    const opts: RebindOpts = { orphanOnly: !!p?.orphanOnly };
    const run = agentLive.list().find((r) => r.chatId === chatId);
    if (!run) return { ok: false as const };
    let previous: WebContents | null = null;
    let rebound = false;
    for (const fn of rebinders) {
      const r = fn(chatId, e.sender, opts);
      if (r.rebound) { rebound = true; previous = r.previous; break; }
    }
    if (!rebound) return { ok: false as const };
    if (previous && previous.id !== e.sender.id && !previous.isDestroyed()) {
      try { previous.send("glyphh-agent:handoff", { runId: run.runId, chatId }); } catch { /* gone */ }
    }
    agentLive.update(chatId, { senderId: e.sender.id });
    console.warn("[agent] run adopted", JSON.stringify({ chatId, runId: run.runId, from: previous?.id ?? null, to: e.sender.id }));
    return { ok: true as const, runId: run.runId, cliSessionId: run.cliSessionId, cli: run.cli, startedAt: run.startedAt, text: turnText.get(chatId) ?? "" };
  });
  // A PANEL CLOSES ITSELF (his report, 2026-10-19: with two agents open there
  // was no way to close one): its card lives in the shell, found by this
  // webContents id. The session stays in the recents.
  ipcMain.handle("agent-panel-close", (e) => {
    sendToHomeShell("agent-panel:close", { wcId: e.sender.id });
    return true;
  });
  ipcMain.handle("agent-panel-open", (_e, p: { loop?: string } | undefined) => {
    broadcast("agent-panel:open", { loop: String(p?.loop ?? "") });
    return true;
  });
  // A panel's ⋮ tools (Files, Terminal, Editor, …) open in the SHELL's grid,
  // beside the panel — never inside it (his report, 2026-09-26).
  ipcMain.handle("agent-panel-open-tool", (e, p: { view?: string; cwd?: string } | undefined) => {
    // THE SHELL FOLLOWS THE AGENT YOU'RE WORKING IN (his decision, 2026-09-27):
    // opening a tool from a panel makes that panel the active one first, so the
    // tool comes up rooted in ITS folder (the folder change lands before the open).
    activateAgentPanel(e.sender.id);
    broadcast("agent-panel:open-tool", { view: String(p?.view ?? ""), cwd: String(p?.cwd ?? "") });
    return true;
  });
  // A FILE a panel opens (an artifact card, a file link) lands in the SHELL's
  // workbench too — the editor, the browser or the Plan view beside the panel,
  // never inside it. The same rule as the tools above, and the same bug class
  // as Gmail opening twice (his report, 2026-09-29), so it goes to the one
  // workbench and nowhere else.
  ipcMain.handle("agent-panel-open-file", (e, p: { path?: string; mode?: string } | undefined) => {
    const file = String(p?.path ?? "");
    if (!file) return false;
    // open (the smart default) · browse (rendered) · edit (the editor).
    const mode = p?.mode === "browse" || p?.mode === "edit" ? p.mode : "open";
    activateAgentPanel(e.sender.id);
    sendToHomeShell("agent-panel:open-file", { path: file, mode });
    return true;
  });
  // A WORKSPACE a panel opens (".dip <workspace>", the Workspace menu) lands
  // in the SHELL's grid — never inside the panel (his report, 2026-10-08:
  // "glyphh inside of glyphh"). Same rule, same door as the tools and files.
  ipcMain.handle("agent-panel-open-layout", (e, p: { name?: string } | undefined) => {
    const name = String(p?.name ?? "").trim();
    if (!name) return false;
    activateAgentPanel(e.sender.id);
    sendToHomeShell("agent-panel:open-layout", { name });
    return true;
  });
  // A PANEL'S ROW IS ITS CARD'S HEAD (his order, 2026-10-09): its drag acts
  // on the panel's card in the shell, found by this webContents id.
  ipcMain.on("agent-panel-drag", (e, p: { phase?: string; cx?: number; cy?: number; sx?: number; sy?: number } | undefined) => {
    const phase = p?.phase === "down" || p?.phase === "up" ? p.phase : "move";
    const n = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
    sendToHomeShell("agent-panel:drag", { wcId: e.sender.id, phase, cx: n(p?.cx), cy: n(p?.cy), sx: n(p?.sx), sy: n(p?.sy) });
  });
  // CREATE WORKSPACE from a panel's menu (his order, 2026-10-08): the modal
  // and the arrangement it saves are the SHELL's.
  ipcMain.handle("agent-panel-create-workspace", (e) => {
    activateAgentPanel(e.sender.id);
    sendToHomeShell("agent-panel:create-workspace", {});
    return true;
  });
  // A SETTINGS PAGE a panel asks for (the "Choose a plan" door under a no-plan
  // refusal) opens in the shell's Settings, the one the dock opens.
  ipcMain.handle("agent-panel-open-settings", (_e, p: { sub?: string } | undefined) => {
    const sub = String(p?.sub ?? "").trim();
    if (!/^[a-z0-9-]{1,40}$/.test(sub)) return false;
    openSettingsPage(sub);
    return true;
  });
  // A panel became the one being worked in — a click or focus inside it (the
  // panel says so itself), or the shell fronting it (with the panel's id).
  ipcMain.handle("agent-panel-activate", (e, p: { wcId?: number } | undefined) => {
    activateAgentPanel(typeof p?.wcId === "number" ? p.wcId : e.sender.id);
    return true;
  });
}
