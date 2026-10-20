/**
 * agent-tools.ts — THE MEMBER'S AGENTS, as tools (his order, 2026-09-29:
 * "extend the mcp tools for the app to include generating agents").
 *
 * The same records Settings → Build → Agents edits (local-agents.ts), reached
 * through the relay dispatch every app tool uses, so the local MCP server and
 * any relay client get the same four calls:
 *
 *   agents.list                 — the roster: slug, name, when to use it, model
 *   agents.get    {agent}       — one agent in full, brief included
 *   agents.save   {agent?, name, description?, brief?, model?, kind?, cli?}
 *                               — make or update one; with no brief the app
 *                                 WRITES one on the member's default model;
 *                                 kind "cli" + cli names a CLI agent run
 *                                 headless (his order, 2026-10-07)
 *   agents.delete {agent}
 *
 * Every save is checked the way the page checks it: a model must be one the
 * member's team carries (a slot naming anything else would be refused at spawn
 * time), and making an agent never silently overwrites one that exists.
 */

import { registerRelayHandler } from "./relay-client.js";
import { deleteAgent, getAgent, listAgents, saveAgent, slugify } from "./local-agents.js";
import { generateAgentBrief } from "./agent-brief.js";
import { listLoopModels } from "./loop-models.js";
import { modelRef } from "./org-models.js";

interface SaveParams { agent?: unknown; name?: unknown; description?: unknown; brief?: unknown; model?: unknown }

const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

function summary(a: ReturnType<typeof getAgent>): { agent: string; name: string; description: string; model: string | null; hasBrief: boolean } {
  return { agent: a.slug, name: a.name, description: a.description, model: modelRef(a.model || "") || null, hasBrief: !!a.prompt.trim() };
}

async function checkedModel(raw: string): Promise<string> {
  const m = modelRef(raw);
  if (!m) return "";
  const list = await listLoopModels().catch(() => null);
  if (!list?.ok) return m;   // the list couldn't be read: the gateway decides at spawn time
  if (list.models.some((x) => x.id === m)) return m;
  const valid = list.models.map((x) => x.id).slice(0, 30).join(", ");
  throw new Error(`"${m}" is not one of this member's models. Use one of: ${valid || "(none available)"} — or omit model to run on the main agent's.`);
}

export function installAgentRelayHandlers(): void {
  registerRelayHandler("agents.list", () => listAgents().map(summary));

  registerRelayHandler("agents.get", (params) => {
    const ref = str((params as { agent?: unknown } | null)?.agent);
    if (!ref) throw new Error("agents.get requires { agent }");
    const a = getAgent(ref);
    return { ...summary(a), brief: a.prompt };
  });

  registerRelayHandler("agents.save", async (params) => {
    const p = (params ?? {}) as SaveParams;
    const ref = str(p.agent);
    const existing = ref ? listAgents().find((a) => a.slug === ref) : undefined;
    if (ref && !existing) throw new Error(`no agent "${ref}" — call agents_list, or omit agent to make a new one`);
    const name = str(p.name) || existing?.name || "";
    if (!name) throw new Error("an agent needs a name");
    // MAKING never overwrites: a name that slugs onto an existing agent is that
    // agent, and changing it is an explicit update.
    if (!ref && listAgents().some((a) => a.slug === slugify(name))) {
      throw new Error(`an agent called "${name}" already exists — pass { agent: "${slugify(name)}" } to update it`);
    }
    const description = p.description === undefined ? existing?.description ?? "" : str(p.description);
    const model = p.model === undefined ? existing?.model ?? "" : await checkedModel(str(p.model));
    let brief = p.brief === undefined ? existing?.prompt ?? "" : str(p.brief);
    let generated = false;
    // NO BRIEF, THE APP WRITES ONE — the same generator as the page's wand, on
    // the member's default model. An agent without a brief can't be handed work.
    if (!brief) {
      const g = await generateAgentBrief({ name, description, model });
      if (!g.ok) throw new Error(`the brief could not be written: ${g.error}`);
      brief = g.brief;
      generated = true;
    }
    const row = saveAgent({ ...(existing ? { slug: existing.slug } : {}), name, description, prompt: brief, model });
    return { ...summary(row), created: !existing, generatedBrief: generated, brief: row.prompt };
  });

  registerRelayHandler("agents.delete", (params) => {
    const ref = str((params as { agent?: unknown } | null)?.agent);
    if (!ref) throw new Error("agents.delete requires { agent }");
    getAgent(ref);   // a clear "not found" rather than a silent no-op
    deleteAgent(ref);
    return { agent: ref, deleted: true };
  });
}
