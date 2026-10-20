/**
 * mcp-lend.ts — WHICH DOOR ANSWERS WHICH NAME when the desktop's loop lends
 * two MCP servers that carry the same tool names (his order, 2026-10-04: the
 * cloud gets the same tools as the desktop; the local server must win for the
 * window tools and the gateway's for the rest).
 *
 * The local server (local-mcp-server.ts) is this machine: its windows, its
 * folders, its loopback apps. The gateway's /mcp (server glyphh/docs/glyphh-
 * mcp.md) is the member's cloud reach: the library the desktop syncs from,
 * the cloud clock, the app instances on the farm, the connected accounts.
 * The SDK keeps the first belt tool of a name and files everything else into
 * the catalog unchecked, so both sides are filtered HERE, once, and a name is
 * lent by exactly one server. Pure, no electron.
 */

/** The desktop's windows: the local server answers; the gateway's copies
 *  would only relay back to this very machine. */
export const WINDOW_TOOLS: ReadonlySet<string> = new Set([
  "relay_ping", "panels_open", "panels_list", "panels_switch", "panels_close", "layouts_open", "settings_open",
]);

/** The desktop's folder: `app_install { dir }` zips or tars a folder ON THIS
 *  MACHINE (the gateway's copies want base64 only a cloud session's pod can
 *  hand them), so the local server answers it like a window tool; the build
 *  job it starts is read here too. The gateway's `app_deploy` (sourceBase64)
 *  is hidden from the loop: nothing big rides through the model. */
export const MACHINE_TOOLS: ReadonlySet<string> = new Set([
  "app_install", "app_build_status", "glyphh_app_scaffold",
  // RPA ON A TAB (2026-10-07): the picker, the mapping and the runs act on a
  // panel on THIS screen, so only the local server answers them.
  "rpa_commands", "rpa_pick", "rpa_map", "rpa_unmap", "rpa_run", "rpa_sequence_save", "rpa_sequence_remove", "rpa_sequence_run",
  // A RUN HAPPENS WHERE THE RPA LIVES (his order, 2026-10-07: "give apps,
  // agents, skills, plugins — everything — the ability to call the rpa
  // tooling"): with the desktop up, a task or a skill run NOW runs on this
  // machine, with its tools; the gateway's copies serve cloud sessions.
  "task_run", "skill_run",
]);

/** The member's cloud reach: the gateway answers, from the library, the
 *  clock and the app instances, wherever the loop runs. */
export const CLOUD_TOOLS: ReadonlySet<string> = new Set([
  "skills_list", "skill_get", "skill_save", "skill_enable", "skill_delete", "skill_retype",
  "tasks_list", "task_get", "task_runs",
  "schedules_list", "schedule_save", "schedule_run", "schedule_delete", "agents_list",
  "app_list_tools", "app_call_tool", "app_releases", "app_pin",
]);

/** The gateway's connections lane: the lookup pair the loop drives connected
 *  accounts through, and the account tools beside it. Off with the org's lane. */
export const GATEWAY_CONNECTION_TOOLS: ReadonlySet<string> = new Set([
  "glyphh_connections", "glyphh_connect", "glyphh_disconnect", "mcp_tool_search", "mcp_tool_call",
]);

/** THE DESKTOP'S OWN CONNECTOR TOOLS — the local server's half of the
 *  connections lane. They reach the same Pipedream accounts the gateway's
 *  lookup pair does, so the org's connections gate has to close over them too
 *  (his order, 2026-09-29: "fully gate the pipedream lane"). */
export const LOCAL_CONNECTION_TOOLS: ReadonlySet<string> = new Set([
  "connector_tools", "connector_call", "connections_list_tools", "connections_call_tool",
]);

/** Host tools the loop never sees: diagnostics, and the list/call pairs the
 *  catalog now stands in for (each app tool and connection tool is its own
 *  entry; connected accounts go through the gateway's search). External MCP
 *  clients still get them — this is the loop's view only. */
export const LOOP_HIDDEN: ReadonlySet<string> = new Set([
  "relay_ping", "app_list_tools", "app_call_tool", "app_deploy",
  "connector_tools", "connector_call", "connections_list_tools", "connections_call_tool",
]);

export interface LendState {
  /** The loopback local MCP server is up and lent. */
  localUp: boolean;
  /** The gateway's /mcp is lent (a signed-in member with a key). */
  gatewayUp: boolean;
  /** The org's connections lane is on. */
  connections: boolean;
  /** The local server's fixed belt (every space): a belt tool must stay local,
   *  because only a local tool rides the belt at all. */
  belt: ReadonlySet<string>;
}

/** The two `allow` filters, one per server. */
export function lendSplit(s: LendState): { local: (tool: string) => boolean; gateway: (tool: string) => boolean } {
  return {
    local: (t) =>
      !LOOP_HIDDEN.has(t)
      && (s.connections || !LOCAL_CONNECTION_TOOLS.has(t))
      && !(s.gatewayUp && CLOUD_TOOLS.has(t) && !s.belt.has(t)),
    gateway: (t) =>
      !(s.localUp && (WINDOW_TOOLS.has(t) || MACHINE_TOOLS.has(t) || s.belt.has(t)))
      && (s.connections || !GATEWAY_CONNECTION_TOOLS.has(t)),
  };
}
