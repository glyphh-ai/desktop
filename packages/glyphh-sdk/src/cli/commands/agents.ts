/**
 * commands/agents.ts — standing workers and their tasks.
 *
 * `agents live` is the runner's view: every live agent with its armed tasks and the
 * guardrails it actually runs under (org ceiling ∧ its own).
 */

import type { CommandRegistry } from "../registry.js";
import { flagStr, flagBool } from "../args.js";
import type { CreateAgentInput, UpdateAgentInput, CreateAgentTaskInput, AgentTaskKind } from "../../contract/agents.js";

const KINDS: AgentTaskKind[] = ["skill", "loop", "app_command"];

function parseArgsJson(raw: string | undefined): Record<string, unknown> | undefined {
  if (raw === undefined) return undefined;
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    throw new Error("--args must be valid JSON");
  }
}

export function registerAgents(reg: CommandRegistry): void {
  reg.register({
    path: "agents list",
    summary: "list agents you can see (your own + org-shared)",
    covers: ["agents.list"],
    async run(ctx) {
      ctx.printJson(await ctx.client.agents.list());
    },
  });

  reg.register({
    path: "agents live",
    summary: "live agents with their armed tasks (what a runner starts)",
    covers: ["agents.live"],
    async run(ctx) {
      ctx.printJson(await ctx.client.agents.live());
    },
  });

  reg.register({
    path: "agents get",
    summary: "an agent's detail (+ resolved guardrails)",
    usage: "agents get <slug|id>",
    covers: ["agents.get"],
    async run(ctx, args) {
      const ref = args.positional[0];
      if (!ref) throw new Error("usage: agents get <slug|id>");
      ctx.printJson(await ctx.client.agents.get(ref));
    },
  });

  reg.register({
    path: "agents create",
    summary: "create an agent",
    usage: "agents create <slug> <name> [--loop <loopId>] [--description <d>] [--live] [--share]",
    covers: ["agents.create"],
    async run(ctx, args) {
      const [slug, name] = args.positional;
      if (!slug || !name) throw new Error("usage: agents create <slug> <name> [--loop <loopId>] [--live] [--share]");
      const input: CreateAgentInput = { slug, name };
      const desc = flagStr(args, "description"); if (desc !== undefined) input.description = desc;
      const loop = flagStr(args, "loop"); if (loop !== undefined) input.loopId = loop;
      if (flagBool(args, "live")) input.live = true;
      // Sharing org-wide is org_admin only — the server enforces it.
      if (flagBool(args, "share")) input.scope = "org";
      ctx.printJson(await ctx.client.agents.create(input));
    },
  });

  reg.register({
    path: "agents update",
    summary: "edit an agent",
    usage: "agents update <slug|id> [--name <n>] [--loop <loopId>] [--live|--stop] [--share]",
    covers: ["agents.update"],
    async run(ctx, args) {
      const ref = args.positional[0];
      if (!ref) throw new Error("usage: agents update <slug|id> [--name ..] [--loop ..] [--live|--stop]");
      const patch: UpdateAgentInput = {};
      const name = flagStr(args, "name"); if (name !== undefined) patch.name = name;
      const desc = flagStr(args, "description"); if (desc !== undefined) patch.description = desc;
      const loop = flagStr(args, "loop"); if (loop !== undefined) patch.loopId = loop;
      if (flagBool(args, "live")) patch.live = true;
      if (flagBool(args, "stop")) patch.live = false;
      if (flagBool(args, "share")) patch.scope = "org";
      if (Object.keys(patch).length === 0) throw new Error("nothing to update — pass at least one flag");
      ctx.printJson(await ctx.client.agents.update(ref, patch));
    },
  });

  reg.register({
    path: "agents delete",
    summary: "delete an agent (and its tasks)",
    usage: "agents delete <slug|id>",
    covers: ["agents.remove"],
    async run(ctx, args) {
      const ref = args.positional[0];
      if (!ref) throw new Error("usage: agents delete <slug|id>");
      await ctx.client.agents.remove(ref);
      ctx.print("deleted ✓");
    },
  });

  reg.register({
    path: "agents tasks",
    summary: "an agent's tasks",
    usage: "agents tasks <slug|id>",
    covers: ["agents.tasks"],
    async run(ctx, args) {
      const ref = args.positional[0];
      if (!ref) throw new Error("usage: agents tasks <slug|id>");
      ctx.printJson(await ctx.client.agents.tasks(ref));
    },
  });

  reg.register({
    path: "agents task add",
    summary: "bind a skill, loop, or app command to a schedule",
    usage: 'agents task add <agent> <name> --kind <skill|loop|app_command> --target <ref> --cron "<expr>" [--args <json>]',
    covers: ["agents.addTask"],
    async run(ctx, args) {
      const [ref, name] = args.positional;
      const kind = flagStr(args, "kind") as AgentTaskKind | undefined;
      const target = flagStr(args, "target");
      const cron = flagStr(args, "cron");
      if (!ref || !name || !kind || !target || !cron) {
        throw new Error('usage: agents task add <agent> <name> --kind <skill|loop|app_command> --target <ref> --cron "<expr>" [--args <json>]');
      }
      if (!KINDS.includes(kind)) throw new Error(`--kind must be one of: ${KINDS.join(", ")}`);
      const input: CreateAgentTaskInput = { name, kind, target, cron };
      const parsed = parseArgsJson(flagStr(args, "args")); if (parsed !== undefined) input.args = parsed;
      ctx.printJson(await ctx.client.agents.addTask(ref, input));
    },
  });

  reg.register({
    path: "agents task set",
    summary: "edit a task (schedule, target, on/off)",
    usage: 'agents task set <agent> <taskId> [--cron "<expr>"] [--target <ref>] [--args <json>] [--on|--off]',
    covers: ["agents.updateTask"],
    async run(ctx, args) {
      const [ref, taskId] = args.positional;
      if (!ref || !taskId) throw new Error('usage: agents task set <agent> <taskId> [--cron ..] [--target ..] [--on|--off]');
      const patch: Parameters<typeof ctx.client.agents.updateTask>[2] = {};
      const cron = flagStr(args, "cron"); if (cron !== undefined) patch.cron = cron;
      const target = flagStr(args, "target"); if (target !== undefined) patch.target = target;
      const name = flagStr(args, "name"); if (name !== undefined) patch.name = name;
      const parsed = parseArgsJson(flagStr(args, "args")); if (parsed !== undefined) patch.args = parsed;
      if (flagBool(args, "on")) patch.enabled = true;
      if (flagBool(args, "off")) patch.enabled = false;
      if (Object.keys(patch).length === 0) throw new Error("nothing to update — pass at least one flag");
      ctx.printJson(await ctx.client.agents.updateTask(ref, taskId, patch));
    },
  });

  reg.register({
    path: "agents task remove",
    summary: "unbind a task",
    usage: "agents task remove <agent> <taskId>",
    covers: ["agents.removeTask"],
    async run(ctx, args) {
      const [ref, taskId] = args.positional;
      if (!ref || !taskId) throw new Error("usage: agents task remove <agent> <taskId>");
      await ctx.client.agents.removeTask(ref, taskId);
      ctx.print("removed ✓");
    },
  });

  reg.register({
    path: "agents task-run-report",
    summary: "record a task firing's outcome (what a scheduler writes back)",
    usage: "agents task-run-report <agent> <taskId> <ok|error> [--error <msg>]",
    covers: ["agents.reportTaskRun"],
    async run(ctx, args) {
      const [agent, taskId, status] = args.positional;
      if (!agent || !taskId || (status !== "ok" && status !== "error")) {
        throw new Error("usage: agents task-run-report <agent> <taskId> <ok|error> [--error <msg>]");
      }
      const error = flagStr(args, "error");
      ctx.printJson(await ctx.client.agents.reportTaskRun(agent, taskId, { status, ...(error !== undefined ? { error } : {}) }));
    },
  });

  reg.register({
    path: "agents task-runs",
    summary: "a task's firing history, newest first",
    usage: "agents task-runs <agent> <taskId>",
    covers: ["agents.taskRuns"],
    async run(ctx, args) {
      const [agent, taskId] = args.positional;
      if (!agent || !taskId) throw new Error("usage: agents task-runs <agent> <taskId>");
      ctx.printJson(await ctx.client.agents.taskRuns(agent, taskId));
    },
  });
}
