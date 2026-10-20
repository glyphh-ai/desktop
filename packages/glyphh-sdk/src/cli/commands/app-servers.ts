/**
 * commands/app-servers.ts — the super-admin app-server image SKU catalog CRUD
 * (`client.admin.*AppServerImage*`). One command per SDK method; `covers` keeps
 * the parity test honest.
 */

import type { CommandRegistry } from "../registry.js";
import type { CliArgs } from "../args.js";
import { flagStr } from "../args.js";
import type { AdminAppServerImageCreate, AdminAppServerImageUpdate } from "../../contract/app-servers.js";

function flagInt(args: CliArgs, name: string): number | undefined {
  const v = flagStr(args, name);
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`--${name} must be a number`);
  return n;
}

function patchFromFlags(args: CliArgs): AdminAppServerImageUpdate {
  const patch: AdminAppServerImageUpdate = {};
  const desc = flagStr(args, "description");
  if (desc !== undefined) patch.description = desc;
  const dbTier = flagStr(args, "dbTier");
  if (dbTier !== undefined) patch.dbTier = dbTier;
  for (const k of ["ramMb", "diskGb", "monthlyCredits", "costPerSecondMicro", "monthlyUsdCents", "sort"] as const) {
    const n = flagInt(args, k);
    if (n !== undefined) patch[k] = n;
  }
  const active = flagStr(args, "active");
  if (active !== undefined) patch.active = active === "true";
  return patch;
}

export function registerAppServers(reg: CommandRegistry): void {
  // ── super-admin catalog CRUD (the runtime-image treatment) ──────────────────
  reg.register({
    path: "admin app-servers list",
    summary: "every app-server SKU, every region (super_admin)",
    covers: ["admin.appServerImages"],
    async run(ctx) {
      ctx.printJson(await ctx.client.admin.appServerImages());
    },
  });

  reg.register({
    path: "admin app-servers create",
    summary: "add an app-server SKU to a region's catalog (super_admin)",
    usage: "admin app-servers create <region> <key> --description <s> --dbTier <s> --ramMb n --diskGb n --monthlyCredits n --costPerSecondMicro n [--monthlyUsdCents n] [--sort n]",
    covers: ["admin.createAppServerImage"],
    async run(ctx, args) {
      const [region, key] = args.positional;
      const description = flagStr(args, "description");
      const dbTier = flagStr(args, "dbTier");
      const ramMb = flagInt(args, "ramMb");
      const diskGb = flagInt(args, "diskGb");
      const monthlyCredits = flagInt(args, "monthlyCredits");
      const costPerSecondMicro = flagInt(args, "costPerSecondMicro");
      if (!region || !key || !description || !dbTier ||
          ramMb === undefined || diskGb === undefined || monthlyCredits === undefined || costPerSecondMicro === undefined) {
        throw new Error("usage: admin app-servers create <region> <key> --description <s> --dbTier <s> --ramMb n --diskGb n --monthlyCredits n --costPerSecondMicro n");
      }
      const input: AdminAppServerImageCreate = { key, region, description, dbTier, ramMb, diskGb, monthlyCredits, costPerSecondMicro };
      const usd = flagInt(args, "monthlyUsdCents");
      if (usd !== undefined) input.monthlyUsdCents = usd;
      const sort = flagInt(args, "sort");
      if (sort !== undefined) input.sort = sort;
      ctx.printJson(await ctx.client.admin.createAppServerImage(input));
    },
  });

  reg.register({
    path: "admin app-servers update",
    summary: "re-price / re-size / retire a region's app-server SKU (super_admin)",
    usage: "admin app-servers update <region> <key> [--description <s>] [--dbTier <s>] [--ramMb n] [--diskGb n] [--monthlyCredits n] [--costPerSecondMicro n] [--monthlyUsdCents n] [--active true|false] [--sort n]",
    covers: ["admin.updateAppServerImage"],
    async run(ctx, args) {
      const [region, key] = args.positional;
      if (!region || !key) throw new Error("usage: admin app-servers update <region> <key> [--flags]");
      const patch = patchFromFlags(args);
      if (Object.keys(patch).length === 0) throw new Error("nothing to update — pass at least one flag");
      ctx.printJson(await ctx.client.admin.updateAppServerImage(region, key, patch));
    },
  });

  reg.register({
    path: "admin app-servers delete",
    summary: "remove an app-server SKU from a region's catalog (super_admin)",
    usage: "admin app-servers delete <region> <key>",
    covers: ["admin.deleteAppServerImage"],
    async run(ctx, args) {
      const [region, key] = args.positional;
      if (!region || !key) throw new Error("usage: admin app-servers delete <region> <key>");
      await ctx.client.admin.deleteAppServerImage(region, key);
      ctx.print("deleted ✓");
    },
  });
}
