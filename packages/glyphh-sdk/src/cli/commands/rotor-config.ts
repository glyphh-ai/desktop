/**
 * commands/config.ts — the rotor catalog + role→model bindings. `config rotors` lists the
 * runnable rotors + their roles; `config bind <rotor> <role>=<modelId>[:local] …` binds them;
 * `config registry <rotor>` shows the resolved runtime registry. (The interactive picker lives
 * in the TUI's /configure.)
 */

import type { CommandRegistry } from "../registry.js";
import type { ModelTransport, RoleBinding } from "../../contract/bindings.js";

export function registerRotorConfig(reg: CommandRegistry): void {
  reg.register({
    path: "config rotors",
    summary: "list runnable rotors + the model roles each needs",
    covers: ["rotorConfig.rotors"],
    async run(ctx) {
      ctx.printJson(await ctx.client.rotorConfig.rotors());
    },
  });

  reg.register({
    path: "config rotor",
    summary: "one rotor + its roles",
    usage: "config rotor <slug>",
    covers: ["rotorConfig.rotor"],
    async run(ctx, args) {
      const slug = args.positional[0];
      if (!slug) throw new Error("usage: config rotor <slug>");
      ctx.printJson(await ctx.client.rotorConfig.rotor(slug));
    },
  });

  reg.register({
    path: "config binding",
    summary: "the current role→model binding for a rotor",
    usage: "config binding <slug>",
    covers: ["rotorConfig.binding"],
    async run(ctx, args) {
      const slug = args.positional[0];
      if (!slug) throw new Error("usage: config binding <slug>");
      ctx.printJson(await ctx.client.rotorConfig.binding(slug));
    },
  });

  reg.register({
    path: "config bind",
    summary: "bind a rotor's roles: role=modelId[:local]",
    usage: "config bind <slug> <role>=<modelId>[:local] [<role>=<modelId> …]",
    covers: ["rotorConfig.setBinding"],
    async run(ctx, args) {
      const slug = args.positional[0];
      const pairs = args.positional.slice(1);
      if (!slug || pairs.length === 0) throw new Error("usage: config bind <slug> <role>=<modelId>[:local] …");
      const roles: RoleBinding[] = pairs.map((p) => {
        const [role, rest] = p.split("=");
        if (!role || !rest) throw new Error(`bad pair: ${p}`);
        const local = rest.endsWith(":local");
        const modelId = local ? rest.slice(0, -":local".length) : rest;
        const transport: ModelTransport = local ? "local" : "gateway";
        return { role, modelId, transport };
      });
      ctx.printJson(await ctx.client.rotorConfig.setBinding(slug, { roles }));
    },
  });

  reg.register({
    path: "config registry",
    summary: "the resolved runtime registry for a rotor",
    usage: "config registry <slug>",
    covers: ["rotorConfig.registry"],
    async run(ctx, args) {
      const slug = args.positional[0];
      if (!slug) throw new Error("usage: config registry <slug>");
      ctx.printJson(await ctx.client.rotorConfig.registry(slug));
    },
  });
}
