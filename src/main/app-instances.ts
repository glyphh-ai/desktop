/**
 * app-instances.ts — APP INSTANCES, which this local app does not have.
 *
 * A Glyphh app ran as a cloud instance on the Glyphh server; with no server
 * there is none to list and none to call. The two doors the loop's tool
 * catalog reads (glyphh-loop.ts) answer exactly that: no app tools, and a
 * call to one is refused by name.
 */

import type { instanceToolRows } from "../shared/app-instances.js";

export type AppToolRow = ReturnType<typeof instanceToolRows>[number];

/** The tools of every app instance this member may open: none. */
export async function listInstanceTools(): Promise<AppToolRow[]> {
  return [];
}

/** Call an app instance's tool: there is no instance to call. */
export async function callInstanceTool(ref: string, tool: string, _args: Record<string, unknown>): Promise<unknown> {
  throw new Error(`no Glyphh app "${ref}" to run "${tool}" on — apps ran as cloud instances, and this app has no cloud`);
}
