/**
 * local-library.ts — TASKS and SKILLS, local (the build, 2026-09-10: the
 * main-era UX returns; storage + execution move onto this machine).
 *
 *   ~/.glyphh/tasks/<slug>.json    — a task spec: the main-era shape
 *                                    (manifest with roles, code = the
 *                                    PROGRAM). A role's `default` names the
 *                                    LOOP that fills the slot (loops carry
 *                                    their model; a workspace/schedule can
 *                                    override).
 *   ~/.glyphh/skills/<slug>.json   — a skill: manifest + prompt + code.
 *   user-state.sqlite              — loop_schedules + loop_runs (migration 9).
 *
 * NAMING (2026-09-11): this file's `LoopRow`/`loop_*` identifiers are the
 * MAIN-ERA sense of "loop" — a program with role slots — which the Tasks
 * page has always rendered ("a task IS a loop row renamed", below). His
 * current vocabulary gives "Loop" to the CLI pre-configs in cli-agents.ts.
 * The directory moved to tasks/ to end the collision; the internal type
 * names and the two SQLite tables keep the old spelling until they are
 * renamed under their own migration — do NOT read `LoopRow` here as a CLI
 * loop.
 *
 * EXECUTION: a scheduled (or run-now) task runs HEADLESSLY — the slotted
 * loop's CLI in print mode (claude -p / codex exec / gemini -p) with the
 * task's program as the prompt, output captured as the run record.
 */

import fs from "fs";
import path from "path";
import { homedir } from "os";
import { spawn } from "child_process";
import { ipcMain } from "electron";
import cron, { type ScheduledTask } from "node-cron";
import { getLocalDb } from "./local-db.js";
import { listCliAgents, composeHeadless, type CliAgentListed } from "./cli-agents.js";

const TASKS_DIR = path.join(homedir(), ".glyphh", "tasks");
const SKILLS_DIR = path.join(homedir(), ".glyphh", "skills");

interface LoopRole { name: string; label?: string; description?: string; default?: string | null; model?: string | null }
interface LoopManifest { version?: number; type?: "turn" | "memory"; roles?: LoopRole[]; skills?: string[]; connections?: string[]; layout?: string }
export interface LoopRow {
  id: string; slug: string; scope: "personal"; ownerUserId: null;
  name: string; description: string; builtIn: boolean; updatedAt: string;
  manifest: LoopManifest; code: string;
}
interface SkillManifest { version?: number; whenToUse?: string; allowedTools?: string[]; requires?: string[]; schedule?: string | null; model?: string | null }
export interface SkillRow {
  id: string; slug: string; scope: "personal"; name: string; description: string;
  hasCode: boolean; builtIn: false; schedule: string | null; updatedAt: string;
  manifest: SkillManifest; prompt: string; code: string;
}

const slugify = (name: string): string =>
  name.trim().toLowerCase().replace(/[^\w.-]+/g, "-").replace(/^-+|-+$/g, "") || "item";

const env = <T>(fn: () => T): { ok: boolean; data?: T; error?: string } => {
  try { return { ok: true, data: fn() }; }
  catch (err) { return { ok: false, error: err instanceof Error ? err.message : String(err) }; }
};

// ── JSON-per-file store (loops + skills share the grammar) ───────────────────

