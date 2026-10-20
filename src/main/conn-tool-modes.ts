/**
 * conn-tool-modes.ts — WHAT A TOOL IS ALLOWED TO DO, decided in one place.
 *
 * His report, 2026-09-17: the Connections page showed `List events` as Always
 * allow, and an unattended run was refused it. Both were reading the same
 * preference, but the page applies a DEFAULT the runtime never knew about — a
 * read-only tool is allowed unless the user says otherwise — and a default
 * that is only ever displayed is not a rule, it is a lie.
 *
 * The rule lives here now. The task runner and the CLI session builder call
 * it, and the Connections page asks for it over IPC rather than keeping its
 * own copy, so what the user sees is what runs.
 */

import { ipcMain } from "electron";
import { preferencesByPrefix } from "./stores/preferences-db.js";

export type ToolMode = "allow" | "ask" | "never";

/** A tool that only reads is allowed by default; anything that writes asks. */
const READ_VERBS = /^(get|list|search|find|read|fetch|retrieve|query|describe|count|check|lookup|view|show|download|export|preview|watch|summarize|detect)\b/i;

/**
 * The tool's own name as words. The gateway prefixes a tool with the server's
 * technical name and Pipedream with the app slug, so everything up to the last
 * run of the app's tokens is dropped: "pd_o52…_gmail-gmail-send-email" is
 * "send email". Mirrors the page's own humanize (the two projects cannot share
 * a file: one import across them moves the renderer's whole build output).
 */
export function humanizeTool(name: string, app?: string): string {
  const tokens = String(name).toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  const appTokens = (app || "").toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  let rest = tokens;
  if (appTokens.length) {
    let cut = -1;
    for (let i = 0; i + appTokens.length < tokens.length; i++) {
      if (appTokens.every((t, j) => tokens[i + j] === t)) cut = i + appTokens.length;
    }
    if (cut > 0) rest = tokens.slice(cut);
  }
  return rest.join(" ");
}

export const isReadOnlyTool = (name: string, app?: string): boolean => READ_VERBS.test(humanizeTool(name, app));

/** Every mode the user has actually SET, by connection key then tool. */
const storedModes = (): Record<string, Record<string, string>> => preferencesByPrefix<Record<string, string>>("connToolModes:");

/**
 * What this tool may do, for real: the user's own setting if they made one,
 * else the default for its kind. `appSlug` is the connection key; `tool` may
 * arrive bare ("list_events") or prefixed ("google_calendar-list_events").
 */
export function effectiveToolMode(appSlug: string, tool: string, modes = storedModes()): ToolMode {
  const byTool = modes[appSlug] ?? {};
  const set = byTool[tool] ?? byTool[`${appSlug}-${tool}`] ?? byTool[tool.replace(`${appSlug}-`, "")];
  if (set === "allow" || set === "ask" || set === "never") return set;
  // The page keys a connection by kind ("mcp:linear", "pd:gmail"); the name's
  // prefix to drop is the bare slug.
  return isReadOnlyTool(tool, appSlug.replace(/^(mcp|pd):/, "")) ? "allow" : "ask";
}

/** The same answer for a whole list, which is what the page renders. */
export function effectiveToolModes(appSlug: string, tools: readonly string[]): Record<string, ToolMode> {
  const modes = storedModes();
  const out: Record<string, ToolMode> = {};
  for (const t of tools) out[t] = effectiveToolMode(appSlug, t, modes);
  return out;
}

export function registerConnToolModesIpc(): void {
  ipcMain.handle("conn-tool-modes", (_e, appSlug: string, tools: string[]) => {
    try { return { ok: true, data: effectiveToolModes(String(appSlug), Array.isArray(tools) ? tools.map(String) : []) }; }
    catch (err) { return { ok: false, error: err instanceof Error ? err.message : String(err) }; }
  });
}
