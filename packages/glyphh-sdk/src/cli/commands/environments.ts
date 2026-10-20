/**
 * commands/environments.ts — the member's named cloud environments (his direction,
 * 2026-10-05: personal environments). `--vars-file` reads the .env text from a file
 * (`-` for stdin), `--vars` takes it inline; the values never print back.
 */

import { readFileSync } from "node:fs";

import { flagStr } from "../args.js";
import type { CliArgs } from "../args.js";
import type { CommandRegistry } from "../registry.js";
import { ENVIRONMENT_NETWORKS } from "../../contract/environments.js";
import type { EnvironmentNetwork } from "../../contract/environments.js";

function networkFlag(args: CliArgs): EnvironmentNetwork | undefined {
  const raw = flagStr(args, "network");
  if (raw === undefined) return undefined;
  if (!(ENVIRONMENT_NETWORKS as string[]).includes(raw)) throw new Error(`--network must be one of ${ENVIRONMENT_NETWORKS.join("|")}`);
  return raw as EnvironmentNetwork;
}

function varsFlag(args: CliArgs): string | undefined {
  const file = flagStr(args, "vars-file");
  if (file !== undefined) return readFileSync(file === "-" ? 0 : file, "utf8");
  return flagStr(args, "vars");
}

export function registerEnvironments(reg: CommandRegistry): void {
  reg.register({
    path: "environments list",
    summary: "list your cloud environments (Default is the absent one)",
    covers: ["environments.list"],
    async run(ctx) {
      ctx.printJson(await ctx.client.environments.list());
    },
  });

  reg.register({
    path: "environments get",
    summary: "one environment: its variable keys with masked previews, never the values",
    usage: "environments get <id|default>",
    covers: ["environments.get"],
    async run(ctx, args) {
      const id = args.positional[0];
      if (!id) throw new Error("usage: environments get <id|default>");
      ctx.printJson(await ctx.client.environments.get(id));
    },
  });

  reg.register({
    path: "environments create",
    summary: "create a cloud environment from a name, a network policy and .env text",
    usage: "environments create <name> [--network none|trusted|full] [--vars 'K=V\\nK2=V2' | --vars-file <path|->]",
    covers: ["environments.create"],
    async run(ctx, args) {
      const name = args.positional[0];
      if (!name) throw new Error("usage: environments create <name> [--network none|trusted|full] [--vars <text> | --vars-file <path|->]");
      const network = networkFlag(args);
      const vars = varsFlag(args);
      ctx.printJson(await ctx.client.environments.create({ name, ...(network ? { network } : {}), ...(vars !== undefined ? { vars } : {}) }));
    },
  });

  reg.register({
    path: "environments update",
    summary: "change an environment's name, network or variables (--vars replaces the whole set)",
    usage: "environments update <id> [--name <name>] [--network none|trusted|full] [--vars <text> | --vars-file <path|->]",
    covers: ["environments.update"],
    async run(ctx, args) {
      const id = args.positional[0];
      if (!id) throw new Error("usage: environments update <id> [--name <name>] [--network none|trusted|full] [--vars <text> | --vars-file <path|->]");
      const name = flagStr(args, "name");
      const network = networkFlag(args);
      const vars = varsFlag(args);
      ctx.printJson(await ctx.client.environments.update(id, { ...(name ? { name } : {}), ...(network ? { network } : {}), ...(vars !== undefined ? { vars } : {}) }));
    },
  });

  reg.register({
    path: "environments delete",
    summary: "delete a cloud environment",
    usage: "environments delete <id>",
    covers: ["environments.delete"],
    async run(ctx, args) {
      const id = args.positional[0];
      if (!id) throw new Error("usage: environments delete <id>");
      await ctx.client.environments.delete(id);
      ctx.printJson({ deleted: id });
    },
  });
}
