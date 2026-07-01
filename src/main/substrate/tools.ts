/**
 * Unified tool registry — every tool the agent can invoke is a skill.
 *
 * Three kinds, one registry:
 *   - substrate tools (built-in, namespaced yo.*)   — privileged ctx
 *   - user skills    (~/yo/skills/*, namespaced skill.*)
 *   - MCP tools      (per-app, namespaced <app>.*)  — via SkillToolRouter
 *
 * Every invocation flows through the substrate breath cycle (sanitize,
 * budget, remember). The agent's tool spec is built dynamically at
 * LLM-call time so users can add tools by creating skills.
 */

import fs from "fs";
import path from "path";
import os from "os";
import { execSync } from "child_process";
import { webSearch, fetchPage } from "../web-search";
import { getWorkingDirectory } from "../working-directory";

// Privileged accessors injected by main.ts. Substrate tools use these;
// user-skill ctx never sees them.
export interface SubstrateToolDeps {
  sessionCache?: { get: () => string | null };
  noteStore?: { search: (q: string, n: number) => Promise<Array<{ file: string; title: string; content: string; rank: number }>>; write: (title: string, content: string, source?: string) => Promise<string> };
  memoryStore?: { save: (content: string, category: string) => Promise<string> };
  skillEngine?: {
    process: (content: string, skillName?: string) => Promise<string>;
    listSkillsDetailed: () => Array<{ name: string; description?: string; scheduled: boolean; scheduleExpr?: string; hasRunner?: boolean; hasApp?: boolean }>;
    getSkill: (name: string) => { manifest: Record<string, unknown>; prompt: string; folderPath: string } | null;
    writeSkill: (name: string, manifest: Record<string, unknown>, prompt: string) => boolean;
    deleteSkill: (name: string) => boolean;
    readSkillFile: (name: string, rel: string) => string | null;
    writeSkillFile: (name: string, rel: string, content: string) => boolean;
    listSkillFiles: (name: string) => string[];
    runSkill?: (name: string, input: unknown, opts?: { trigger?: "manual" | "schedule" | "skill" }) => Promise<unknown>;
    getRunHistory?: (name: string) => Array<{ id: string; trigger: string; startedAt: number; durationMs?: number; output?: unknown; error?: string; logs: string[]; events: Array<{ type: string; label: string; status: string }> }>;
    hasRunner?: (name: string) => boolean;
  };
  mcpRouter?: { resolveAll: () => Array<{ name: string; description: string; input_schema: Record<string, unknown> }>; callMcp?: (name: string, input: Record<string, unknown>) => Promise<string>; hasTool?: (name: string) => boolean; mcpCoveredApps?: () => Map<string, string[]> };
  dripManager?: {
    listCustoms: () => Array<{ name: string; recipe: string }>;
    saveCustom: (name: string, recipe: string) => string;
    deleteCustom: (name: string) => string;
    listBuiltinEffects: () => string[];
  };
  layoutManager?: {
    listLayouts: () => Array<{ name: string; version: 2; cols: number; rows: number; colWidths: number[]; rowHeights: number[]; cells: Array<{ panelId: string; col: number; row: number; colSpan: number; rowSpan: number }> }>;
    getLayout: (name: string) => { name: string; version: 2; cols: number; rows: number; colWidths: number[]; rowHeights: number[]; cells: Array<{ panelId: string; col: number; row: number; colSpan: number; rowSpan: number }> } | undefined;
    saveLayout: (grid: { name: string; version: 2; cols: number; rows: number; colWidths: number[]; rowHeights: number[]; cells: Array<{ panelId: string; col: number; row: number; colSpan: number; rowSpan: number }> }) => void;
    deleteLayout: (name: string) => boolean;
  };
  dataStore?: {
    get: (namespace: string, key: string) => unknown | null;
    set: (namespace: string, key: string, value: unknown) => void;
    delete: (namespace: string, key: string) => boolean;
    list: (namespace: string, prefix?: string, limit?: number) => Array<{ key: string; value: unknown; updatedAt: number }>;
    query: (namespace: string, filter: Record<string, unknown>, limit?: number) => Array<{ key: string; value: unknown; updatedAt: number }>;
    keys: (namespace: string) => string[];
    count: (namespace: string) => number;
    clear: (namespace: string) => number;
    listNamespaces: () => string[];
  };
  workspace?: {
    teamStatus: () => string;
    readLog: (filter: Record<string, unknown>) => string;
    postTo: (agent: string, body: string, kind?: string) => string;
    post: (body: string, tags?: string[], kind?: string) => string;
    readAgent: (name: string, kind?: string) => string;
    broadcastAndWait: (body: string, tags: string[], kind: string | undefined, timeoutMs: number) => Promise<string>;
  };
  panels?: {
    list: () => string;
    scan: (panelId: string) => Promise<string | null>;
    grab: (panelId: string) => Promise<string | null>;
    click: (panelId: string, text?: string, selector?: string) => Promise<string>;
    navigate: (panelId: string, url: string) => Promise<string>;
    type: (panelId: string, text: string, opts: { label?: string; placeholder?: string; selector?: string; clear?: boolean; submit?: boolean }) => Promise<string>;
    open: (url: string, panelId?: string) => Promise<string>;
    openBackground: (url: string, panelId?: string) => Promise<string>;
    runCommand: (panelId: string, command: string, value?: string) => Promise<string>;
    screenshot: (panelId: string) => Promise<string | null>;
    refresh: (panelId?: string) => Promise<string>;
  };
  tabs?: {
    list: () => Array<{ id: string; title: string; url?: string }>;
    switch: (id: string) => void;
    close: (id: string) => void;
    create: () => string;
  };
  execCommand?: (cmd: string) => Promise<string>;
  /** The user's configured apps (the registry behind `dip <app>`). */
  apps?: {
    list: () => Array<{ id: string; name: string; url?: string; description?: string }>;
    open: (id: string) => Promise<string>;
    /** Register an app with the AppConnector — appears in the Apps list +
     *  is openable via `dip <id>`. Used by the create_app tool after
     *  scaffolding files. */
    register?: (id: string, name: string, url: string, description?: string) => boolean;
    /** Check whether an app id is already taken. */
    has?: (id: string) => boolean;
  };
  swarm?: {
    /** Draft + spawn a local swarm. Returns a text status for the agent. */
    create: (goal: string, agentIds?: string[], size?: number) => Promise<string>;
    /** Spawn one detached ephemeral background agent. Returns immediately. */
    spawnBackground?: (prompt: string, role?: string) => Promise<string>;
  };
  /** User-created agent registry — surfaced as list_agents + call_agent
   *  so the .yo loop can delegate to a named agent without committing to a
   *  full multi-agent swarm. */
  agentRegistry?: {
    list: () => Array<{ id: string; name: string; role?: string; mode?: string }>;
    get: (id: string) => { id: string; name: string; role?: string } | null;
  };
}

let deps: SubstrateToolDeps = {};
export function setSubstrateToolDeps(d: SubstrateToolDeps): void { deps = { ...deps, ...d }; }

export interface ToolDef {
  /** Bare name as the LLM sees it (e.g. "search_captures"). */
  name: string;
  /** Display namespace ("yo" | "skill" | app id). */
  namespace: "yo" | "skill" | string;
  description: string;
  input_schema: Record<string, unknown>;
  /** True if invocation is destructive (triggers act.checkpoint). */
  destructive?: boolean;
  /** Implementation. Receives input + privileged deps. */
  run: (input: Record<string, unknown>) => Promise<string>;
}

// ── Built-in substrate tools (namespace: yo) ────────────────

