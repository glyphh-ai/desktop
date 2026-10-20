/**
 * connection-catalog.ts — THE CONNECTIONS' TOOLS AS GLYPHH-LOOP CATALOG
 * ENTRIES, with the user's tool permissions applied (conn-tool-modes.ts).
 *
 *   Never           not listed at all (listConnectionTools already drops it)
 *   Needs approval  `ask`: the loop asks before every run, in any permission
 *                   mode — the user said so for this tool
 *   Always allow    `readOnly`: runs without asking
 *
 * An unattended run has no one to ask, so it only carries Always-allow tools,
 * the same rule the task runner applies to a task's connection calls.
 * Pure: the caller hands in the tools and the call.
 */

import type { LoopCatalogEntry } from "@glyphh/sdk/loop";
import type { ConnTool } from "./mcp-connections.js";

const safe = (s: string): string => s.replace(/[^a-zA-Z0-9_-]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 64);
const asText = (v: unknown): string => (typeof v === "string" ? v : JSON.stringify(v));

export function connectionCatalogEntries(
  tools: readonly ConnTool[],
  call: (connection: string, tool: string, args: Record<string, unknown>) => Promise<unknown>,
  unattended: boolean,
): LoopCatalogEntry[] {
  const out: LoopCatalogEntry[] = [];
  for (const t of tools) {
    if (unattended && t.mode !== "allow") continue;
    out.push({
      name: safe(`${t.connection}_${t.name}`),
      description: (t.description || t.name).slice(0, 1000),
      family: `connection: ${t.label || t.connection}`,
      ...(t.inputSchema && typeof t.inputSchema === "object" ? { inputSchema: t.inputSchema as Record<string, unknown> } : {}),
      ...(t.mode === "allow" ? { readOnly: true } : { ask: true }),
      run: async (args) => {
        try {
          const r = await call(t.connection, t.name, args) as { isError?: boolean };
          return { text: asText(r), failed: r?.isError === true };
        } catch (err) { return { text: err instanceof Error ? err.message : String(err), failed: true }; }
      },
    });
  }
  return out;
}
