/**
 * commands/keys.ts — user-scoped API keys. `create` prints the raw token once;
 * `list` shows your keys; `list-org` is the platform's org→user view (org_admin);
 * `revoke` deletes one.
 */

import type { CommandRegistry } from "../registry.js";
import { flagStr } from "../args.js";
import type { ApiKeyInput } from "../../contract/api-keys.js";

export function registerApiKeys(reg: CommandRegistry): void {
  reg.register({
    path: "keys create",
    summary: "mint an API key (token shown once)",
    usage: "keys create <label> [--days <n>]",
    covers: ["apiKeys.create"],
    async run(ctx, args) {
      const label = args.positional[0];
      if (!label) throw new Error("usage: keys create <label> [--days <n>]");
      const input: ApiKeyInput = { label };
      const days = flagStr(args, "days");
      if (days !== undefined) input.expiresInDays = Number(days);
      ctx.printJson(await ctx.client.apiKeys.create(input));
    },
  });

  reg.register({
    path: "keys list",
    summary: "your API keys",
    covers: ["apiKeys.list"],
    async run(ctx) {
      ctx.printJson(await ctx.client.apiKeys.list());
    },
  });

  reg.register({
    path: "keys list-org",
    summary: "every API key in the org, by user (org_admin)",
    covers: ["apiKeys.listOrg"],
    async run(ctx) {
      ctx.printJson(await ctx.client.apiKeys.listOrg());
    },
  });

  reg.register({
    path: "keys revoke",
    summary: "revoke an API key",
    usage: "keys revoke <id>",
    covers: ["apiKeys.revoke"],
    async run(ctx, args) {
      const id = args.positional[0];
      if (!id) throw new Error("usage: keys revoke <id>");
      await ctx.client.apiKeys.revoke(id);
      ctx.printJson({ revoked: id });
    },
  });
}
