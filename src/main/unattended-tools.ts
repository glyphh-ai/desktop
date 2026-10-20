/**
 * unattended-tools.ts — WHAT A RUN WITH NOBODY WATCHING MAY NOT TOUCH (his
 * report, 2026-10-08: "the terminal window keeps randomly showing up" — a
 * scheduled skill ran the loop with the same toolset a live chat has, and the
 * model opened a terminal whenever the skill text suggested one).
 *
 * An unattended run — a schedule, a task slot, a CLI agent run headless —
 * gets no tool that opens, moves or drives anything on the member's screen:
 * no panels, no workspaces, no Settings, no RPA (a mapped command opens its
 * tab's panel to run; the picker needs a hand on the mouse). Everything
 * else the local server lends stays. Pure: the local MCP server mounts a
 * second door with these left out, and the loop's unattended copy and the
 * CLIs' headless lines use that door.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

export const UNATTENDED_HIDDEN: ReadonlySet<string> = new Set([
  "panels_open", "panels_switch", "panels_close", "layouts_open", "settings_open",
  "rpa_click", "rpa_type", "rpa_read", "rpa_screenshot", "rpa_goto",
  "rpa_commands", "rpa_pick", "rpa_map", "rpa_unmap", "rpa_run", "rpa_sequence_save", "rpa_sequence_remove", "rpa_sequence_run",
]);

/** The local server's door for unattended callers: the same tools, minus the screen. */
export const UNATTENDED_MCP_PATH = "/mcp-unattended";


/** A catalog family the loop built from a tab's RPA mapping (glyphh-loop.ts). */
export const isScreenFamily = (family: string): boolean => family.startsWith("rpa: ");

/** The same McpServer, with every registration of a hidden tool dropped. */
export function withoutUnattendedTools<T extends Pick<McpServer, "tool">>(mcp: T): T {
  return new Proxy(mcp, {
    get(target, prop, receiver) {
      if (prop !== "tool") return Reflect.get(target, prop, receiver);
      return (...args: unknown[]) => {
        if (typeof args[0] === "string" && UNATTENDED_HIDDEN.has(args[0])) return undefined;
        return (target.tool as unknown as (...a: unknown[]) => unknown).apply(target, args);
      };
    },
  });
}
