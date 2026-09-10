/**
 * local-tasks.ts — TASKS, the one work primitive (his collapse, 2026-09-10).
 *
 * A task is an ordered set of STEPS, each slotted to a CLI AGENT (Claude for
 * x, Gemini for y — the slots are the power), run one-off, on a cron, or
 * REPEATED (a bounded recursive pass over the steps).
 *
 *   ~/.glyphh/tasks/<slug>.json — { slug, name, description,
 *       steps: [{ name?, agent, model?, program }], repeat, createdAt/updatedAt }
 *   user-state.sqlite           — task_schedules + task_runs (migration 10)
 *
 * EXECUTION: steps run sequentially and headlessly through each step's
 * agent (claude -p / codex exec / gemini -p, riding that agent's env/model/
 * MCP wiring); every step after the first receives the previous step's
 * output appended to its program. `repeat` > 1 re-walks the whole step list,
 * stopping early when an iteration's final output contains DONE.
 *
 * Loops were this idea's first draft — existing ~/.glyphh/loops rows import
 * once as single-step tasks, then the loops dir retires.
 */

import fs from "fs";
import path from "path";
import os from "os";
import { spawn } from "child_process";
import { ipcMain } from "electron";
import cron, { type ScheduledTask } from "node-cron";
import { getLocalDb } from "./local-db.js";
import { listCliAgents, composeHeadless } from "./cli-agents.js";

const TASKS_DIR = path.join(os.homedir(), ".glyphh", "tasks");
const LOOPS_DIR = path.join(os.homedir(), ".glyphh", "loops");

export interface TaskStep { name?: string; agent: string; model?: string; program: string }
export interface TaskRow {
  slug: string;
  name: string;
  description: string;
  steps: TaskStep[];
  /** Walk the step list this many times (bounded recursion); an iteration
   *  whose final output contains "DONE" stops early. Default 1. */
  repeat: number;
  createdAt: string;
  updatedAt: string;
}

const slugify = (name: string): string =>
  name.trim().toLowerCase().replace(/[^\w.-]+/g, "-").replace(/^-+|-+$/g, "") || "task";

const env = <T>(fn: () => T): { ok: boolean; data?: T; error?: string } => {
  try { return { ok: true, data: fn() }; }
  catch (err) { return { ok: false, error: err instanceof Error ? err.message : String(err) }; }
};

function readTask(slug: string): TaskRow | null {
  try {
    const row = JSON.parse(fs.readFileSync(path.join(TASKS_DIR, `${slug}.json`), "utf-8")) as TaskRow;
    if (!row?.slug) return null;
    row.steps = Array.isArray(row.steps) ? row.steps : [];
    row.repeat = Number.isFinite(row.repeat) && row.repeat >= 1 ? Math.min(25, Math.floor(row.repeat)) : 1;
    return row;
  } catch {
    return null;
  }
}

function writeTask(row: TaskRow): TaskRow {
  fs.mkdirSync(TASKS_DIR, { recursive: true });
  const file = path.join(TASKS_DIR, `${row.slug}.json`);
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(row, null, 2), "utf-8");
  fs.renameSync(`${file}.tmp`, file);
  return row;
}

export function saveTaskRow(input: Partial<TaskRow> & { name: string }): TaskRow {
  const name = String(input?.name ?? "").trim();
  if (!name) throw new Error("a task needs a name");
  const slug = input.slug ? String(input.slug) : slugify(name);
  const existing = readTask(slug);
  const now = new Date().toISOString();
  const steps = (Array.isArray(input.steps) ? input.steps : existing?.steps ?? [])
    .map((st) => ({
      ...(st.name ? { name: String(st.name) } : {}),
      agent: String(st.agent ?? ""),
      ...(st.model ? { model: String(st.model) } : {}),
      program: String(st.program ?? ""),
    }))
    .filter((st) => st.program.trim());
  return writeTask({
    slug,
    name,
    description: String(input.description ?? existing?.description ?? ""),
    steps,
    repeat: Number.isFinite(input.repeat) && Number(input.repeat) >= 1 ? Math.min(25, Math.floor(Number(input.repeat))) : existing?.repeat ?? 1,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  });
}

export function listTaskRuns(slug: string): Array<{ id: string; startedAt: string; durationMs: number | null; status: string; error: string | null; output: string | null }> {
  return (getLocalDb().prepare("SELECT * FROM task_runs WHERE task_slug = ? ORDER BY started_at DESC LIMIT 30").all(String(slug)) as RunRow[])
    .map((r) => ({ id: r.id, startedAt: r.started_at, durationMs: r.duration_ms, status: r.status, error: r.error, output: r.output }));
}

