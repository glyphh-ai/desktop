/**
 * Local MCP server — a 127.0.0.1 HTTP MCP endpoint so an LLM running on the
 * SAME machine (Claude Desktop, Cursor, the `claude` CLI) can drive Glyphh
 * directly, with no cloud round-trip. It's an alternative to the cloud relay:
 * lowest latency, no account/tier requirement, works offline.
 *
 * Every panel/RPA/layout call dispatches through `dispatchRelayMethod` — the
 * shared handler registry that `relay-handlers.ts` populates.
 *
 * Opt-in via the `localMcpEnabled` preference (Settings > MCP > Local server).
 * Bearer-token authed against locally-stored, SHA-256-hashed tokens.
 */

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { userScopedPath } from "./app-paths.js";
import crypto from "node:crypto";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { UNATTENDED_MCP_PATH, withoutUnattendedTools } from "./unattended-tools.js";
import { getPreference, setPreference } from "./stores/preferences-db.js";
import { dispatchRelayMethod } from "./relay-client.js";
import { listConnectionTools, callConnectionTool } from "./mcp-connections.js";
import { listTaskSpecs, getTaskSpec, saveTaskSpec, runTaskAndWait, listTaskRuns } from "./task-runner.js";
import { listSkills, getSkill, installSkill, writeSkillFile, deleteSkill, setSkillEnabled, retypeBundle, type BundleType } from "./skills-fs.js";
import { listSchedulesView, saveSchedule, deleteSchedule, runSchedule, runSkillHeadless, scheduleForTask } from "./local-library.js";
import { WHERE_TO_SEE, hasAppFace, NO_FACE_ERROR, checkBundlePath, checkNoForeignManifest, normalizeConnDeps } from "../shared/bundle-shape.js";
import { SEMANTIC_TOOLS } from "./glyphh-agent-semantic.js";

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

/**
 * WHERE A LOOPBACK SECRET LIVES (his order, 2026-09-17: "super durable and
 * can't fail on the user but also secure").
 *
 * These tokens guard http://127.0.0.1 — this machine's own tool surface — and
 * they were kept ONLY in preferences, which are fetched from the server. Until
 * that fetch lands, or if it fails, the map is empty and every token the app
 * itself wrote reads as expired, which is what the agent reported. A local
 * capability must not need the network to authenticate.
 *
 * So the hashes are mirrored beside the config files that already carry the
 * raw tokens, in the user's own directory, 0600. Preferences stay the roaming
 * copy; the file is the one that answers when the server has not. Verification
 * reads BOTH, so it never fails open (a token still has to match a hash we
 * minted) and never fails shut because a fetch is in flight.
 */
const tokenFile = (): string => userScopedPath("mcp-tokens.json");

function readTokenFile(): StoredToken[] {
  try {
    const raw = JSON.parse(fs.readFileSync(tokenFile(), "utf-8")) as StoredToken[];
    return Array.isArray(raw) ? raw : [];
  } catch { return []; }
}

function writeTokenFile(tokens: StoredToken[]): void {
  try {
    fs.mkdirSync(path.dirname(tokenFile()), { recursive: true });
    fs.writeFileSync(tokenFile(), JSON.stringify(tokens, null, 2), { encoding: "utf-8", mode: 0o600 });
  } catch (err) {
    console.warn("[mcp] could not mirror the token store locally:", err instanceof Error ? err.message : err);
  }
}

function loadTokens(): StoredToken[] {
  const fromPrefs = getPreference<StoredToken[]>("localMcpTokens", []);
  const prefs = Array.isArray(fromPrefs) ? fromPrefs : [];
  const local = readTokenFile();
  const byHash = new Map<string, StoredToken>();
  for (const t of [...local, ...prefs]) if (t?.hash) byHash.set(t.hash, t);
  return [...byHash.values()];
}

