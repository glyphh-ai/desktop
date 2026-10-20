/**
 * commands/runtime-images.ts — the runtime IMAGE SKU surface (§7b): the org's
 * picker/current/change plus the super-admin catalog CRUD. One command per SDK
 * method; `covers` keeps the parity test honest.
 */

import type { CommandRegistry } from "../registry.js";
import type { CliArgs } from "../args.js";
import { flagStr } from "../args.js";
import type { AdminRuntimeImageCreate, AdminRuntimeImageUpdate, RuntimeImageType } from "../../contract/runtime-images.js";

function flagInt(args: CliArgs, name: string): number | undefined {
  const v = flagStr(args, name);
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`--${name} must be a number`);
  return n;
}

/** Build the admin patch from flags (undefined fields are omitted). */
function patchFromFlags(args: CliArgs): AdminRuntimeImageUpdate {
  const patch: AdminRuntimeImageUpdate = {};
  const name = flagStr(args, "name");
  if (name !== undefined) patch.displayName = name;
  for (const k of ["ramMb", "diskGb", "monthlyCredits", "costPerSecondMicro", "monthlyUsdCents", "sort"] as const) {
    const n = flagInt(args, k);
    if (n !== undefined) patch[k] = n;
  }
  const active = flagStr(args, "active");
  if (active !== undefined) patch.active = active === "true";
  return patch;
}

export function registerRuntimeImages(reg: CommandRegistry): void {
  reg.register({
    path: "runtime-images list",
    summary: "the runtime images available to your org (its region's active SKUs)",
    covers: ["runtimeImages.list"],
    async run(ctx) {
      ctx.printJson(await ctx.client.runtimeImages.list());
    },
  });

  reg.register({
    path: "runtime-images current",
    summary: "your org's current runtime image + realized route",
    covers: ["runtimeImages.current"],
    async run(ctx) {
      ctx.printJson(await ctx.client.runtimeImages.current());
    },
  });

  reg.register({
    path: "runtime-images set",
    summary: "change your org's runtime image (org_admin; free|small|medium|large)",
    usage: "runtime-images set <key>",
    covers: ["runtimeImages.change"],
    async run(ctx, args) {
      const key = args.positional[0];
      if (!key) throw new Error("usage: runtime-images set <key>");
      ctx.printJson(await ctx.client.runtimeImages.change(key));
    },
  });

  // ── super-admin catalog CRUD (the model-catalog treatment) ─────────────────
  reg.register({
    path: "admin runtime-images list",
    summary: "every catalog image, every region (super_admin)",
    covers: ["admin.runtimeImages"],
    async run(ctx) {
      ctx.printJson(await ctx.client.admin.runtimeImages());
    },
  });

  reg.register({
    path: "admin runtime-images create",
    summary: "add a SKU to a region's catalog (super_admin)",
    usage:
      "admin runtime-images create <region> <key> --name <s> --type shared|dedicated --ramMb n --diskGb n --monthlyCredits n --costPerSecondMicro n [--monthlyUsdCents n] [--sort n]",
    covers: ["admin.createRuntimeImage"],
    async run(ctx, args) {
      const [region, key] = args.positional;
      const name = flagStr(args, "name");
      const type = flagStr(args, "type");
      const ramMb = flagInt(args, "ramMb");
      const diskGb = flagInt(args, "diskGb");
      const monthlyCredits = flagInt(args, "monthlyCredits");
      const costPerSecondMicro = flagInt(args, "costPerSecondMicro");
      if (!region || !key || !name || (type !== "shared" && type !== "dedicated") ||
          ramMb === undefined || diskGb === undefined || monthlyCredits === undefined || costPerSecondMicro === undefined) {
        throw new Error("usage: admin runtime-images create <region> <key> --name <s> --type shared|dedicated --ramMb n --diskGb n --monthlyCredits n --costPerSecondMicro n");
      }
      const input: AdminRuntimeImageCreate = {
        key, region, displayName: name, type: type as RuntimeImageType,
        ramMb, diskGb, monthlyCredits, costPerSecondMicro,
      };
      const usd = flagInt(args, "monthlyUsdCents");
      if (usd !== undefined) input.monthlyUsdCents = usd;
      const sort = flagInt(args, "sort");
      if (sort !== undefined) input.sort = sort;
      ctx.printJson(await ctx.client.admin.createRuntimeImage(input));
    },
  });

  reg.register({
    path: "admin runtime-images update",
    summary: "re-price / re-size / retire a region's SKU (super_admin)",
    usage: "admin runtime-images update <region> <key> [--name <s>] [--ramMb n] [--diskGb n] [--monthlyCredits n] [--costPerSecondMicro n] [--monthlyUsdCents n] [--active true|false] [--sort n]",
    covers: ["admin.updateRuntimeImage"],
    async run(ctx, args) {
      const [region, key] = args.positional;
      if (!region || !key) throw new Error("usage: admin runtime-images update <region> <key> [--flags]");
      const patch = patchFromFlags(args);
      if (Object.keys(patch).length === 0) throw new Error("nothing to update — pass at least one flag");
      ctx.printJson(await ctx.client.admin.updateRuntimeImage(region, key, patch));
    },
  });

  reg.register({
    path: "admin runtime-images delete",
    summary: "remove a SKU from a region's catalog (super_admin)",
    usage: "admin runtime-images delete <region> <key>",
    covers: ["admin.deleteRuntimeImage"],
    async run(ctx, args) {
      const [region, key] = args.positional;
      if (!region || !key) throw new Error("usage: admin runtime-images delete <region> <key>");
      await ctx.client.admin.deleteRuntimeImage(region, key);
      ctx.print("deleted ✓");
    },
  });
}
