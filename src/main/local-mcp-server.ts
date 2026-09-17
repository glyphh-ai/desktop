/**
 * Local MCP server — a 127.0.0.1 HTTP MCP endpoint so an LLM running on the
 * SAME machine (Claude Desktop, Cursor, the `claude` CLI) can drive Glyphh
 * directly, with no cloud round-trip. It's an alternative to the cloud relay:
 * lowest latency, no account/tier requirement, works offline.
 *
 * It exposes the SAME tool surface as the cloud relay by dispatching every
 * call through `dispatchRelayMethod` — the shared handler registry that
 * `relay-handlers.ts` populates. Server-only tools (Pipedream connectors, the
 * capture store) are intentionally absent: those need cloud auth the local
 * server can't provide.
 *
 * Opt-in via the `localMcpEnabled` preference (Settings > MCP > Local server).
 * Bearer-token authed against locally-stored, SHA-256-hashed tokens.
 */

import http from "node:http";
import path from "node:path";
import crypto from "node:crypto";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { getPreference, setPreference } from "./stores/preferences-db.js";
import { dispatchRelayMethod } from "./relay-client.js";
import { listConnectionTools, callConnectionTool } from "./mcp-connections.js";
import { listTaskSpecs, getTaskSpec, saveTaskSpec, runTaskAndWait, listTaskRuns } from "./task-runner.js";
import { listSkills, getSkill, installSkill, writeSkillFile, deleteSkill, setSkillEnabled, retypeBundle, type BundleType } from "./skills-fs.js";
import { listSchedulesView, saveSchedule, deleteSchedule, runSchedule } from "./local-library.js";
import { openSettingsPage } from "./app-resolver.js";
import { WHERE_TO_SEE, hasAppFace, NO_FACE_ERROR, checkBundlePath, checkNoForeignManifest } from "../shared/bundle-shape.js";
import { listCliAgents } from "./cli-agents.js";
import { SEMANTIC_TOOLS } from "./glyphh-agent-semantic.js";
import { refreshConnectorCatalog, getConnectorCatalog, getCatalogAge, callConnectorTool } from "./connector-tools-client.js";

const DEFAULT_PORT = 7860;
const TOKEN_TTL_DAYS = 90;
const SERVER_NAME = "glyphh-local";
const SERVER_VERSION = "1.0.0";

// ── Token storage (hashed at rest in preferences) ──────────────────

interface StoredToken {
  id: string;
  label: string;
  hash: string; // sha256(rawToken)
  createdAt: string;
  expiresAt: string;
}

export interface LocalMcpTokenInfo {
  id: string;
  label: string;
  createdAt: string;
  expiresAt: string;
}

function sha256(s: string): string {
  return crypto.createHash("sha256").update(s).digest("hex");
}

function loadTokens(): StoredToken[] {
  const raw = getPreference<StoredToken[]>("localMcpTokens", []);
  return Array.isArray(raw) ? raw : [];
}

function saveTokens(tokens: StoredToken[]): void {
  setPreference("localMcpTokens", tokens);
}

/** Generate a token. The raw value is returned ONCE — only its hash is stored. */
export function localMcpGenToken(label: string = "default", ttlDays: number = TOKEN_TTL_DAYS): LocalMcpTokenInfo & { token: string } {
  const raw = `glyphh_${crypto.randomBytes(24).toString("hex")}`;
  const now = new Date();
  const expires = ttlDays > 0
    ? new Date(now.getTime() + ttlDays * 24 * 60 * 60 * 1000)
    : new Date("9999-12-31T00:00:00.000Z");
  const rec: StoredToken = {
    id: crypto.randomBytes(8).toString("hex"),
    label: label.trim() || "default",
    hash: sha256(raw),
    createdAt: now.toISOString(),
    expiresAt: expires.toISOString(),
  };
  const tokens = loadTokens();
  tokens.push(rec);
  saveTokens(tokens);
  return { id: rec.id, label: rec.label, createdAt: rec.createdAt, expiresAt: rec.expiresAt, token: raw };
}

export function localMcpListTokens(): LocalMcpTokenInfo[] {
  return loadTokens().map((t) => ({ id: t.id, label: t.label, createdAt: t.createdAt, expiresAt: t.expiresAt }));
}

export function localMcpRevokeToken(id: string): void {
  saveTokens(loadTokens().filter((t) => t.id !== id));
}

function isValidBearer(raw: string | undefined): boolean {
  if (!raw) return false;
  const hash = sha256(raw);
  const now = Date.now();
  return loadTokens().some((t) => t.hash === hash && new Date(t.expiresAt).getTime() > now);
}

// ── MCP tool surface (mirrors the cloud relay's WS-routed tools) ───

