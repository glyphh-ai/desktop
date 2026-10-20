/**
 * commands/loops.ts — the org's task library. Members list/read; org_admins
 * build/edit/delete.
 *
 * A task is a manifest + a program, so authoring happens against FILES, not inline
 * JSON: `--code <path>` reads the program off disk and `--manifest <path>` its
 * manifest, which is how a task is actually edited (in an editor, in a repo).
 * `loops pull` writes both back out so a stored task round-trips.
 */

import { readFileSync, writeFileSync } from "node:fs";
import type { CommandRegistry } from "../registry.js";
import type { CliArgs } from "../args.js";
import { flagStr } from "../args.js";
import type { CreateTaskInput, UpdateTaskInput, TaskManifest } from "../../contract/tasks.js";

/** Read a file flag's contents, or undefined when the flag is absent. */
function fileFlag(args: CliArgs, name: string): string | undefined {
  const path = flagStr(args, name);
  if (path === undefined) return undefined;
  try {
    return readFileSync(path, "utf8");
  } catch (err) {
    throw new Error(`--${name}: cannot read ${path} (${err instanceof Error ? err.message : String(err)})`);
  }
}

/** Read + parse the manifest file flag, or undefined when absent. */
function manifestFlag(args: CliArgs): TaskManifest | undefined {
  const raw = fileFlag(args, "manifest");
  if (raw === undefined) return undefined;
  try {
    return JSON.parse(raw) as TaskManifest;
  } catch {
    throw new Error("--manifest must be a file containing valid JSON");
  }
}

export function registerTasks(reg: CommandRegistry): void {
  reg.register({
    path: "tasks list",
    summary: "list the org's tasks (+ built-in Default)",
    covers: ["tasks.list"],
    async run(ctx) {
      ctx.printJson(await ctx.client.tasks.list());
    },
  });

  reg.register({
    path: "tasks get",
    summary: "a task's detail (manifest + program)",
    usage: "tasks get <slug|id>",
    covers: ["tasks.get"],
    async run(ctx, args) {
      const ref = args.positional[0];
      if (!ref) throw new Error("usage: tasks get <slug|id>");
      ctx.printJson(await ctx.client.tasks.get(ref));
    },
  });

  reg.register({
    path: "tasks roles",
    summary: "the model slots a task declares, resolved for you (what a picker shows)",
    usage: "tasks roles <slug|id> [--select <role>:<modelId>]",
    covers: ["tasks.roles"],
    async run(ctx, args) {
      const ref = args.positional[0];
      if (!ref) throw new Error("usage: tasks roles <slug|id> [--select <role>:<modelId>]");
      const selections: Record<string, string> = {};
      const raw = flagStr(args, "select");
      if (raw) {
        const at = raw.indexOf(":");
        if (at <= 0) throw new Error("--select must be <role>:<modelId>");
        selections[raw.slice(0, at)] = raw.slice(at + 1);
      }
      ctx.printJson(await ctx.client.tasks.roles(ref, selections));
    },
  });

  reg.register({
    path: "tasks pull",
    summary: "write a task's program + manifest to disk",
    usage: "tasks pull <slug|id> [--code <path>] [--manifest <path>]",
    async run(ctx, args) {
      const ref = args.positional[0];
      if (!ref) throw new Error("usage: tasks pull <slug|id> [--code <path>] [--manifest <path>]");
      const task = await ctx.client.tasks.get(ref);
      const codePath = flagStr(args, "code") ?? `${task.slug}.task.js`;
      const manifestPath = flagStr(args, "manifest") ?? `${task.slug}.task.json`;
      writeFileSync(codePath, task.code, "utf8");
      writeFileSync(manifestPath, `${JSON.stringify(task.manifest, null, 2)}\n`, "utf8");
      ctx.print(`${codePath}\n${manifestPath}`);
    },
  });

  reg.register({
    path: "tasks create",
    summary: "build a task (org_admin)",
    usage: "tasks create <slug> <name> [--description <d>] [--code <path>] [--manifest <path>]",
    covers: ["tasks.create"],
    async run(ctx, args) {
      const [slug, name] = args.positional;
      if (!slug || !name) {
        throw new Error("usage: tasks create <slug> <name> [--description ..] [--code <path>] [--manifest <path>]");
      }
      const input: CreateTaskInput = { slug, name };
      const desc = flagStr(args, "description"); if (desc !== undefined) input.description = desc;
      const code = fileFlag(args, "code"); if (code !== undefined) input.code = code;
      const manifest = manifestFlag(args); if (manifest !== undefined) input.manifest = manifest;
      ctx.printJson(await ctx.client.tasks.create(input));
    },
  });

  reg.register({
    path: "tasks update",
    summary: "edit a task (org_admin)",
    usage: "tasks update <slug|id> [--name <n>] [--description <d>] [--code <path>] [--manifest <path>]",
    covers: ["tasks.update"],
    async run(ctx, args) {
      const ref = args.positional[0];
      if (!ref) {
        throw new Error("usage: tasks update <slug|id> [--name ..] [--description ..] [--code <path>] [--manifest <path>]");
      }
      const patch: UpdateTaskInput = {};
      const name = flagStr(args, "name"); if (name !== undefined) patch.name = name;
      const desc = flagStr(args, "description"); if (desc !== undefined) patch.description = desc;
      const slug = flagStr(args, "slug"); if (slug !== undefined) patch.slug = slug;
      const code = fileFlag(args, "code"); if (code !== undefined) patch.code = code;
      const manifest = manifestFlag(args); if (manifest !== undefined) patch.manifest = manifest;
      if (Object.keys(patch).length === 0) throw new Error("nothing to update — pass at least one flag");
      ctx.printJson(await ctx.client.tasks.update(ref, patch));
    },
  });

  reg.register({
    path: "tasks delete",
    summary: "delete a task (org_admin)",
    usage: "tasks delete <slug|id>",
    covers: ["tasks.remove"],
    async run(ctx, args) {
      const ref = args.positional[0];
      if (!ref) throw new Error("usage: tasks delete <slug|id>");
      await ctx.client.tasks.remove(ref);
      ctx.print("deleted ✓");
    },
  });

  reg.register({
    path: "tasks share",
    summary: "offer a task to the org's share queue",
    usage: "tasks share <slug|id>",
    covers: ["tasks.share"],
    async run(ctx, args) {
      const ref = args.positional[0];
      if (!ref) throw new Error("usage: tasks share <slug|id>");
      ctx.printJson(await ctx.client.tasks.share(ref));
    },
  });

  reg.register({
    path: "tasks publish",
    summary: "submit a task to the marketplace review desk",
    usage: "tasks publish <slug|id>",
    covers: ["tasks.publish"],
    async run(ctx, args) {
      const ref = args.positional[0];
      if (!ref) throw new Error("usage: tasks publish <slug|id>");
      ctx.printJson(await ctx.client.tasks.publish(ref));
    },
  });
}