function saveTokens(tokens: StoredToken[]): void {
  setPreference("localMcpTokens", tokens);
  writeTokenFile(tokens);
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

/** Is a token we handed out earlier still good? A config file keeps its token
 *  forever, so the writer has to ask before reusing one — a token minted under
 *  another account, or lost when the preference store could not be read, stays
 *  in that file and every call fails with "the token has expired" (his report,
 *  2026-09-17). */
export const localMcpTokenValid = (raw: string | undefined): boolean => isValidBearer(raw);

function isValidBearer(raw: string | undefined): boolean {
  if (!raw) return false;
  const hash = sha256(raw);
  const now = Date.now();
  return loadTokens().some((t) => t.hash === hash && new Date(t.expiresAt).getTime() > now);
}

// ── MCP tool surface (mirrors the cloud relay's WS-routed tools) ───

function buildMcpServer(opts: { unattended?: boolean } = {}): McpServer {
  // THE UNATTENDED DOOR (his report, 2026-10-08): the same server with every
  // tool that touches the screen left out (unattended-tools.ts).
  const mcp = opts.unattended ? withoutUnattendedTools(new McpServer({ name: SERVER_NAME, version: SERVER_VERSION })) : new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });

  const via = async (method: string, params: unknown) => {
    try {
      const result = await dispatchRelayMethod(method, params);
      return { content: [{ type: "text" as const, text: typeof result === "string" ? result : JSON.stringify(result, null, 2) }] };
    } catch (err) {
      // Flagged as an error (his report, 2026-09-29): as plain text a failed
      // open drew a ✓ and read to the model as a success.
      return { content: [{ type: "text" as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
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
    for (const sk of listSkills(["skill", "task", "plugin"])) {
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
    files?: Record<string, string>; program?: string; connections?: string[]; schedule?: string;
    slots?: Array<{ name?: string; label?: string; description?: string; agent?: string | null; model?: string; kind?: "glyphh" | "cli"; cli?: string }>;
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
      const spec = saveTaskSpec({ slug, name, description: input.description, program: input.program, slots: input.slots, connections: input.connections, schedule: input.schedule });
      const id = idFor(slug, "task");
      if (input.prompt) {
        const sk = getSkill(id);
        writeSkillFile(id, "SKILL.md", `---\nname: ${slug}\ndescription: ${(input.description ?? sk.description ?? name).replace(/\r?\n/g, " ").trim()}\ntype: task\n---\n\n${String(input.prompt).trim()}\n`);
      }
      for (const [rel, body] of Object.entries(extra)) writeSkillFile(id, rel, body);
      const onClock = scheduleForTask(slug);
      return {
        ...describeBundle(id, input.program ? undefined : "no program was given, so run.js is whatever it already was"),
        connections: spec.connections,
        schedule: onClock ? { id: onClock.id, cron: onClock.cron, enabled: onClock.enabled } : null,
        // A run refuses an account the manifest does not declare, so an empty
        // list beside code that calls ctx.connections is the bug to report.
        ...(spec.connections.length ? {} : { connectionsNote: "this task declares no connections; pass `connections` if its program calls ctx.connections.<app>" }),
      };
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
        tools: "tools/manifest.json", dependencies: { connections: normalizeConnDeps(input.connections) }, screenshots: [],
      }, null, 2) + "\n";
    }
    if (existing) for (const [rel, text] of Object.entries(files)) writeSkillFile(id, rel, text);
    else installSkill(slug, files, type);
    return describeBundle(id);
  }

  // ── AGENTS — the user's own sub-agents (his order, 2026-09-29: "extend the
  //    mcp tools for the app to include generating agents"). The same records
  //    Settings → Build → Agents edits; the Glyphh loop hands work to them with
  //    spawn_agent, and a new one is spawnable from the next turn on. ─────────
  mcp.tool(
    "agents_list",
    "The user's AGENTS — each a name, a line saying when to use it, a standing brief, and a model slot. These are what the Glyphh agent hands work to (spawn_agent), and the ONLY valid values for a task slot's agent binding and task_run's agent override. Returns [{ agent, name, description, model, hasBrief }]; `agent` is the id every other agent tool takes.",
    {},
    async () => via("agents.list", {}),
  );
  mcp.tool(
    "agent_get",
    "One of the user's agents in full, its brief included. Returns { agent, name, description, model, hasBrief, brief }.",
    { agent: z.string().describe("The agent's id, from agents_list") },
    async ({ agent }) => via("agents.get", { agent }),
  );
  mcp.tool(
    "agent_save",
    "MAKE or UPDATE one of the user's agents. Omit `agent` to make a new one (a name already in use is refused — update it instead); pass `agent` to change an existing one (fields you leave out are kept). `description` is WHEN TO USE IT — the main agent reads it to decide what to hand over, so say what the agent is for. `brief` is its standing instruction; OMIT it and Glyphh writes one on the user's default model from the name and description. `model` must be one of the user's models (models_available); omit it to run on the main agent's. Returns { agent, name, description, model, created, generatedBrief, brief }.",
    {
      agent: z.string().optional().describe("The agent to update (its id from agents_list); omit to make a new one"),
      name: z.string().optional().describe("Its name, e.g. \"Researcher\" — required for a new agent"),
      description: z.string().optional().describe("When to use it: what it is for, in a sentence"),
      brief: z.string().optional().describe("Its standing instruction, second person. Omit to have Glyphh write it"),
      model: z.string().optional().describe("Its model slot — one of the user's models; omit for the main agent's"),
    },
    async ({ agent, name, description, brief, model }) => via("agents.save", { agent, name, description, brief, model }),
  );
  mcp.tool(
    "agent_delete",
    "DELETE one of the user's agents (and its scheduled tasks). Only when the user asked for it.",
    { agent: z.string().describe("The agent's id, from agents_list") },
    async ({ agent }) => via("agents.delete", { agent }),
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
  // SKILL_RUN, LOCAL (his order, 2026-10-07: "give apps, agents, skills,
  // plugins — everything — the ability to call the rpa tooling"): the
  // gateway's copy runs a skill in the cloud, where no RPA lives; this one
  // runs it on the Glyphh loop HERE, with this machine's tools.
  mcp.tool(
    "skill_run",
    "Run a Glyphh SKILL now, on this machine, and wait for the answer: its SKILL.md instructions go through the Glyphh agent with this desktop's tools (the RPA tools included). Returns { ok, text, error }.",
    {
      slug: z.string().describe("Skill slug from skills_list"),
      input: z.string().optional().describe("What to run it on — text handed to the skill under its instructions"),
    },
    async ({ slug, input }) => {
      try { return text(await runSkillHeadless(slug, input)); }
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
    "Open the user's Settings on one of its pages so they can see or change something themselves: skills, connections, plugins, tasks, models, members, billing, general, appearance, mcp.",
    { page: z.string().describe("Which page: skills | connections | plugins | tasks | general | appearance | mcp | models | members | billing") },
    async ({ page }) => via("settings.open", { page }),
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
    + '`type:"task"` = a PROGRAM the desktop runs itself (pass `program` = run.js exporting async run(ctx, input), `slots` for the agents it calls; ctx.decide(state, questions) and ctx.route(state, branches, {minConfidence, fallback}) make deterministic Jev decisions through GlyphhRouter), for headless or scheduled work; '
    + '`type:"app"` = a work panel with a face (pass `files` including ui/index.html) and its own tools. '
    + "Never build an app because you need code: a skill carries files and a task carries a program. The answer says what was made, its folder, and where the user sees it.",
    {
      type: z.enum(["skill", "app", "task"]).describe('The shape — use the user\'s word: "skill", "task" or "app"'),
      slug: z.string().optional().describe("Existing slug to update; omit to create"),
      name: z.string().describe("Name"),
      description: z.string().optional().describe("One line: when an agent should reach for this"),
      prompt: z.string().optional().describe("SKILL.md body — the instructions (every type has one)"),
      files: z.record(z.string(), z.string()).optional().describe("Extra files by relative path, e.g. { \"scripts/report.js\": \"…\", \"ui/index.html\": \"…\" }"),
      program: z.string().optional().describe('type:"task" only — run.js: module.exports = async function run(ctx, input) { … }. ctx: agents.<slot>.run, connections.<app>.call, data(repo).exec, decide(state, questions, {model?}), route(state, branches, {instructions?, minConfidence?, fallback?}), checkpoint, log'),
      schedule: z.string().optional().describe('type:"task" only — a five-field cron in the machine\'s local time ("0 8 * * 1-5" is weekdays at 8am). Setting it puts the task on the clock and it shows on Settings → Customize → Schedules; change it there afterwards, not here.'),
      connections: z.array(z.string()).optional().describe('The connected accounts it needs, by app slug (e.g. ["gmail","google_calendar"]). REQUIRED whenever the code calls ctx.connections.<app> or the app declares connector tools: a run refuses any account the manifest does not declare.'),
      slots: z.array(z.object({
        name: z.string().optional(),
        label: z.string().optional(),
        description: z.string().optional(),
        agent: z.string().nullable().optional().describe("An agent slug from agents_list (Glyphh or CLI). null = the default Glyphh agent on the default model with no brief — never silently the first agent."),
        kind: z.enum(["glyphh", "cli"]).optional().describe('The lane: "glyphh" runs the Glyphh loop, "cli" runs a vendor CLI headless (claude, codex, gemini, copilot, cursor). Omit to take it from the agent.'),
        cli: z.string().optional().describe('kind:"cli" only — the CLI id (claude, codex, gemini, copilot, cursor) when no agent names one'),
        model: z.string().optional().describe("The slot's model; it beats the agent's own. Omit for the agent's, then the org default."),
      })).optional().describe('type:"task" only — the fixed slots the program calls agents through as ctx.agents.<slot>.run(prompt, { schema?, model? }). The program also has ctx.rpa: commands(app), run(app, command, value?), sequence(app, name, args?), read(app, selector?) — the mapped commands of the user\'s tabs (rpa_commands).'),
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

  // ── Connections — the user's own MCP servers and Pipedream apps ─────
  mcp.tool(
    "connections_list_tools",
    "List the tools of the user's CONNECTIONS: their own MCP servers and the apps they connected through Pipedream (Gmail, Slack, GitHub…, connection \"pd:<app>\"), dialed locally. Returns [{ connection, label, name, description, inputSchema, mode }]; mode \"ask\" means the user wants to approve each call. Call one with connections_call_tool.",
    {},
    async () => {
      const tools = await listConnectionTools();
      return { content: [{ type: "text" as const, text: JSON.stringify(tools) }] };
    },
  );
  mcp.tool(
    "connections_call_tool",
    "Call a tool on one of the user's connections — an MCP server of their own or a connected Pipedream app (discover with connections_list_tools).",
    {
      connection: z.string().describe("Connection id from connections_list_tools (a server's slug, or pd:<app>)"),
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
    "Diagnostics only: echoes a message back. Never needed before the panel tools, which report their own errors.",
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
    "Open an app as a panel and wait until it is actually showing; an error means nothing opened. `app` is a slug from panels_available (the user's saved app library — PREFER these over the raw browser when one matches the task), or 'browser' / 'terminal'. Pass `url` to open the browser (or a web panel) at an http(s) address in the same call, e.g. a dev server at http://localhost:5173. Re-opening an already-open app focuses it. Installed Glyphh apps MUST open this way (by slug) — a file:// URL in the browser panel gets no glyphh bridge and the app won't work.",
    {
      app: z.string().describe("App to open: a saved-app slug from panels_available, or 'browser' / 'terminal'"),
      url: z.string().optional().describe("Optional http(s) address to show in it once it is open"),
    },
    async ({ app, url }) => via("panels.open", { app, ...(url ? { url } : {}) }),
  );
  mcp.tool(
    "panels_add",
    "SAVE a web page as a tab in the user's app library (Settings → Tabs), so panels_open can open it by slug from now on. Use it when the user asks to add a site, bookmark, dashboard or tool as a tab — it appears on their wall at once. Returns { app, name, url }.",
    {
      name: z.string().describe("Display name for the tab"),
      url: z.string().describe("The http(s) URL the tab opens"),
      slug: z.string().optional().describe("Slug to open it by (defaults to the name, lowercased and hyphenated)"),
    },
    async ({ name, url, slug }) => via("panels.add", { name, url, slug }),
  );
  mcp.tool(
    "panels_remove",
    "REMOVE a saved tab from the user's app library, by its slug from panels_available. Built-in work panels and installed Glyphh apps are not tabs and cannot be removed this way.",
    { app: z.string().describe("Slug of the saved tab to remove") },
    async ({ app }) => via("panels.remove", { app }),
  );
  mcp.tool(
    "models_available",
    "List the models THIS user can actually call, and what each one is registered FOR: `mode` is chat, embedding, image_generation or video_generation. Call this BEFORE trying to generate an image, a video or an embedding — pick a model whose mode matches, then call the gateway `endpoint` this returns (OpenAI-shaped: /v1/chat/completions, /v1/images/generations, /v1/videos/generations) with the desktop's own gateway key. Never go hunting for provider API keys: `lane: \"gateway\"` means Glyphh bills and authenticates it for the user. Returns { endpoint, authenticated, byMode, models: [{ model, provider, mode, lane, contextWindow, maxOutputTokens, pricing }] }.",
    {},
    async () => via("models.available", {}),
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
    "See an open app panel: returns a screenshot of its current frame as an image.",
    { app: z.string() },
    // An IMAGE, not a data URL in text (his audit, 2026-09-29: the base64 text
    // of one screenshot was a 96,667-token call that showed the model nothing).
    async (a) => {
      try {
        const { dataUrl } = await dispatchRelayMethod("rpa.screenshot", a) as { dataUrl: string };
        const m = /^data:(image\/[a-z]+);base64,(.+)$/.exec(dataUrl);
        if (!m) return { content: [{ type: "text" as const, text: "Error: the panel returned no image" }], isError: true };
        return { content: [{ type: "text" as const, text: `Screenshot of ${a.app}` }, { type: "image" as const, data: m[2], mimeType: m[1] }] };
      } catch (err) {
        return { content: [{ type: "text" as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
      }
    },
  );
  mcp.tool(
    "rpa_goto",
    "Navigate an open app panel to an http(s) URL. To show a page in the Browser, use panels_open { app: \"browser\", url } instead: it opens the page as a tab in the Browser the user sees, in one step.",
    { app: z.string(), url: z.string() },
    async (a) => via("rpa.goto", a),
  );

  // ── RPA ON A TAB (his order, 2026-10-07): the mapped commands and the
  // sequences a saved tab carries, which the agent builds out itself. Every
  // mapped command is also its own tool, <tab>_<key>, in the loop's catalog. ──
  const guideArg = z.object({
    pre: z.string().optional().describe("What must be true before it runs"),
    post: z.string().optional().describe("What to expect after it succeeds"),
    verify: z.string().optional().describe("A selector that must exist afterwards, or the run failed"),
    recover: z.string().optional().describe("What to try when it fails"),
    delay: z.number().optional().describe("Milliseconds to wait after acting, before verifying"),
  }).optional().describe("The guide that makes the command reliable");
  mcp.tool(
    "rpa_commands",
    "The RPA commands and sequences mapped on a saved tab (its slug from panels_available), and whether its panel is open. Map more with rpa_pick + rpa_map; run one with rpa_run, or by its own tool name <tab>_<command>.",
    { app: z.string().describe("The tab's slug") },
    async (a) => via("rpa.commands", a),
  );
  mcp.tool(
    "rpa_pick",
    "Ask the user to point at an element on the tab's panel: a picker overlay appears on the panel on their screen (it opens if it is not up), they click the element, and you get its selector, tag, text and whether it is editable or clickable. Use it when you cannot find a selector by rpa_read; then rpa_map it.",
    { app: z.string().describe("The tab's slug") },
    async (a) => via("rpa.pick", a),
  );
  mcp.tool(
    "rpa_map",
    "Map (or remap) an RPA command on a saved tab: a key, what it does, the action (click, type, read, readHtml, goto, custom) and the selector it acts on. `text`/`url` take {{value}} for the caller's value; `custom` runs `script` in the page with VALUE in scope. Give it a guide (verify selector, delay, recover) so it runs reliably without the user.",
    {
      app: z.string().describe("The tab's slug"),
      key: z.string().describe("The command key: lowercase, digits, _ or -"),
      description: z.string().describe("What it does, for whoever runs it"),
      action: z.enum(["click", "type", "read", "readHtml", "goto", "custom"]),
      selector: z.string().optional().describe("The element (click, type, read, readHtml)"),
      text: z.string().optional().describe("type: the text; {{value}} is the caller's value (default)"),
      url: z.string().optional().describe("goto: the address; {{value}} allowed"),
      script: z.string().optional().describe("custom: JavaScript run in the page; VALUE is in scope"),
      waitFor: z.string().optional().describe("A selector to wait for before acting"),
      guide: guideArg,
    },
    async (a) => via("rpa.map", a),
  );
  mcp.tool(
    "rpa_unmap",
    "Remove an RPA command from a saved tab.",
    { app: z.string(), key: z.string() },
    async (a) => via("rpa.unmap", a),
  );
  mcp.tool(
    "rpa_run",
    "Run one mapped RPA command on the tab's panel, the user watching (the panel opens if it is not up). `value` fills {{value}} for type, goto and custom. A read returns the text.",
    { app: z.string(), command: z.string(), value: z.string().optional() },
    async (a) => via("rpa.run", a),
  );
  mcp.tool(
    "rpa_sequence_save",
    "Save (or replace) an RPA sequence on a saved tab: a shortcut of ordered steps over its mapped commands. A step's `value` may carry {{placeholders}}, filled from rpa_sequence_run's args; a read's result is in scope for later steps as {{<command>}}. The sequence becomes its own tool, <tab>_<name>.",
    {
      app: z.string(), name: z.string().describe("lowercase, digits, _ or -"), description: z.string(),
      steps: z.array(z.object({ command: z.string(), value: z.string().optional(), waitFor: z.string().optional() })).min(1),
    },
    async (a) => via("rpa.sequenceSave", a),
  );
  mcp.tool(
    "rpa_sequence_remove",
    "Remove an RPA sequence from a saved tab.",
    { app: z.string(), name: z.string() },
    async (a) => via("rpa.sequenceRemove", a),
  );
  mcp.tool(
    "rpa_sequence_run",
    "Run a saved RPA sequence on the tab's panel, step by step, the user watching. `args` fills the steps' {{placeholders}}. It stops at the first failing step and says which.",
    { app: z.string(), sequence: z.string(), args: z.record(z.string(), z.unknown()).optional() },
    async (a) => via("rpa.sequenceRun", a),
  );

  // ── Scrape (the runners for saved loops/skills/agents left with the scheduler, 2026-09-21) ──
  // ── Memory pages (his order, 2026-09-20): what the curator skill reads and writes ──
  const memText = (v: unknown) => ({ content: [{ type: "text" as const, text: typeof v === "string" ? v : JSON.stringify(v, null, 2) }] });
  mcp.tool(
    "memory_turns",
    "The user's remembered turns on this machine (what they said and what the loop answered), newest first, with the folder and workspace each ran in. Read these to compile memory pages.",
    { limit: z.number().int().min(1).max(500).optional().describe("How many turns (default 100)"), days: z.number().int().min(1).max(365).optional().describe("Only turns from the last N days") },
    async ({ limit, days }) => { const { memoryTurns } = await import("./memory.js"); return memText(memoryTurns({ limit, days })); },
  );
  mcp.tool(
    "memory_pages",
    "The memory pages that exist today: the Profile (section you), topics and areas, each with title, summary and details. Update a page by writing it again with the same title.",
    {},
    async () => { const { memoryPages } = await import("./memory.js"); return memText(memoryPages()); },
  );
  mcp.tool(
    "memory_page_write",
    "Write (or rewrite) one memory page. section: you = the Profile, topic = a recurring subject, area = a project or domain. Keep details to short factual bullets the user actually said; never invent.",
    { section: z.enum(["you", "topic", "area"]), title: z.string().min(1).max(90), summary: z.string().max(140).describe("One line under the title"), details: z.array(z.string()).min(1).max(40) },
    async (input) => { const { writeMemoryPage } = await import("./memory.js"); try { return memText(await writeMemoryPage(input)); } catch (err) { return memText(`Error: ${err instanceof Error ? err.message : String(err)}`); } },
  );
  mcp.tool(
    "memory_page_delete",
    "Delete a memory page by its id (from memory_pages).",
    { id: z.string().min(1) },
    async ({ id }) => { const { deleteMemoryPage } = await import("./memory.js"); return memText(deleteMemoryPage(id)); },
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
  if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/mcp" || url.pathname === UNATTENDED_MCP_PATH)) {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ name: SERVER_NAME, version: SERVER_VERSION, status: "ok" }));
    return;
  }

  if (req.method === "POST" && (url.pathname === "/mcp" || url.pathname === UNATTENDED_MCP_PATH)) {
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
    const mcp = buildMcpServer({ unattended: url.pathname === UNATTENDED_MCP_PATH });
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