const BUILTIN_TOOLS: ToolDef[] = [
  {
    name: "get_context",
    namespace: "yo",
    description: "Read current session context — in-memory .sup captures from this session.",
    input_schema: { type: "object", properties: {} },
    async run() {
      if (!deps.sessionCache) return "Session cache not available.";
      const content = deps.sessionCache.get();
      return content || "No captures in this session yet.";
    },
  },
  {
    name: "format",
    namespace: "yo",
    description: "Apply a named skill to format content. If no skill specified, lists available skills.",
    input_schema: {
      type: "object",
      properties: {
        content: { type: "string", description: "Content to format" },
        skill: { type: "string", description: "Skill name (omit to list)" },
      },
    },
    async run(input) {
      const content = input.content as string;
      const skill = input.skill as string;
      if (!deps.skillEngine) return "Skill engine not available.";
      if (!skill) {
        const skills = deps.skillEngine.listSkillsDetailed();
        if (skills.length === 0) return "No skills available.";
        return `Available skills:\n${skills.map((s) => `- ${s.name}${s.description ? ` — ${s.description}` : ""}`).join("\n")}\n\nCall format again with a skill name.`;
      }
      if (!content) return "No content provided.";
      try {
        return await deps.skillEngine.process(content, skill);
      } catch (err) {
        return `Skill error: ${err instanceof Error ? err.message : String(err)}`;
      }
    },
  },

  // ── Skill authoring (agent uses these to build user skills on demand) ──
  {
    name: "mcp_tools_list",
    namespace: "yo",
    description: "List every connected MCP tool with name, description, and a typed-key summary. Inputs are shown as 'key:type*' where * means required. ALWAYS call this before drafting a skill so allowed-tools and ctx.tools.call(...) reference real names. Use mcp_tool_schema for the full input schema of a specific tool.",
    input_schema: {
      type: "object",
      properties: {
        namespace: { type: "string", description: "Filter to one MCP namespace (server id)" },
      },
    },
    async run(input) {
      if (!deps.mcpRouter?.resolveAll) return "MCP router not available.";
      const filter = (input.namespace as string | undefined)?.trim();
      const tools = deps.mcpRouter.resolveAll();
      const filtered = filter ? tools.filter(t => t.name.startsWith(filter + ".") || t.name.startsWith(filter + "_") || t.name.split(".")[0] === filter) : tools;
      if (filtered.length === 0) return filter ? `No tools found for namespace "${filter}".` : "No MCP tools connected.";
      const lines = filtered.map((t) => {
        const props = (t.input_schema?.properties || {}) as Record<string, { type?: string }>;
        const required = new Set((t.input_schema?.required || []) as string[]);
        const keys = Object.entries(props)
          .map(([k, v]) => `${k}:${v?.type || "any"}${required.has(k) ? "*" : ""}`)
          .join(", ");
        return `- ${t.name}${keys ? ` (${keys})` : ""}\n    ${t.description?.slice(0, 200) || ""}`;
      });
      return `${filtered.length} MCP tool(s) (* = required):\n\n${lines.join("\n")}`;
    },
  },
  {
    name: "mcp_tool_schema",
    namespace: "yo",
    description: "Return the complete JSON input schema for a single MCP tool, qualified as '<server>.<tool>' (e.g. 'gmail.gmail-find-email'). Use this BEFORE writing a ctx.tools.call(...) so you don't miss required fields like Pipedream's withTextPayload.",
    input_schema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Qualified tool name '<server>.<tool>'" },
      },
      required: ["name"],
    },
    async run(input) {
      if (!deps.mcpRouter?.resolveAll) return "MCP router not available.";
      const target = (input.name as string)?.trim();
      if (!target) return "Provide a tool name (from mcp_tools_list).";
      const tools = deps.mcpRouter.resolveAll();
      // Accept either the short name mcp_tools_list shows (gmail__gmail_find_email)
      // or the qualified '<server>.<tool>' form. resolveAll keys on short names
      // (hyphens converted to underscores).
      const short = target.includes(".")
        ? `${target.slice(0, target.indexOf(".")).replace(/-/g, "_")}__${target.slice(target.indexOf(".") + 1).replace(/-/g, "_")}`
        : target;
      const match = tools.find(t => t.name === short);
      if (!match) return `Tool "${target}" not found. Run mcp_tools_list to see what's connected.`;
      return [
        `# ${target}`,
        ``,
        match.description || "(no description)",
        ``,
        `## input_schema`,
        "```json",
        JSON.stringify(match.input_schema, null, 2),
        "```",
      ].join("\n");
    },
  },
  {
    name: "mcp_tool_call",
    namespace: "yo",
    description: "Run a connected-app (MCP) tool by name. Connected-app tools (Gmail, Slack, Calendar, Drive, …) are NOT loaded into your context by default — discover them with mcp_tools_list, check inputs with mcp_tool_schema, then call them here. Use the short name from mcp_tools_list (e.g. 'gmail__gmail_find_email').",
    input_schema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Short tool name from mcp_tools_list, e.g. 'gmail__gmail_find_email'." },
        input: { type: "object", description: "Arguments matching the tool's input_schema (see mcp_tool_schema)." },
      },
      required: ["name"],
    },
    async run(input) {
      if (!deps.mcpRouter?.callMcp) return "MCP router not available.";
      const name = (input.name as string)?.trim();
      if (!name) return "Provide the tool name (from mcp_tools_list).";
      const args = (input.input as Record<string, unknown>) || {};
      return deps.mcpRouter.callMcp(name, args);
    },
  },
  {
    name: "find_tools",
    namespace: "yo",
    description: "Search for less-common tools that aren't already loaded — skill authoring, layout/store/drip management, workspace coordination, and other specialized substrate actions. Returns matching tool names, descriptions, and input summaries; run one with call_tool. NOTE: connected-app tools (Gmail, Slack, Calendar, …) are already loaded and directly callable — do NOT use find_tools for those.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Keywords for what you want to do (e.g. 'send email', 'save layout', 'create skill', 'post to workspace')." },
      },
      required: ["query"],
    },
    async run(input) {
      const q = String(input.query ?? "").toLowerCase().trim();
      if (!q) return "Provide a query describing what you want to do.";
      const terms = q.split(/\s+/).filter(Boolean);
      // Everything NOT already loaded in the core kit: the rare substrate tail,
      // skills, AND the connected-app (MCP) tools (includeMcp=true) — connectors
      // are discovered here, not preloaded, so they scale to hundreds of apps.
      const all = getAgentToolSpec(undefined, true, false).filter((t) => !AGENT_CORE_TOOLS.has(t.name));
      const scored = all
        .map((t) => {
          const hay = `${t.name} ${t.description || ""}`.toLowerCase();
          return { t, score: terms.reduce((s, term) => s + (hay.includes(term) ? 1 : 0), 0) };
        })
        .filter((x) => x.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, 12);
      if (scored.length === 0) return `No tools match "${q}". Try different keywords.`;
      // Compact summary only (key:type*, * = required) — NOT the full JSON
      // schema, which for connector tools is 1-2K tokens each and would bloat
      // the context. The keys are enough to call_tool; details via mcp_tool_schema.
      return `${scored.length} tool(s) matching "${q}" — call one with call_tool(name, input):\n\n` +
        scored.map(({ t }) => {
          const props = (t.input_schema?.properties || {}) as Record<string, { type?: string }>;
          const required = new Set((t.input_schema?.required || []) as string[]);
          const keys = Object.entries(props).map(([k, v]) => `${k}:${v?.type || "any"}${required.has(k) ? "*" : ""}`).join(", ");
          return `${t.name}${keys ? ` (${keys})` : ""}\n  ${(t.description || "").slice(0, 130)}`;
        }).join("\n\n");
    },
  },
  {
    name: "call_tool",
    namespace: "yo",
    description: "Run a tool by name with its input — for tools you found via find_tools that aren't in your loaded set (specialized substrate actions, skills). For tools you already have loaded (including connected-app tools), call them directly instead.",
    input_schema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Exact tool name from find_tools." },
        input: { type: "object", description: "Arguments matching the tool's input_schema." },
      },
      required: ["name"],
    },
    async run(input) {
      const name = String(input.name ?? "").trim();
      if (!name) return "Provide the tool name (from find_tools).";
      // Don't let call_tool wrap another invoker (call_tool / find_tools /
      // mcp_tool_call) — that would launder the real tool past the permission
      // gate. Call the target tool directly through call_tool instead.
      if (["call_tool", "find_tools", "mcp_tool_call"].includes(name.replace(/^mcp__[^_]+__/, ""))) {
        return `Call the target tool directly via call_tool(name, input), not through ${name}.`;
      }
      const args = (input.input as Record<string, unknown>) || {};
      return executeTool(name, args);
    },
  },
  {
    name: "skill_list",
    namespace: "yo",
    description: "List user skills (folder + SKILL.md + optional SKILL.js under ~/.claude/skills/). Returns name, description, hasRunner, schedule.",
    input_schema: { type: "object", properties: {} },
    async run() {
      if (!deps.skillEngine) return "Skill engine not available.";
      const skills = deps.skillEngine.listSkillsDetailed();
      if (skills.length === 0) return "No skills found in ~/.claude/skills/.";
      return skills.map(s => {
        const tags = [];
        if (s.hasRunner) tags.push("runner");
        if (s.scheduled) tags.push(`cron: ${s.scheduleExpr}`);
        const tagStr = tags.length ? ` [${tags.join(", ")}]` : "";
        return `- ${s.name}${tagStr}${s.description ? ` — ${s.description}` : ""}`;
      }).join("\n");
    },
  },
  {
    name: "skill_get",
    namespace: "yo",
    description: "Read a skill's SKILL.md (frontmatter + body) and SKILL.js (if present). Use to inspect or template off existing skills before editing.",
    input_schema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Skill folder name" },
      },
      required: ["name"],
    },
    async run(input) {
      const name = input.name as string;
      if (!deps.skillEngine) return "Skill engine not available.";
      const s = deps.skillEngine.getSkill(name);
      if (!s) return `Skill "${name}" not found.`;
      const runnerCode = deps.skillEngine.readSkillFile(name, "SKILL.js");
      const out: string[] = [];
      out.push(`# Skill: ${name}`);
      out.push(`folder: ${s.folderPath}`);
      out.push(`hasRunner: ${!!runnerCode}`);
      out.push("");
      out.push("## SKILL.md");
      out.push("```yaml");
      out.push(JSON.stringify(s.manifest, null, 2));
      out.push("```");
      out.push("");
      out.push("### body");
      out.push(s.prompt || "(empty)");
      if (runnerCode) {
        out.push("");
        out.push("## SKILL.js");
        out.push("```js");
        out.push(runnerCode);
        out.push("```");
      }
      return out.join("\n");
    },
  },
  {
    name: "skill_create",
    namespace: "yo",
    description: "Create or replace a skill's SKILL.md (frontmatter + body). For SKILL.js use skill_write_runner. Frontmatter fields: description, allowed-tools (array of '<server>.<tool>'), schedule (cron, optional), when_to_use, model.",
    input_schema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Folder name (alphanumeric, hyphens)" },
        manifest: {
          type: "object",
          description: "YAML frontmatter object: { description, when_to_use?, allowed-tools?, schedule?, model? }",
        },
        body: { type: "string", description: "Markdown body of SKILL.md (description, usage notes, examples)" },
      },
      required: ["name", "manifest", "body"],
    },
    async run(input) {
      const name = input.name as string;
      const manifest = input.manifest as Record<string, unknown>;
      const body = input.body as string;
      if (!deps.skillEngine) return "Skill engine not available.";
      const ok = deps.skillEngine.writeSkill(name, { name, ...manifest }, body || "");
      if (!ok) return `Failed to write skill "${name}". Bad name?`;
      return `Wrote ~/.claude/skills/${name}/SKILL.md`;
    },
  },
  {
    name: "skill_write_runner",
    namespace: "yo",
    description: "Write or replace a skill's SKILL.js (the deterministic runner). The code uses module.exports = { schedule?, init?, async start(ctx) {...}, exit? }. ctx surface: ctx.claude(prompt, {system,model}) → string, ctx.tools.call('server.tool', args) → string, ctx.step, ctx.evaluate, ctx.ask, ctx.progress, ctx.state, ctx.exit(value), ctx.log, ctx.config (frontmatter), ctx.file, ctx.library.{read,write}.",
    input_schema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Skill folder name (must already exist)" },
        code: { type: "string", description: "Full JS content for SKILL.js" },
      },
      required: ["name", "code"],
    },
    async run(input) {
      const name = input.name as string;
      const code = input.code as string;
      if (!deps.skillEngine) return "Skill engine not available.";
      if (!deps.skillEngine.getSkill(name)) return `Skill "${name}" doesn't exist — call skill_create first.`;
      const ok = deps.skillEngine.writeSkillFile(name, "SKILL.js", code);
      return ok ? `Wrote ~/.claude/skills/${name}/SKILL.js (${code.length} chars)` : "Failed to write SKILL.js";
    },
  },
  {
    name: "skill_delete",
    namespace: "yo",
    description: "Delete a skill folder under ~/.claude/skills/. Destructive — confirm with the user before calling.",
    destructive: true,
    input_schema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Skill folder name" },
      },
      required: ["name"],
    },
    async run(input) {
      const name = input.name as string;
      if (!deps.skillEngine) return "Skill engine not available.";
      const ok = deps.skillEngine.deleteSkill(name);
      return ok ? `Deleted skill "${name}".` : `Skill "${name}" not found or could not be removed.`;
    },
  },
  {
    name: "skill_run",
    namespace: "yo",
    description: "Execute a skill end-to-end (runner if SKILL.js exists, prompt-mode otherwise) and return the structured run output. Use after authoring/editing to verify it works before iterating.",
    input_schema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Skill name" },
        input: { description: "Optional input passed to the skill" },
      },
      required: ["name"],
    },
    async run(input) {
      const name = input.name as string;
      if (!deps.skillEngine?.runSkill) return "Skill engine runSkill not available.";
      try {
        const out = await deps.skillEngine.runSkill(name, input.input ?? null, { trigger: "manual" });
        return `Skill "${name}" ran. Output:\n${typeof out === "string" ? out : JSON.stringify(out, null, 2)}`;
      } catch (err) {
        return `Skill "${name}" errored: ${err instanceof Error ? err.message : String(err)}`;
      }
    },
  },
  {
    name: "skill_run_history",
    namespace: "yo",
    description: "Read the last 10 runs of a skill — duration, output, error, logs, event tree. Use to debug failures and iterate on a skill.",
    input_schema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Skill name" },
      },
      required: ["name"],
    },
    async run(input) {
      const name = input.name as string;
      if (!deps.skillEngine?.getRunHistory) return "Run history not available.";
      const runs = deps.skillEngine.getRunHistory(name);
      if (runs.length === 0) return `No runs recorded for "${name}".`;
      return runs.map((r, i) => {
        const when = new Date(r.startedAt).toLocaleString();
        const status = r.error ? `ERROR: ${r.error}` : "ok";
        const events = r.events.length > 0 ? `\n  events: ${r.events.map(e => `${e.type}/${e.label}/${e.status}`).slice(0, 8).join(", ")}` : "";
        const logs = r.logs.length > 0 ? `\n  logs: ${r.logs.slice(0, 5).join(" | ")}` : "";
        const out = r.output !== undefined ? `\n  output: ${typeof r.output === "string" ? r.output.slice(0, 200) : JSON.stringify(r.output).slice(0, 200)}` : "";
        return `[${i + 1}] ${when} (${r.durationMs ?? "?"}ms, ${r.trigger}) — ${status}${events}${logs}${out}`;
      }).join("\n\n");
    },
  },

  {
    name: "save_memory",
    namespace: "yo",
    description: "Save something to persistent memory. Use for preferences, facts about the user's work.",
    input_schema: {
      type: "object",
      properties: {
        content: { type: "string", description: "What to remember" },
        category: { type: "string", enum: ["preference", "fact", "workflow", "app_pattern", "context"] },
      },
      required: ["content", "category"],
    },
    async run(input) {
      const content = input.content as string;
      const category = (input.category as string) || "context";
      if (!content) return "No content provided.";
      if (!deps.memoryStore) return "Memory not available.";
      const id = await deps.memoryStore.save(content, category);
      return `Memory saved (${id}).`;
    },
  },
  {
    name: "create_skill",
    namespace: "yo",
    description: "Create or overwrite a skill. Provide the full SKILL.md prompt body and manifest fields. Call with just 'name' to get the current skill template.",
    input_schema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Skill name (lowercase, hyphens ok)" },
        description: { type: "string", description: "One-line description of what the skill does" },
        prompt: { type: "string", description: "The skill prompt (instructions for the LLM when this skill runs)" },
        allowed_tools: { type: "array", items: { type: "string" }, description: "Tools this skill can use, e.g. ['gmail.send_email', 'yo.search_captures']" },
        requires: { type: "array", items: { type: "string" }, description: "Other skills this skill can call" },
        schedule: { type: "string", description: "Cron expression for auto-scheduling, e.g. '0 9 * * 1-5' for weekdays at 9am" },
        inputs: { type: "array", items: { type: "object", properties: { name: { type: "string" }, type: { type: "string" }, description: { type: "string" } } }, description: "Input parameters the skill accepts" },
        runner_code: { type: "string", description: "Optional SKILL.js lifecycle runner code (advanced)" },
      },
      required: ["name", "description", "prompt"],
    },
    async run(input) {
      if (!deps.skillEngine) return "Skill engine not available.";
      const name = input.name as string;
      if (!name) return "Skill name is required.";
      const manifest: Record<string, unknown> = {
        name,
        description: input.description as string || "",
      };
      if (input.allowed_tools) manifest["allowed-tools"] = input.allowed_tools;
      if (input.requires) manifest.requires = input.requires;
      if (input.schedule) manifest.schedule = input.schedule;
      if (input.inputs) manifest.inputs = input.inputs;
      const prompt = input.prompt as string || "";
      const ok = deps.skillEngine.writeSkill(name, manifest, prompt);
      if (!ok) return `Failed to create skill "${name}".`;
      return `Skill "${name}" created. The user can run it with .yo format <content> ${name}, or you can call skill_${name.replace(/[^a-zA-Z0-9_]/g, "_")} to test it.`;
    },
  },
  {
    name: "update_skill",
    namespace: "yo",
    description: "Update an existing skill's prompt, manifest fields, or runner code. Only provided fields are changed.",
    input_schema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Skill name to update" },
        description: { type: "string", description: "Updated description" },
        prompt: { type: "string", description: "Updated prompt body" },
        allowed_tools: { type: "array", items: { type: "string" }, description: "Updated allowed tools list" },
        requires: { type: "array", items: { type: "string" }, description: "Updated skill dependencies" },
        schedule: { type: "string", description: "Updated cron schedule (empty string to remove)" },
        inputs: { type: "array", items: { type: "object", properties: { name: { type: "string" }, type: { type: "string" }, description: { type: "string" } } }, description: "Updated input parameters" },
        runner_code: { type: "string", description: "Updated SKILL.js code (null to remove)" },
      },
      required: ["name"],
    },
    async run(input) {
      if (!deps.skillEngine) return "Skill engine not available.";
      const name = input.name as string;
      const existing = deps.skillEngine.getSkill(name);
      if (!existing) return `Skill "${name}" not found. Use create_skill to create it.`;
      const manifest = { ...existing.manifest };
      if (input.description !== undefined) manifest.description = input.description;
      if (input.allowed_tools !== undefined) manifest["allowed-tools"] = input.allowed_tools;
      if (input.requires !== undefined) manifest.requires = input.requires;
      if (input.schedule !== undefined) manifest.schedule = (input.schedule as string) || null;
      if (input.inputs !== undefined) manifest.inputs = input.inputs;
      const prompt = (input.prompt as string) ?? existing.prompt;
      const ok = deps.skillEngine.writeSkill(name, manifest, prompt);
      if (!ok) return `Failed to update skill "${name}".`;
      return `Skill "${name}" updated.`;
    },
  },
  {
    name: "read_skill",
    namespace: "yo",
    description: "Read a skill's full definition — manifest, prompt, runner status, and files.",
    input_schema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Skill name" },
      },
      required: ["name"],
    },
    async run(input) {
      if (!deps.skillEngine) return "Skill engine not available.";
      const name = input.name as string;
      const skill = deps.skillEngine.getSkill(name);
      if (!skill) return `Skill "${name}" not found.`;
      const lines = [
        `Skill: ${name}`,
        `Description: ${(skill.manifest as any).description || "(none)"}`,
      ];
      const m = skill.manifest as Record<string, unknown>;
      if (m["allowed-tools"]) lines.push(`Allowed tools: ${(m["allowed-tools"] as string[]).join(", ")}`);
      if (m.requires) lines.push(`Requires: ${(m.requires as string[]).join(", ")}`);
      if (m.schedule) lines.push(`Schedule: ${m.schedule}`);
      if (m.inputs) lines.push(`Inputs: ${JSON.stringify(m.inputs)}`);
      lines.push("", "--- PROMPT ---", skill.prompt);
      const files = deps.skillEngine.listSkillFiles(name);
      const extraFiles = files.filter(f => f !== "SKILL.md");
      if (extraFiles.length > 0) lines.push("", `Other files: ${extraFiles.join(", ")}`);
      return lines.join("\n");
    },
  },
  {
    name: "create_drip",
    namespace: "yo",
    description: "Create or overwrite a custom drip recipe. A drip is a visual effect overlay. Recipes combine built-in effects with optional count and opacity.",
    input_schema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Drip name (lowercase, no spaces)" },
        recipe: { type: "string", description: "Recipe string, e.g. 'fireworks hearts 2' or '-1 0.5 matrix' for persistent" },
      },
      required: ["name", "recipe"],
    },
    async run(input) {
      if (!deps.dripManager) return "Drip manager not available.";
      const name = (input.name as string).toLowerCase().replace(/\s+/g, "-");
      const recipe = input.recipe as string;
      if (!name || !recipe) return "Name and recipe are required.";
      return deps.dripManager.saveCustom(name, recipe);
    },
  },
  {
    name: "update_drip",
    namespace: "yo",
    description: "Update an existing custom drip recipe.",
    input_schema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Drip name to update" },
        recipe: { type: "string", description: "New recipe string" },
      },
      required: ["name", "recipe"],
    },
    async run(input) {
      if (!deps.dripManager) return "Drip manager not available.";
      const name = (input.name as string).toLowerCase();
      const customs = deps.dripManager.listCustoms();
      if (!customs.find(c => c.name === name)) return `Drip "${name}" not found. Use create_drip to create it.`;
      return deps.dripManager.saveCustom(name, input.recipe as string);
    },
  },
  {
    name: "read_drip",
    namespace: "yo",
    description: "Read drip definitions — a specific custom drip, or list all available effects and custom drips.",
    input_schema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Drip name (omit to list all)" },
      },
    },
    async run(input) {
      if (!deps.dripManager) return "Drip manager not available.";
      const name = input.name as string;
      if (name) {
        const customs = deps.dripManager.listCustoms();
        const found = customs.find(c => c.name === name.toLowerCase());
        if (found) return `Drip: ${found.name}\nRecipe: ${found.recipe}`;
        const builtins = deps.dripManager.listBuiltinEffects();
        if (builtins.includes(name.toLowerCase())) return `"${name}" is a built-in effect (not a custom drip).`;
        return `Drip "${name}" not found.`;
      }
      const builtins = deps.dripManager.listBuiltinEffects();
      const customs = deps.dripManager.listCustoms();
      const lines = [`Built-in effects: ${builtins.join(", ")}`];
      if (customs.length > 0) {
        lines.push("", "Custom drips:");
        for (const c of customs) lines.push(`  ${c.name} → ${c.recipe}`);
      } else {
        lines.push("", "No custom drips yet.");
      }
      lines.push("", "Recipe syntax:", "  [count] [effects...] — one-shot, e.g. 'fireworks hearts 2'", "  -1 [opacity] [effects...] — persistent loop, e.g. '-1 0.5 matrix'", "  Opacity: 0-1 float (default 0.5 for persistent)", "  Count: integer 1-10 (default 1)");
      return lines.join("\n");
    },
  },
  {
    name: "create_layout",
    namespace: "yo",
    description: "Create or overwrite a named panel layout. A layout is a grid arrangement of app panels.",
    input_schema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Layout name" },
        cols: { type: "number", description: "Number of columns (1-4)" },
        rows: { type: "number", description: "Number of rows (1-4)" },
        col_widths: { type: "array", items: { type: "number" }, description: "Column width fractions (must sum to ~1), e.g. [0.5, 0.5]" },
        row_heights: { type: "array", items: { type: "number" }, description: "Row height fractions (must sum to ~1), e.g. [0.6, 0.4]" },
        cells: {
          type: "array",
          items: {
            type: "object",
            properties: {
              panel_id: { type: "string", description: "App panel ID (e.g. 'gmail', 'claude', 'slack')" },
              col: { type: "number", description: "0-based column" },
              row: { type: "number", description: "0-based row" },
              col_span: { type: "number", description: "Width in grid cells (default 1)" },
              row_span: { type: "number", description: "Height in grid cells (default 1)" },
            },
            required: ["panel_id", "col", "row"],
          },
          description: "Panel placements in the grid",
        },
      },
      required: ["name", "cols", "rows", "cells"],
    },
    async run(input) {
      if (!deps.layoutManager) return "Layout manager not available.";
      const name = input.name as string;
      const cols = Math.max(1, Math.min(4, input.cols as number));
      const rows = Math.max(1, Math.min(4, input.rows as number));
      const colWidths = (input.col_widths as number[]) || Array(cols).fill(1 / cols);
      const rowHeights = (input.row_heights as number[]) || Array(rows).fill(1 / rows);
      const rawCells = input.cells as Array<{ panel_id: string; col: number; row: number; col_span?: number; row_span?: number }>;
      if (!rawCells || rawCells.length === 0) return "At least one cell is required.";
      const cells = rawCells.map(c => ({
        panelId: c.panel_id,
        col: c.col,
        row: c.row,
        colSpan: c.col_span || 1,
        rowSpan: c.row_span || 1,
      }));
      const grid = { name, version: 2 as const, cols, rows, colWidths, rowHeights, cells };
      deps.layoutManager.saveLayout(grid);
      return `Layout "${name}" saved (${cols}x${rows} grid, ${cells.length} panels). The user can apply it from the layouts page or with .dip layout ${name}.`;
    },
  },
  {
    name: "update_layout",
    namespace: "yo",
    description: "Update an existing layout's grid, panels, or proportions. Only provided fields are changed.",
    input_schema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Layout name to update" },
        cols: { type: "number", description: "Updated column count" },
        rows: { type: "number", description: "Updated row count" },
        col_widths: { type: "array", items: { type: "number" }, description: "Updated column widths" },
        row_heights: { type: "array", items: { type: "number" }, description: "Updated row heights" },
        cells: {
          type: "array",
          items: {
            type: "object",
            properties: {
              panel_id: { type: "string" },
              col: { type: "number" },
              row: { type: "number" },
              col_span: { type: "number" },
              row_span: { type: "number" },
            },
            required: ["panel_id", "col", "row"],
          },
          description: "Updated panel placements",
        },
      },
      required: ["name"],
    },
    async run(input) {
      if (!deps.layoutManager) return "Layout manager not available.";
      const name = input.name as string;
      const existing = deps.layoutManager.getLayout(name);
      if (!existing) return `Layout "${name}" not found. Use create_layout to create it.`;
      const grid = { ...existing };
      if (input.cols !== undefined) grid.cols = Math.max(1, Math.min(4, input.cols as number));
      if (input.rows !== undefined) grid.rows = Math.max(1, Math.min(4, input.rows as number));
      if (input.col_widths) grid.colWidths = input.col_widths as number[];
      if (input.row_heights) grid.rowHeights = input.row_heights as number[];
      if (input.cells) {
        grid.cells = (input.cells as Array<{ panel_id: string; col: number; row: number; col_span?: number; row_span?: number }>).map(c => ({
          panelId: c.panel_id,
          col: c.col,
          row: c.row,
          colSpan: c.col_span || 1,
          rowSpan: c.row_span || 1,
        }));
      }
      deps.layoutManager.saveLayout(grid);
      return `Layout "${name}" updated.`;
    },
  },
  {
    name: "read_layout",
    namespace: "yo",
    description: "Read a layout's definition, or list all saved layouts.",
    input_schema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Layout name (omit to list all)" },
      },
    },
    async run(input) {
      if (!deps.layoutManager) return "Layout manager not available.";
      const name = input.name as string;
      if (name) {
        const layout = deps.layoutManager.getLayout(name);
        if (!layout) return `Layout "${name}" not found.`;
        const lines = [
          `Layout: ${layout.name}`,
          `Grid: ${layout.cols}x${layout.rows}`,
          `Column widths: ${layout.colWidths.map(w => w.toFixed(2)).join(", ")}`,
          `Row heights: ${layout.rowHeights.map(h => h.toFixed(2)).join(", ")}`,
          "", "Cells:",
        ];
        for (const c of layout.cells) {
          const span = (c.colSpan > 1 || c.rowSpan > 1) ? ` (span ${c.colSpan}x${c.rowSpan})` : "";
          lines.push(`  [${c.col},${c.row}] ${c.panelId}${span}`);
        }
        return lines.join("\n");
      }
      const layouts = deps.layoutManager.listLayouts();
      if (layouts.length === 0) return "No saved layouts.";
      return layouts.map(l => {
        const panels = l.cells.map(c => c.panelId).join(", ");
        return `${l.name} — ${l.cols}x${l.rows} grid — ${panels}`;
      }).join("\n");
    },
  },
  // ── Data store tools ──────────────────────────────────────
  {
    name: "store_set",
    namespace: "yo",
    description: "Store a value in a namespaced key-value store. Values are JSON — store objects, arrays, strings, numbers, etc.",
    input_schema: {
      type: "object",
      properties: {
        namespace: { type: "string", description: "Store namespace (e.g. skill name, or any logical group)" },
        key: { type: "string", description: "Key to store under" },
        value: { description: "JSON value to store (object, array, string, number, boolean)" },
      },
      required: ["namespace", "key", "value"],
    },
    async run(input) {
      if (!deps.dataStore) return "Data store not available.";
      const ns = input.namespace as string;
      const key = input.key as string;
      deps.dataStore.set(ns, key, input.value);
      return `Stored "${key}" in "${ns}".`;
    },
  },
  {
    name: "store_get",
    namespace: "yo",
    description: "Get a value by key from a namespaced store.",
    input_schema: {
      type: "object",
      properties: {
        namespace: { type: "string", description: "Store namespace" },
        key: { type: "string", description: "Key to retrieve" },
      },
      required: ["namespace", "key"],
    },
    async run(input) {
      if (!deps.dataStore) return "Data store not available.";
      const val = deps.dataStore.get(input.namespace as string, input.key as string);
      if (val === null) return `Key "${input.key}" not found in "${input.namespace}".`;
      return JSON.stringify(val, null, 2);
    },
  },
  {
    name: "store_delete",
    namespace: "yo",
    description: "Delete a key from a namespaced store.",
    input_schema: {
      type: "object",
      properties: {
        namespace: { type: "string", description: "Store namespace" },
        key: { type: "string", description: "Key to delete" },
      },
      required: ["namespace", "key"],
    },
    async run(input) {
      if (!deps.dataStore) return "Data store not available.";
      const deleted = deps.dataStore.delete(input.namespace as string, input.key as string);
      return deleted ? `Deleted "${input.key}" from "${input.namespace}".` : `Key "${input.key}" not found.`;
    },
  },
  {
    name: "store_list",
    namespace: "yo",
    description: "List entries in a namespaced store. Optional prefix filter. Returns keys and values.",
    input_schema: {
      type: "object",
      properties: {
        namespace: { type: "string", description: "Store namespace" },
        prefix: { type: "string", description: "Key prefix filter (optional)" },
        limit: { type: "number", description: "Max results (default 100)" },
      },
      required: ["namespace"],
    },
    async run(input) {
      if (!deps.dataStore) return "Data store not available.";
      const ns = input.namespace as string;
      const entries = deps.dataStore.list(ns, input.prefix as string | undefined, (input.limit as number) || 100);
      if (entries.length === 0) return `No entries in "${ns}"${input.prefix ? ` with prefix "${input.prefix}"` : ""}.`;
      return entries.map(e => `${e.key}: ${JSON.stringify(e.value)}`).join("\n");
    },
  },
  {
    name: "store_query",
    namespace: "yo",
    description: "Query a namespaced store by field values inside JSON objects. Filter by one or more fields to find matching entries.",
    input_schema: {
      type: "object",
      properties: {
        namespace: { type: "string", description: "Store namespace" },
        filter: { type: "object", description: "Field-value pairs to match (e.g. {\"status\": \"active\", \"role\": \"admin\"})" },
        limit: { type: "number", description: "Max results (default 100)" },
      },
      required: ["namespace", "filter"],
    },
    async run(input) {
      if (!deps.dataStore) return "Data store not available.";
      const ns = input.namespace as string;
      const filter = input.filter as Record<string, unknown>;
      if (!filter || Object.keys(filter).length === 0) return "Filter must have at least one field.";
      const entries = deps.dataStore.query(ns, filter, (input.limit as number) || 100);
      if (entries.length === 0) return `No entries in "${ns}" matching filter.`;
      return entries.map(e => `${e.key}: ${JSON.stringify(e.value)}`).join("\n");
    },
  },
  {
    name: "store_info",
    namespace: "yo",
    description: "Get info about stores: list all namespaces, or count entries in a specific namespace.",
    input_schema: {
      type: "object",
      properties: {
        namespace: { type: "string", description: "Namespace to count (omit to list all namespaces)" },
      },
    },
    async run(input) {
      if (!deps.dataStore) return "Data store not available.";
      const ns = input.namespace as string;
      if (!ns) {
        const namespaces = deps.dataStore.listNamespaces();
        if (namespaces.length === 0) return "No data stores exist yet. Use store_set to create one.";
        return namespaces.join("\n");
      }
      const count = deps.dataStore.count(ns);
      return `Store "${ns}": ${count} entries.`;
    },
  },
  {
    name: "search_notes",
    namespace: "yo",
    description: "Search saved notes in ~/yo/notes/.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query" },
        limit: { type: "number", description: "Max results (default 10)" },
      },
      required: ["query"],
    },
    async run(input) {
      const query = input.query as string;
      const limit = (input.limit as number) || 10;
      if (!query) return "No query provided.";
      if (!deps.noteStore) return "Note store not available.";
      const results = await deps.noteStore.search(query, limit);
      if (results.length === 0) return "No matching notes found.";
      return results.map((r, i) =>
        `[${i + 1}] ${r.title} (${r.file}) — rank: ${r.rank.toFixed(2)}\n${r.content.slice(0, 600)}`
      ).join("\n\n---\n\n");
    },
  },
  {
    name: "read_file",
    namespace: "yo",
    description: "Read a file under ~/yo/ or ~/.",
    input_schema: {
      type: "object",
      properties: { path: { type: "string", description: "File path (relative to ~/yo/ or absolute)" } },
      required: ["path"],
    },
    async run(input) {
      let filePath = input.path as string;
      if (!filePath) return "No path provided.";
      if (!path.isAbsolute(filePath)) filePath = path.join(os.homedir(), "yo", filePath);
      const resolved = path.resolve(filePath);
      const yoDir = path.join(os.homedir(), "yo");
      if (!resolved.startsWith(yoDir) && !resolved.startsWith(os.homedir())) {
        return "Access denied — can only read files under ~/";
      }
      if (!fs.existsSync(resolved)) return `File not found: ${resolved}`;
      const stat = fs.statSync(resolved);
      if (stat.isDirectory()) return `${resolved} is a directory.`;
      if (stat.size > 500_000) return `File too large (${(stat.size / 1024).toFixed(0)} KB). Max 500 KB.`;
      return fs.readFileSync(resolved, "utf-8");
    },
  },
  {
    name: "list_files",
    namespace: "yo",
    description: "List files in a directory under ~/.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Directory path" },
        pattern: { type: "string", description: "Glob pattern" },
      },
    },
    async run(input) {
      let dirPath = (input.path as string) || path.join(os.homedir(), "yo", "notes");
      const pattern = (input.pattern as string) || "";
      if (!path.isAbsolute(dirPath)) dirPath = path.join(os.homedir(), "yo", dirPath);
      const resolved = path.resolve(dirPath);
      if (!resolved.startsWith(os.homedir())) return "Access denied — can only list files under ~/";
      if (!fs.existsSync(resolved)) return `Directory not found: ${resolved}`;
      if (!fs.statSync(resolved).isDirectory()) return `Not a directory: ${resolved}`;
      let entries = fs.readdirSync(resolved);
      if (pattern) {
        const re = new RegExp("^" + pattern.replace(/\*/g, ".*").replace(/\?/g, ".") + "$");
        entries = entries.filter((e) => re.test(e));
      }
      if (entries.length === 0) return "No files found.";
      const lines = entries.slice(0, 100).map((name) => {
        try {
          const stat = fs.statSync(path.join(resolved, name));
          const size = stat.isDirectory() ? "dir" : `${(stat.size / 1024).toFixed(1)}K`;
          const modified = new Date(stat.mtimeMs).toISOString().slice(0, 16).replace("T", " ");
          return `${name.padEnd(40)} ${size.padStart(8)}  ${modified}`;
        } catch { return name; }
      });
      if (entries.length > 100) lines.push(`... and ${entries.length - 100} more`);
      return lines.join("\n");
    },
  },
  {
    name: "run_command",
    namespace: "yo",
    description: "Run a read-only shell command (allowlist: git, ls, cat, head, tail, wc, find, which, echo, pwd, date).",
    input_schema: {
      type: "object",
      properties: {
        command: { type: "string", description: "Command to run" },
        cwd: { type: "string", description: "Working directory" },
      },
      required: ["command"],
    },
    async run(input) {
      const command = input.command as string;
      if (!command) return "No command provided.";
      const firstWord = command.trim().split(/\s+/)[0];
      const allowed = new Set(["git", "ls", "cat", "head", "tail", "wc", "find", "which", "echo", "pwd", "date"]);
      if (!firstWord || !allowed.has(firstWord)) {
        return `Command not allowed: ${firstWord}. Allowed: ${[...allowed].join(", ")}`;
      }
      if (firstWord === "git") {
        const subCmd = command.trim().split(/\s+/)[1];
        const destructive = new Set(["push", "reset", "clean", "checkout", "rebase", "merge", "commit", "stash", "rm", "mv"]);
        if (subCmd && destructive.has(subCmd)) return `Destructive git command not allowed: git ${subCmd}`;
      }
      // Default to the app-wide working directory so the yo agent's shell
      // commands run where the project lives — falling back to ~ only when
      // no working directory is set.
      const base = getWorkingDirectory() || os.homedir();
      let cwd = (input.cwd as string) || base;
      if (!path.isAbsolute(cwd)) cwd = path.join(base, cwd);
      try {
        const output = execSync(command, {
          cwd, timeout: 30_000, maxBuffer: 512 * 1024,
          encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"],
        });
        return output.slice(0, 10_000) || "(no output)";
      } catch (err: any) {
        return `Command failed: ${err.stderr || err.message || err}`.slice(0, 2000);
      }
    },
  },
  {
    name: "code_search",
    namespace: "yo",
    description:
      "Semantic search over the working-directory codebase. Returns the most " +
      "relevant code chunks (file:line ranges + snippets) for a natural-language " +
      "or keyword query. Prefer this over grep/glob for finding where something " +
      "is implemented — it returns just the relevant spans, not whole files.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "What to find — natural language or keywords" },
        limit: { type: "number", description: "Max results (default 8, max 20)" },
      },
      required: ["query"],
    },
    async run(input) {
      const query = (input.query as string || "").trim();
      if (!query) return "No query provided.";
      const limit = typeof input.limit === "number"
        ? Math.max(1, Math.min(20, Math.floor(input.limit)))
        : 8;
      try {
        const { searchCode } = await import("../code-index/search.js");
        const res = searchCode(query, getWorkingDirectory(), limit);
        if (res.hits.length === 0) return "No matches found.";
        const body = res.hits
          .map((h) => `${h.file}:${h.startLine}-${h.endLine}\n${h.text}`)
          .join("\n\n---\n\n");
        return `${res.hits.length} matches:\n\n${body}`;
      } catch (err) {
        return `code_search error: ${err instanceof Error ? err.message : String(err)}`;
      }
    },
  },
  // ── Panel interaction tools ──────────────────────────────
  {
    name: "list_panels",
    namespace: "yo",
    description: "List all available workspace panels with IDs and URLs.",
    input_schema: { type: "object", properties: {} },
    async run() {
      if (!deps.panels) return "Panel system not available.";
      return deps.panels.list();
    },
  },
  {
    name: "scan_panel",
    namespace: "yo",
    description: "Fast DOM scan of a panel — returns actionable elements (inputs, buttons, links, content areas). Use this FIRST for element discovery before click/type.",
    input_schema: {
      type: "object",
      properties: { panel_id: { type: "string", description: "Panel ID to scan" } },
      required: ["panel_id"],
    },
    async run(input) {
      if (!deps.panels) return "Panel system not available.";
      const scan = await deps.panels.scan(input.panel_id as string);
      if (!scan) return `Could not scan panel: ${input.panel_id}`;
      return scan.length > 4000 ? scan.slice(0, 4000) + "\n[scan truncated]" : scan;
    },
  },
  {
    name: "grab_panel",
    namespace: "yo",
    description: "Grab full visible text content from a panel. EXPENSIVE (~10K tokens). Use scan_panel first for element discovery.",
    input_schema: {
      type: "object",
      properties: { panel_id: { type: "string", description: "Panel ID to grab content from" } },
      required: ["panel_id"],
    },
    async run(input) {
      if (!deps.panels) return "Panel system not available.";
      const content = await deps.panels.grab(input.panel_id as string);
      if (!content) return `Could not grab content from panel: ${input.panel_id}`;
      return content.length > 4000 ? content.slice(0, 4000) + "\n[content truncated]" : content;
    },
  },
  {
    name: "click_element",
    namespace: "yo",
    description: "Click an element in a panel by visible text or CSS selector.",
    input_schema: {
      type: "object",
      properties: {
        panel_id: { type: "string", description: "Panel ID" },
        text: { type: "string", description: "Visible text to click" },
        selector: { type: "string", description: "CSS selector to click" },
      },
      required: ["panel_id"],
    },
    async run(input) {
      if (!deps.panels) return "Panel system not available.";
      const text = input.text as string | undefined;
      const selector = input.selector as string | undefined;
      if (!text && !selector) return "Provide either text or selector to click.";
      return deps.panels.click(input.panel_id as string, text, selector);
    },
  },
  {
    name: "navigate_panel",
    namespace: "yo",
    description: "Navigate an existing panel to a specific URL.",
    input_schema: {
      type: "object",
      properties: {
        panel_id: { type: "string", description: "Panel ID" },
        url: { type: "string", description: "URL to navigate to" },
      },
      required: ["panel_id", "url"],
    },
    async run(input) {
      if (!deps.panels) return "Panel system not available.";
      return deps.panels.navigate(input.panel_id as string, input.url as string);
    },
  },
  {
    name: "type_text",
    namespace: "yo",
    description: "Type text into an input field in a panel. Use submit=true for Enter.",
    input_schema: {
      type: "object",
      properties: {
        panel_id: { type: "string", description: "Panel ID" },
        text: { type: "string", description: "Text to type" },
        label: { type: "string", description: "Input label to target" },
        placeholder: { type: "string", description: "Input placeholder to target" },
        selector: { type: "string", description: "CSS selector of the input" },
        clear: { type: "boolean", description: "Clear existing text first" },
        submit: { type: "boolean", description: "Press Enter after typing" },
      },
      required: ["panel_id", "text"],
    },
    async run(input) {
      if (!deps.panels) return "Panel system not available.";
      return deps.panels.type(input.panel_id as string, input.text as string, {
        label: input.label as string | undefined,
        placeholder: input.placeholder as string | undefined,
        selector: input.selector as string | undefined,
        clear: input.clear as boolean | undefined,
        submit: input.submit as boolean | undefined,
      });
    },
  },
  {
    name: "open_panel",
    namespace: "yo",
    description: "Open a NEW app panel by URL. Only use for apps not already in list_panels.",
    input_schema: {
      type: "object",
      properties: {
        url: { type: "string", description: "URL to open" },
        panel_id: { type: "string", description: "Optional panel ID to assign" },
      },
      required: ["url"],
    },
    async run(input) {
      if (!deps.panels) return "Panel system not available.";
      return deps.panels.open(input.url as string, input.panel_id as string | undefined);
    },
  },
  {
    name: "run_panel_command",
    namespace: "yo",
    description: "Execute a pre-mapped app command (grab, input, submit, new, search, read-latest). Faster than manual click/type.",
    input_schema: {
      type: "object",
      properties: {
        panel_id: { type: "string", description: "Panel ID" },
        command: { type: "string", description: "Command name" },
        value: { type: "string", description: "Optional value for the command" },
      },
      required: ["panel_id", "command"],
    },
    async run(input) {
      if (!deps.panels) return "Panel system not available.";
      return deps.panels.runCommand(input.panel_id as string, input.command as string, input.value as string | undefined);
    },
  },
  {
    name: "refresh_panel",
    namespace: "yo",
    description: "Reload a panel's page.",
    input_schema: {
      type: "object",
      properties: { panel_id: { type: "string", description: "Panel ID (omit for active panel)" } },
    },
    async run(input) {
      if (!deps.panels) return "Panel system not available.";
      return deps.panels.refresh(input.panel_id as string | undefined);
    },
  },
  {
    name: "manage_tabs",
    namespace: "yo",
    description: "Manage workspace tabs: list, switch, close, create new.",
    input_schema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["list", "switch", "close", "new"], description: "Tab action" },
        tab_id: { type: "string", description: "Tab ID (for switch/close)" },
      },
      required: ["action"],
    },
    async run(input) {
      if (!deps.tabs) return "Tab management not available.";
      const action = input.action as string;
      switch (action) {
        case "list": {
          const tabs = deps.tabs.list();
          if (tabs.length === 0) return "No tabs open.";
          return tabs.map((t) => `${t.id} — ${t.title}${t.url ? ` (${t.url})` : ""}`).join("\n");
        }
        case "switch": {
          const id = input.tab_id as string;
          if (!id) return "Provide tab_id to switch to.";
          deps.tabs.switch(id);
          return `Switched to tab: ${id}`;
        }
        case "close": {
          const id = input.tab_id as string;
          if (!id) return "Provide tab_id to close.";
          deps.tabs.close(id);
          return `Closed tab: ${id}`;
        }
        case "new": {
          const id = deps.tabs.create();
          return `Created new tab: ${id}`;
        }
        default: return `Unknown tab action: ${action}`;
      }
    },
  },
  // ── Layout tools ──────────────────────────────────────────
  {
    name: "switch_panel",
    namespace: "yo",
    description: "Switch to a single panel fullscreen.",
    input_schema: {
      type: "object",
      properties: { panel_id: { type: "string", description: "Panel ID to switch to" } },
      required: ["panel_id"],
    },
    async run(input) {
      if (!deps.execCommand) return "Command runner not available.";
      return deps.execCommand(`dip ${input.panel_id}`);
    },
  },
  {
    name: "split_view",
    namespace: "yo",
    description: "Create split view with 2+ panels side by side. Use / for rows.",
    input_schema: {
      type: "object",
      properties: { panels: { type: "string", description: "Panel IDs space-separated, / for row break (e.g. 'gmail slack / claude')" } },
      required: ["panels"],
    },
    async run(input) {
      if (!deps.execCommand) return "Command runner not available.";
      return deps.execCommand(`dip split ${input.panels}`);
    },
  },
  {
    name: "grid_layout",
    namespace: "yo",
    description: "Create grid layout with optional col/row sizes and spans.",
    input_schema: {
      type: "object",
      properties: {
        panels: { type: "string", description: "Panel cells (e.g. 'gmail:2x1 slack claude')" },
        col_widths: { type: "string", description: "Column widths (e.g. '2,1,1')" },
        row_heights: { type: "string", description: "Row heights (e.g. '1,2')" },
      },
      required: ["panels"],
    },
    async run(input) {
      if (!deps.execCommand) return "Command runner not available.";
      let cmd = "dip grid";
      if (input.col_widths) cmd += ` [${input.col_widths}]`;
      if (input.row_heights) cmd += ` [${input.row_heights}]`;
      cmd += ` ${input.panels}`;
      return deps.execCommand(cmd);
    },
  },
  {
    name: "apply_saved_layout",
    namespace: "yo",
    description: "Apply a previously saved layout by name.",
    input_schema: {
      type: "object",
      properties: { name: { type: "string", description: "Layout name" } },
      required: ["name"],
    },
    async run(input) {
      if (!deps.execCommand) return "Command runner not available.";
      return deps.execCommand(`dip ${input.name}`);
    },
  },
  {
    name: "save_current_layout",
    namespace: "yo",
    description: "Save current panel arrangement as a named layout.",
    input_schema: {
      type: "object",
      properties: { name: { type: "string", description: "Layout name to save as" } },
      required: ["name"],
    },
    async run(input) {
      if (!deps.execCommand) return "Command runner not available.";
      return deps.execCommand(`dip save ${input.name}`);
    },
  },
  {
    name: "web_search",
    namespace: "yo",
    description: "Search the web via DuckDuckGo. Returns titles, URLs, and snippets. Use this to find current information, news, documentation, or any web content. Chain with web_read to get full page content from specific results.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query" },
        limit: { type: "number", description: "Max results (default 8, max 20)" },
      },
      required: ["query"],
    },
    async run(input) {
      const query = input.query as string;
      if (!query) return "No query provided.";
      const limit = Math.min((input.limit as number) || 8, 20);
      try {
        const results = await webSearch(query, limit);
        if (results.length === 0) return "No results found.";
        return results.map((r, i) =>
          `[${i + 1}] ${r.title}\n    ${r.url}\n    ${r.snippet}`
        ).join("\n\n");
      } catch (err) {
        return `Search failed: ${err instanceof Error ? err.message : err}`;
      }
    },
  },
  {
    name: "web_read",
    namespace: "yo",
    description: "Fetch a web page and extract its text content. Strips navigation, scripts, and ads — returns the readable body text. Use after web_search to read specific pages, or directly with a known URL.",
    input_schema: {
      type: "object",
      properties: {
        url: { type: "string", description: "Full URL to fetch (https://...)" },
        max_length: { type: "number", description: "Max characters to return (default 8000)" },
      },
      required: ["url"],
    },
    async run(input) {
      const url = input.url as string;
      if (!url) return "No URL provided.";
      if (!url.startsWith("http://") && !url.startsWith("https://")) return "URL must start with http:// or https://";
      const maxChars = Math.min((input.max_length as number) || 8000, 30000);
      try {
        const content = await fetchPage(url, maxChars);
        if (!content.trim()) return "Page returned no readable content.";
        return `Source: ${url}\n\n${content}`;
      } catch (err) {
        return `Fetch failed: ${err instanceof Error ? err.message : err}`;
      }
    },
  },
  // ── Workspace tools (code mode) ─────────────────────────────
  {
    name: "ws_team_status",
    namespace: "yo",
    description: "List all agents in the active workspace with roles and last-post timestamps.",
    input_schema: { type: "object", properties: {} },
    run: async () => {
      if (!deps.workspace) return "Workspace not available. Is MCP running?";
      return deps.workspace.teamStatus();
    },
  },
  {
    name: "ws_read_log",
    namespace: "yo",
    description: "Read workspace event log. Filter by tags, sender, kind, or time range.",
    input_schema: {
      type: "object",
      properties: {
        tags: { type: "array", items: { type: "string" }, description: "Filter by tags" },
        from: { type: "array", items: { type: "string" }, description: "Filter by sender agent names" },
        to: { type: "string", description: "Filter events addressed to this agent" },
        since: { type: "number", description: "Events after this timestamp (ms)" },
        kinds: { type: "array", items: { type: "string" }, description: "Filter by event kind" },
        limit: { type: "number", description: "Max events to return" },
      },
    },
    run: async (input) => {
      if (!deps.workspace) return "Workspace not available. Is MCP running?";
      return deps.workspace.readLog(input);
    },
  },
  {
    name: "ws_post_to",
    namespace: "yo",
    description: "Send a direct message to a specific agent in the workspace.",
    input_schema: {
      type: "object",
      properties: {
        agent: { type: "string", description: "Target agent name" },
        body: { type: "string", description: "Message body" },
        kind: { type: "string", enum: ["post", "status", "question", "answer", "artifact"], description: "Message kind" },
      },
      required: ["agent", "body"],
    },
    destructive: true,
    run: async (input) => {
      if (!deps.workspace) return "Workspace not available. Is MCP running?";
      return deps.workspace.postTo(String(input.agent), String(input.body), input.kind as string | undefined);
    },
  },
  {
    name: "ws_broadcast",
    namespace: "yo",
    description: "Broadcast a message to all agents in the workspace.",
    input_schema: {
      type: "object",
      properties: {
        body: { type: "string", description: "Message body" },
        tags: { type: "array", items: { type: "string" }, description: "Additional tags" },
        kind: { type: "string", enum: ["post", "status", "question", "answer", "artifact"], description: "Message kind" },
      },
      required: ["body"],
    },
    destructive: true,
    run: async (input) => {
      if (!deps.workspace) return "Workspace not available. Is MCP running?";
      const tags = (input.tags as string[] || []).concat(["broadcast"]);
      return deps.workspace.post(String(input.body), tags, input.kind as string | undefined);
    },
  },
  {
    name: "ws_request",
    namespace: "yo",
    description: "Broadcast a message and wait for agent responses. Returns all responses received within the timeout.",
    input_schema: {
      type: "object",
      properties: {
        body: { type: "string", description: "Message body to broadcast" },
        tags: { type: "array", items: { type: "string" }, description: "Additional tags" },
        kind: { type: "string", enum: ["post", "status", "question", "answer", "artifact"], description: "Message kind (default: question)" },
        timeout: { type: "number", description: "Max seconds to wait for responses (default: 30, max: 120)" },
      },
      required: ["body"],
    },
    destructive: true,
    run: async (input) => {
      if (!deps.workspace) return "Workspace not available. Is MCP running?";
      if (!deps.workspace.broadcastAndWait) return "broadcastAndWait not available.";
      const timeoutSec = Math.min(Math.max(Number(input.timeout) || 30, 5), 120);
      const tags = (input.tags as string[] || []).concat(["broadcast"]);
      const kind = (input.kind as string) || "question";
      return deps.workspace.broadcastAndWait(String(input.body), tags, kind, timeoutSec * 1000);
    },
  },
  {
    name: "ws_read_agent",
    namespace: "yo",
    description: "Read another agent's scratchpad or post history.",
    input_schema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Agent name" },
        kind: { type: "string", enum: ["scratchpad", "log"], description: "What to read (default: scratchpad)" },
      },
      required: ["name"],
    },
    run: async (input) => {
      if (!deps.workspace) return "Workspace not available. Is MCP running?";
      return deps.workspace.readAgent(String(input.name), input.kind as string | undefined);
    },
  },

  // ── User agents ───────────────────────────────────────────
  {
    name: "list_agents",
    namespace: "yo",
    description: "List the user's local agents (the library they curate in the Agents screen). "
      + "Returns id, name, optional role, and mode for each. Use this to discover who's available "
      + "before calling call_agent — pick the agent whose role best matches the task.",
    input_schema: { type: "object", properties: {} },
    run: async () => {
      if (!deps.agentRegistry) return "[]";
      const all = deps.agentRegistry.list();
      return JSON.stringify(all.map((a) => ({ id: a.id, name: a.name, role: a.role, mode: a.mode })), null, 2);
    },
  },
  {
    name: "spawn_background",
    namespace: "yo",
    description: "Spawn ONE detached, ad-hoc background agent to handle a task without blocking the user. "
      + "Use this when the work is long-running or independent and the user shouldn't wait, or when you want to "
      + "keep helping with other things while it runs. Unlike the in-turn Task tool (which blocks your current turn "
      + "until it returns), this returns IMMEDIATELY: the agent runs the full agent loop with tools, its activity "
      + "streams into the Sub-Agents panel, and when it finishes its result is handed back to you as a new message "
      + "so you can follow up. Use call_agent instead to delegate to one of the user's SAVED library agents, or "
      + "create_swarm for a multi-agent team. Use the in-turn Task tool only when you need the result to finish the "
      + "very response you're writing right now.",
    input_schema: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "The full task for the background agent, in plain language. It should be self-contained — the agent has no other context." },
        role: { type: "string", description: "Optional short label for the agent (e.g. \"researcher\", \"test-runner\"), shown in the Sub-Agents panel." },
      },
      required: ["prompt"],
    },
    run: async (input) => {
      if (!deps.swarm?.spawnBackground) return "Background agent runner not wired.";
      const prompt = String(input.prompt || "").trim();
      if (!prompt) return "prompt is required.";
      const role = input.role != null ? String(input.role).trim() : undefined;
      return deps.swarm.spawnBackground(prompt, role || undefined);
    },
  },
  {
    name: "call_agent",
    namespace: "yo",
    description: "Delegate a single task to one of the user's local agents (use list_agents to discover ids). "
      + "Runs in the BACKGROUND (detached): returns immediately so you and the user are NOT blocked, the agent's "
      + "activity streams into the Sub-Agents panel, and its result is handed back to you as a new message when it "
      + "finishes. Use this for a saved library agent when the work shouldn't block the user. "
      + "Prefer this over create_swarm when you only need ONE agent — swarms are for multi-agent collaboration. "
      + "For an ad-hoc (non-library) helper, use spawn_background instead.",
    input_schema: {
      type: "object",
      properties: {
        agent_id: { type: "string", description: "Agent id from list_agents" },
        prompt: { type: "string", description: "What this agent should do (full task description in the user's own words)" },
      },
      required: ["agent_id", "prompt"],
    },
    run: async (input) => {
      if (!deps.swarm) return "Agent runner not wired.";
      if (!deps.agentRegistry) return "Agent registry not wired.";
      const agentId = String(input.agent_id || "").trim();
      const prompt = String(input.prompt || "").trim();
      if (!agentId) return "agent_id is required.";
      if (!prompt) return "prompt is required.";
      if (!deps.agentRegistry.get(agentId)) {
        const available = deps.agentRegistry.list().map((a) => a.id).join(", ");
        return `Unknown agent id "${agentId}". Available: ${available || "(none — create one in the Agents tab)"}.`;
      }
      // Reuse the swarm machinery with a roster of one — the agent's activity
      // streams into the same conversation feed.
      return deps.swarm.create(prompt, [agentId], 1);
    },
  },

  // ── Swarm ─────────────────────────────────────────────────
  {
    name: "create_swarm",
    namespace: "yo",
    description: "Spin up a LOCAL swarm of agents to work a goal together. The first "
      + "agent leads — it decomposes the goal and assigns tasks to the rest over the bus; "
      + "the others execute and report back. Pass specific agent ids from the Agents "
      + "library, or a `size` to auto-pick that many. This is the tool for any "
      + "\"create a swarm / spin up N agents to do X / convene a team to debate X\" request. "
      + "Runs in the BACKGROUND (detached): returns immediately so you and the user are NOT blocked. "
      + "The swarm's activity streams inline into this conversation — there is no separate "
      + "swarm panel, so don't tell the user to open or watch one.",
    input_schema: {
      type: "object",
      properties: {
        goal: { type: "string", description: "What the swarm should accomplish" },
        agents: { type: "array", items: { type: "string" }, description: "Agent ids from the library; the first one leads. Omit to auto-pick by size." },
        size: { type: "number", description: "If no agents are given, take this many from the library (default 3)" },
      },
      required: ["goal"],
    },
    run: async (input) => {
      if (!deps.swarm) return "Swarm driver not wired.";
      const goal = String(input.goal || "").trim();
      if (!goal) return "A goal is required.";
      const agents = Array.isArray(input.agents) ? (input.agents as unknown[]).map((a) => String(a)) : undefined;
      const size = typeof input.size === "number" ? input.size : undefined;
      return deps.swarm.create(goal, agents, size);
    },
  },
  {
    name: "list_apps",
    namespace: "yo",
    description: "List the apps the user has configured in yo (id, name, URL). Use this to resolve an app the user names — e.g. \"open council\", \"open gmail\" — to its id before calling open_app.",
    input_schema: { type: "object", properties: {} },
    run: async () => {
      if (!deps.apps) return "App registry not available.";
      const apps = deps.apps.list();
      if (apps.length === 0) return "No apps configured.";
      return apps.map((a) => `- ${a.id}: ${a.name}${a.url ? ` — ${a.url}` : ""}${a.description ? ` (${a.description})` : ""}`).join("\n");
    },
  },
  {
    name: "open_app",
    namespace: "yo",
    description: "Open one of the user's configured apps by its id (from list_apps) as a panel/tab in yo. This is the tool for \"open <app>\" requests — open it directly, don't ask the user for a URL.",
    input_schema: {
      type: "object",
      properties: { app_id: { type: "string", description: "The app id from list_apps (e.g. \"council\", \"gmail\")" } },
      required: ["app_id"],
    },
    run: async (input) => {
      if (!deps.apps) return "App registry not available.";
      const id = String(input.app_id || "").trim();
      if (!id) return "An app_id is required.";
      return deps.apps.open(id);
    },
  },
  {
    name: "create_app",
    namespace: "yo",
    description: "Build a brand-new yo app and register it. The app is a static HTML bundle under ~/yo/apps/<id>/ — single-page apps work great here (vanilla, React via CDN, anything that runs in a browser). The file watcher picks it up automatically and it appears in list_apps + the Apps registry without restart. Use this whenever the user asks you to \"build me an app for X\", \"make a tool for Y\", etc. After creating, you can open it with open_app.",
    input_schema: {
      type: "object",
      properties: {
        id:          { type: "string", description: "Slug (lowercase letters, digits, hyphens). Must be unique." },
        name:        { type: "string", description: "Display name shown in the Apps list." },
        description: { type: "string", description: "One-line description (optional)." },
        html:        { type: "string", description: "Full <!DOCTYPE html> document. Link styles.css and app.js with relative paths if you also provide them." },
        css:         { type: "string", description: "Optional CSS — written to styles.css next to index.html." },
        js:          { type: "string", description: "Optional JS — written to app.js next to index.html." },
      },
      required: ["id", "name", "html"],
    },
    run: async (input) => {
      const id = String(input.id || "").trim().toLowerCase();
      const name = String(input.name || "").trim();
      const html = String(input.html || "");
      const css = input.css == null ? "" : String(input.css);
      const js = input.js == null ? "" : String(input.js);
      const description = input.description ? String(input.description) : undefined;
      if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) return "Invalid app id — use lowercase letters, digits, and hyphens (must start with a letter/digit).";
      if (!name) return "A display name is required.";
      if (!html.trim()) return "An html document is required (full <!DOCTYPE html>).";
      if (deps.apps?.has?.(id)) return `An app with id "${id}" already exists. Pick a different id or call write_app_file to update it.`;
      const appsDir = path.join(os.homedir(), "yo", "apps");
      const dir = path.join(appsDir, id);
      try {
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, "index.html"), html);
        if (css) fs.writeFileSync(path.join(dir, "styles.css"), css);
        if (js) fs.writeFileSync(path.join(dir, "app.js"), js);
      } catch (err) {
        return `Failed to write app files: ${err instanceof Error ? err.message : String(err)}`;
      }
      const url = `file://${path.join(dir, "index.html")}`;
      if (deps.apps?.register) {
        deps.apps.register(id, name, url, description);
      }
      return `Created app "${id}" at ${dir}. It's registered in the Apps list and openable with open_app({app_id:"${id}"}).`;
    },
  },
  {
    name: "write_app_file",
    namespace: "yo",
    description: "Write a file inside an existing app's folder under ~/yo/apps/<id>/. Use this to update index.html / styles.css / app.js after create_app, or to add assets (.json data, .svg, additional .js modules). Pass an existing app id from list_apps.",
    input_schema: {
      type: "object",
      properties: {
        app_id: { type: "string", description: "App id (from list_apps)." },
        file:   { type: "string", description: "Filename or relative path inside the app folder (e.g. \"index.html\", \"styles.css\", \"data/notes.json\"). No leading slash; no \"..\"." },
        content: { type: "string", description: "Full file contents (replaces any existing file)." },
      },
      required: ["app_id", "file", "content"],
    },
    run: async (input) => {
      const id = String(input.app_id || "").trim().toLowerCase();
      const rel = String(input.file || "").trim().replace(/^\/+/, "");
      const content = String(input.content ?? "");
      if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) return "Invalid app_id.";
      if (!rel) return "A file path is required.";
      if (rel.includes("..")) return "Path may not contain \"..\".";
      const dir = path.join(os.homedir(), "yo", "apps", id);
      if (!fs.existsSync(dir)) return `App "${id}" does not exist. Use create_app first.`;
      const dest = path.join(dir, rel);
      try {
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.writeFileSync(dest, content);
      } catch (err) {
        return `Failed to write ${rel}: ${err instanceof Error ? err.message : String(err)}`;
      }
      return `Wrote ${rel} in app "${id}".`;
    },
  },
];