function readRow<T>(dir: string, slug: string): T | null {
  try { return JSON.parse(fs.readFileSync(path.join(dir, `${slug}.json`), "utf-8")) as T; }
  catch { return null; }
}
function writeRow(dir: string, slug: string, row: unknown): void {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${slug}.json`);
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(row, null, 2), "utf-8");
  fs.renameSync(`${file}.tmp`, file);
}
function listRows<T>(dir: string): T[] {
  let names: string[] = [];
  try { names = fs.readdirSync(dir).filter((n) => n.endsWith(".json")); } catch { return []; }
  const out: T[] = [];
  for (const n of names) {
    const row = readRow<T>(dir, n.slice(0, -5));
    if (row) out.push(row);
  }
  return out;
}

function getLoop(ref: string): LoopRow {
  const row = readRow<LoopRow>(TASKS_DIR, String(ref));
  if (!row) throw new Error(`loop "${ref}" not found`);
  return row;
}
function saveLoop(row: LoopRow): LoopRow {
  row.updatedAt = new Date().toISOString();
  writeRow(TASKS_DIR, row.slug, row);
  return row;
}
export function listSkillRows(): SkillRow[] { return listRows<SkillRow>(SKILLS_DIR); }
export function getSkillRow(ref: string): SkillRow { return getSkill(ref); }
export function saveSkillRow(input: { slug?: string; name: string; description?: string; prompt?: string }): SkillRow {
  const name = String(input.name ?? "").trim();
  if (!name) throw new Error("a skill needs a name");
  const slug = input.slug ? String(input.slug) : slugify(name);
  const existing = readRow<SkillRow>(SKILLS_DIR, slug);
  const now = new Date().toISOString();
  const row: SkillRow = {
    id: slug, slug, scope: "personal", name,
    description: String(input.description ?? existing?.description ?? ""),
    hasCode: existing?.hasCode ?? false, builtIn: false,
    schedule: existing?.schedule ?? null, updatedAt: now,
    manifest: existing?.manifest ?? { version: 1 },
    prompt: String(input.prompt ?? existing?.prompt ?? ""),
    code: existing?.code ?? "",
  };
  writeRow(SKILLS_DIR, slug, row);
  return row;
}

function getSkill(ref: string): SkillRow {
  const row = readRow<SkillRow>(SKILLS_DIR, String(ref));
  if (!row) throw new Error(`skill "${ref}" not found`);
  return row;
}

// ── Schedules (SQLite) + the cron runner ─────────────────────────────────────

export interface ScheduleRow {
  id: string; agent_id: string; name: string; loop_slug: string;
  cron: string; enabled: number; created_at: string;
  /** The AGENT that owns this task, if any (local-agents.ts). NULL = a loose
   *  schedule made straight from the Tasks page. */
  owner_agent_id: string | null;
  /** What fires: a task spec or a skill. `target` is its slug. */
  kind: "task" | "skill";
  target: string;
  /** JSON blob of arguments handed to the target. */
  args: string;
}

/** What an AGENT contributes to a run: which CLI loop actually runs it, the
 *  standing prompt that rides ahead of the target's own program, and an
 *  optional model override.
 *
 *  A TASK SLOT NAMES AN AGENT (his rule, 2026-09-11: "tasks are still
 *  referencing loops and not agents"). The agent is the unit of standing
 *  work; the loop is an implementation detail it carries. Tasks therefore
 *  never pick a CLI directly — they pick who does the work.
 *
 *  Injected rather than imported: local-agents.ts depends on this module, so
 *  reaching back for agent rows directly would close an import cycle. */
export interface ScheduleContext { loopId: string; prompt: string; model?: string }
/** An agent as a slot CHOICE — id, display name, and the loop behind it. */
export interface SlotAgent { id: string; name: string; loopId: string | null }

let agentContext: ((agentId: string) => ScheduleContext | null) | null = null;
let agentChoices: (() => SlotAgent[]) | null = null;
export function setAgentProviders(
  ctx: (agentId: string) => ScheduleContext | null,
  list: () => SlotAgent[],
): void {
  agentContext = ctx;
  agentChoices = list;
}
interface RunRow { id: string; schedule_id: string; started_at: string; duration_ms: number | null; status: string; error: string | null; output: string | null }

const rid = (): string => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

const liveJobs = new Map<string, ScheduledTask>();

export function armSchedule(row: ScheduleRow): void {
  liveJobs.get(row.id)?.stop();
  liveJobs.delete(row.id);
  if (!row.enabled || !cron.validate(row.cron)) return;
  const task = cron.schedule(row.cron, () => { void runSchedule(row.id).catch(() => {}); });
  liveJobs.set(row.id, task);
}

function loadSchedules(): ScheduleRow[] {
  return getLocalDb().prepare("SELECT * FROM loop_schedules ORDER BY created_at").all() as ScheduleRow[];
}

/** Boot: arm every enabled schedule. */
export function startLoopScheduler(): void {
  try { for (const row of loadSchedules()) armSchedule(row); }
  catch (err) { console.error("[loops] scheduler boot failed:", err instanceof Error ? err.message : err); }
}

export function stopLoopScheduler(): void {
  for (const t of liveJobs.values()) { try { t.stop(); } catch { /* down anyway */ } }
  liveJobs.clear();
}

/** What a schedule actually asks for: the target's own text, plus the model
 *  its slot names. Throws with a readable reason the run feed can show. */
function promptForSchedule(sched: ScheduleRow): { text: string; slotModel?: string } {
  const ref = sched.target || sched.loop_slug;
  if (sched.kind === "skill") {
    const skill = getSkill(ref);
    const text = skill.prompt || skill.description || skill.name;
    return { text, ...(skill.manifest.model ? { slotModel: skill.manifest.model } : {}) };
  }
  const spec = getLoop(ref);
  // The slot whose default IS this loop names the model; else the first slot.
  const slot = (spec.manifest.roles ?? []).find((r) => r.default === sched.agent_id) ?? spec.manifest.roles?.[0];
  const text = spec.code || spec.description || spec.name;
  return { text, ...(slot?.model ? { slotModel: slot.model } : {}) };
}

/** One run: the target's program, through the AGENT doing the work.
 *
 *  The agent supplies the loop, the standing prompt and any model override —
 *  that is what makes it a worker and not just a cron entry. `agent_id` on
 *  the row is whoever was slotted; an owning agent (an Agents-page task)
 *  wins over it. Rows written before slots named agents hold a LOOP id
 *  there, so an unresolvable agent falls back to reading it as one. */
export async function runSchedule(scheduleId: string): Promise<void> {
  const db = getLocalDb();
  const sched = db.prepare("SELECT * FROM loop_schedules WHERE id = ?").get(scheduleId) as ScheduleRow | undefined;
  if (!sched) throw new Error("schedule not found");
  const who = sched.owner_agent_id || sched.agent_id;
  const ctx = who ? agentContext?.(who) ?? null : null;
  const loopId = ctx?.loopId || sched.agent_id;
  const loop = listCliAgents().find((a) => a.id === loopId) as CliAgentListed | undefined;
  const runId = rid();
  const startedAt = new Date().toISOString();
  db.prepare("INSERT INTO loop_runs (id, schedule_id, started_at, status) VALUES (?, ?, ?, 'running')")
    .run(runId, scheduleId, startedAt);
  const t0 = Date.now();
  const finish = (status: string, error: string | null, output: string | null): void => {
    db.prepare("UPDATE loop_runs SET duration_ms = ?, status = ?, error = ?, output = ? WHERE id = ?")
      .run(Date.now() - t0, status, error, output ? output.slice(0, 20_000) : null, runId);
  };
  let line: string;
  try {
    if (!loop) throw new Error(`loop "${loopId}" not found`);
    const { text, slotModel } = promptForSchedule(sched);
    // The agent's standing prompt frames the task's own program.
    const prompt = ctx?.prompt ? `${ctx.prompt}\n\n${text}` : text;
    line = composeHeadless(loop, prompt, ctx?.model ?? slotModel);
  } catch (err) {
    finish("failed", err instanceof Error ? err.message : String(err), null);
    return;
  }
  const r = await execHeadless(line);
  finish(r.code === 0 ? "ok" : "failed", r.code === 0 ? null : r.error ?? `exit ${r.code}`, r.output || null);
}

function execHeadless(line: string): Promise<{ code: number; output: string; error?: string }> {
  return new Promise((resolve) => {
    const child = spawn("/bin/sh", ["-lc", line], { env: process.env });
    let out = "";
    const cap = (b: Buffer): void => { if (out.length < 40_000) out += b.toString(); };
    child.stdout.on("data", cap);
    child.stderr.on("data", cap);
    const timer = setTimeout(() => { try { child.kill("SIGKILL"); } catch { /* raced exit */ } }, 10 * 60 * 1000);
    child.on("close", (codeNum) => { clearTimeout(timer); resolve({ code: codeNum ?? 1, output: out.trim() }); });
    child.on("error", (err) => { clearTimeout(timer); resolve({ code: 1, output: out.trim(), error: err.message }); });
  });
}

// ── Task-spec surface — the MCP authoring lanes ride the SAME loop store; a
//    task IS a loop row renamed: program = code, slots = manifest.roles ──────

export interface TaskSpec {
  slug: string; name: string; description: string; program: string;
  slots: Array<{ name: string; label?: string; description?: string; agent: string | null; model?: string }>;
}

const specOf = (row: LoopRow): TaskSpec => ({
  slug: row.slug, name: row.name, description: row.description, program: row.code,
  slots: (row.manifest.roles ?? []).map((r) => ({
    name: r.name, ...(r.label ? { label: r.label } : {}), ...(r.description ? { description: r.description } : {}),
    agent: r.default ?? null, ...(r.model ? { model: r.model } : {}),
  })),
});

export function listTaskSpecs(): TaskSpec[] {
  return listRows<LoopRow>(TASKS_DIR).filter((r) => !r.builtIn).map(specOf)
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function getTaskSpec(ref: string): TaskSpec {
  return specOf(getLoop(ref));
}

export function saveTaskSpec(input: {
  slug?: string; name: string; description?: string; program?: string;
  slots?: Array<{ name?: string; label?: string; description?: string; agent?: string | null; model?: string | null }>;
}): TaskSpec {
  const name = String(input.name ?? "").trim();
  if (!name) throw new Error("a task needs a name");
  const slug = input.slug ? String(input.slug) : slugify(name);
  const existing = readRow<LoopRow>(TASKS_DIR, slug);
  const roles: LoopRole[] = Array.isArray(input.slots) && input.slots.length
    ? input.slots.map((sl, i) => ({
        name: String(sl.name ?? `slot-${i + 1}`),
        label: String(sl.label ?? sl.name ?? `Slot ${i + 1}`),
        ...(sl.description ? { description: String(sl.description) } : {}),
        default: sl.agent ? String(sl.agent) : null,
        ...(sl.model ? { model: String(sl.model) } : {}),
      }))
    : existing?.manifest.roles ?? [{ name: "main", label: "Main", description: "The agent this task runs on.", default: null }];
  const row: LoopRow = {
    id: slug, slug, scope: "personal", ownerUserId: null, name,
    description: String(input.description ?? existing?.description ?? ""),
    builtIn: false, updatedAt: new Date().toISOString(),
    manifest: { ...(existing?.manifest ?? { version: 1, type: "turn" }), roles },
    code: String(input.program ?? existing?.code ?? ""),
  };
  writeRow(TASKS_DIR, slug, row);
  return specOf(row);
}

/** Run a task NOW, outside any schedule — the program through the slotted
 *  (or given) agent's headless CLI; the transcript goes back to the caller. */
export async function runTaskNow(ref: string, agentId?: string): Promise<{ status: string; output: string }> {
  const row = getLoop(ref);
  // WHO does it: the given agent, else the first slot's agent, else the only
  // agent there is. No agent = nothing to run it — say so rather than
  // silently borrowing some CLI.
  const roster = agentChoices?.() ?? [];
  const wanted = agentId || row.manifest.roles?.[0]?.default || "";
  const who = roster.find((a) => a.id === wanted) ?? roster[0];
  const ctx = who ? agentContext?.(who.id) ?? null : null;
  // Pre-agent rows slotted a LOOP id directly; fall back to reading it that way.
  const loopId = ctx?.loopId || wanted;
  const loop = listCliAgents().find((a) => a.id === loopId) as CliAgentListed | undefined;
  if (!loop) throw new Error(who ? `agent "${who.name}" has no loop to run on` : "no agents exist to run this task");
  const slot = (row.manifest.roles ?? []).find((r) => r.default === who?.id) ?? row.manifest.roles?.[0];
  const program = row.code || row.description || row.name;
  const line = composeHeadless(loop, ctx?.prompt ? `${ctx.prompt}\n\n${program}` : program, ctx?.model ?? slot?.model ?? undefined);
  const r = await execHeadless(line);
  return { status: r.code === 0 ? "ok" : "failed", output: r.error ? `${r.output}\n${r.error}`.trim() : r.output };
}

export function listTaskRunsFor(ref: string): Array<{ id: string; startedAt: string; durationMs: number | null; status: string; error: string | null; output: string | null }> {
  const rows = getLocalDb().prepare(
    `SELECT r.* FROM loop_runs r JOIN loop_schedules s ON r.schedule_id = s.id
     WHERE s.loop_slug = ? ORDER BY r.started_at DESC LIMIT 30`).all(String(ref)) as RunRow[];
  return rows.map((r) => ({ id: r.id, startedAt: r.started_at, durationMs: r.duration_ms, status: r.status, error: r.error, output: r.output }));
}

// ── IPC — the exact lanes the main-era UX rides ──────────────────────────────

export function registerLocalLibraryIpc(): void {
  // LOOPS
  ipcMain.handle("loops-list", () => ({
    loops: listRows<LoopRow>(TASKS_DIR)
      .map(({ manifest: _m, code: _c, ...summary }) => summary)
      .sort((a, b) => a.name.localeCompare(b.name)),
  }));
  ipcMain.handle("library-loop-get", (_e, ref: string) => env(() => getLoop(ref)));
  ipcMain.handle("library-loop-update", (_e, ref: string, patch: Partial<LoopRow>) => env(() => {
    const row = getLoop(ref);
    if (patch.name !== undefined) row.name = String(patch.name);
    if (patch.description !== undefined) row.description = String(patch.description);
    if (patch.code !== undefined) row.code = String(patch.code);
    if (patch.manifest !== undefined && patch.manifest) row.manifest = patch.manifest;
    return saveLoop(row);
  }));
  ipcMain.handle("library-loop-delete", (_e, ref: string) => env(() => {
    fs.rmSync(path.join(TASKS_DIR, `${String(ref)}.json`), { force: true });
    const db = getLocalDb();
    for (const s of loadSchedules().filter((x) => x.loop_slug === String(ref))) {
      liveJobs.get(s.id)?.stop();
      liveJobs.delete(s.id);
      db.prepare("DELETE FROM loop_schedules WHERE id = ?").run(s.id);
    }
    return { deleted: true };
  }));
  ipcMain.handle("loops-create", (_e, input: { name?: string } | undefined) => env(() => {
    const name = String(input?.name ?? "New loop").trim() || "New loop";
    const slug = slugify(name);
    if (readRow(TASKS_DIR, slug)) throw new Error(`a loop named "${slug}" already exists`);
    const row: LoopRow = {
      id: slug, slug, scope: "personal", ownerUserId: null,
      name, description: "", builtIn: false, updatedAt: new Date().toISOString(),
      manifest: { version: 1, type: "turn", roles: [{ name: "main", label: "Main", description: "The agent this loop runs on.", default: null }] },
      code: "",
    };
    writeRow(TASKS_DIR, slug, row);
    return row;
  }));
  // Roles resolve with CHOICES = the CLI AGENTS (a role's default names an
  // agent now; the agent carries its model) — the main-era picker mechanics
  // read modelId/choices unchanged.
  // Preload sends { loop } / { loopId, role, modelId } object payloads (the
  // main-era wire shape) — accept those AND bare positionals.
  ipcMain.handle("loop-roles", (_e, arg: string | { loop?: string }) => {
    const loop = typeof arg === "string" ? arg : String(arg?.loop ?? "");
    try {
      const row = getLoop(String(loop));
      // A slot picks an AGENT, not a CLI — the agent brings its own loop.
      const choices = (agentChoices?.() ?? []).map((a) => ({ id: a.id, name: a.name }));
      const roles = (row.manifest.roles ?? []).map((r) => ({
        name: r.name, label: r.label, description: r.description,
        modelId: r.default ?? null,
        model: r.model ?? null,
        choices,
      }));
      return { ok: true, loop: row.slug, roles };
    } catch (err) {
      return { ok: false, loop: String(loop), roles: [], error: err instanceof Error ? err.message : String(err) };
    }
  });
  ipcMain.handle("loop-set-role-default", (_e, arg: string | { loopId?: string; role?: string; modelId?: string | null; model?: string | null }, rolePos?: string, agentPos?: string | null) => env(() => {
    const loopId = typeof arg === "string" ? arg : String(arg?.loopId ?? "");
    const role = typeof arg === "string" ? String(rolePos ?? "") : String(arg?.role ?? "");
    const agentId = typeof arg === "string" ? agentPos ?? null : arg?.modelId ?? null;
    const row = getLoop(loopId);
    const r = (row.manifest.roles ?? []).find((x) => x.name === role);
    if (!r) throw new Error(`role "${role}" not on this loop`);
    r.default = agentId ? String(agentId) : null;
    // The slot's MODEL OVERRIDE rides the same lane: undefined = untouched,
    // "" / null = cleared (the agent's own model runs).
    if (typeof arg === "object" && arg && "model" in arg) r.model = arg.model ? String(arg.model) : null;
    return saveLoop(row);
  }));

  // SKILLS
  ipcMain.handle("library-skills-list", () => env(() =>
    listRows<SkillRow>(SKILLS_DIR)
      .map(({ manifest: _m, prompt: _p, code: _c, ...summary }) => summary)
      .sort((a, b) => a.name.localeCompare(b.name))));
  ipcMain.handle("library-skill-get", (_e, ref: string) => env(() => getSkill(ref)));
  ipcMain.handle("library-skill-update", (_e, ref: string, patch: Partial<SkillRow>) => env(() => {
    const row = getSkill(ref);
    if (patch.name !== undefined) row.name = String(patch.name);
    if (patch.description !== undefined) row.description = String(patch.description);
    if (patch.prompt !== undefined) row.prompt = String(patch.prompt);
    if (patch.code !== undefined) { row.code = String(patch.code); row.hasCode = !!row.code; }
    if (patch.manifest !== undefined && patch.manifest) row.manifest = patch.manifest;
    row.schedule = row.manifest.schedule ?? null;
    row.updatedAt = new Date().toISOString();
    writeRow(SKILLS_DIR, row.slug, row);
    return row;
  }));
  ipcMain.handle("library-skill-delete", (_e, ref: string) => env(() => {
    fs.rmSync(path.join(SKILLS_DIR, `${String(ref)}.json`), { force: true });
    return { deleted: true };
  }));
  ipcMain.handle("skills-create", (_e, input: { name?: string } | undefined) => env(() => {
    const name = String(input?.name ?? "New skill").trim() || "New skill";
    const slug = slugify(name);
    if (readRow(SKILLS_DIR, slug)) throw new Error(`a skill named "${slug}" already exists`);
    const row: SkillRow = {
      id: slug, slug, scope: "personal", name, description: "",
      hasCode: false, builtIn: false, schedule: null, updatedAt: new Date().toISOString(),
      manifest: { version: 1 }, prompt: "", code: "",
    };
    writeRow(SKILLS_DIR, slug, row);
    return row;
  }));

  // SCHEDULED TASKS — the Tasks view's exact lanes over the local scheduler.
  // Who has scheduled work, for the workbench Tasks panel's grouping. Slots
  // name AGENTS now; rows written before that hold a LOOP id in agent_id, so
  // an id the roster doesn't know falls back to reading it as a loop.
  ipcMain.handle("tasks-agents-list", () => env(() => {
    const withTasks = [...new Set(loadSchedules().map((s) => s.agent_id).filter(Boolean))];
    const roster = agentChoices?.() ?? [];
    const loops = listCliAgents();
    return withTasks.map((id) => {
      const agent = roster.find((a) => a.id === id);
      if (agent) return { id, slug: id, name: agent.name };
      const loop = loops.find((l) => l.id === id);
      return { id, slug: id, name: loop ? `${loop.name} (loop)` : id };
    });
  }));
  ipcMain.handle("tasks-for-agent", (_e, ref: string) => env(() => {
    const db = getLocalDb();
    return loadSchedules().filter((s) => s.agent_id === String(ref)).map((s) => {
      const last = db.prepare("SELECT started_at, status, error FROM loop_runs WHERE schedule_id = ? ORDER BY started_at DESC LIMIT 1")
        .get(s.id) as { started_at: string; status: string; error: string | null } | undefined;
      return {
        id: s.id, name: s.name, kind: "loop", target: s.loop_slug, cron: s.cron,
        enabled: s.enabled === 1,
        lastRunAt: last?.started_at ?? null, lastStatus: last?.status ?? null, lastError: last?.error ?? null,
      };
    });
  }));
  ipcMain.handle("tasks-run-list", (_e, _ref: string, taskId: string) => env(() =>
    (getLocalDb().prepare("SELECT * FROM loop_runs WHERE schedule_id = ? ORDER BY started_at DESC LIMIT 30").all(String(taskId)) as RunRow[])
      .map((r) => ({ id: r.id, startedAt: r.started_at, durationMs: r.duration_ms, status: r.status, error: r.error, output: r.output }))));
  ipcMain.handle("tasks-run-now", async (_e, _ref: string, taskId: string) => {
    try { await runSchedule(String(taskId)); return { ok: true }; }
    catch (err) { return { ok: false, error: err instanceof Error ? err.message : String(err) }; }
  });
  ipcMain.handle("tasks-set-enabled", (_e, _ref: string, taskId: string, patch: { enabled?: boolean }) => env(() => {
    const db = getLocalDb();
    if (patch?.enabled !== undefined) {
      db.prepare("UPDATE loop_schedules SET enabled = ? WHERE id = ?").run(patch.enabled ? 1 : 0, String(taskId));
    }
    const row = db.prepare("SELECT * FROM loop_schedules WHERE id = ?").get(String(taskId)) as ScheduleRow | undefined;
    if (row) armSchedule(row);
    return { updated: true };
  }));

  // Schedule CRUD — the loop detail's Schedule block writes here.
  ipcMain.handle("loop-schedules-list", (_e, loopSlug: string) => env(() =>
    loadSchedules().filter((s) => s.loop_slug === String(loopSlug))
      .map((s) => ({ id: s.id, agentId: s.agent_id, name: s.name, cron: s.cron, enabled: s.enabled === 1 }))));
  ipcMain.handle("loop-schedule-save", (_e, input: { loopSlug: string; agentId: string; cron: string; name?: string; id?: string }) => env(() => {
    const loop = getLoop(String(input.loopSlug));
    if (!cron.validate(String(input.cron ?? ""))) throw new Error("that cron expression doesn't parse (five fields, e.g. 0 9 * * 1-5)");
    const db = getLocalDb();
    const id = input.id ? String(input.id) : rid();
    const name = String(input.name ?? loop.name).trim() || loop.name;
    db.prepare(`INSERT INTO loop_schedules (id, agent_id, name, loop_slug, cron, enabled, created_at)
                VALUES (?, ?, ?, ?, ?, 1, datetime('now'))
                ON CONFLICT(id) DO UPDATE SET agent_id = excluded.agent_id, name = excluded.name, cron = excluded.cron`)
      .run(id, String(input.agentId), name, loop.slug, String(input.cron));
    const row = db.prepare("SELECT * FROM loop_schedules WHERE id = ?").get(id) as ScheduleRow;
    armSchedule(row);
    return { id };
  }));
  ipcMain.handle("loop-schedule-delete", (_e, id: string) => env(() => {
    liveJobs.get(String(id))?.stop();
    liveJobs.delete(String(id));
    getLocalDb().prepare("DELETE FROM loop_schedules WHERE id = ?").run(String(id));
    return { deleted: true };
  }));
}
