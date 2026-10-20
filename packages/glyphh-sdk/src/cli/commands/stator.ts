/**
 * commands/stator.ts — the org memory plane (the fact substrate) from the
 * CLI: recall (the runtime path) and the curation surface
 * (browse/create/graph/forget/amend).
 */

import type { CommandRegistry } from "../registry.js";
import { flagStr } from "../args.js";

/** Parse "layer.role=value" pairs into the {layer: {role: value}} shape. */
function parseSlots(pairs: string[]): Record<string, Record<string, string>> {
  const out: Record<string, Record<string, string>> = {};
  for (const pair of pairs) {
    const eq = pair.indexOf("=");
    const path = eq > 0 ? pair.slice(0, eq) : "";
    const value = eq > 0 ? pair.slice(eq + 1) : "";
    const dot = path.indexOf(".");
    if (dot <= 0 || !value) throw new Error(`slot "${pair}" must be layer.role=value`);
    const layer = path.slice(0, dot), role = path.slice(dot + 1);
    (out[layer] ??= {})[role] = value;
  }
  return out;
}

export function registerStator(reg: CommandRegistry): void {
  reg.register({
    path: "memory recall",
    summary: "cosine-gated fact hits for a query, plus their fact-block rendering",
    usage: "memory recall <query> [--k <n>]",
    covers: ["stator.recall"],
    async run(ctx, args) {
      const query = args.positional.join(" ").trim();
      const k = flagStr(args, "k");
      ctx.printJson(await ctx.client.stator.recall({
        ...(query ? { query } : {}),
        ...(k ? { topK: Number(k) } : {}),
      }));
    },
  });

  reg.register({
    path: "memory browse",
    summary: "every live fact glyphh in the caller's ledger",
    usage: "memory browse [--limit <n>]",
    covers: ["stator.browse"],
    async run(ctx, args) {
      const limit = flagStr(args, "limit");
      ctx.printJson(await ctx.client.stator.browse(limit ? { limit: Number(limit) } : {}));
    },
  });

  reg.register({
    path: "memory create",
    summary: "append a new fact glyphh (slots as layer.role=value pairs)",
    usage: "memory create <name> [layer.role=value ...] [--confidence <f>] [--scope org|user]",
    covers: ["stator.create"],
    async run(ctx, args) {
      const [name, ...pairs] = args.positional;
      if (!name) throw new Error("usage: memory create <name> [layer.role=value ...]");
      const confidence = flagStr(args, "confidence");
      const scopeFlag = flagStr(args, "scope");
      const facts = parseSlots(pairs);
      ctx.printJson(await ctx.client.stator.create({
        name,
        ...(Object.keys(facts).length ? { facts } : {}),
        ...(confidence ? { confidence: Number(confidence) } : {}),
        ...(scopeFlag === "user" || scopeFlag === "org" ? { scope: scopeFlag } : {}),
      }));
    },
  });

  reg.register({
    path: "memory graph",
    summary: "the fact space: nodes + 3D PCA coords + banded similarity edges",
    usage: "memory graph [--max <n>] [--sem <f>] [--nmin <f>] [--nmax <f>]",
    covers: ["stator.graph"],
    async run(ctx, args) {
      const num = (k: string) => { const v = flagStr(args, k); return v ? Number(v) : undefined; };
      const max = num("max"), semMin = num("sem"), neuralMin = num("nmin"), neuralMax = num("nmax");
      ctx.printJson(await ctx.client.stator.graph({
        ...(max !== undefined ? { max } : {}),
        ...(semMin !== undefined ? { semMin } : {}),
        ...(neuralMin !== undefined ? { neuralMin } : {}),
        ...(neuralMax !== undefined ? { neuralMax } : {}),
      }));
    },
  });

  reg.register({
    path: "memory forget",
    summary: "tombstone a fact by id (it leaves every future turn; the row stays)",
    usage: "memory forget <id>",
    covers: ["stator.forget"],
    async run(ctx, args) {
      const id = args.positional.join(" ").trim();
      if (!id) throw new Error("usage: memory forget <id>");
      ctx.printJson(await ctx.client.stator.forget({ id }));
    },
  });

  reg.register({
    path: "memory amend",
    summary: "correct a fact: appends a new version and supersedes the old id",
    usage: "memory amend <id> [--name <n>] [layer.role=value ...] [--confidence <f>]",
    covers: ["stator.amend"],
    async run(ctx, args) {
      const [id, ...pairs] = args.positional;
      if (!id) throw new Error("usage: memory amend <id> [--name <n>] [layer.role=value ...]");
      const name = flagStr(args, "name");
      const confidence = flagStr(args, "confidence");
      const facts = parseSlots(pairs);
      ctx.printJson(await ctx.client.stator.amend({
        id,
        ...(name ? { name } : {}),
        ...(Object.keys(facts).length ? { facts } : {}),
        ...(confidence ? { confidence: Number(confidence) } : {}),
      }));
    },
  });
}