// Map for fast lookup
const BUILTIN_BY_NAME = new Map(BUILTIN_TOOLS.map((t) => [t.name, t]));

// ── Public API ──────────────────────────────────────────────

/**
 * Build the LLM tool spec dynamically: substrate + user skills + MCP.
 * `allowedTools` filters by qualified entries (yo.search_captures, gmail.send_email, etc).
 * Pass undefined/empty to get the full registry (substrate + all user skills).
 */
// The agent loads only these "core" substrate tools up front (its everyday kit).
// Everything else — skill authoring, layout/store/drip management, workspace
// coordination, connected-app tools, and other specialized actions — is
// discovered on demand via find_tools + call_tool, to keep the cached prompt
// small. find_tools/call_tool themselves are always core.
// Minimal always-loaded kit. Everything else — panel arrangement (grab/open/
// navigate/switch/split/grid), code_search, app authoring (create_app/
// write_app_file), and delegation execution (spawn_background/call_agent/
// create_swarm) — is situational and reachable on demand via find_tools +
// call_tool, so it stays OUT of the per-turn prefix. Kept: the discovery pair,
// recall/memory, web, panel SEE+INTERACT primitives, read-only file recon, the
// two hot app verbs, and delegation discovery.
const AGENT_CORE_TOOLS = new Set<string>([
  "find_tools", "call_tool",
  // recall + memory
  "search_captures", "get_context", "search_notes", "save_memory",
  // web
  "web_search", "web_read",
  // panel: see + interact (arrangement tools are discoverable)
  "list_panels", "scan_panel", "click_element", "type_text",
  // light file recon (read-only; full dev tools come via request_dev_tools)
  "read_file", "list_files", "run_command",
  // apps: the two hot verbs (create_app/write_app_file are discoverable)
  "list_apps", "open_app",
  // delegation discovery (spawn/call/swarm are discoverable)
  "list_agents",
]);

