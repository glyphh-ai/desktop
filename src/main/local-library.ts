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
import { userScopedPath } from "./app-paths.js";
import { homedir } from "os";
import { spawn } from "child_process";
import { ipcMain } from "electron";
import cron, { type ScheduledTask } from "node-cron";
import { getLocalDb } from "./local-db.js";
import { listCliAgents, composeHeadless, type CliAgentListed } from "./cli-agents.js";
import { cliFix } from "./cli-auth.js";
import { getSkill as getSkillFolder } from "./skills-fs.js";

const TASKS_DIR = (): string => userScopedPath("tasks");
const SKILLS_DIR = (): string => userScopedPath("skills");

interface LoopRole { name: string; label?: string; description?: string; default?: string | null; model?: string | null }
interface LoopManifest { version?: number; type?: "turn" | "memory"; roles?: LoopRole[]; skills?: string[]; connections?: string[]; layout?: string }
export interface LoopRow {
  id: string; slug: string; scope: "personal"; ownerUserId: null;
  name: string; description: string; builtIn: boolean; updatedAt: string;
  manifest: LoopManifest; code: string;
}
export interface SkillManifest { version?: number; whenToUse?: string; allowedTools?: string[]; requires?: string[]; schedule?: string | null; model?: string | null }
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
  const row = readRow<LoopRow>(TASKS_DIR(), String(ref));
  if (!row) throw new Error(`loop "${ref}" not found`);
  return row;
}
function saveLoop(row: LoopRow): LoopRow {
  row.updatedAt = new Date().toISOString();
  writeRow(TASKS_DIR(), row.slug, row);
  return row;
}
export function listSkillRows(): SkillRow[] { return listRows<SkillRow>(SKILLS_DIR()); }
export function getSkillRow(ref: string): SkillRow { return getSkill(ref); }
export function getTaskRow(ref: string): LoopRow { return getLoop(ref); }
/** A hub install lands whole — manifest, prompt AND program (saveSkillRow is the page's identity/prompt editor). */
export function putSkillRow(input: { slug: string; name: string; description: string; manifest: SkillManifest; prompt: string; code: string }): SkillRow {
  const existing = readRow<SkillRow>(SKILLS_DIR(), input.slug);
  const row: SkillRow = {
    id: input.slug, slug: input.slug, scope: "personal", name: input.name, description: input.description,
    hasCode: !!input.code, builtIn: false, schedule: input.manifest.schedule ?? existing?.schedule ?? null,
    updatedAt: new Date().toISOString(), manifest: input.manifest, prompt: input.prompt, code: input.code,
  };
  writeRow(SKILLS_DIR(), input.slug, row);
  return row;
}
export function saveSkillRow(input: { slug?: string; name: string; description?: string; prompt?: string }): SkillRow {
  const name = String(input.name ?? "").trim();
  if (!name) throw new Error("a skill needs a name");
  const slug = input.slug ? String(input.slug) : slugify(name);
  const existing = readRow<SkillRow>(SKILLS_DIR(), slug);
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
  writeRow(SKILLS_DIR(), slug, row);
  return row;
}

