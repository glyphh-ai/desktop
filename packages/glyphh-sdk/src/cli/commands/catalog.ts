/**
 * commands/catalog.ts — the provider/model catalog (read), org provider enablement,
 * and the super_admin catalog/pricing admin.
 */

import type { CommandRegistry } from "../registry.js";
import { flagStr } from "../args.js";
import type { ProviderKind, Modality, RateUnit } from "../../contract/catalog.js";

function kind(v: string | undefined): ProviderKind {
  return v === "open_weight" ? "open_weight" : "proxied";
}

export function registerCatalog(reg: CommandRegistry): void {
  reg.register({
    path: "catalog providers",
    summary: "list providers (+ org enablement)",
    covers: ["catalog.providers"],
    async run(ctx) {
      ctx.printJson(await ctx.client.catalog.providers());
    },
  });

  reg.register({
    path: "catalog models",
    summary: "list models (+ vendor list price, $/1M tokens)",
    covers: ["catalog.models"],
    async run(ctx) {
      ctx.printJson(await ctx.client.catalog.models());
    },
  });

  reg.register({
    path: "providers enable",
    summary: "enable a provider for the org (optional BYOK key)",
    usage: "providers enable <slug> [--key <apiKey>]",
    covers: ["providers.enable"],
    async run(ctx, args) {
      const slug = args.positional[0];
      if (!slug) throw new Error("usage: providers enable <slug> [--key <apiKey>]");
      ctx.printJson(await ctx.client.providers.enable(slug, flagStr(args, "key")));
    },
  });

  reg.register({
    path: "providers clear-key",
    summary: "remove the org's BYOK key but keep the provider enabled",
    usage: "providers clear-key <slug>",
    covers: ["providers.clearKey"],
    async run(ctx, args) {
      const slug = args.positional[0];
      if (!slug) throw new Error("usage: providers clear-key <slug>");
      await ctx.client.providers.clearKey(slug);
      ctx.print("key removed ✓ (provider stays enabled — platform proxy key applies)");
    },
  });

  reg.register({
    path: "providers disable",
    summary: "disable a provider for the org",
    usage: "providers disable <slug>",
    covers: ["providers.disable"],
    async run(ctx, args) {
      const slug = args.positional[0];
      if (!slug) throw new Error("usage: providers disable <slug>");
      await ctx.client.providers.disable(slug);
      ctx.print("disabled ✓");
    },
  });

  reg.register({
    path: "catalog hf-search",
    summary: "search Hugging Face for GGUF open-weight repos",
    usage: "catalog hf-search [query]",
    covers: ["catalog.hfSearch"],
    async run(ctx, args) {
      ctx.printJson(await ctx.client.catalog.hfSearch(args.positional[0] ?? ""));
    },
  });

  reg.register({
    path: "catalog hf-quants",
    summary: "list a Hugging Face repo's GGUF quants",
    usage: "catalog hf-quants <repo>",
    covers: ["catalog.hfQuants"],
    async run(ctx, args) {
      const repo = args.positional[0];
      if (!repo) throw new Error("usage: catalog hf-quants <repo>");
      ctx.printJson(await ctx.client.catalog.hfQuants(repo));
    },
  });

  reg.register({
    path: "admin provider",
    summary: "release a provider (super_admin)",
    usage: "admin provider <slug> --name <name> [--kind proxied|open_weight]",
    covers: ["admin.createProvider"],
    async run(ctx, args) {
      const slug = args.positional[0];
      const name = flagStr(args, "name");
      if (!slug || !name) throw new Error("usage: admin provider <slug> --name <name> [--kind ...]");
      ctx.printJson(await ctx.client.admin.createProvider({ slug, name, kind: kind(flagStr(args, "kind")) }));
    },
  });

  reg.register({
    path: "admin model",
    summary: "release a model (super_admin); --in/--out are the vendor's list price in dollars per unit",
    usage: "admin model <id> --provider <slug> --name <name> [--in <usd/unit>] [--out <usd/unit>] [--kind ...] [--modality chat|image|video|speech|transcription] [--rate-unit mtok|image|second|mchar|minute]",
    covers: ["admin.createModel"],
    async run(ctx, args) {
      const id = args.positional[0];
      const providerSlug = flagStr(args, "provider");
      const name = flagStr(args, "name");
      const inRaw = flagStr(args, "in");
      const outRaw = flagStr(args, "out");
      const input = inRaw === undefined ? undefined : Number(inRaw);
      const output = outRaw === undefined ? undefined : Number(outRaw);
      if (!id || !providerSlug || !name || Number.isNaN(input) || Number.isNaN(output)) {
        throw new Error("usage: admin model <id> --provider <slug> --name <name> [--in <usd>] [--out <usd>]");
      }
      const modality = flagStr(args, "modality") as Modality | undefined;
      const rateUnit = flagStr(args, "rate-unit") as RateUnit | undefined;
      ctx.printJson(
        await ctx.client.admin.createModel({
          id, providerSlug, name, kind: kind(flagStr(args, "kind")),
          ...(modality ? { modality } : {}), ...(rateUnit ? { rateUnit } : {}),
          ...(input !== undefined ? { inputUsdPerMTok: input } : {}),
          ...(output !== undefined ? { outputUsdPerMTok: output } : {}),
        }),
      );
    },
  });

  reg.register({
    path: "admin pricing",
    summary: "update a model's list price / availability (super_admin; dollars per unit)",
    usage: "admin pricing <modelId> [--in <n>] [--out <n>] [--active true|false] [--free-plan true|false]",
    covers: ["admin.setModelPricing"],
    async run(ctx, args) {
      const id = args.positional[0];
      if (!id) throw new Error("usage: admin pricing <modelId> [--in n] [--out n] [--active true|false]");
      const pricing: { inputUsdPerMTok?: number; outputUsdPerMTok?: number; active?: boolean; modality?: Modality; rateUnit?: RateUnit; freePlan?: boolean } = {};
      const inFlag = flagStr(args, "in");
      const outFlag = flagStr(args, "out");
      if (inFlag !== undefined) pricing.inputUsdPerMTok = Number(inFlag);
      if (outFlag !== undefined) pricing.outputUsdPerMTok = Number(outFlag);
      const mod = flagStr(args, "modality");
      const ru = flagStr(args, "rate-unit");
      if (mod !== undefined) pricing.modality = mod as Modality;
      if (ru !== undefined) pricing.rateUnit = ru as RateUnit;
      if ("active" in args.flags) pricing.active = String(args.flags.active) === "true";
      if ("free-plan" in args.flags) pricing.freePlan = String(args.flags["free-plan"]) === "true";
      ctx.printJson(await ctx.client.admin.setModelPricing(id, pricing));
    },
  });
}