export function getAgentToolSpec(allowedTools?: string[], includeMcp = true, coreOnly = false): Array<{ name: string; description: string; input_schema: Record<string, unknown> }> {
  const out: Array<{ name: string; description: string; input_schema: Record<string, unknown> }> = [];
  const allowed = allowedTools && allowedTools.length > 0 ? new Set(allowedTools) : null;

  // Substrate tools. In coreOnly mode (the agent's loaded set) only the core
  // kit is included; the rest are reachable via find_tools/call_tool.
  for (const t of BUILTIN_TOOLS) {
    if (coreOnly && !AGENT_CORE_TOOLS.has(t.name)) continue;
    const qualified = `${t.namespace}.${t.name}`;
    if (allowed && !allowed.has(qualified)) continue;
    out.push({ name: t.name, description: t.description, input_schema: t.input_schema });
  }

  // User skills — tail-only (discovered via find_tools), never preloaded.
  if (deps.skillEngine && !coreOnly) {
    for (const s of deps.skillEngine.listSkillsDetailed()) {
      const qualified = `skill.${s.name}`;
      if (allowed && !allowed.has(qualified)) continue;
      const skill = deps.skillEngine.getSkill(s.name);
      const inputs = (skill?.manifest.inputs ?? []) as Array<{ name: string; type: string; description?: string }>;
      const props: Record<string, unknown> = {};
      const required: string[] = [];
      for (const i of inputs) {
        props[i.name] = { type: i.type === "string" ? "string" : i.type === "number" ? "number" : "string", description: i.description ?? "" };
        required.push(i.name);
      }
      const schema = inputs.length > 0
        ? { type: "object", properties: props, required }
        : { type: "object", properties: { input: { type: "string", description: "Input for the skill" } } };
      out.push({
        name: `skill_${s.name.replace(/[^a-zA-Z0-9_]/g, "_")}`,
        description: `[user skill] ${s.description ?? s.name}`,
        input_schema: schema,
      });
    }
  }

  // Connected-app (MCP) tools. By default the FULL catalog is included, but the
  // agent excludes it (includeMcp=false) — dozens of connector tool schemas in
  // every prompt is the bulk of the cached-token cost. Instead the agent
  // discovers them on demand via mcp_tools_list / mcp_tool_schema and runs them
  // with mcp_tool_call. Other callers (validation, skill authoring) keep the
  // full catalog.
  if (deps.mcpRouter && includeMcp) {
    const mcpTools = deps.mcpRouter.resolveAll();
    for (const t of mcpTools) {
      if (allowed && !allowed.has(t.name)) continue;
      out.push(t);
    }
  }

  // Deduplicate by name — MCP servers can register the same tool twice
  const seen = new Set<string>();
  return out.filter(t => {
    if (seen.has(t.name)) return false;
    seen.add(t.name);
    return true;
  });
}

