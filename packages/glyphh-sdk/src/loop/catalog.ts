/**
 * catalog.ts — WHAT THE LOOP CAN DO, AT ANY SCALE (his order, 2026-09-29: "this
 * list of tools can get massive with connections also. So how should we handle
 * this for scale? let's make a comprehensive fix strategically").
 *
 * A tool definition rides every message, so a toolset that grows with every
 * install and every connected account is a prompt that grows with them, and a
 * long menu is exactly what makes a model (a small one above all) pick badly.
 * The fix is the one the desktop had before the rebuild (tool-vectors.ts,
 * 2026-08-17; the find_tools escape hatch, 2026-08-11), now in the engine:
 *
 *   - a SMALL FIXED BELT per thread type, the same size however much is
 *     installed or connected;
 *   - everything else in a CATALOG: the host's other tools, each installed
 *     app's tools, the member's own MCP connections;
 *   - ONE find/call pair over the catalog AND the gateway's connected-account
 *     search, so the model searches once and calls by name;
 *   - a WORKING SET: what this chat already used ranks first, so retrieval is
 *     a first-touch cost, not a per-turn one.
 *
 * Pure: the ranking, the map and the specs are tested apart from the engine.
 */

import type { ImageParam, ToolSpec } from "./messages.js";

export const FIND_TOOL = "find_tools";
export const CALL_TOOL = "call_tool";

/** A tool reachable through find_tools / call_tool rather than wired into the prompt. */
export interface LoopCatalogEntry {
  name: string;
  description: string;
  inputSchema?: Record<string, unknown>;
  /** What it belongs to, for the map and the ranking: "tasks", "app: Happy Shoes", "connection: my-crm". */
  family: string;
  /** Runs without an approval in Ask mode. */
  readOnly?: boolean;
  /** Asks before every run, whatever the permission mode (Auto included):
   *  the host's user set this tool to need an approval. Plan mode still denies. */
  ask?: boolean;
  /** ON THE BELT (2026-10-07): a host tool the model must see by name, not
   *  find — the worker's app_install / glyphh_app_scaffold. The belt stays
   *  fixed-size by construction: a host lends a handful, never a catalog. */
  belt?: boolean;
  run(args: Record<string, unknown>, signal?: AbortSignal): Promise<{ text: string; failed: boolean; images?: ImageParam[] }>;
}

/** A skill the loop may read before doing the kind of work it covers. */
export interface LoopSkill { slug: string; name: string; description: string }

const STOP: ReadonlySet<string> = new Set(["a", "an", "the", "to", "of", "for", "in", "on", "and", "or", "my", "me", "i", "it", "is", "with", "from", "this", "that", "please", "can", "you", "tool", "tools"]);

/** Lowercase word stems: "Scheduled emails" → ["schedul", "email"]. */
export function terms(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 1 && !STOP.has(w))
    .map((w) => w.replace(/(ing|ed|es|s)$/, "") || w);
}

/** A host tool's family from its name: panels_open → "panels", schedule_save → "schedules". */
export function familyOf(name: string): string {
  const head = name.split(/[_.:-]/)[0] ?? name;
  return head.endsWith("s") ? head : `${head}s`;
}

/** The catalog entries that best match what the model asked for, best first. */
export function searchCatalog(entries: readonly LoopCatalogEntry[], query: string, limit: number, recent: ReadonlyMap<string, number>): LoopCatalogEntry[] {
  const want = [...new Set(terms(query))];
  if (!want.length) return [];
  const exact = query.trim().toLowerCase();
  const scored = entries.map((e) => {
    const name = new Set(terms(e.name));
    const family = new Set(terms(e.family));
    const desc = new Set(terms(e.description));
    let score = e.name.toLowerCase() === exact ? 10 : 0;
    for (const w of want) score += name.has(w) ? 3 : family.has(w) ? 2 : desc.has(w) ? 1 : 0;
    // The working set: a tool this chat already used is most likely the one again.
    if (score > 0 && recent.has(e.name)) score += 1.5;
    return { e, score };
  });
  return scored
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || a.e.name.localeCompare(b.e.name))
    .slice(0, limit)
    .map((x) => x.e);
}

/** The map find_tools carries: every family and how many tools it holds, so the
 *  model knows what exists before it searches (and phrases the task, not a keyword). */
export function familyMap(entries: readonly LoopCatalogEntry[], cap = 900): string {
  const counts = new Map<string, number>();
  for (const e of entries) counts.set(e.family, (counts.get(e.family) ?? 0) + 1);
  const parts = [...counts.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([f, n]) => `${f} (${n})`);
  const out: string[] = [];
  let used = 0;
  for (const p of parts) {
    if (used + p.length + 2 > cap) { out.push(`and ${parts.length - out.length} more`); break; }
    out.push(p);
    used += p.length + 2;
  }
  return out.join(", ");
}

export function findToolSpec(entries: readonly LoopCatalogEntry[], hasAccounts: boolean): ToolSpec {
  const map = entries.length ? `On this machine: ${familyMap(entries)}.` : "";
  const accounts = hasAccounts ? " Connected accounts (Gmail, Drive, GitHub, Slack and thousands more) are searched in the same call." : "";
  return {
    name: FIND_TOOL,
    description:
      "Find a tool you do not have listed, by describing the TASK in plain words (\"send an email to Sam\", \"schedule this every Monday\", not a keyword). "
      + "Returns the best matches with their names, what they do and their input schemas; run one with call_tool. "
      + `Search before telling the user something cannot be done.${map ? ` ${map}` : ""}${accounts}`,
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "The task, in plain words" },
        limit: { type: "integer", description: "How many matches (default 8)" },
      },
      required: ["query"],
    },
  };
}

export function callToolSpec(): ToolSpec {
  return {
    name: CALL_TOOL,
    description: "Run a tool that find_tools returned, by its exact name, with arguments that match its input schema.",
    input_schema: {
      type: "object",
      properties: {
        name: { type: "string", description: "The tool's exact name from find_tools" },
        arguments: { type: "object", description: "Arguments per the tool's input schema" },
      },
      required: ["name"],
    },
  };
}

/** The skills index for the system prompt: what each is for, read in full on demand. */
export function skillsIndex(skills: readonly LoopSkill[], readTool: string, cap = 40): string {
  if (!skills.length) return "";
  const shown = skills.slice(0, cap).map((s) => `- ${s.slug}: ${(s.description || s.name).replace(/\s+/g, " ").slice(0, 200)}`);
  const more = skills.length > cap ? `\n- …and ${skills.length - cap} more (skills_list through find_tools).` : "";
  return `The user's skills: standing know-how for kinds of work. Before doing work a skill covers, read it with ${readTool} {slug} and follow it.\n${shown.join("\n")}${more}`;
}
