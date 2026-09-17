/**
 * task-runner.ts — Glyphh TASKS: bundles the desktop runs itself.
 *
 * A task is a folder in the tasks home (Settings → Build → Tasks, the same
 * shape as skills, apps and plugins): SKILL.md + task.json naming a program
 * script, the slots agents fill, the connections it uses and an optional
 * cron. The program is the process (his ruling, 2026-09-17): start, end and a
 * result shape are the runner's whole contract; everything between is the
 * program's own code, agents only where it slots them.
 *
 * Each run is one utility process (task-host.ts). Main answers its ctx calls
 * here: agent turns through the slotted agent's headless CLI, connection
 * tools, app data, checkpoints, logs. Every answer is journaled in loop_runs
 * as it lands, so the run has a story and a cursor: a run cut off mid-way
 * resumes on the next boot from the last checkpoint the program chose.
 *
 * Desktop only. The fork stores and distributes bundles through the hub and
 * never executes one.
 */

import fs from "fs";
import path from "path";
import { app, utilityProcess, type UtilityProcess, ipcMain, BrowserWindow } from "electron";
import { getLocalDb } from "./local-db.js";
import { listSkills, TASKS_HOME, installSkill, getSkill } from "./skills-fs.js";
import { listCliAgents, composeHeadless, type CliAgentListed } from "./cli-agents.js";
import { execHeadless, slotAgentContext, slotAgentRoster, setTaskRunner, ensureTaskSchedule } from "./local-library.js";
import { callConnectionTool, listConnRows } from "./mcp-connections.js";
import { normalizeConnDeps, connDepNames, type ConnDep } from "../shared/bundle-shape.js";
import { dbExec } from "./glyphh-app-services.js";
import { preferencesByPrefix } from "./stores/preferences-db.js";
import { mcpCreds } from "./gateway-token.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

export interface TaskSlot { label?: string; description?: string; model?: string | null; agent?: string | null }
export interface TaskManifest {
  name: string;
  icon?: string;
  program: string;
  slots?: Record<string, TaskSlot>;
  schedule?: string | null;
  dependencies?: { connections?: Array<ConnDep | string> };
  input?: unknown;
  result?: unknown;
  timeoutMs?: number;
}
export interface TaskSpec {
  slug: string; name: string; description: string; program: string; icon: string | null;
  slots: Array<{ name: string; label?: string; description?: string; agent: string | null; model?: string }>;
  connections: string[]; schedule: string | null; enabled: boolean; dir: string;
}
export interface RunEvent { t: string; kind: "agent" | "connection" | "data" | "checkpoint" | "log" | "resume"; [k: string]: unknown }
export interface RunJournal { checkpoints: Record<string, unknown>; events: RunEvent[] }
export interface TaskRun {
  id: string; taskSlug: string; scheduleId: string | null; trigger: string; startedAt: string; durationMs: number | null;
  status: string; error: string | null; input: unknown; result: unknown; journal: RunJournal;
}

const MANIFEST = "task.json";
const rid = (): string => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
const now = (): string => new Date().toISOString();

// ── bundles ──────────────────────────────────────────────────────────────────

function readManifest(dir: string): TaskManifest {
  const m = JSON.parse(fs.readFileSync(path.join(dir, MANIFEST), "utf-8")) as TaskManifest;
  if (!m || typeof m !== "object" || !m.program) throw new Error(`${MANIFEST} names no program`);
  return m;
}

function writeManifest(dir: string, m: TaskManifest): void {
  fs.writeFileSync(path.join(dir, MANIFEST), JSON.stringify(m, null, 2) + "\n", "utf-8");
}

function specOf(dir: string, slug: string, enabled: boolean): TaskSpec {
  const m = readManifest(dir);
  let description = "";
  let icon: string | null = null;
  try { description = getSkill(`task:${slug}`).description; } catch { description = ""; }
  if (m.icon) { try { icon = fs.readFileSync(path.join(dir, m.icon), "utf-8"); } catch { icon = null; } }
  return {
    slug, name: m.name || slug, description, program: m.program, icon,
    slots: Object.entries(m.slots ?? {}).map(([name, s]) => ({ name, ...(s.label ? { label: s.label } : {}), ...(s.description ? { description: s.description } : {}), agent: s.agent ?? null, ...(s.model ? { model: s.model } : {}) })),
    connections: connDepNames(m.dependencies?.connections),
    schedule: m.schedule ?? null, enabled, dir,
  };
}

