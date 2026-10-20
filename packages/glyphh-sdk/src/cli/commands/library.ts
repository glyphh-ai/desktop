/**
 * commands/library.ts — one command factory drives every library kind (rotors, skills,
 * agents, layouts, drips, message sessions). `save` takes `--name` + `--data` (inline
 * JSON or `@file.json`) and optional `--scope org` / `--id` to update.
 */

import { readFileSync } from "node:fs";
import type { CommandRegistry } from "../registry.js";
import type { CliContext } from "../context.js";
import { flagStr } from "../args.js";
import type { LibraryClient } from "../../resources/library.js";
import type { LibraryScope, SaveLibraryItemInput } from "../../contract/library.js";

/** Resolve the `--data` flag: inline JSON, or `@path` to a JSON file. */
function parseData(raw: string | undefined): unknown {
  if (raw === undefined) return {};
  const text = raw.startsWith("@") ? readFileSync(raw.slice(1), "utf8") : raw;
  return JSON.parse(text);
}

/** Register `<cmd> list|get|save|delete` for one library kind. */
function registerKind(
  reg: CommandRegistry,
  cmd: string,
  surface: string,
  pick: (ctx: CliContext) => LibraryClient,
): void {
  reg.register({
    path: `${cmd} list`,
    summary: `list ${cmd} (your personal + org shared)`,
    covers: [`${surface}.list`],
    async run(ctx) {
      ctx.printJson(await pick(ctx).list());
    },
  });

  reg.register({
    path: `${cmd} get`,
    summary: `one ${cmd.replace(/s$/, "")} by id`,
    usage: `${cmd} get <id>`,
    covers: [`${surface}.get`],
    async run(ctx, args) {
      const id = args.positional[0];
      if (!id) throw new Error(`usage: ${cmd} get <id>`);
      ctx.printJson(await pick(ctx).get(id));
    },
  });

  reg.register({
    path: `${cmd} save`,
    summary: `create/update a ${cmd.replace(/s$/, "")}`,
    usage: `${cmd} save --name <name> --data <json|@file> [--scope org] [--id <id>]`,
    covers: [`${surface}.save`],
    async run(ctx, args) {
      const name = flagStr(args, "name");
      if (!name) throw new Error(`usage: ${cmd} save --name <name> --data <json|@file>`);
      const input: SaveLibraryItemInput = { name, data: parseData(flagStr(args, "data")) };
      const scope = flagStr(args, "scope");
      if (scope) input.scope = scope as LibraryScope;
      const id = flagStr(args, "id");
      if (id) input.id = id;
      ctx.printJson(await pick(ctx).save(input));
    },
  });

  reg.register({
    path: `${cmd} delete`,
    summary: `delete a ${cmd.replace(/s$/, "")} by id`,
    usage: `${cmd} delete <id>`,
    covers: [`${surface}.delete`],
    async run(ctx, args) {
      const id = args.positional[0];
      if (!id) throw new Error(`usage: ${cmd} delete <id>`);
      await pick(ctx).delete(id);
      ctx.printJson({ deleted: id });
    },
  });
}

export function registerLibrary(reg: CommandRegistry): void {
  registerKind(reg, "rotors", "rotors", (ctx) => ctx.client.rotors);
  registerKind(reg, "layouts", "layouts", (ctx) => ctx.client.layouts);
  registerKind(reg, "drips", "drips", (ctx) => ctx.client.drips);
  registerKind(reg, "msgs", "messageSessions", (ctx) => ctx.client.messageSessions);
}