export function listTasks(): TaskRow[] {
  migrateLoopsOnce();
  let names: string[] = [];
  try { names = fs.readdirSync(TASKS_DIR).filter((n) => n.endsWith(".json")); } catch { return []; }
  const out: TaskRow[] = [];
  for (const n of names) {
    const row = readTask(n.slice(0, -5));
    if (row) out.push(row);
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** Loops were the first draft — each becomes a single-step task, once. */
let loopsMigrated = false;
function migrateLoopsOnce(): void {
  if (loopsMigrated) return;
  loopsMigrated = true;
  let names: string[] = [];
  try { names = fs.readdirSync(LOOPS_DIR).filter((n) => n.endsWith(".json")); } catch { return; }
  let moved = 0;
  for (const n of names) {
    try {
      const loop = JSON.parse(fs.readFileSync(path.join(LOOPS_DIR, n), "utf-8")) as {
        slug?: string; name?: string; description?: string; code?: string;
        manifest?: { roles?: Array<{ default?: string | null }> };
      };
      const slug = String(loop.slug || n.slice(0, -5));
      if (readTask(slug)) continue;
      const now = new Date().toISOString();
      writeTask({
        slug,
        name: String(loop.name || slug),
        description: String(loop.description || ""),
        steps: [{ agent: String(loop.manifest?.roles?.[0]?.default || ""), program: String(loop.code || "") }],
        repeat: 1,
        createdAt: now,
        updatedAt: now,
      });
      moved++;
    } catch { /* not a loop — skip */ }
  }
  if (moved) {
    try { fs.renameSync(LOOPS_DIR, `${LOOPS_DIR}.migrated`); } catch { /* best effort */ }
    console.log(`[tasks] imported ${moved} loop(s) as single-step tasks`);
  }
}

// ── Schedules + the runner ───────────────────────────────────────────────────

interface ScheduleRow { id: string; task_slug: string; name: string; cron: string; enabled: number; created_at: string }
interface RunRow { id: string; task_slug: string; schedule_id: string | null; started_at: string; duration_ms: number | null; status: string; error: string | null; output: string | null }

const rid = (): string => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
const liveJobs = new Map<string, ScheduledTask>();

function loadSchedules(): ScheduleRow[] {
  return getLocalDb().prepare("SELECT * FROM task_schedules ORDER BY created_at").all() as ScheduleRow[];
}

function armSchedule(row: ScheduleRow): void {
  liveJobs.get(row.id)?.stop();
  liveJobs.delete(row.id);
  if (!row.enabled || !cron.validate(row.cron)) return;
  liveJobs.set(row.id, cron.schedule(row.cron, () => { void runTask(row.task_slug, row.id).catch(() => {}); }));
}

export function startTaskScheduler(): void {
  try { for (const row of loadSchedules()) armSchedule(row); }
  catch (err) { console.error("[tasks] scheduler boot failed:", err instanceof Error ? err.message : err); }
}

export function stopTaskScheduler(): void {
  for (const t of liveJobs.values()) { try { t.stop(); } catch { /* down */ } }
  liveJobs.clear();
}

function sh(line: string): Promise<{ code: number; output: string }> {
  return new Promise((resolve) => {
    const child = spawn("/bin/sh", ["-lc", line], { env: process.env });
    let out = "";
    const cap = (b: Buffer): void => { if (out.length < 60_000) out += b.toString(); };
    child.stdout.on("data", cap);
    child.stderr.on("data", cap);
    const timer = setTimeout(() => { try { child.kill("SIGKILL"); } catch { /* raced */ } }, 10 * 60 * 1000);
    child.on("close", (code) => { clearTimeout(timer); resolve({ code: code ?? 1, output: out.trim() }); });
    child.on("error", (err) => { clearTimeout(timer); resolve({ code: 1, output: `${out}\n${err.message}`.trim() }); });
  });
}

/** Run a task now — every step through ITS slotted agent, outputs chaining
 *  forward; `repeat` re-walks the list (stop early on DONE). */
export async function runTask(taskSlug: string, scheduleId: string | null = null): Promise<{ status: string; output: string }> {
  const db = getLocalDb();
  const task = readTask(taskSlug);
  if (!task) throw new Error(`task "${taskSlug}" not found`);
  if (!task.steps.length) throw new Error("this task has no steps");
  const agents = listCliAgents();
  const runId = rid();
  db.prepare("INSERT INTO task_runs (id, task_slug, schedule_id, started_at, status) VALUES (?, ?, ?, ?, 'running')")
    .run(runId, task.slug, scheduleId, new Date().toISOString());
  const t0 = Date.now();

  let transcript = "";
  let status = "ok";
  let error: string | null = null;
  outer:
  for (let pass = 1; pass <= task.repeat; pass++) {
    let carry = "";
    for (let i = 0; i < task.steps.length; i++) {
      const step = task.steps[i]!;
      const agent = agents.find((a) => a.id === step.agent) ?? agents[0];
      if (!agent) { status = "failed"; error = "no agents exist to run this task"; break outer; }
      const label = `— pass ${pass}, step ${i + 1}${step.name ? ` (${step.name})` : ""} · ${agent.name} —`;
      const prompt = carry
        ? `${step.program}\n\nOutput of the previous step:\n${carry.slice(0, 8_000)}`
        : step.program;
      let line: string;
      try {
        line = composeHeadless(agent, prompt, step.model);
      } catch (err) {
        status = "failed";
        error = err instanceof Error ? err.message : String(err);
        transcript += `\n${label}\n${error}\n`;
        break outer;
      }
      const r = await sh(line);
      transcript += `\n${label}\n${r.output}\n`;
      if (r.code !== 0) { status = "failed"; error = `step ${i + 1} exited ${r.code}`; break outer; }
      carry = r.output;
    }
    if (carry.includes("DONE")) break;
  }

  db.prepare("UPDATE task_runs SET duration_ms = ?, status = ?, error = ?, output = ? WHERE id = ?")
    .run(Date.now() - t0, status, error, transcript.trim().slice(0, 40_000) || null, runId);
  return { status, output: transcript.trim() };
}

// ── IPC ──────────────────────────────────────────────────────────────────────

export function registerLocalTasksIpc(): void {
  ipcMain.handle("tasks-list", () => env(() => listTasks()));
  ipcMain.handle("tasks-get", (_e, slug: string) => env(() => {
    const row = readTask(String(slug));
    if (!row) throw new Error("task not found");
    return row;
  }));
  ipcMain.handle("tasks-save", (_e, input: Partial<TaskRow> & { name: string }) => env(() => saveTaskRow(input)));
  ipcMain.handle("tasks-delete", (_e, slug: string) => env(() => {
    fs.rmSync(path.join(TASKS_DIR, `${String(slug)}.json`), { force: true });
    const db = getLocalDb();
    for (const s of loadSchedules().filter((x) => x.task_slug === String(slug))) {
      liveJobs.get(s.id)?.stop();
      liveJobs.delete(s.id);
      db.prepare("DELETE FROM task_schedules WHERE id = ?").run(s.id);
    }
    return { deleted: true };
  }));
  ipcMain.handle("tasks-run-now", async (_e, slug: string) => {
    try { return { ok: true, ...(await runTask(String(slug))) }; }
    catch (err) { return { ok: false, error: err instanceof Error ? err.message : String(err) }; }
  });
  ipcMain.handle("tasks-runs", (_e, slug: string) => env(() =>
    (getLocalDb().prepare("SELECT * FROM task_runs WHERE task_slug = ? ORDER BY started_at DESC LIMIT 30").all(String(slug)) as RunRow[])
      .map((r) => ({ id: r.id, startedAt: r.started_at, durationMs: r.duration_ms, status: r.status, error: r.error, output: r.output }))));
  ipcMain.handle("task-schedules-list", (_e, slug: string) => env(() =>
    loadSchedules().filter((s) => s.task_slug === String(slug))
      .map((s) => ({ id: s.id, name: s.name, cron: s.cron, enabled: s.enabled === 1 }))));
  ipcMain.handle("task-schedule-save", (_e, input: { taskSlug: string; cron: string; id?: string; enabled?: boolean }) => env(() => {
    const task = readTask(String(input.taskSlug));
    if (!task) throw new Error("task not found");
    if (!cron.validate(String(input.cron ?? ""))) throw new Error("that cron expression doesn't parse (five fields, e.g. 0 9 * * 1-5)");
    const db = getLocalDb();
    const id = input.id ? String(input.id) : rid();
    db.prepare(`INSERT INTO task_schedules (id, task_slug, name, cron, enabled, created_at)
                VALUES (?, ?, ?, ?, ?, datetime('now'))
                ON CONFLICT(id) DO UPDATE SET cron = excluded.cron, enabled = excluded.enabled`)
      .run(id, task.slug, task.name, String(input.cron), input.enabled === false ? 0 : 1);
    const row = db.prepare("SELECT * FROM task_schedules WHERE id = ?").get(id) as ScheduleRow;
    armSchedule(row);
    return { id };
  }));
  ipcMain.handle("task-schedule-delete", (_e, id: string) => env(() => {
    liveJobs.get(String(id))?.stop();
    liveJobs.delete(String(id));
    getLocalDb().prepare("DELETE FROM task_schedules WHERE id = ?").run(String(id));
    return { deleted: true };
  }));
}
