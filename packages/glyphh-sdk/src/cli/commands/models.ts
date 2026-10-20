/**
 * commands/models.ts — MODEL GOVERNANCE. `models available` shows the caller's
 * effective set; `org models` + `org models set[-all]` manage the org's SUPPORTED
 * set (org_admin); `org model-audit` reads the model-governance audit slice.
 */

import type { CommandRegistry } from "../registry.js";
import { flagStr } from "../args.js";
import type { ModelAuditQuery } from "../../contract/models.js";

export function registerModels(reg: CommandRegistry): void {
  reg.register({
    path: "models available",
    summary: "the models you may actually use (catalog ∩ org-supported ∩ workspace)",
    covers: ["models.available"],
    async run(ctx) {
      ctx.printJson(await ctx.client.models.available());
    },
  });

  reg.register({
    path: "org models",
    summary: "the whole catalog + this org's support flag (org_admin)",
    covers: ["orgModels.list"],
    async run(ctx) {
      ctx.printJson(await ctx.client.orgModels.list());
    },
  });

  reg.register({
    path: "org models set",
    summary: "toggle support for one model (org_admin)",
    usage: "org models set <modelId> <true|false>",
    covers: ["orgModels.setSupported"],
    async run(ctx, args) {
      const id = args.positional[0];
      const flag = args.positional[1];
      if (!id || (flag !== "true" && flag !== "false")) {
        throw new Error("usage: org models set <modelId> <true|false>");
      }
      ctx.printJson(await ctx.client.orgModels.setSupported(id, flag === "true"));
    },
  });

  reg.register({
    path: "org models set-all",
    summary: "set the FULL supported set at once (org_admin)",
    usage: "org models set-all <modelId> [<modelId> …]",
    covers: ["orgModels.setSupportedBulk"],
    async run(ctx, args) {
      if (args.positional.length === 0) throw new Error("usage: org models set-all <modelId> [<modelId> …]");
      ctx.printJson(await ctx.client.orgModels.setSupportedBulk(args.positional));
    },
  });

  reg.register({
    path: "org model-audit",
    summary: "the org's model-governance audit slice (org_admin)",
    usage: "org model-audit [--action <model.*>] [--actor <email>] [--days <n>] [--page <n>] [--limit <n>]",
    covers: ["orgModels.audit"],
    async run(ctx, args) {
      const q: ModelAuditQuery = {};
      const action = flagStr(args, "action");
      const actor = flagStr(args, "actor");
      const days = flagStr(args, "days");
      const page = flagStr(args, "page");
      const limit = flagStr(args, "limit");
      if (action) q.action = action;
      if (actor) q.actor = actor;
      if (days) q.days = Number(days);
      if (page) q.page = Number(page);
      if (limit) q.limit = Number(limit);
      ctx.printJson(await ctx.client.orgModels.audit(q));
    },
  });

  // ── custom models (BYO OpenAI-compatible endpoint) ──
  reg.register({
    path: "org custom-models list",
    summary: "the org's custom models (org_admin)",
    covers: ["orgModels.listCustom"],
    async run(ctx) {
      ctx.printJson(await ctx.client.orgModels.listCustom());
    },
  });

  reg.register({
    path: "org custom-models add",
    summary: "add/update a custom model (org_admin)",
    usage: "org custom-models add --slug <s> --name <n> --base-url <u> --model <m> --context <n> --max-output <n> [--key <k>]",
    covers: ["orgModels.saveCustom"],
    async run(ctx, args) {
      const slug = flagStr(args, "slug"), name = flagStr(args, "name"), baseUrl = flagStr(args, "base-url");
      const modelName = flagStr(args, "model"), context = flagStr(args, "context"), maxOut = flagStr(args, "max-output");
      const key = flagStr(args, "key");
      if (!slug || !name || !baseUrl || !modelName || !context || !maxOut) {
        throw new Error("usage: org custom-models add --slug --name --base-url --model --context --max-output [--key]");
      }
      ctx.printJson(await ctx.client.orgModels.saveCustom({
        slug, name, baseUrl, modelName, contextWindow: Number(context), maxOutputTokens: Number(maxOut),
        ...(key ? { key } : {}),
      }));
    },
  });

  reg.register({
    path: "org custom-models remove",
    summary: "delete a custom model by id (org_admin)",
    usage: "org custom-models remove <custom::slug>",
    covers: ["orgModels.deleteCustom"],
    async run(ctx, args) {
      const id = args.positional[0];
      if (!id) throw new Error("usage: org custom-models remove <custom::slug>");
      await ctx.client.orgModels.deleteCustom(id);
      ctx.printJson({ deleted: id });
    },
  });
}