function buildMcpServer(): McpServer {
  const mcp = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });

  const via = async (method: string, params: unknown) => {
    try {
      const result = await dispatchRelayMethod(method, params);
      return { content: [{ type: "text" as const, text: typeof result === "string" ? result : JSON.stringify(result, null, 2) }] };
    } catch (err) {
      return { content: [{ type: "text" as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }] };
    }
  };

  // ── Tasks + skills — Glyphh's OWN primitives, author-grade (the write
  //    path agents lacked: a pipeline built here lands in Glyphh's registry,
  //    schedulable and visible in the UI, not beside it) ─────────────────
  const text = (v: unknown) => ({ content: [{ type: "text" as const, text: typeof v === "string" ? v : JSON.stringify(v) }] });
  // ── SKILLS ARE FOLDERS (2026-09-17) ────────────────────────────────────
  // An agent that saved a skill used to write a JSON row into a store nothing
  // renders any more, so the skill it just made was nowhere in the app (his
  // report). These write and read the SAME folders the Skills page lists.
  const skillId = (slug: string): string => `glyphh:${String(slug).trim()}`;
  const skillSlug = (name: string): string =>
    name.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64);

  /** ONE ID PER SHAPE: the homes differ, so a slug alone is ambiguous. */
  const idFor = (slug: string, type: BundleType): string =>
    `${type === "app" ? "app" : type === "task" ? "task" : type === "plugin" ? "plugin" : "glyphh"}:${String(slug).trim()}`;

  /** Find a bundle by slug across every home, whatever its type. */
  function findBundle(slug: string): { id: string; type: BundleType } | null {
    const want = String(slug).trim().toLowerCase();
    for (const sk of listSkills(["skill", "app", "task", "plugin"])) {
      if (sk.id.slice(sk.id.indexOf(":") + 1).toLowerCase() === want) return { id: sk.id, type: sk.type };
    }
    return null;
  }

  /** WHAT WAS ACTUALLY MADE (his report, 2026-09-17): an agent said "installed
   *  successfully" about an app the user could find on no page. Every write
   *  answers with the shape, the folder and where to look. */
  const WHERE = WHERE_TO_SEE;
  function describeBundle(id: string, note?: string): Record<string, unknown> {
    const sk = getSkill(id);
    return {
      slug: id.slice(id.indexOf(":") + 1), type: sk.type, name: sk.name, description: sk.description,
      folder: sk.dir, enabled: sk.enabled, files: sk.files.map((f) => f.path),
      where: WHERE[sk.type], mirroredToEveryCli: sk.enabled,
      ...(note ? { note } : {}),
    };
  }

  const MAX_BUNDLE_FILE = 512 * 1024;
  function checkFiles(files: Record<string, string> | undefined): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [rel, body] of Object.entries(files ?? {})) {
      const clean = checkBundlePath(rel);
      if (typeof body !== "string") throw new Error(`file "${clean}" must be text`);
      if (Buffer.byteLength(body) > MAX_BUNDLE_FILE) throw new Error(`file "${clean}" is larger than 512 KB`);
      out[clean] = body;
    }
    return out;
  }

  /** THE ONE AUTHORING DOOR (his order, 2026-09-17). Type is required, so no
   *  agent can drift from the shape the user asked for, and each shape carries
   *  what it actually needs — a skill can ship files now, which is why an
   *  agent needing code no longer has to reach for an app bundle. */
  function saveBundle(input: {
    type: BundleType; slug?: string; name: string; description?: string; prompt?: string;
    files?: Record<string, string>; program?: string;
    slots?: Array<{ name?: string; label?: string; description?: string; agent?: string | null; model?: string }>;
  }): Record<string, unknown> {
    const name = String(input.name ?? "").trim();
    if (!name) throw new Error("a bundle needs a name");
    const type = input.type;
    if (type === "plugin") {
      throw new Error("a plugin is Claude Code's own format — import one with skill_import in the app, or build a skill (type \"skill\"), an app (type \"app\") or a task (type \"task\")");
    }
    const slug = (input.slug ? String(input.slug) : skillSlug(name)) || "skill";
    const extra = checkFiles(input.files);
    checkNoForeignManifest(type, Object.keys(extra));

    // A TASK IS A PROGRAM: the task lane owns task.json, run.js and the slots.
    if (type === "task") {
      saveTaskSpec({ slug, name, description: input.description, program: input.program, slots: input.slots });
      const id = idFor(slug, "task");
      if (input.prompt) {
        const sk = getSkill(id);
        writeSkillFile(id, "SKILL.md", `---\nname: ${slug}\ndescription: ${(input.description ?? sk.description ?? name).replace(/\r?\n/g, " ").trim()}\ntype: task\n---\n\n${String(input.prompt).trim()}\n`);
      }
      for (const [rel, body] of Object.entries(extra)) writeSkillFile(id, rel, body);
      return describeBundle(id, input.program ? undefined : "no program was given, so run.js is whatever it already was");
    }

    // AN APP HAS A FACE. Without one it is a task (headless, on a clock) or a
    // skill (instructions) — name the alternatives rather than accept a lie.
    const existingApp = (() => { try { return getSkill(idFor(slug, "app")); } catch { return null; } })();
    if (type === "app" && !hasAppFace(Object.keys(extra)) && !existingApp) throw new Error(NO_FACE_ERROR);

    const id = idFor(slug, type);
    let existing: ReturnType<typeof getSkill> | null = null;
    try { existing = getSkill(id); } catch { existing = null; }
    const description = String(input.description ?? existing?.description ?? "").replace(/\r?\n/g, " ").trim();
    const body = String(input.prompt ?? existing?.body ?? "").trim();
    const md = `---\nname: ${slug}\ndescription: ${description || name}\n${type === "app" ? "type: app\n" : ""}---\n\n${body || `# ${name}\n`}\n`;
    const files: Record<string, string> = { "SKILL.md": md, ...extra };
    if (type === "app" && !existing && !files["app.json"]) {
      files["app.json"] = JSON.stringify({
        name: slug, ui: Object.keys(extra).find((r) => /\.html?$/i.test(r)) || "ui/index.html",
        tools: "tools/manifest.json", dependencies: { connections: [] }, screenshots: [],
      }, null, 2) + "\n";
    }
    if (existing) for (const [rel, text] of Object.entries(files)) writeSkillFile(id, rel, text);
    else installSkill(slug, files, type);
    return describeBundle(id);
  }

  mcp.tool(
    "agents_list",
    "The user's CLI-agent roster — the ONLY valid values for a task slot's agent binding and for task_run's agent override. Returns [{ id, name, cli, model, cwd }].",
    {},
    async () => text(listCliAgents().map((a) => ({ id: a.id, name: a.name, cli: a.cli, model: a.model ?? null, cwd: a.cwd ?? null }))),
  );
  mcp.tool(
    "tasks_list",
    "List the user's Glyphh TASKS. A task is a BUNDLE the desktop runs itself: a program (run.js) plus the slots it calls agents through, the connections it uses and an optional cron. Returns [{ slug, name, description, program, icon, slots, connections, schedule, enabled }].",
    {},
    async () => text(listTaskSpecs()),
  );
  mcp.tool(
    "task_get",
    "Read one Glyphh task in full — its program (the spec) and its slots.",
    { slug: z.string().describe("Task slug from tasks_list") },
    async ({ slug }) => {
      try { return text(getTaskSpec(slug)); }
      catch (err) { return text(`Error: ${err instanceof Error ? err.message : String(err)}`); }
    },
  );
  mcp.tool(
    "task_run",
    "Run a Glyphh task NOW and wait for it. Returns { status, runId, result, error }; the run's own story is in task_runs.",
    {
      slug: z.string().describe("Task slug from tasks_list"),
      agent: z.string().optional().describe("CLI-agent id override for this run"),
    },
    async ({ slug, agent }) => {
      try { void agent; const r = await runTaskAndWait(slug, {}); return text({ status: r.status, runId: r.id, result: r.result, error: r.error }); }
      catch (err) { return text(`Error: ${err instanceof Error ? err.message : String(err)}`); }
    },
  );
  mcp.tool(
    "task_runs",
    "A Glyphh task's recent scheduled runs (newest first): { id, startedAt, durationMs, status, error, output }.",
    { slug: z.string().describe("Task slug") },
    async ({ slug }) => text(listTaskRuns(slug).map((r) => ({ id: r.id, startedAt: r.startedAt, durationMs: r.durationMs, status: r.status, error: r.error, result: r.result, events: r.journal.events.length }))),
  );
  // ── SCHEDULES — anything on a clock (2026-09-17). A task's program runs
  //    itself; a skill's instructions go through an agent. Same rows the
  //    Settings → Customize → Schedules page shows.
  mcp.tool(
    "schedules_list",
    "Everything the user has on a clock: { id, name, kind (task|skill), target, cron, enabled, agentName, lastRunAt, lastStatus }.",
    {},
    async () => text(listSchedulesView()),
  );
  mcp.tool(
    "schedule_save",
    "Put a task or a skill on a clock, or change one already there. A TASK runs its own program; a SKILL's instructions run through an agent, so it needs one. Cron is five fields in the machine's local time (0 8 * * 1-5 = weekdays at 8am).",
    {
      id: z.string().optional().describe("Existing schedule id to change; omit to create"),
      kind: z.enum(["task", "skill"]).describe("What runs: a task bundle, or a skill"),
      target: z.string().describe("The task or skill slug"),
      name: z.string().optional().describe("What to call it; defaults to the target"),
      cron: z.string().describe("Five-field cron, e.g. 0 8 * * 1-5"),
      agentId: z.string().optional().describe("For a skill: the agent whose loop runs it (agents_list)"),
      enabled: z.boolean().optional().describe("Armed? Default true"),
      args: z.record(z.string(), z.unknown()).optional().describe("Input handed to a task's program"),
    },
    async (input) => {
      try { return text(saveSchedule(input)); }
      catch (err) { return text(`Error: ${err instanceof Error ? err.message : String(err)}`); }
    },
  );
  mcp.tool(
    "schedule_delete",
    "Take something off the clock. Its run history stays.",
    { id: z.string().describe("Schedule id from schedules_list") },
    async ({ id }) => {
      try { return text(deleteSchedule(id)); }
      catch (err) { return text(`Error: ${err instanceof Error ? err.message : String(err)}`); }
    },
  );
  mcp.tool(
    "schedule_run",
    "Fire a schedule NOW, outside its clock, to prove it works.",
    { id: z.string().describe("Schedule id from schedules_list") },
    async ({ id }) => {
      try { await runSchedule(id); return text({ id, ran: true }); }
      catch (err) { return text(`Error: ${err instanceof Error ? err.message : String(err)}`); }
    },
  );
  mcp.tool(
    "settings_open",
    "Open the user's Settings on one of its pages so they can see or change something themselves: skills, connections, plugins, tasks, schedules, tabs, workspaces, drips, models, members, billing, general, appearance, mcp.",
    { page: z.string().describe("Which page: skills | connections | plugins | tasks | schedules | tabs | layouts | drips | general | appearance | mcp | models | members | billing") },
    async ({ page }) => {
      try { openSettingsPage(page); return text({ page, opened: true }); }
      catch (err) { return text(`Error: ${err instanceof Error ? err.message : String(err)}`); }
    },
  );

  mcp.tool(
    "skills_list",
    "List the user's Glyphh SKILLS — folders in the Agent Skills standard, the same ones Settings → Build → Skills shows. Returns summaries; read one with skill_get.",
    {},
    async () => text(listSkills("skill").map((sk) => ({ slug: sk.id.slice(sk.id.indexOf(":") + 1), name: sk.name, description: sk.description, source: sk.source, enabled: sk.enabled, updatedAt: sk.updatedAt }))),
  );
  mcp.tool(
    "skill_get",
    "Read a Glyphh skill in full — its SKILL.md frontmatter and the markdown instructions (prompt) under it.",
    { slug: z.string().describe("Skill slug from skills_list") },
    async ({ slug }) => {
      try {
        const sk = getSkill(skillId(slug));
        return text({ slug, name: sk.name, description: sk.description, prompt: sk.body, frontmatter: sk.frontmatter, files: sk.files.map((f) => f.path), enabled: sk.enabled });
      } catch (err) { return text(`Error: ${err instanceof Error ? err.message : String(err)}`); }
    },
  );
  mcp.tool(
    "skill_save",
    "THE ONE DOOR for making anything in the user's library. Everything there is a SKILL and `type` says which kind, so use the user's own word: "
    + '`type:"skill"` = markdown instructions an agent follows, and it may ship files (scripts, references) — this is the default answer to "make me a skill"; '
    + '`type:"task"` = a PROGRAM the desktop runs itself (pass `program` = run.js exporting async run(ctx, input), `slots` for the agents it calls), for headless or scheduled work; '
    + '`type:"app"` = a work panel with a face (pass `files` including ui/index.html) and its own tools. '
    + "Never build an app because you need code: a skill carries files and a task carries a program. The answer says what was made, its folder, and where the user sees it.",
    {
      type: z.enum(["skill", "app", "task"]).describe('The shape — use the user\'s word: "skill", "task" or "app"'),
      slug: z.string().optional().describe("Existing slug to update; omit to create"),
      name: z.string().describe("Name"),
      description: z.string().optional().describe("One line: when an agent should reach for this"),
      prompt: z.string().optional().describe("SKILL.md body — the instructions (every type has one)"),
      files: z.record(z.string(), z.string()).optional().describe("Extra files by relative path, e.g. { \"scripts/report.js\": \"…\", \"ui/index.html\": \"…\" }"),
      program: z.string().optional().describe('type:"task" only — run.js: module.exports = async function run(ctx, input) { … }'),
      slots: z.array(z.object({
        name: z.string().optional(),
        label: z.string().optional(),
        description: z.string().optional(),
        agent: z.string().nullable().optional().describe("CLI-agent id from agents_list (null = first agent)"),
        model: z.string().optional(),
      })).optional().describe('type:"task" only — the fixed slots the program calls agents through'),
    },
    async (input) => {
      try { return text(saveBundle(input)); }
      catch (err) { return text(`Error: ${err instanceof Error ? err.message : String(err)}`); }
    },
  );
  mcp.tool(
    "skill_retype",
    "Change what KIND of skill something is, keeping its folder and files: app → task, task → skill, and so on. Use it the moment a bundle turns out to be the wrong shape (an app with no face is a task) instead of deleting and rebuilding. Plugins keep Claude Code's format and cannot be converted.",
    {
      slug: z.string().describe("Slug from skills_list / tasks_list"),
      to: z.enum(["skill", "app", "task"]).describe("The shape it should be"),
    },
    async ({ slug, to }) => {
      try {
        const found = findBundle(slug);
        if (!found) return text(`Error: no skill, app or task named "${slug}"`);
        const s2 = retypeBundle(found.id, to);
        return text(describeBundle(s2.id, `was a ${found.type}, now a ${to}`));
      } catch (err) { return text(`Error: ${err instanceof Error ? err.message : String(err)}`); }
    },
  );
  mcp.tool(
    "skill_enable",
    "Turn a skill, app or task ON or OFF without deleting it. Off means it leaves every CLI's skill directory and an app's tab leaves the dock and the wall; the folder and its files stay, and turning it back on restores them. Prefer this over skill_delete whenever the user says stop using it, hide it, or turn it off.",
    {
      slug: z.string().describe("Slug from skills_list / tasks_list"),
      enabled: z.boolean().describe("true = on, false = off"),
    },
    async ({ slug, enabled }) => {
      try {
        const found = findBundle(slug);
        if (!found) return text(`Error: no skill, app or task named "${slug}"`);
        const s2 = setSkillEnabled(found.id, enabled);
        return text(describeBundle(s2.id, enabled ? "on" : "off — the folder is still there"));
      } catch (err) { return text(`Error: ${err instanceof Error ? err.message : String(err)}`); }
    },
  );
  mcp.tool(
    "skill_delete",
    "Delete a skill, app or task FOR GOOD: the folder, its files, an app's tab and its installed payload all go. This cannot be undone, so when the user means stop using it rather than destroy it, call skill_enable with enabled:false instead. Say plainly which one you did.",
    { slug: z.string().describe("Slug from skills_list / tasks_list") },
    async ({ slug }) => {
      try {
        const found = findBundle(slug);
        if (!found) return text(`Error: no skill, app or task named "${slug}"`);
        const was = describeBundle(found.id);
        deleteSkill(found.id);
        return text({ deleted: true, slug, type: found.type, folder: was.folder, note: "gone for good; disable with skill_enable next time if the user only wanted it off" });
      } catch (err) { return text(`Error: ${err instanceof Error ? err.message : String(err)}`); }
    },
  );

  // ── Custom MCP connections — the user's own servers, aggregated ─────
  // ── Connected APPS (Pipedream Connect, server-executed) ──────────────
  // The org/personal connector reach (Gmail, Slack, 3,500 more) — governed
  // and METERED server-side; this lane just carries the call. Distinct from
  // connections_* below, which are the user's own LOCAL custom MCP servers.
  mcp.tool(
    "connector_tools",
    "The user's CONNECTED APPS (Gmail, Slack, Google Drive — 3,500+ via the org's connections) and each app's callable tools with input schemas. Governed server-side: this lists exactly what YOU may call. Invoke with connector_call.",
    {},
    async () => {
      const tools = getCatalogAge() < 5 * 60 * 1000 ? getConnectorCatalog() : await refreshConnectorCatalog();
      return text(tools.map((t) => ({ app: t.slug, tool: t.name, description: t.description, inputSchema: t.inputSchema })));
    },
  );
  mcp.tool(
    "connector_call",
    "Call one connected app's tool (from connector_tools). Executes on the Glyphh server under the org's governance — the account binding, allow-lists, and metering all apply there.",
    {
      app: z.string().describe("The connection slug (connector_tools 'app')"),
      tool: z.string().describe("The tool key to invoke"),
      props: z.record(z.string(), z.unknown()).optional().describe("The tool's arguments per its inputSchema"),
    },
    async ({ app, tool, props }) => {
      try { return text(await callConnectorTool(app, tool, props ?? {})); }
      catch (err) { return text(`Error: ${err instanceof Error ? err.message : String(err)}`); }
    },
  );
  mcp.tool(
    "connections_list_tools",
    "List the tools published by the user's CUSTOM MCP CONNECTIONS (their own servers, dialed locally). Returns [{ connection, name, description, inputSchema }]. Call one with connections_call_tool.",
    {},
    async () => {
      const tools = await listConnectionTools();
      return { content: [{ type: "text" as const, text: JSON.stringify(tools) }] };
    },
  );
  mcp.tool(
    "connections_call_tool",
    "Call a tool on one of the user's custom MCP connections (discover with connections_list_tools).",
    {
      connection: z.string().describe("Connection slug"),
      tool: z.string().describe("Tool name on that connection"),
      args: z.record(z.string(), z.unknown()).optional().describe("Tool arguments"),
    },
    async ({ connection, tool, args }) => {
      try {
        const r = await callConnectionTool(connection, tool, (args as Record<string, unknown>) || {});
        return { content: [{ type: "text" as const, text: typeof r === "string" ? r : JSON.stringify(r) }] };
      } catch (err) {
        return { content: [{ type: "text" as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }] };
      }
    },
  );

  mcp.tool(
    "relay_ping",
    "Smoke-test the local server: pings Glyphh and returns whatever it echoes. Use this to confirm the connection is alive before relying on panel tools.",
    { message: z.string().optional().describe("Optional message to echo back") },
    async ({ message }) => via("relay.ping", { message: message ?? "ping" }),
  );

  // ── Panel management ─────────────────────────────────
  mcp.tool(
    "panels_list",
    "List the user's OPEN app panels (see panels_available for everything that CAN be opened). Returns app (slug — the key every other panel tool takes), name, current url, page title, and which window is focused.",
    {},
    async () => via("panels.list", {}),
  );
  mcp.tool(
    "panels_switch",
    "Focus an open app's window. Use panels_list to see what's open.",
    { app: z.string().describe("App slug to focus") },
    async ({ app }) => via("panels.switch", { app }),
  );
  mcp.tool(
    "panels_close",
    "Close an app's window.",
    { app: z.string().describe("App slug to close") },
    async ({ app }) => via("panels.close", { app }),
  );
  mcp.tool(
    "panels_available",
    "List the user's SAVED APP LIBRARY — everything panels_open can open (slug, name, url, kind). When the user asks about a site or service (mail, calendar, a dashboard…), check here FIRST and open their saved app for it instead of driving the raw browser.",
    {},
    async () => via("panels.available", {}),
  );
  mcp.tool(
    "panels_open",
    "Open an app as a panel. `app` is a slug from panels_available (the user's saved app library — PREFER these over the raw browser when one matches the task), or 'browser' / 'terminal'. Re-opening an already-open app focuses it. Installed Glyphh apps MUST open this way (by slug) — a file:// URL in the browser panel gets no glyphh bridge and the app won't work.",
    { app: z.string().describe("App to open: a saved-app slug from panels_available, or 'browser' / 'terminal'") },
    async ({ app }) => via("panels.open", { app }),
  );
  mcp.tool(
    "layouts_open",
    "Open one of the user's saved layouts (a named grid of apps). mode 'window' (default) opens ONE window with the apps tiled inside it; mode 'screen' tiles the whole screen with one native window per app.",
    {
      name: z.string().describe("Saved layout name"),
      mode: z.enum(["window", "screen"]).optional().describe("'window' = tiled inside one window (default); 'screen' = OS-level tiling, one window per app"),
    },
    async ({ name, mode }) => via("layouts.open", { name, mode }),
  );

  // ── Installed Glyphh apps — discover / invoke / deploy ─
  mcp.tool(
    "app_list_tools",
    "List the MCP tools exposed by the user's installed Glyphh apps. Returns [{ app (slug), name, tools: [{ name, description, inputSchema }] }]. Call this to discover what THIS user's Glyphh can do, then invoke with app_call_tool.",
    {},
    async () => via("apps.listTools", {}),
  );
  mcp.tool(
    "app_call_tool",
    "Invoke a tool exposed by an installed Glyphh app. Pass the app slug + tool name from app_list_tools and an args object matching the tool's inputSchema. Runs headlessly on the user's machine.",
    {
      app: z.string().describe("App slug — from app_list_tools"),
      tool: z.string().describe("Tool name — from app_list_tools"),
      args: z.record(z.string(), z.unknown()).optional().describe("Tool arguments matching the tool's inputSchema"),
    },
    async ({ app, tool, args }) => via("apps.callTool", { app, tool, args: args || {} }),
  );
  mcp.tool(
    "app_install",
    "IMPORT an existing .glyphh bundle (a zip you were handed or built) as an APP on the user's machine, so its tools become available. This is not the way to author something new: use skill_save with the type the user asked for. `intent` must be the literal \"app\", which is your statement that the user asked for a work panel with a face — if they asked for a skill or a task, stop and use skill_save. Re-installing the same slug updates it in place. To show it, call panels_open with its slug; NEVER open its index.html as a file:// URL, because the glyphh bridge only exists when the app opens through its slug.",
    {
      bundleBase64: z.string().describe("The .glyphh bundle (a zip) as a base64 string"),
      intent: z.literal("app").describe('Confirm this is meant to be an APP. A skill or a task goes through skill_save.'),
    },
    async ({ bundleBase64, intent }) => {
      void intent;
      try {
        // The install answers with the app's own name; say where it landed too,
        // so no agent can report success and point at an empty page.
        const installed = await dispatchRelayMethod("apps.install", { bundleBase64 });
        return text({ installed, where: WHERE.app, convert: 'wrong shape? skill_retype { slug, to: "task" | "skill" }' });
      } catch (err) { return text(`Error: ${err instanceof Error ? err.message : String(err)}`); }
    },
  );

  // ── The SEMANTIC STACK — every app's own vector store + knowledge graph
  //    (glyphh-agent-semantic.ts; restored 2026-09-14). The workpanel-app
  //    contract's data plane: loops discover, build, and query an app's
  //    stores through these six; scheduled tasks refresh them.
  const semantic = (name: string, shape: Record<string, z.ZodTypeAny>): void => {
    const def = SEMANTIC_TOOLS.find((t) => t.name === name)!;
    mcp.tool(name, def.doc, shape, async (a: Record<string, unknown>) => {
      try { return text(await def.run(a)); }
      catch (err) { return text(`Error: ${err instanceof Error ? err.message : String(err)}`); }
    });
  };
  const appArg = z.string().describe("Target app slug — the stores travel with the app");
  const collArg = z.string().describe("Vector collection name ([a-zA-Z0-9_-])");
  semantic("semantic_collections", { app: appArg });
  semantic("index_files", {
    app: appArg, collection: collArg,
    paths: z.array(z.string()).describe("Working-folder file paths (max 50, 1MB each)"),
    chunkChars: z.number().optional().describe("Chunk size in chars (200–4000, default 1500)"),
  });
  semantic("index_text", {
    app: appArg, collection: collArg,
    id: z.string().describe("Stable source id for these chunks"),
    text: z.string().describe("Raw text to chunk + embed"),
    chunkChars: z.number().optional(),
  });
  semantic("index_connection", {
    app: appArg, collection: collArg,
    slug: z.string().describe("Connection slug (from the user's connections)"),
    tool: z.string().describe("The connector tool to run"),
    props: z.record(z.string(), z.unknown()).optional().describe("Arguments for the connector tool"),
  });
  semantic("vector_search", {
    app: appArg, collection: collArg,
    query: z.string().describe("Semantic query text"),
    k: z.number().optional().describe("Top-k (1–50, default 8)"),
    filter: z.record(z.string(), z.unknown()).optional().describe("Exact-match metadata filter"),
  });
  semantic("graph_query", {
    app: appArg,
    cypher: z.string().describe("Cypher statement(s) — CREATE NODE TABLE first; Kuzu is schema-full"),
  });

  // ── RPA — drive an open app panel ────────────────────
  mcp.tool(
    "rpa_click",
    "Click inside an open app panel. Pass the panel `app` slug (from panels_list) and EITHER a CSS `selector` (clicked in-page) OR absolute `x`/`y` coordinates (a real input event). Open the panel first with panels_open.",
    { app: z.string(), selector: z.string().optional(), x: z.number().optional(), y: z.number().optional() },
    async (a) => via("rpa.click", a),
  );
  mcp.tool(
    "rpa_type",
    "Type into an element in an open app panel: focuses `selector`, sets its value, fires input/change. Set `submit` to also submit the surrounding form.",
    { app: z.string(), selector: z.string(), text: z.string(), submit: z.boolean().optional() },
    async (a) => via("rpa.type", a),
  );
  mcp.tool(
    "rpa_read",
    "Read text or HTML from an open app panel — a `selector`'s content, or the whole page when omitted. `as` is 'text' (default) or 'html'.",
    { app: z.string(), selector: z.string().optional(), as: z.enum(["text", "html"]).optional() },
    async (a) => via("rpa.read", a),
  );
  mcp.tool(
    "rpa_screenshot",
    "Capture the current frame of an open app panel as a PNG data URL.",
    { app: z.string() },
    async (a) => via("rpa.screenshot", a),
  );
  mcp.tool(
    "rpa_goto",
    "Navigate an open app panel to an http(s) URL.",
    { app: z.string(), url: z.string() },
    async (a) => via("rpa.goto", a),
  );

  // ── Run the user's automations / scrape ──────────────
  mcp.tool(
    "loop_run",
    "Run one of the user's saved loops on their machine and return its output.",
    { slug: z.string().describe("Loop slug"), input: z.record(z.string(), z.unknown()).optional() },
    async ({ slug, input }) => via("loops.run", { slug, input: input || {} }),
  );
  mcp.tool(
    "skill_run",
    "Run one of the user's saved skills on their machine and return its output.",
    { slug: z.string().describe("Skill slug"), input: z.record(z.string(), z.unknown()).optional() },
    async ({ slug, input }) => via("skills.run", { slug, input: input || {} }),
  );
  mcp.tool(
    "agent_run",
    "Fire a standing agent's scheduled task now, on the user's machine.",
    { agentId: z.string(), taskId: z.string() },
    async ({ agentId, taskId }) => via("agents.run", { agentId, taskId }),
  );
  mcp.tool(
    "scrape_page",
    "Load an http(s) URL headlessly on the user's machine and return its title, text, and html. `wait` (ms, ≤15000) delays extraction for JS-rendered pages.",
    { url: z.string(), wait: z.number().optional() },
    async ({ url, wait }) => via("scrape.page", { url, wait }),
  );

  return mcp;
}

