/**
 * local-agents.ts — AGENTS, restored local (2026-09-11).
 *
 * An agent is a STANDING WORKER, the thing a session isn't: a name, a
 * standing prompt, the LOOP it runs on, what it may reach (skills, apps),
 * and the scheduled tasks it fires. Where a session is you driving a loop,
 * an agent is the same machinery running without you.
 *
 *   ~/.glyphh/agents/<slug>.json   — the agent record (below)
 *   user-state.sqlite              — its tasks ARE loop_schedules rows
 *                                    stamped owner_agent_id (migration 10)
 *
 * Restored from the pre-purge page (4cae30db^:help/agents.ts) and ported to
 * local storage on his ruling: the shape, the form and the operational
 * detail view survive; the server-side `scope: personal|org` does not —
 * there is no server to enforce org sharing, and a selector that silently
 * did nothing would be a lie.
 *
 * TASKS REUSE THE SCHEDULER on purpose. local-library.ts already arms crons,
 * captures runs and serves the run feed; an agent task is one of its rows
 * with an owner. No parallel scheduler, no second run table.
 */

import fs from "fs";
import path from "path";
import { userScopedPath } from "./app-paths.js";
import { homedir } from "os";
import { ipcMain } from "electron";
import cron from "node-cron";
import { getLocalDb } from "./local-db.js";
import {
  armSchedule, runSchedule, setAgentProviders,
  type ScheduleRow, type ScheduleContext, type SlotAgent,
} from "./local-library.js";

const AGENTS_DIR = (): string => userScopedPath("agents");

/** Local caps. Blank fields mean "no cap" — the pre-purge page called these
 *  guardrails and inherited an org ceiling; locally there is no ceiling, so
 *  these are the only limits there are. */
export interface GuardrailsPolicy {
  maxInputTokens?: number | null;
  maxOutputTokens?: number | null;
  windowSeconds?: number | null;
  windowTokens?: number | null;
  windowCalls?: number | null;
  maxConcurrent?: number | null;
}

export interface AgentRow {
  id: string;
  slug: string;
  name: string;
  description: string;
  /** The standing instruction every one of this agent's runs opens with. */
  prompt: string;
  /** Which CLI loop runs it (a cli-agents.ts id). Null when the agent is a
   *  PROVIDER agent instead — an agent is one or the other, never both. */
  loopId: string | null;
  /** The provider slug when this agent is a provider+model agent (no CLI):
   *  the model on its own, for work that is just thinking and writing. */
  provider: string;
  /** Optional model override; empty = the loop's own model. */
  model: string;
  /** Skill slugs this agent may load. */
  skills: string[];
  /** App slugs this agent may drive. */
  apps: string[];
  /** Armed — false parks every task without deleting its schedule. */
  live: boolean;
  guardrails: GuardrailsPolicy | null;
  createdAt: string;
  updatedAt: string;
}

/** What the renderer renders per task — a schedule row in the page's words. */
export interface AgentTaskRow {
  id: string;
  agentId: string;
  name: string;
  kind: "task" | "skill";
  target: string;
  args: Record<string, unknown>;
  cron: string;
  enabled: boolean;
  lastRunAt: string | null;
  lastStatus: string | null;
  lastError: string | null;
}

const slugify = (name: string): string =>
  name.trim().toLowerCase().replace(/[^\w.-]+/g, "-").replace(/^-+|-+$/g, "") || "agent";

const env = <T>(fn: () => T): { ok: boolean; data?: T; error?: string } => {
  try { return { ok: true, data: fn() }; }
  catch (err) { return { ok: false, error: err instanceof Error ? err.message : String(err) }; }
};

const rid = (): string => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

// ── Store ────────────────────────────────────────────────────────────────────

function readAgent(slug: string): AgentRow | null {
  try { return JSON.parse(fs.readFileSync(path.join(AGENTS_DIR(), `${slug}.json`), "utf-8")) as AgentRow; }
  catch { return null; }
}

function writeAgent(row: AgentRow): void {
  fs.mkdirSync(AGENTS_DIR(), { recursive: true });
  const file = path.join(AGENTS_DIR(), `${row.slug}.json`);
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(row, null, 2), "utf-8");
  fs.renameSync(`${file}.tmp`, file);
}

