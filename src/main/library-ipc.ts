/**
 * library-ipc.ts — the org library: LOOPS, SKILLS, and AGENTS over the SDK.
 *
 * Thin pass-throughs: every handler is `client.<resource>.<verb>` wrapped in the
 * `{ ok, error }` envelope the renderer's CRUD sections speak. No shapes are
 * invented here — the SDK contract types cross the bridge as-is, so the renderer
 * sees exactly what the server said.
 *
 * Server-side authorization is the real gate (members read, authors write,
 * org_admins share); a 403 surfaces as `{ ok: false, error }` and the section
 * shows it. The desktop never pre-judges who may do what.
 */

import { ipcMain } from "electron";
import { getClient } from "./glyphh-client";
import { invalidateRoles } from "./loop-selections";
import { runTaskNow, taskRunningSince } from "./agent-scheduler";
import type {
  CreateLoopInput, UpdateLoopInput,
  CreateSkillInput, UpdateSkillInput,
  CreateAgentInput, UpdateAgentInput,
  CreateAgentTaskInput, UpdateAgentTaskInput,
} from "@glyphh/sdk";

/** The `{ ok, error }` envelope every renderer CRUD section speaks. */
async function envelope<T>(work: () => Promise<T>): Promise<{ ok: true; data: T } | { ok: false; error: string }> {
  try {
    return { ok: true, data: await work() };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export function registerLibraryIpc(): void {
  // ── Loops ──────────────────────────────────────────────────────────────────
  // (`loops-list` for the composer's chip lives in apps-ipc; these are the
  // library page's richer verbs.)
  ipcMain.handle("library-loop-get", (_e, ref: string) =>
    envelope(() => getClient().loops.get(String(ref))));
  ipcMain.handle("library-loop-create", (_e, input: CreateLoopInput) =>
    envelope(async () => {
      const loop = await getClient().loops.create(input);
      invalidateRoles();
      return loop;
    }));
  ipcMain.handle("library-loop-update", (_e, ref: string, patch: UpdateLoopInput) =>
    envelope(async () => {
      const loop = await getClient().loops.update(String(ref), patch);
      // Slots may have changed — a stale roles cache would keep showing them.
      invalidateRoles();
      return loop;
    }));
  ipcMain.handle("library-loop-delete", (_e, ref: string) =>
    envelope(async () => {
      await getClient().loops.remove(String(ref));
      invalidateRoles();
    }));

  // ── Skills ─────────────────────────────────────────────────────────────────
  ipcMain.handle("library-skills-list", () =>
    envelope(() => getClient().skills.list()));
  ipcMain.handle("library-skill-get", (_e, ref: string) =>
    envelope(() => getClient().skills.get(String(ref))));
  ipcMain.handle("library-skill-create", (_e, input: CreateSkillInput) =>
    envelope(() => getClient().skills.create(input)));
  ipcMain.handle("library-skill-update", (_e, ref: string, patch: UpdateSkillInput) =>
    envelope(() => getClient().skills.update(String(ref), patch)));
  ipcMain.handle("library-skill-delete", (_e, ref: string) =>
    envelope(() => getClient().skills.remove(String(ref))));

  // ── Agents ─────────────────────────────────────────────────────────────────
  ipcMain.handle("library-agents-list", () =>
    envelope(() => getClient().agents.list()));
  ipcMain.handle("library-agent-get", (_e, ref: string) =>
    envelope(() => getClient().agents.get(String(ref))));
  ipcMain.handle("library-agent-create", (_e, input: CreateAgentInput) =>
    envelope(() => getClient().agents.create(input)));
  ipcMain.handle("library-agent-update", (_e, ref: string, patch: UpdateAgentInput) =>
    envelope(() => getClient().agents.update(String(ref), patch)));
  ipcMain.handle("library-agent-delete", (_e, ref: string) =>
    envelope(() => getClient().agents.remove(String(ref))));

  // ── Agent tasks — bindings, never code ────────────────────────────────────
  ipcMain.handle("library-agent-tasks", (_e, ref: string) =>
    envelope(() => getClient().agents.tasks(String(ref))));
  ipcMain.handle("library-agent-task-add", (_e, ref: string, input: CreateAgentTaskInput) =>
    envelope(() => getClient().agents.addTask(String(ref), input)));
  ipcMain.handle("library-agent-task-update", (_e, ref: string, taskId: string, patch: UpdateAgentTaskInput) =>
    envelope(() => getClient().agents.updateTask(String(ref), String(taskId), patch)));
  ipcMain.handle("library-agent-task-run-now", (_e, ref: string, taskId: string) =>
    envelope(() => runTaskNow(String(ref), String(taskId))));
  ipcMain.handle("library-agent-task-runs", (_e, ref: string, taskId: string) =>
    envelope(() => getClient().agents.taskRuns(String(ref), String(taskId))));
  ipcMain.handle("library-agent-task-running", (_e, _ref: string, taskId: string) =>
    envelope(async () => ({ since: taskRunningSince(String(taskId)) })));
  ipcMain.handle("library-agent-task-delete", (_e, ref: string, taskId: string) =>
    envelope(async () => {
      await getClient().agents.removeTask(String(ref), String(taskId));
    }));
}