// ── HTTP server lifecycle ──────────────────────────────────────────

let server: http.Server | null = null;
let boundPort = DEFAULT_PORT;

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => { data += chunk; });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

function setCors(res: http.ServerResponse): void {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS, DELETE");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, mcp-session-id, mcp-protocol-version");
}

function bearerFrom(req: http.IncomingMessage): string | undefined {
  const h = req.headers["authorization"];
  if (!h || Array.isArray(h)) return undefined;
  const m = /^Bearer\s+(.+)$/i.exec(h);
  return m ? m[1].trim() : undefined;
}

async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  setCors(res);
  const url = new URL(req.url || "/", `http://127.0.0.1:${boundPort}`);

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  // Health check — unauthenticated, so users can curl to confirm it's up.
  if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/mcp")) {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ name: SERVER_NAME, version: SERVER_VERSION, status: "ok" }));
    return;
  }

  if (req.method === "POST" && url.pathname === "/mcp") {
    if (!isValidBearer(bearerFrom(req))) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Invalid or missing bearer token. Generate one in Settings > MCP > Local server." }));
      return;
    }
    let parsed: unknown;
    try {
      const body = await readBody(req);
      parsed = body ? JSON.parse(body) : undefined;
    } catch {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Invalid JSON body" }));
      return;
    }
    // Stateless: a fresh server + transport per request (matches the cloud relay).
    const mcp = buildMcpServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => { transport.close().catch(() => {}); });
    try {
      await mcp.connect(transport);
      await transport.handleRequest(req, res, parsed);
    } catch (err) {
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
      }
    }
    return;
  }

  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "Not found" }));
}