export function listAgents(): AgentRow[] {
  let names: string[] = [];
  try { names = fs.readdirSync(AGENTS_DIR()).filter((n) => n.endsWith(".json")); } catch { return []; }
  return names
    .map((n) => readAgent(n.slice(0, -5)))
    .filter((a): a is AgentRow => !!a)
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function getAgent(ref: string): AgentRow {
  const row = readAgent(String(ref));
  if (!row) throw new Error(`agent "${ref}" not found`);
  return row;
}

interface AgentInput {
  slug?: string; name?: string; description?: string; prompt?: string;
  loopId?: string | null; provider?: string; model?: string; skills?: string[]; apps?: string[];
  live?: boolean; guardrails?: GuardrailsPolicy | null;
}

const numOrNull = (v: unknown): number | null => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
};

function cleanGuardrails(g: GuardrailsPolicy | null | undefined): GuardrailsPolicy | null {
  if (!g) return null;
  const out: GuardrailsPolicy = {
    maxInputTokens: numOrNull(g.maxInputTokens),
    maxOutputTokens: numOrNull(g.maxOutputTokens),
    windowSeconds: numOrNull(g.windowSeconds),
    windowTokens: numOrNull(g.windowTokens),
    windowCalls: numOrNull(g.windowCalls),
    maxConcurrent: numOrNull(g.maxConcurrent),
  };
  // All blank = no policy at all, so the detail view says "none" instead of
  // rendering six empty rows.
  return Object.values(out).some((v) => v !== null) ? out : null;
}