/**
 * Execute a tool by name. Routes to substrate, user skill, or MCP.
 * Returns the tool's text output.
 *
 * Path-gate: every tool call is checked against the .yo trust boundary
 * (~/.yo/). Calls that resolve to paths outside this boundary are rejected
 * before execution. Cypher-scoped jammers run with a tighter boundary;
 * that's wired separately at the agent-runner layer (v2).
 *
 */
const PATH_GATE_EXEMPT = new Set([
  "search_captures", "search_notes", "store_get", "store_set", "store_list", "store_query",
  // Skill-authoring tools — take a `name` not a path; SkillEngine.sanitizeName
  // already constrains the folder, and skill folders live under ~/.claude/skills
  // (outside the ~/.yo/ trust boundary the gate enforces by default).
  "mcp_tools_list", "mcp_tool_schema", "mcp_tool_call", "skill_list", "skill_get", "skill_create",
  "skill_write_runner", "skill_delete", "skill_run", "skill_run_history",
]);

export async function executeTool(name: string, input: Record<string, unknown>): Promise<string> {
  // Warm the connector catalog (populates the short→qualified map hasTool/callMcp
  // rely on) for any name that isn't a substrate builtin or skill — so call_tool
  // reaches connectors even if find_tools didn't run first this session.
  if (deps.mcpRouter?.resolveAll && !BUILTIN_BY_NAME.has(name) && !name.startsWith("skill_") && !name.startsWith("mcp__")) {
    try { deps.mcpRouter.resolveAll(); } catch { /* best-effort */ }
  }
  // Connector (MCP) tools are routed remotely — their inputs are API args, not
  // local FS paths — so they bypass the path-gate (matches mcp_tool_call's
  // exemption; call_tool routes connectors here too).
  const isConnectorRoute = name.startsWith("mcp__") || !!deps.mcpRouter?.hasTool?.(name);
  // Path-gate: reject anything resolving outside ~/.yo/ unless the tool is
  // explicitly exempt (bus tools, semantic search, connectors) or a skill
  // (skills run in their own sandboxed ctx; gating their input args is both
  // redundant and breaks skills whose declared input keys collide with PATH_KEYS).
  if (!PATH_GATE_EXEMPT.has(name) && !isConnectorRoute && !name.startsWith("skill_")) {
    const { checkToolCall } = await import("./path-gate.js");
    // The solo yo agent may also operate on the app-wide working directory —
    // that's the folder the user pointed it at (project repo).
    const wd = getWorkingDirectory();
    const violation = checkToolCall(input, wd ? { extraRoots: [wd] } : {});
    if (violation) {
      return `Refused: ${violation}.`;
    }
  }

  // 1. Substrate built-in?
  if (BUILTIN_BY_NAME.has(name)) {
    try {
      return await BUILTIN_BY_NAME.get(name)!.run(input);
    } catch (err) {
      return `Tool error (${name}): ${err instanceof Error ? err.message : String(err)}`;
    }
  }
  // 2. User skill via the skill_<name> convention?
  if (name.startsWith("skill_")) {
    const skillName = name.slice(6).replace(/_/g, "-");
    if (!deps.skillEngine) return "Skill engine not available.";
    try {
      const content = "input" in input ? String(input.input) : JSON.stringify(input);
      return await deps.skillEngine.process(content, skillName);
    } catch (err) {
      return `Skill error: ${err instanceof Error ? err.message : String(err)}`;
    }
  }
  // 3. MCP tool (short name or legacy qualified name)?
  if (deps.mcpRouter?.callMcp && (name.startsWith("mcp__") || deps.mcpRouter.hasTool?.(name))) {
    return deps.mcpRouter.callMcp(name, input);
  }
  return `Unknown tool: ${name}`;
}

/** True if a tool is destructive (substrate-flagged or matches keywords). */
const DESTRUCTIVE_VERBS = new Set(["send", "delete", "remove", "publish", "push", "deploy", "destroy"]);
export function isDestructiveTool(name: string): boolean {
  const builtin = BUILTIN_BY_NAME.get(name);
  if (builtin?.destructive) return true;
  // Token-aware heuristic. Connector short-names use underscores
  // ("srv__delete_event", "..__send_email"), and \b treats "_" as a word char,
  // so split on non-letters and test each segment instead of using \b.
  return name.toLowerCase().split(/[^a-z]+/).some((seg) => DESTRUCTIVE_VERBS.has(seg));
}

/** All registered tool names (for debugging / introspection). */
export function listAllTools(): string[] {
  return getAgentToolSpec().map((t) => t.name);
}

/**
 * Just the substrate built-in `yo.*` tools — used by skill-tool-router so
 * skills can declare `allowed-tools: [yo.search_captures]` etc.
 */
export function listBuiltinYoTools(): Array<{ name: string; description: string; input_schema: Record<string, unknown> }> {
  return BUILTIN_TOOLS.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.input_schema,
  }));
}
