/**
 * commands/gateway.ts — run one metered completion. The CLI face of the single
 * model egress: `glyphh complete <model> "<prompt>"`.
 */

import { readFileSync } from "node:fs";
import type { CommandRegistry } from "../registry.js";
import { flagStr } from "../args.js";
import type { MessageTurnInput, MessageTool } from "../../contract/gateway.js";

export function registerGateway(reg: CommandRegistry): void {
  reg.register({
    path: "messages",
    summary: "one Anthropic Messages turn, printed raw (what an agent loop rides)",
    usage: 'messages <model> "<prompt>" [--max <tokens>] [--stream]',
    covers: ["gateway.messages"],
    async run(ctx, args) {
      const [model, prompt] = args.positional;
      if (!model || !prompt) return ctx.print('usage: messages <model> "<prompt>" [--max <tokens>] [--stream]');
      const upstream = await ctx.client.gateway.messages({
        model,
        max_tokens: args.flags.max ? Number(args.flags.max) : 1024,
        ...(args.flags.stream ? { stream: true } : {}),
        messages: [{ role: "user", content: prompt }],
      });
      // Raw on purpose: SSE frames or the JSON body, exactly as the loop sees them.
      ctx.print(await upstream.text());
    },
  });

  reg.register({
    path: "complete",
    summary: "one metered completion on a model you're allowed to use",
    usage: 'complete <model> "<prompt>" [--system "<text>"] [--max <tokens>] [--json]',
    covers: ["gateway.complete", "gateway.text"],
    async run(ctx, args) {
      const [model, prompt] = args.positional;
      if (!model || !prompt) {
        return ctx.print('usage: complete <model> "<prompt>" [--system "<text>"] [--max <tokens>] [--json]');
      }
      const system = args.flags.system ? String(args.flags.system) : undefined;
      const max = args.flags.max ? Number(args.flags.max) : undefined;
      const messages = [
        ...(system ? [{ role: "system", content: system }] : []),
        { role: "user", content: prompt },
      ];
      const input = { model, messages, ...(max ? { maxTokens: max } : {}) };
      if (args.flags.json) {
        ctx.printJson(await ctx.client.gateway.complete(input));
        return;
      }
      ctx.print(await ctx.client.gateway.text(input));
    },
  });

  reg.register({
    path: "gateway turn",
    summary: "one tool-capable turn — what a loop runs on each step",
    usage: "gateway turn <model> <prompt> [--system <s>] [--tools <path>] [--max-tokens <n>]",
    covers: ["gateway.turn"],
    async run(ctx, args) {
      const [model, prompt] = args.positional;
      if (!model || !prompt) {
        throw new Error("usage: gateway turn <model> <prompt> [--system <s>] [--tools <path>] [--max-tokens <n>]");
      }
      const input: MessageTurnInput = { model, messages: [{ role: "user", content: prompt }] };
      const system = flagStr(args, "system"); if (system !== undefined) input.system = system;
      const maxTokens = flagStr(args, "max-tokens");
      if (maxTokens !== undefined) {
        const n = Number(maxTokens);
        if (!Number.isFinite(n) || n <= 0) throw new Error("--max-tokens must be a positive number");
        input.maxTokens = n;
      }
      // Tools come from a FILE: a JSON schema array is not something you type at a
      // shell, and it is the same file a loop would ship.
      const toolsPath = flagStr(args, "tools");
      if (toolsPath !== undefined) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(readFileSync(toolsPath, "utf8"));
        } catch (err) {
          throw new Error(`--tools: cannot read ${toolsPath} (${err instanceof Error ? err.message : String(err)})`);
        }
        if (!Array.isArray(parsed)) throw new Error("--tools must be a file containing a JSON array of tools");
        input.tools = parsed as MessageTool[];
      }
      ctx.printJson(await ctx.client.gateway.turn(input));
    },
  });

  reg.register({
    path: "gateway my-keys",
    summary: "your own API keys, plus whether member minting is open to you",
    covers: ["gateway.myKeys"],
    async run(ctx) {
      ctx.printJson(await ctx.client.gateway.myKeys());
    },
  });

  reg.register({
    path: "gateway mint-key",
    summary: "mint a personal API key (shown once) — paid plan + org switch",
    usage: "gateway mint-key <name> [--days <n>]",
    covers: ["gateway.mintMyKey"],
    async run(ctx, args) {
      const name = args.positional[0];
      if (!name) throw new Error("usage: gateway mint-key <name> [--days <n>]");
      const days = typeof args.flags.days === "string" ? Number(args.flags.days) : undefined;
      ctx.printJson(await ctx.client.gateway.mintMyKey(name, days));
    },
  });

  reg.register({
    path: "gateway revoke-key",
    summary: "revoke one of YOUR keys",
    usage: "gateway revoke-key <id>",
    covers: ["gateway.revokeMyKey"],
    async run(ctx, args) {
      const id = args.positional[0];
      if (!id) throw new Error("usage: gateway revoke-key <id>");
      await ctx.client.gateway.revokeMyKey(id);
      ctx.printJson({ ok: true });
    },
  });

  reg.register({
    path: "gateway member-keys",
    summary: "read or flip the org's member-minting switch (org_admin)",
    usage: "gateway member-keys [on|off]",
    covers: ["gateway.memberKeysEnabled", "gateway.setMemberKeysEnabled"],
    async run(ctx, args) {
      const state = args.positional[0];
      if (state === "on" || state === "off") {
        ctx.printJson(await ctx.client.gateway.setMemberKeysEnabled(state === "on"));
      } else {
        ctx.printJson(await ctx.client.gateway.memberKeysEnabled());
      }
    },
  });
}