/** Every task bundle, enabled or parked. */
export function listTaskSpecs(): TaskSpec[] {
  migrateLegacyTasks();
  const out: TaskSpec[] = [];
  for (const s of listSkills("task")) {
    try { out.push(specOf(s.dir, s.id.slice("task:".length), s.enabled)); } catch { /* a folder without a program is not a task yet */ }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

export function getTaskSpec(slug: string): TaskSpec {
  const hit = listTaskSpecs().find((t) => t.slug === slug);
  if (!hit) throw new Error(`task "${slug}" not found`);
  return hit;
}

/** The MCP authoring lane: a task written by an agent lands as a bundle. */
export function saveTaskSpec(input: {
  slug?: string; name: string; description?: string; program?: string;
  slots?: Array<{ name?: string; label?: string; description?: string; agent?: string | null; model?: string | null }>;
  connections?: Array<ConnDep | string>; schedule?: string | null;
}): TaskSpec {
  const name = String(input.name ?? "").trim();
  if (!name) throw new Error("a task needs a name");
  const slug = (input.slug ? String(input.slug) : name).toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64);
  const existing = listTaskSpecs().find((t) => t.slug === slug);
  const slots: Record<string, TaskSlot> = {};
  if (Array.isArray(input.slots) && input.slots.length) {
    input.slots.forEach((sl, i) => {
      const n = String(sl.name ?? `slot-${i + 1}`).toLowerCase().replace(/[^a-z0-9_-]+/g, "-");
      slots[n] = { label: String(sl.label ?? sl.name ?? `Slot ${i + 1}`), ...(sl.description ? { description: String(sl.description) } : {}), agent: sl.agent ? String(sl.agent) : null, ...(sl.model ? { model: String(sl.model) } : {}) };
    });
  } else if (existing) {
    for (const s of existing.slots) slots[s.name] = { label: s.label, description: s.description, agent: s.agent, ...(s.model ? { model: s.model } : {}) };
  } else {
    slots.main = { label: "Main", description: "The agent this task runs through.", agent: null };
  }
  // ONE SHAPE ON DISK: the manifest the UI reads and the hub validates is
  // `{ app, as }`, whoever wrote it (an agent hand-editing task.json wrote bare
  // slugs, and the task then refused its own connections — his report).
  const connections = normalizeConnDeps(input.connections ?? existing?.connections ?? []);
  const manifest: TaskManifest = {
    name, program: "run.js", slots, schedule: input.schedule === undefined ? existing?.schedule ?? null : input.schedule,
    dependencies: { connections }, ...(existing ? (() => { try { const m = readManifest(existing.dir); return { ...(m.icon ? { icon: m.icon } : {}), ...(m.input !== undefined ? { input: m.input } : {}), ...(m.result !== undefined ? { result: m.result } : {}) }; } catch { return {}; } })() : {}),
  };
  // A manifest schedule only means something once it is a row on the clock.
  // Arm it when the author sets or changes it, never on every save, so a row
  // the user deleted stays deleted.
  const armWanted = manifest.schedule && (!existing || (existing.schedule ?? null) !== manifest.schedule);
  const description = String(input.description ?? existing?.description ?? "");
  if (existing) {
    writeManifest(existing.dir, manifest);
    pinCommonJs(existing.dir);
    if (input.program !== undefined) fs.writeFileSync(path.join(existing.dir, "run.js"), String(input.program), "utf-8");
    if (input.description !== undefined) {
      const md = path.join(existing.dir, "SKILL.md");
      let text = "";
      try { text = fs.readFileSync(md, "utf-8"); } catch { text = ""; }
      const body = text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "");
      fs.writeFileSync(md, `---\nname: ${slug}\ndescription: ${description.replace(/\n/g, " ")}\n---\n\n${body || `# ${name}\n`}`, "utf-8");
    }
    if (armWanted) ensureTaskSchedule(slug, manifest.schedule ?? null, name);
    return getTaskSpec(slug);
  }
  const program = input.program && /module\.exports|export\s+default|exports\.run/.test(String(input.program))
    ? String(input.program)
    : promptProgram(String(input.program ?? ""), Object.keys(slots)[0] ?? "main");
  installSkill(slug, {
    "SKILL.md": `---\nname: ${slug}\ndescription: ${description.replace(/\n/g, " ") || name}\n---\n\n# ${name}\n\nA Glyphh task: a program the desktop runs on its own.\n`,
    [MANIFEST]: JSON.stringify(manifest, null, 2) + "\n",
    // THE BUNDLE SAYS WHAT ITS PROGRAM IS (his report, 2026-09-17). Node reads
    // the nearest package.json to decide, and a "type": "module" anywhere above
    // the bundle — a home directory will do — turned run.js into an ES module
    // and broke module.exports. This one is nearer than anything else.
    "package.json": JSON.stringify({ type: "commonjs", private: true }, null, 2) + "\n",
    "run.js": program,
  }, "task");
  if (armWanted) ensureTaskSchedule(slug, manifest.schedule ?? null, name);
  return getTaskSpec(slug);
}

/** Pin a bundle's program to CommonJS, whatever package.json sits above it. */
function pinCommonJs(dir: string): void {
  const f = path.join(dir, "package.json");
  if (fs.existsSync(f)) return;
  try { fs.writeFileSync(f, JSON.stringify({ type: "commonjs", private: true }, null, 2) + "\n", "utf-8"); }
  catch (err) { console.warn("[tasks] could not pin the program's module type:", err instanceof Error ? err.message : err); }
}

/** A program that hands one prompt to one slot: the shape every pre-bundle task had. */
function promptProgram(prompt: string, slot: string): string {
  return `// A Glyphh task: the desktop runs this program itself. The slotted agent does the work.\nconst PROMPT = ${JSON.stringify(prompt)};\nmodule.exports = async function run(ctx, input) {\n  const turn = await ctx.checkpoint("turn", () => ctx.agents[${JSON.stringify(slot)}].run(PROMPT));\n  return { output: turn.text };\n};\n`;
}

/** Slot → agent, written into task.json (the install-time fill). */
export function setTaskSlot(slug: string, slot: string, agentId: string | null): TaskSpec {
  const t = getTaskSpec(slug);
  const m = readManifest(t.dir);
  if (!m.slots?.[slot]) throw new Error(`task "${slug}" has no slot "${slot}"`);
  m.slots[slot] = { ...m.slots[slot], agent: agentId || null };
  writeManifest(t.dir, m);
  return getTaskSpec(slug);
}

/** Tasks written before bundles were one JSON row each (name, program text,
 *  roles). Each becomes a folder with the same slug: SKILL.md, task.json and a
 *  run.js that plays the old program through its first slot, so the schedule
 *  rows that name it keep firing. One pass; the row is removed after. */
let migrated = false;
export function migrateLegacyTasks(): void {
  if (migrated) return;
  migrated = true;
  const home = TASKS_HOME();
  let names: string[] = [];
  try { names = fs.readdirSync(home).filter((f) => f.endsWith(".json")); } catch { return; }
  for (const f of names) {
    const file = path.join(home, f);
    try {
      const row = JSON.parse(fs.readFileSync(file, "utf-8")) as { slug?: string; name?: string; description?: string; code?: string; builtIn?: boolean; manifest?: { roles?: Array<{ name: string; label?: string; description?: string; default?: string | null; model?: string | null }> } };
      const slug = String(row.slug || f.replace(/\.json$/, ""));
      if (row.builtIn || fs.existsSync(path.join(home, slug))) { fs.rmSync(file, { force: true }); continue; }
      const roles = row.manifest?.roles?.length ? row.manifest.roles : [{ name: "main", label: "Main", description: "The agent this task runs through.", default: null }];
      const slots: Record<string, TaskSlot> = {};
      for (const r of roles) slots[r.name.toLowerCase().replace(/[^a-z0-9_-]+/g, "-")] = { label: r.label ?? r.name, ...(r.description ? { description: r.description } : {}), agent: r.default ?? null, ...(r.model ? { model: r.model } : {}) };
      const manifest: TaskManifest = { name: String(row.name || slug), program: "run.js", slots, schedule: null, dependencies: { connections: [] } };
      installSkill(slug, {
        "SKILL.md": `---\nname: ${slug}\ndescription: ${String(row.description || row.name || slug).replace(/\n/g, " ")}\n---\n\n# ${row.name || slug}\n\nA Glyphh task, carried over from its pre-bundle form.\n`,
        [MANIFEST]: JSON.stringify(manifest, null, 2) + "\n",
        "run.js": promptProgram(String(row.code || row.description || row.name || ""), Object.keys(slots)[0] ?? "main"),
      }, "task");
      fs.rmSync(file, { force: true });
      console.log(`[tasks] migrated "${slug}" to a bundle`);
    } catch (err) {
      console.warn(`[tasks] could not migrate ${f}:`, err instanceof Error ? err.message : err);
    }
  }
}

// ── runs: the journal ────────────────────────────────────────────────────────

interface RunRow {
  id: string; schedule_id: string; started_at: string; duration_ms: number | null; status: string; error: string | null; output: string | null;
  task_slug: string | null; trigger: string | null; input: string | null; journal: string | null; result: string | null;
}

const parse = <T>(s: string | null, fallback: T): T => { if (!s) return fallback; try { return JSON.parse(s) as T; } catch { return fallback; } };

function rowToRun(r: RunRow): TaskRun {
  return {
    id: r.id, taskSlug: r.task_slug || "", scheduleId: r.schedule_id || null, trigger: r.trigger || "manual", startedAt: r.started_at,
    durationMs: r.duration_ms, status: r.status, error: r.error, input: parse(r.input, null), result: parse(r.result, null),
    journal: parse<RunJournal>(r.journal, { checkpoints: {}, events: [] }),
  };
}

export function listTaskRuns(slug: string, limit = 30): TaskRun[] {
  const rows = getLocalDb().prepare("SELECT * FROM loop_runs WHERE task_slug = ? ORDER BY started_at DESC LIMIT ?").all(slug, limit) as RunRow[];
  return rows.map(rowToRun);
}

export function getTaskRun(id: string): TaskRun | null {
  const r = getLocalDb().prepare("SELECT * FROM loop_runs WHERE id = ?").get(id) as RunRow | undefined;
  return r ? rowToRun(r) : null;
}

function saveJournal(runId: string, journal: RunJournal): void {
  getLocalDb().prepare("UPDATE loop_runs SET journal = ? WHERE id = ?").run(JSON.stringify(journal), runId);
}

// ── the ctx verbs main answers ───────────────────────────────────────────────

interface Live { proc: UtilityProcess; journal: RunJournal; slug: string; spec: TaskSpec; timer: NodeJS.Timeout }
const live = new Map<string, Live>();

const summarize = (v: unknown, max = 4000): unknown => {
  const s = typeof v === "string" ? v : JSON.stringify(v);
  return s && s.length > max ? `${s.slice(0, max)}… (${s.length} chars)` : v;
};

function resolveSlotAgent(spec: TaskSpec, slot: string): { loop: CliAgentListed; prompt: string; model?: string; agentName: string } {
  const s = spec.slots.find((x) => x.name === slot);
  if (!s) throw new Error(`no slot "${slot}" on task "${spec.slug}"`);
  const roster = slotAgentRoster();
  const who = (s.agent ? roster.find((a) => a.id === s.agent) : undefined) ?? roster[0];
  const ctx = who ? slotAgentContext(who.id) : null;
  // A slot filled before agents existed holds a loop id; read it that way.
  const loopId = ctx?.loopId || s.agent || "";
  const loop = listCliAgents().find((a) => a.id === loopId) as CliAgentListed | undefined;
  if (!loop) throw new Error(who ? `agent "${who.name}" has no loop to run on` : `slot "${slot}" has no agent and none exist`);
  return { loop, prompt: ctx?.prompt || "", model: ctx?.model ?? s.model, agentName: who?.name || loop.name };
}

function firstJson(text: string): unknown {
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  const body = fence ? fence[1] : text;
  const start = body.search(/[[{]/);
  if (start < 0) throw new Error("the agent returned no JSON");
  for (let end = body.length; end > start; end--) {
    try { return JSON.parse(body.slice(start, end)); } catch { /* shrink */ }
  }
  throw new Error("the agent's JSON did not parse");
}

async function agentTurn(spec: TaskSpec, slot: string, prompt: string, opts: { schema?: unknown; model?: string }): Promise<{ text: string; json?: unknown; agent: string }> {
  const { loop, prompt: standing, model, agentName } = resolveSlotAgent(spec, slot);
  const ask = opts.schema ? `${prompt}\n\nReply with only JSON matching this shape, no prose:\n${JSON.stringify(opts.schema)}` : prompt;
  const line = composeHeadless(loop, standing ? `${standing}\n\n${ask}` : ask, opts.model ?? model);
  const r = await execHeadless(line);
  if (r.code !== 0) throw new Error(r.error || `${agentName} exited ${r.code}: ${r.output.slice(-800)}`);
  return { text: r.output, ...(opts.schema ? { json: firstJson(r.output) } : {}), agent: agentName };
}

let gateway: Client | null = null;
async function gatewayClient(): Promise<Client> {
  if (gateway) return gateway;
  const creds = await mcpCreds();
  if (!creds) throw new Error("no gateway credential: sign in to reach the org's connections");
  const client = new Client({ name: "glyphh-task", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(`${creds.baseUrl.replace(/\/$/, "")}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${creds.token}` } } });
  await client.connect(transport);
  gateway = client;
  return client;
}

/** A connection call runs unattended: only a tool the user set to Always
 *  allow on the Connections page goes through. Ask and Never both refuse. */
async function connectionCall(spec: TaskSpec, appSlug: string, tool: string, args: unknown): Promise<unknown> {
  if (!spec.connections.includes(appSlug)) throw new Error(`task "${spec.slug}" does not declare the connection "${appSlug}"`);
  const modes = preferencesByPrefix<Record<string, string>>("connToolModes:");
  const mode = modes[appSlug]?.[tool] ?? modes[appSlug]?.[`${appSlug}-${tool}`];
  if (mode !== "allow") throw new Error(`"${tool}" on ${appSlug} is not set to Always allow — unattended runs only use tools you allowed on the Connections page`);
  const a = args && typeof args === "object" ? args as Record<string, unknown> : {};
  if (listConnRows().some((r) => r.slug === appSlug)) return callConnectionTool(appSlug, tool, a);
  const client = await gatewayClient();
  const name = tool.startsWith(`${appSlug}-`) ? tool : `${appSlug}-${tool}`;
  try { return await client.callTool({ name, arguments: a }); }
  catch (err) { gateway = null; throw err; }
}

function answer(l: Live, runId: string, kind: string, args: unknown[]): Promise<unknown> {
  const push = (ev: Omit<RunEvent, "t">): void => { l.journal.events.push({ t: now(), ...ev } as RunEvent); saveJournal(runId, l.journal); };
  switch (kind) {
    case "agent": {
      const [slot, prompt, opts] = args as [string, string, { schema?: unknown; model?: string }];
      return agentTurn(l.spec, slot, prompt, opts ?? {}).then((r) => {
        push({ kind: "agent", slot, agent: r.agent, prompt: summarize(prompt, 2000), output: summarize(r.text, 8000), ...(r.json !== undefined ? { json: r.json } : {}) });
        return r;
      }, (err: Error) => { push({ kind: "agent", slot, prompt: summarize(prompt, 2000), error: err.message }); throw err; });
    }
    case "connection": {
      const [appSlug, tool, a] = args as [string, string, unknown];
      return connectionCall(l.spec, appSlug, tool, a).then((r) => {
        push({ kind: "connection", app: appSlug, tool, args: summarize(a, 2000), result: summarize(r, 4000) });
        return r;
      }, (err: Error) => { push({ kind: "connection", app: appSlug, tool, args: summarize(a, 2000), error: err.message }); throw err; });
    }
    case "data": {
      const [repo, sql, params] = args as [string, string, unknown];
      try {
        const r = dbExec(String(repo), { sql, params });
        push({ kind: "data", repo, sql: summarize(sql, 1000), rows: Array.isArray(r.rows) ? r.rows.length : undefined, changes: r.changes });
        return Promise.resolve(r);
      } catch (err) {
        push({ kind: "data", repo, sql: summarize(sql, 1000), error: err instanceof Error ? err.message : String(err) });
        return Promise.reject(err);
      }
    }
    case "checkpoint-get": {
      const [key] = args as [string];
      const hit = Object.prototype.hasOwnProperty.call(l.journal.checkpoints, key);
      if (hit) push({ kind: "checkpoint", key, replayed: true });
      return Promise.resolve({ hit, ...(hit ? { value: l.journal.checkpoints[key] } : {}) });
    }
    case "checkpoint-set": {
      const [key, value] = args as [string, unknown];
      l.journal.checkpoints[key] = value;
      push({ kind: "checkpoint", key, replayed: false });
      return Promise.resolve(true);
    }
    case "log": {
      const [message, detail] = args as [string, unknown];
      push({ kind: "log", message: String(message).slice(0, 2000), ...(detail != null ? { detail: summarize(detail, 2000) } : {}) });
      return Promise.resolve(true);
    }
    default:
      return Promise.reject(new Error(`unknown ctx call "${kind}"`));
  }
}

// ── running ──────────────────────────────────────────────────────────────────

const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;

function broadcast(): void {
  for (const w of BrowserWindow.getAllWindows()) { if (!w.isDestroyed()) w.webContents.send("task-runs-changed"); }
}

function finish(runId: string, startedAt: string, status: "ok" | "failed", error: string | null, result: unknown): void {
  getLocalDb().prepare("UPDATE loop_runs SET duration_ms = ?, status = ?, error = ?, result = ?, output = ? WHERE id = ?")
    .run(Date.now() - Date.parse(startedAt), status, error, result === undefined ? null : JSON.stringify(result), error ? error.slice(0, 20_000) : JSON.stringify(result ?? null).slice(0, 20_000), runId);
  const l = live.get(runId);
  if (l) { clearTimeout(l.timer); live.delete(runId); }
  broadcast();
}

function hostPath(): string {
  return path.join(__dirname, "task-host.js");
}

function launch(run: TaskRun, spec: TaskSpec, resumed: boolean): void {
  const manifest = readManifest(spec.dir);
  const proc = utilityProcess.fork(hostPath(), [], { serviceName: `glyphh-task:${spec.slug}` });
  const journal = run.journal;
  if (resumed) { journal.events.push({ t: now(), kind: "resume" }); saveJournal(run.id, journal); }
  const timer = setTimeout(() => {
    try { proc.kill(); } catch { /* gone */ }
    finish(run.id, run.startedAt, "failed", `timed out after ${Math.round((manifest.timeoutMs || DEFAULT_TIMEOUT_MS) / 60000)} min`, null);
  }, manifest.timeoutMs || DEFAULT_TIMEOUT_MS);
  const l: Live = { proc, journal, slug: spec.slug, spec, timer };
  live.set(run.id, l);
  proc.on("message", (msg: { type: string; id?: number; kind?: string; args?: unknown[]; result?: unknown; error?: string }) => {
    if (msg.type === "call" && typeof msg.id === "number") {
      answer(l, run.id, String(msg.kind), msg.args ?? []).then(
        (value) => proc.postMessage({ type: "reply", id: msg.id, ok: true, value }),
        (err: Error) => proc.postMessage({ type: "reply", id: msg.id, ok: false, error: err.message }),
      );
    } else if (msg.type === "done") {
      finish(run.id, run.startedAt, "ok", null, msg.result ?? null);
      proc.kill();
    } else if (msg.type === "failed") {
      finish(run.id, run.startedAt, "failed", msg.error || "the program failed", null);
      proc.kill();
    }
  });
  proc.on("exit", (code) => {
    if (live.has(run.id)) finish(run.id, run.startedAt, "failed", code === 0 ? "the program exited without a result" : `the program died (exit ${code})`, null);
  });
  // Whoever wrote this bundle — us, an agent, the hub — its program is CommonJS
  // unless it says otherwise, and no package.json further up gets a vote.
  pinCommonJs(spec.dir);
  proc.postMessage({ type: "start", dir: spec.dir, program: spec.program, input: run.input, slots: spec.slots.map((s) => s.name), connections: spec.connections, repos: [] });
}

/** Start a run. Resolves as soon as the process is up; the journal tells the rest. */
export function runTask(slug: string, input: unknown = {}, trigger: { kind: "manual" | "schedule" | "agent"; scheduleId?: string } = { kind: "manual" }): TaskRun {
  const spec = getTaskSpec(slug);
  if (!spec.enabled) throw new Error(`task "${slug}" is turned off`);
  if ([...live.values()].some((l) => l.slug === slug)) throw new Error(`task "${slug}" is already running`);
  const id = rid();
  const startedAt = now();
  const journal: RunJournal = { checkpoints: {}, events: [] };
  getLocalDb().prepare("INSERT INTO loop_runs (id, schedule_id, started_at, status, task_slug, trigger, input, journal) VALUES (?, ?, ?, 'running', ?, ?, ?, ?)")
    .run(id, trigger.scheduleId ?? "", startedAt, slug, trigger.kind, JSON.stringify(input ?? {}), JSON.stringify(journal));
  const run: TaskRun = { id, taskSlug: slug, scheduleId: trigger.scheduleId ?? null, trigger: trigger.kind, startedAt, durationMs: null, status: "running", error: null, input, result: null, journal };
  launch(run, spec, false);
  broadcast();
  return run;
}

/** Start a run and wait for it: the MCP task_run lane. */
export async function runTaskAndWait(slug: string, input: unknown = {}): Promise<TaskRun> {
  const run = runTask(slug, input, { kind: "agent" });
  return new Promise((resolve) => {
    const tick = (): void => {
      const r = getTaskRun(run.id);
      if (r && r.status !== "running") { resolve(r); return; }
      setTimeout(tick, 1000);
    };
    tick();
  });
}

export function cancelTaskRun(id: string): boolean {
  const l = live.get(id);
  if (!l) return false;
  try { l.proc.kill(); } catch { /* gone */ }
  const r = getTaskRun(id);
  finish(id, r?.startedAt ?? now(), "failed", "cancelled", null);
  return true;
}

/** Boot: a run left in `running` picks up where its journal ends. */
export function resumeInterruptedRuns(): void {
  let rows: RunRow[] = [];
  try { rows = getLocalDb().prepare("SELECT * FROM loop_runs WHERE status = 'running' AND task_slug IS NOT NULL").all() as RunRow[]; }
  catch { return; }
  for (const r of rows) {
    const run = rowToRun(r);
    try {
      const spec = getTaskSpec(run.taskSlug);
      if (!spec.enabled) { finish(run.id, run.startedAt, "failed", "the task was turned off before the run finished", null); continue; }
      launch(run, spec, true);
    } catch (err) {
      finish(run.id, run.startedAt, "failed", err instanceof Error ? err.message : String(err), null);
    }
  }
}

export function stopTaskRunner(): void {
  for (const [id, l] of live) { clearTimeout(l.timer); try { l.proc.kill(); } catch { /* down anyway */ } live.delete(id); }
  if (gateway) { void gateway.close().catch(() => {}); gateway = null; }
}

// ── IPC ──────────────────────────────────────────────────────────────────────

const env = <T>(fn: () => T): { ok: boolean; data?: T; error?: string } => {
  try { return { ok: true, data: fn() }; } catch (err) { return { ok: false, error: err instanceof Error ? err.message : String(err) }; }
};

export function registerTaskRunnerIpc(): void {
  setTaskRunner((slug, scheduleId, input) => { runTask(slug, input, { kind: "schedule", scheduleId }); });
  ipcMain.handle("tasks-specs", () => env(() => listTaskSpecs()));
  ipcMain.handle("task-spec", (_e, slug: string) => env(() => getTaskSpec(String(slug))));
  ipcMain.handle("task-slot-set", (_e, slug: string, slot: string, agentId: string | null) => env(() => setTaskSlot(String(slug), String(slot), agentId ? String(agentId) : null)));
  ipcMain.handle("task-run", (_e, slug: string, input?: unknown) => env(() => runTask(String(slug), input ?? {})));
  ipcMain.handle("task-runs", (_e, slug: string) => env(() => listTaskRuns(String(slug))));
  ipcMain.handle("task-run-get", (_e, id: string) => env(() => getTaskRun(String(id))));
  ipcMain.handle("task-run-cancel", (_e, id: string) => env(() => cancelTaskRun(String(id))));
  app.whenReady().then(() => { migrateLegacyTasks(); resumeInterruptedRuns(); }).catch(() => {});
}