export function saveAgent(input: AgentInput): AgentRow {
  const name = String(input.name ?? "").trim();
  if (!name) throw new Error("an agent needs a name");
  const slug = slugify(String(input.slug || name));
  const existing = readAgent(slug);
  const now = new Date().toISOString();
  const row: AgentRow = {
    id: slug,
    slug,
    name,
    description: String(input.description ?? existing?.description ?? ""),
    prompt: String(input.prompt ?? existing?.prompt ?? ""),
    loopId: input.loopId === undefined ? existing?.loopId ?? null : (input.loopId || null),
    provider: input.provider === undefined ? existing?.provider ?? "" : String(input.provider || ""),
    model: String(input.model ?? existing?.model ?? ""),
    skills: Array.isArray(input.skills) ? input.skills.map(String) : existing?.skills ?? [],
    apps: Array.isArray(input.apps) ? input.apps.map(String) : existing?.apps ?? [],
    live: input.live === undefined ? existing?.live ?? true : !!input.live,
    guardrails: input.guardrails === undefined ? existing?.guardrails ?? null : cleanGuardrails(input.guardrails),
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
  writeAgent(row);
  // Live flips park or arm every one of its tasks at once.
  if (!existing || existing.live !== row.live) rearmTasksOf(row.slug);
  return row;
}

export function deleteAgent(ref: string): void {
  const slug = String(ref);
  const db = getLocalDb();
  // Its schedules go with it — an orphaned cron with no agent to frame it
  // would keep firing a prompt nobody can see or edit.
  for (const t of rawTasksOf(slug)) disarm(t.id);
  db.prepare("DELETE FROM loop_runs WHERE schedule_id IN (SELECT id FROM loop_schedules WHERE owner_agent_id = ?)").run(slug);
  db.prepare("DELETE FROM loop_schedules WHERE owner_agent_id = ?").run(slug);
  fs.rmSync(path.join(AGENTS_DIR(), `${slug}.json`), { force: true });
}

// ── Tasks (schedule rows owned by an agent) ──────────────────────────────────

function rawTasksOf(agentSlug: string): ScheduleRow[] {
  return getLocalDb()
    .prepare("SELECT * FROM loop_schedules WHERE owner_agent_id = ? ORDER BY created_at")
    .all(String(agentSlug)) as ScheduleRow[];
}

/** The last run of a schedule — the card's status line. */
function lastRunOf(scheduleId: string): { at: string; status: string; error: string | null } | null {
  const r = getLocalDb()
    .prepare("SELECT started_at, status, error FROM loop_runs WHERE schedule_id = ? ORDER BY started_at DESC LIMIT 1")
    .get(scheduleId) as { started_at: string; status: string; error: string | null } | undefined;
  return r ? { at: r.started_at, status: r.status, error: r.error } : null;
}

const taskOf = (r: ScheduleRow): AgentTaskRow => {
  const last = lastRunOf(r.id);
  let args: Record<string, unknown> = {};
  try { args = JSON.parse(r.args || "{}") as Record<string, unknown>; } catch { /* corrupt args → none */ }
  return {
    id: r.id,
    agentId: r.owner_agent_id ?? "",
    name: r.name,
    kind: r.kind === "skill" ? "skill" : "task",
    target: r.target || r.loop_slug,
    args,
    cron: r.cron,
    enabled: !!r.enabled,
    lastRunAt: last?.at ?? null,
    lastStatus: last?.status ?? null,
    lastError: last?.error ?? null,
  };
};

export function listAgentTasks(agentSlug: string): AgentTaskRow[] {
  return rawTasksOf(agentSlug).map(taskOf);
}

function disarm(scheduleId: string): void {
  // armSchedule with enabled = 0 stops the live job without touching the row.
  const row = getLocalDb().prepare("SELECT * FROM loop_schedules WHERE id = ?").get(scheduleId) as ScheduleRow | undefined;
  if (row) armSchedule({ ...row, enabled: 0 });
}

/** Re-arm (or park) every task of an agent — after a live flip or an edit. */
function rearmTasksOf(agentSlug: string): void {
  const agent = readAgent(agentSlug);
  for (const row of rawTasksOf(agentSlug)) {
    // A parked agent arms nothing, whatever its tasks say.
    armSchedule(agent?.live ? row : { ...row, enabled: 0 });
  }
}

interface TaskInput {
  name?: string; kind?: "task" | "skill"; target?: string;
  args?: Record<string, unknown>; cron?: string; enabled?: boolean;
}

export function addAgentTask(agentSlug: string, input: TaskInput): AgentTaskRow {
  const agent = getAgent(agentSlug);
  const name = String(input.name ?? "").trim();
  if (!name) throw new Error("a task needs a name");
  const target = String(input.target ?? "").trim();
  if (!target) throw new Error("a task needs something to run");
  const schedule = String(input.cron ?? "").trim();
  if (schedule && !cron.validate(schedule)) throw new Error(`"${schedule}" is not a valid cron expression`);
  const id = rid();
  const row: ScheduleRow = {
    id,
    // agent_id on this table is the CLI LOOP (pre-rename name). The agent's
    // own loop is the one that runs its work.
    agent_id: agent.loopId ?? "",
    name,
    loop_slug: target,
    cron: schedule,
    enabled: input.enabled === false ? 0 : 1,
    created_at: new Date().toISOString(),
    owner_agent_id: agent.slug,
    kind: input.kind === "skill" ? "skill" : "task",
    target,
    args: JSON.stringify(input.args ?? {}),
  };
  getLocalDb().prepare(
    `INSERT INTO loop_schedules (id, agent_id, name, loop_slug, cron, enabled, created_at, owner_agent_id, kind, target, args)
     VALUES (@id, @agent_id, @name, @loop_slug, @cron, @enabled, @created_at, @owner_agent_id, @kind, @target, @args)`
  ).run(row);
  if (agent.live) armSchedule(row);
  return taskOf(row);
}

export function updateAgentTask(agentSlug: string, taskId: string, patch: TaskInput): AgentTaskRow {
  const db = getLocalDb();
  const cur = db.prepare("SELECT * FROM loop_schedules WHERE id = ? AND owner_agent_id = ?")
    .get(String(taskId), String(agentSlug)) as ScheduleRow | undefined;
  if (!cur) throw new Error("task not found");
  const schedule = patch.cron === undefined ? cur.cron : String(patch.cron).trim();
  if (schedule && !cron.validate(schedule)) throw new Error(`"${schedule}" is not a valid cron expression`);
  const target = patch.target === undefined ? (cur.target || cur.loop_slug) : String(patch.target).trim();
  const next: ScheduleRow = {
    ...cur,
    name: patch.name === undefined ? cur.name : String(patch.name).trim() || cur.name,
    kind: patch.kind === undefined ? cur.kind : (patch.kind === "skill" ? "skill" : "task"),
    target,
    loop_slug: target,
    cron: schedule,
    enabled: patch.enabled === undefined ? cur.enabled : (patch.enabled ? 1 : 0),
    args: patch.args === undefined ? cur.args : JSON.stringify(patch.args ?? {}),
  };
  db.prepare(
    `UPDATE loop_schedules SET name = @name, kind = @kind, target = @target, loop_slug = @loop_slug,
     cron = @cron, enabled = @enabled, args = @args WHERE id = @id`
  ).run(next);
  const agent = readAgent(agentSlug);
  armSchedule(agent?.live ? next : { ...next, enabled: 0 });
  return taskOf(next);
}

export function deleteAgentTask(agentSlug: string, taskId: string): void {
  const db = getLocalDb();
  disarm(String(taskId));
  db.prepare("DELETE FROM loop_runs WHERE schedule_id = ?").run(String(taskId));
  db.prepare("DELETE FROM loop_schedules WHERE id = ? AND owner_agent_id = ?").run(String(taskId), String(agentSlug));
}

export function listAgentTaskRuns(taskId: string): Array<{ id: string; startedAt: string; durationMs: number | null; status: string; error: string | null; output: string | null }> {
  const rows = getLocalDb().prepare(
    "SELECT * FROM loop_runs WHERE schedule_id = ? ORDER BY started_at DESC LIMIT 30"
  ).all(String(taskId)) as Array<{ id: string; started_at: string; duration_ms: number | null; status: string; error: string | null; output: string | null }>;
  return rows.map((r) => ({
    id: r.id, startedAt: r.started_at, durationMs: r.duration_ms,
    status: r.status, error: r.error, output: r.output,
  }));
}

/** Is a run in flight? The feed polls this to show the running row. */
export function agentTaskRunning(taskId: string): boolean {
  const r = getLocalDb()
    .prepare("SELECT 1 FROM loop_runs WHERE schedule_id = ? AND status = 'running' LIMIT 1")
    .get(String(taskId));
  return !!r;
}

// ── Wiring ───────────────────────────────────────────────────────────────────

/** What this agent brings to a run (see local-library's ScheduleContext):
 *  the loop that does the work, the standing prompt, the model override. */
function agentContext(agentId: string): ScheduleContext | null {
  const agent = readAgent(agentId);
  if (!agent) return null;
  // A PROVIDER agent has no CLI to spawn — its turn goes through the gateway
  // (router.glyphh.ai + a minted member key), which is not wired yet. Return
  // nothing rather than quietly borrowing some other loop's CLI; the run
  // records a readable failure instead of doing the wrong work silently.
  if (!agent.loopId) return null;
  return {
    loopId: agent.loopId,
    prompt: agent.prompt,
    ...(agent.model ? { model: agent.model } : {}),
  };
}

/** The roster a TASK SLOT picks from. Paused agents still appear — a slot
 *  binding is authoring, not arming; the live switch is what arms. */
function agentRoster(): SlotAgent[] {
  return listAgents().map((a) => ({
    id: a.id,
    name: a.provider ? `${a.name} — ${a.provider}` : a.name,
    loopId: a.loopId,
  }));
}

export function registerLocalAgentsIpc(): void {
  setAgentProviders(agentContext, agentRoster);

  // Channel names are the PRE-PURGE ones (4cae30db^) so the restored page
  // wires to them unchanged. The Tasks page's by-loop lane, which had
  // squatted several of these, moved to tasks-* in local-library.ts.
  ipcMain.handle("library-agents-list", () => env(() => listAgents()));
  ipcMain.handle("library-agent-get", (_e, ref: string) => env(() => getAgent(ref)));
  ipcMain.handle("library-agent-create", (_e, input: AgentInput) => env(() => saveAgent(input)));
  ipcMain.handle("library-agent-update", (_e, ref: string, input: AgentInput) =>
    env(() => saveAgent({ ...input, slug: String(ref) })));
  ipcMain.handle("library-agent-delete", (_e, ref: string) => env(() => { deleteAgent(ref); return true; }));

  ipcMain.handle("library-agent-tasks", (_e, agentSlug: string) => env(() => listAgentTasks(agentSlug)));
  ipcMain.handle("library-agent-task-add", (_e, agentSlug: string, input: TaskInput) => env(() => addAgentTask(agentSlug, input)));
  ipcMain.handle("library-agent-task-update", (_e, agentSlug: string, taskId: string, patch: TaskInput) =>
    env(() => updateAgentTask(agentSlug, taskId, patch)));
  ipcMain.handle("library-agent-task-delete", (_e, agentSlug: string, taskId: string) =>
    env(() => { deleteAgentTask(agentSlug, taskId); return true; }));
  ipcMain.handle("library-agent-task-runs", (_e, _agentSlug: string, taskId: string) => env(() => listAgentTaskRuns(taskId)));
  ipcMain.handle("library-agent-task-running", (_e, _agentSlug: string, taskId: string) => env(() => agentTaskRunning(taskId)));
  // Run NOW, off-schedule. Resolves when the run FINISHES so the caller can
  // refresh the feed on completion rather than guessing at a delay.
  ipcMain.handle("library-agent-task-run-now", async (_e, _agentSlug: string, taskId: string) => {
    try { await runSchedule(String(taskId)); return { ok: true, data: true }; }
    catch (err) { return { ok: false, error: err instanceof Error ? err.message : String(err) }; }
  });
}

/** Boot: park the tasks of every non-live agent. The generic scheduler arms
 *  by the row's own `enabled`, which knows nothing about its owner. */
export function reconcileAgentSchedules(): void {
  try { for (const a of listAgents()) if (!a.live) rearmTasksOf(a.slug); }
  catch (err) { console.error("[agents] schedule reconcile failed:", err instanceof Error ? err.message : err); }
}