function getSkill(ref: string): SkillRow {
  const row = readRow<SkillRow>(SKILLS_DIR(), String(ref));
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
export const slotAgentContext = (agentId: string): ScheduleContext | null => agentContext?.(agentId) ?? null;
export const slotAgentRoster = (): SlotAgent[] => agentChoices?.() ?? [];

/** The task runner (task-runner.ts) — late-bound, since it imports this module. */
let taskRunner: ((slug: string, scheduleId: string, input: unknown) => void) | null = null;
export function setTaskRunner(fn: (slug: string, scheduleId: string, input: unknown) => void): void { taskRunner = fn; }
interface RunRow {
  id: string; schedule_id: string; started_at: string; duration_ms: number | null; status: string;
  error: string | null; output: string | null;
  trigger?: string | null; input?: string | null; result?: string | null; journal?: string | null;
}

/** A journalled column is TEXT holding JSON; a missing or broken one is not
 *  worth failing a history read over. */
const jsonOr = <T>(raw: unknown, fallback: T): T | unknown => {
  if (raw == null) return fallback;
  if (typeof raw !== "string") return raw;
  try { return JSON.parse(raw) as unknown; } catch { return fallback; }
};

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

export interface ScheduleView {
  id: string; name: string; kind: "task" | "skill"; target: string; cron: string; enabled: boolean;
  agentId: string | null; agentName: string | null; args: string; createdAt: string;
  lastRunAt: string | null; lastStatus: string | null; lastError: string | null;
}

/** Everything on a clock, with how its last run went. */
export function listSchedulesView(): ScheduleView[] {
  const db = getLocalDb();
  const roster = agentChoices?.() ?? [];
  const loops = listCliAgents();
  return loadSchedules().map((s) => {
    const last = db.prepare("SELECT started_at, status, error FROM loop_runs WHERE schedule_id = ? ORDER BY started_at DESC LIMIT 1")
      .get(s.id) as { started_at: string; status: string; error: string | null } | undefined;
    const agent = roster.find((a) => a.id === s.agent_id);
    const loop = loops.find((l) => l.id === s.agent_id);
    return {
      id: s.id, name: s.name, kind: s.kind === "skill" ? "skill" : "task", target: s.target || s.loop_slug,
      cron: s.cron, enabled: s.enabled === 1, agentId: s.agent_id || null,
      agentName: agent?.name ?? (loop ? `${loop.name} (loop)` : s.agent_id || null),
      args: s.args || "{}", createdAt: s.created_at,
      lastRunAt: last?.started_at ?? null, lastStatus: last?.status ?? null, lastError: last?.error ?? null,
    };
  });
}

/** Put a task or a skill on a clock, or change one that is already there. */
export function saveSchedule(input: { id?: string; name?: string; kind?: string; target: string; agentId?: string | null; cron: string; enabled?: boolean; args?: unknown }): { id: string } {
  if (!cron.validate(String(input.cron ?? ""))) throw new Error("that cron expression doesn't parse (five fields, e.g. 0 9 * * 1-5)");
  const kind = input.kind === "skill" ? "skill" : "task";
  const target = String(input.target || "").trim();
  if (!target) throw new Error("a schedule needs something to run");
  if (kind === "skill") getSkillFolder(`glyphh:${target}`);
  const db = getLocalDb();
  const id = input.id ? String(input.id) : rid();
  const name = String(input.name ?? "").trim() || target;
  const agentId = input.agentId ? String(input.agentId) : (kind === "skill" ? (agentChoices?.()[0]?.id ?? "") : "");
  if (kind === "skill" && !agentId) throw new Error("a skill needs an agent to run through");
  db.prepare(`INSERT INTO loop_schedules (id, agent_id, name, loop_slug, cron, enabled, created_at, kind, target, args)
              VALUES (?, ?, ?, ?, ?, ?, datetime('now'), ?, ?, ?)
              ON CONFLICT(id) DO UPDATE SET agent_id = excluded.agent_id, name = excluded.name, loop_slug = excluded.loop_slug, cron = excluded.cron,
                enabled = excluded.enabled, kind = excluded.kind, target = excluded.target, args = excluded.args`)
    .run(id, agentId, name, target, String(input.cron), input.enabled === false ? 0 : 1, kind, target, JSON.stringify(input.args ?? {}));
  const row = db.prepare("SELECT * FROM loop_schedules WHERE id = ?").get(id) as ScheduleRow;
  armSchedule(row);
  return { id };
}

/**
 * A BUNDLE'S SCHEDULE IS AN INTENT (his report, 2026-09-17: "I don't see the
 * schedule for this task either").
 *
 * A task saved with `schedule` in its manifest never fired and appeared on no
 * page, because the clock is `loop_schedules` and nothing mirrored the
 * manifest into it. The row stays the truth: this creates the first one and
 * then leaves it alone, so a schedule the user edits or deletes is never
 * resurrected behind their back.
 */
export function ensureTaskSchedule(slug: string, cron: string | null, name?: string): { id: string; cron: string } | null {
  const target = String(slug || "").trim();
  if (!target || !cron) return null;
  const have = listSchedulesView().find((s) => s.kind === "task" && s.target === target);
  if (have) return { id: have.id, cron: have.cron };
  const { id } = saveSchedule({ kind: "task", target, cron, name: name || target });
  return { id, cron };
}

/** What this task is on the clock for, if anything. */
export const scheduleForTask = (slug: string): { id: string; cron: string; enabled: boolean } | null => {
  const row = listSchedulesView().find((s) => s.kind === "task" && s.target === String(slug || "").trim());
  return row ? { id: row.id, cron: row.cron, enabled: row.enabled } : null;
};

/** Take it off the clock. Its run history stays. */
export function deleteSchedule(id: string): { deleted: boolean } {
  liveJobs.get(String(id))?.stop();
  liveJobs.delete(String(id));
  getLocalDb().prepare("DELETE FROM loop_schedules WHERE id = ?").run(String(id));
  return { deleted: true };
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
    // A skill is a folder now (skills-fs); the JSON row is the pre-folder shape.
    try { const folder = getSkillFolder(`glyphh:${ref}`); return { text: folder.body.trim() || folder.description || folder.name }; } catch { /* legacy row below */ }
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
  // A TASK on a clock: the bundle's program runs in its own process and
  // journals its own run (task-runner.ts). Nothing here composes a prompt.
  if (sched.kind === "task") {
    if (!taskRunner) throw new Error("the task runner is not up");
    let input: unknown = {};
    try { input = JSON.parse(sched.args || "{}"); } catch { input = {}; }
    taskRunner(sched.target || sched.loop_slug, sched.id, input);
    return;
  }
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
  // A known CLI refusal is reported in the user's words (cliFix), the CLI's
  // own line kept underneath; anything else keeps the CLI's text.
  const fix = r.code === 0 ? null : cliFix(`${r.error || ""}\n${r.output.slice(-2000)}`, loop.cli || "claude");
  finish(r.code === 0 ? "ok" : "failed", r.code === 0 ? null : fix ? fix.message : r.error ?? `exit ${r.code}`, r.output || null);
}

export function execHeadless(line: string): Promise<{ code: number; output: string; error?: string }> {
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

// ── IPC — the exact lanes the main-era UX rides ──────────────────────────────

export function registerLocalLibraryIpc(): void {
  // LOOPS
  ipcMain.handle("loops-list", () => ({
    loops: listRows<LoopRow>(TASKS_DIR())
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
    fs.rmSync(path.join(TASKS_DIR(), `${String(ref)}.json`), { force: true });
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
    if (readRow(TASKS_DIR(), slug)) throw new Error(`a loop named "${slug}" already exists`);
    const row: LoopRow = {
      id: slug, slug, scope: "personal", ownerUserId: null,
      name, description: "", builtIn: false, updatedAt: new Date().toISOString(),
      manifest: { version: 1, type: "turn", roles: [{ name: "main", label: "Main", description: "The agent this loop runs on.", default: null }] },
      code: "",
    };
    writeRow(TASKS_DIR(), slug, row);
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
    listRows<SkillRow>(SKILLS_DIR())
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
    writeRow(SKILLS_DIR(), row.slug, row);
    return row;
  }));
  ipcMain.handle("library-skill-delete", (_e, ref: string) => env(() => {
    fs.rmSync(path.join(SKILLS_DIR(), `${String(ref)}.json`), { force: true });
    return { deleted: true };
  }));
  ipcMain.handle("skills-create", (_e, input: { name?: string } | undefined) => env(() => {
    const name = String(input?.name ?? "New skill").trim() || "New skill";
    const slug = slugify(name);
    if (readRow(SKILLS_DIR(), slug)) throw new Error(`a skill named "${slug}" already exists`);
    const row: SkillRow = {
      id: slug, slug, scope: "personal", name, description: "",
      hasCode: false, builtIn: false, schedule: null, updatedAt: new Date().toISOString(),
      manifest: { version: 1 }, prompt: "", code: "",
    };
    writeRow(SKILLS_DIR(), slug, row);
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

  // SCHEDULES (Settings → Customize → Schedules): anything on a clock — a
  // task bundle (its program runs itself) or a skill (its text through an
  // agent). One table, one runner, the run feed shared.
  ipcMain.handle("schedules-list", () => env(listSchedulesView));
  ipcMain.handle("schedule-save", (_e, input: { id?: string; name?: string; kind: "task" | "skill"; target: string; agentId?: string | null; cron: string; enabled?: boolean; args?: unknown }) => env(() => saveSchedule(input)));
  ipcMain.handle("schedule-set-enabled", (_e, id: string, enabled: boolean) => env(() => {
    const db = getLocalDb();
    db.prepare("UPDATE loop_schedules SET enabled = ? WHERE id = ?").run(enabled ? 1 : 0, String(id));
    const row = db.prepare("SELECT * FROM loop_schedules WHERE id = ?").get(String(id)) as ScheduleRow | undefined;
    if (row) armSchedule(row);
    return { updated: !!row };
  }));
  ipcMain.handle("schedule-delete", (_e, id: string) => env(() => deleteSchedule(String(id))));
  ipcMain.handle("schedule-run-now", async (_e, id: string) => {
    try { await runSchedule(String(id)); return { ok: true }; }
    catch (err) { return { ok: false, error: err instanceof Error ? err.message : String(err) }; }
  });
  ipcMain.handle("schedule-runs", (_e, id: string) => env(() =>
    // ALL OF IT (his order, 2026-09-17): the schedule's own page is where the
    // whole history lives, so this is the deep read; the card and the recents
    // lane are the shallow ones.
    (getLocalDb().prepare("SELECT * FROM loop_runs WHERE schedule_id = ? ORDER BY started_at DESC LIMIT 500").all(String(id)) as Array<RunRow & { task_slug?: string | null }>)
      // THE WHOLE ROW (his order, 2026-09-17): the schedule's history renders
      // with the same renderer as a bundle's Runs tab, which tells the story
      // from the journal, so the journal has to come with it.
      .map((r) => ({
        id: r.id, startedAt: r.started_at, durationMs: r.duration_ms, status: r.status, error: r.error,
        output: r.output, taskSlug: r.task_slug ?? null, trigger: r.trigger ?? null,
        input: jsonOr(r.input, null), result: jsonOr(r.result, null), journal: jsonOr(r.journal, { checkpoints: {}, events: [] }),
      }))));
  // ONE RUN, WHOLE (his report, 2026-09-18: a run in Recent runs would not
  // open). The recent lanes are deliberately shallow - a journal per row, 60
  // rows deep, is megabytes nobody asked for - so a row expands by reading
  // its own story here, once.
  ipcMain.handle("run-get", (_e, id: string) => env(() => {
    const r = getLocalDb().prepare("SELECT * FROM loop_runs WHERE id = ?").get(String(id)) as (RunRow & { task_slug?: string | null }) | undefined;
    if (!r) throw new Error("that run is no longer on this machine");
    return {
      id: r.id, startedAt: r.started_at, durationMs: r.duration_ms, status: r.status, error: r.error,
      output: r.output, taskSlug: r.task_slug ?? null, trigger: r.trigger ?? null,
      input: jsonOr(r.input, null), result: jsonOr(r.result, null), journal: jsonOr(r.journal, { checkpoints: {}, events: [] }),
    };
  }));
  ipcMain.handle("schedule-recent-runs", () => env(() =>
    (getLocalDb().prepare(`SELECT r.*, s.name AS schedule_name FROM loop_runs r LEFT JOIN loop_schedules s ON s.id = r.schedule_id ORDER BY r.started_at DESC LIMIT 60`).all() as Array<RunRow & { schedule_name: string | null; task_slug?: string | null; trigger?: string | null }>)
      .map((r) => ({ id: r.id, scheduleId: r.schedule_id || null, scheduleName: r.schedule_name, taskSlug: r.task_slug ?? null, trigger: r.trigger ?? null, startedAt: r.started_at, durationMs: r.duration_ms, status: r.status, error: r.error }))));
}