/** Start the local MCP server on 127.0.0.1. Idempotent. */
export function startLocalMcpServer(): Promise<{ ok: boolean; error?: string }> {
  return new Promise((resolve) => {
    if (server) { resolve({ ok: true }); return; }
    const port = Number(getPreference("localMcpPort", DEFAULT_PORT)) || DEFAULT_PORT;
    const srv = http.createServer((req, res) => { void handle(req, res); });
    srv.on("error", (err: NodeJS.ErrnoException) => {
      server = null;
      const msg = err.code === "EADDRINUSE" ? `Port ${port} is already in use — pick another in Settings.` : err.message;
      console.error("[local-mcp] failed to start:", msg);
      resolve({ ok: false, error: msg });
    });
    srv.listen(port, "127.0.0.1", () => {
      server = srv;
      boundPort = port;
      console.log(`[local-mcp] listening on http://127.0.0.1:${port}/mcp`);
      resolve({ ok: true });
    });
  });
}

/** Stop the local MCP server. Idempotent. */
export function stopLocalMcpServer(): void {
  if (!server) return;
  try { server.close(); } catch { /* ignore */ }
  server = null;
  console.log("[local-mcp] stopped");
}

export function localMcpStatus(): { running: boolean; port: number } {
  const port = server ? boundPort : (Number(getPreference("localMcpPort", DEFAULT_PORT)) || DEFAULT_PORT);
  return { running: !!server, port };
}

/**
 * Reconcile the running server with the `localMcpEnabled` preference. Called at
 * boot and whenever the user toggles the setting.
 */
export async function syncLocalMcpServer(): Promise<{ ok: boolean; error?: string }> {
  const enabled = getPreference<boolean>("localMcpEnabled", true) !== false;
  if (enabled && !server) return startLocalMcpServer();
  if (!enabled && server) { stopLocalMcpServer(); return { ok: true }; }
  return { ok: true };
}
