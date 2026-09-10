/**
 * local-library.ts — LOOPS, SKILLS and SCHEDULED TASKS, local
 * (the build, 2026-09-10: the main-era UX returns; storage + execution move
 * onto this machine).
 *
 *   ~/.glyphh/loops/<slug>.json    — a loop: the main-era shape (manifest
 *                                    with roles, code = the PROGRAM). A
 *                                    role's `default` names the CLI AGENT
 *                                    that fills the slot (agents carry their
 *                                    model; a workspace/schedule can override).
 *   ~/.glyphh/skills/<slug>.json   — a skill: manifest + prompt + code.
 *   user-state.sqlite              — loop_schedules + loop_runs (migration 9).
 *
 * EXECUTION: a scheduled (or run-now) task runs its loop HEADLESSLY — the
 * slotted agent's CLI in print mode (claude -p / codex exec / gemini -p)
 * with the loop's program as the prompt, output captured as the run record.
 */

import fs from "fs";
import path from "path";
import { homedir } from "os";
import { spawn } from "child_process";
import { ipcMain } from "electron";
import cron, { type ScheduledTask } from "node-cron";
import { getLocalDb } from "./local-db.js";
import { listCliAgents, composeHeadless, type CliAgentListed } from "./cli-agents.js";

const LOOPS_DIR = path.join(homedir(), ".glyphh", "loops");
const SKILLS_DIR = path.join(homedir(), ".glyphh", "skills");

interface LoopRole { name: string; label?: string; description?: string; default?: string | null }
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
  const row = readRow<LoopRow>(LOOPS_DIR, String(ref));
  if (!row) throw new Error(`loop "${ref}" not found`);
  return row;
}
function saveLoop(row: LoopRow): LoopRow {
  row.updatedAt = new Date().toISOString();
  writeRow(LOOPS_DIR, row.slug, row);
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
}
interface RunRow { id: string; schedule_id: string; started_at: string; duration_ms: number | null; status: string; error: string | null; output: string | null }

const rid = (): string => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

const liveJobs = new Map<string, ScheduledTask>();

function armSchedule(row: ScheduleRow): void {
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

/** One run: the loop's program through the slotted agent's headless CLI. */
async function runSchedule(scheduleId: string): Promise<void> {
  const db = getLocalDb();
  const sched = db.prepare("SELECT * FROM loop_schedules WHERE id = ?").get(scheduleId) as ScheduleRow | undefined;
  if (!sched) throw new Error("schedule not found");
  const loop = getLoop(sched.loop_slug);
  const agent = listCliAgents().find((a) => a.id === sched.agent_id) as CliAgentListed | undefined;
  if (!agent) throw new Error(`agent "${sched.agent_id}" not found`);
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
    line = composeHeadless(agent, loop.code || loop.description || loop.name);
  } catch (err) {
    finish("failed", err instanceof Error ? err.message : String(err), null);
    return;
  }
  await new Promise<void>((resolve) => {
    const child = spawn("/bin/sh", ["-lc", line], { env: process.env });
    let out = "";
    const cap = (b: Buffer): void => { if (out.length < 40_000) out += b.toString(); };
    child.stdout.on("data", cap);
    child.stderr.on("data", cap);
    const timer = setTimeout(() => { try { child.kill("SIGKILL"); } catch { /* raced exit */ } }, 10 * 60 * 1000);
    child.on("close", (codeNum) => {
      clearTimeout(timer);
      finish(codeNum === 0 ? "ok" : "failed", codeNum === 0 ? null : `exit ${codeNum}`, out.trim() || null);
      resolve();
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      finish("failed", err.message, out.trim() || null);
      resolve();
    });
  });
}

// ── IPC — the exact lanes the main-era UX rides ──────────────────────────────

export function registerLocalLibraryIpc(): void {
  // LOOPS
  ipcMain.handle("loops-list", () => ({
    loops: listRows<LoopRow>(LOOPS_DIR)
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
    fs.rmSync(path.join(LOOPS_DIR, `${String(ref)}.json`), { force: true });
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
    if (readRow(LOOPS_DIR, slug)) throw new Error(`a loop named "${slug}" already exists`);
    const row: LoopRow = {
      id: slug, slug, scope: "personal", ownerUserId: null,
      name, description: "", builtIn: false, updatedAt: new Date().toISOString(),
      manifest: { version: 1, type: "turn", roles: [{ name: "main", label: "Main", description: "The agent this loop runs on.", default: null }] },
      code: "",
    };
    writeRow(LOOPS_DIR, slug, row);
    return row;
  }));
  // Roles resolve with CHOICES = the CLI AGENTS (a role's default names an
  // agent now; the agent carries its model) — the main-era picker mechanics
  // read modelId/choices unchanged.
  ipcMain.handle("loop-roles", (_e, loop: string) => {
    try {
      const row = getLoop(String(loop));
      const agents = listCliAgents();
      const choices = agents.map((a) => ({ id: a.id, name: a.model ? `${a.name} — ${a.model}` : a.name }));
      const roles = (row.manifest.roles ?? []).map((r) => ({
        name: r.name, label: r.label, description: r.description,
        modelId: r.default ?? null,
        choices,
      }));
      return { ok: true, loop: row.slug, roles };
    } catch (err) {
      return { ok: false, loop: String(loop), roles: [], error: err instanceof Error ? err.message : String(err) };
    }
  });
  ipcMain.handle("loop-set-role-default", (_e, loopId: string, role: string, agentId: string | null) => env(() => {
    const row = getLoop(String(loopId));
    const r = (row.manifest.roles ?? []).find((x) => x.name === String(role));
    if (!r) throw new Error(`role "${role}" not on this loop`);
    r.default = agentId ? String(agentId) : null;
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
  ipcMain.handle("library-agents-list", () => env(() => {
    const withTasks = new Set(loadSchedules().map((s) => s.agent_id));
    return listCliAgents()
      .filter((a) => withTasks.has(a.id))
      .map((a) => ({ id: a.id, slug: a.id, name: a.name }));
  }));
  ipcMain.handle("library-agent-tasks", (_e, ref: string) => env(() => {
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
  ipcMain.handle("library-agent-task-runs", (_e, _ref: string, taskId: string) => env(() =>
    (getLocalDb().prepare("SELECT * FROM loop_runs WHERE schedule_id = ? ORDER BY started_at DESC LIMIT 30").all(String(taskId)) as RunRow[])
      .map((r) => ({ id: r.id, startedAt: r.started_at, durationMs: r.duration_ms, status: r.status, error: r.error, output: r.output }))));
  ipcMain.handle("library-agent-task-run-now", async (_e, _ref: string, taskId: string) => {
    try { await runSchedule(String(taskId)); return { ok: true }; }
    catch (err) { return { ok: false, error: err instanceof Error ? err.message : String(err) }; }
  });
  ipcMain.handle("library-agent-task-update", (_e, _ref: string, taskId: string, patch: { enabled?: boolean }) => env(() => {
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
