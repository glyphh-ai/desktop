/**
 * commands/oauth.ts — the connections a user has authorized to act for them, and the
 * consent step itself.
 *
 * `oauth consent` exists mainly so the flow is inspectable from a terminal: the real
 * consent happens in the platform's screen, but being able to drive it by hand is what
 * makes an MCP client's authorization debuggable when it fails.
 */

import type { CommandRegistry } from "../registry.js";
import { flagStr } from "../args.js";

export function registerOAuth(reg: CommandRegistry): void {
  reg.register({
    path: "oauth client",
    summary: "show the app requesting access (what a consent screen renders)",
    usage: "oauth client --id <client_id>",
    covers: ["oauth.clientInfo"],
    async run(ctx, args) {
      const id = flagStr(args, "id");
      if (!id) throw new Error("usage: oauth client --id <client_id>");
      ctx.printJson(await ctx.client.oauth.clientInfo(id));
    },
  });

  reg.register({
    path: "oauth consent",
    summary: "approve an authorization request; prints where to send the browser",
    usage: "oauth consent --client-id <id> --redirect-uri <uri> --code-challenge <c> [--state <s>] [--scope <s>]",
    covers: ["oauth.consent"],
    async run(ctx, args) {
      const clientId = flagStr(args, "client-id");
      const redirectUri = flagStr(args, "redirect-uri");
      const codeChallenge = flagStr(args, "code-challenge");
      if (!clientId || !redirectUri || !codeChallenge) {
        throw new Error("usage: oauth consent --client-id <id> --redirect-uri <uri> --code-challenge <c>");
      }
      const state = flagStr(args, "state");
      const scope = flagStr(args, "scope");
      ctx.printJson(
        await ctx.client.oauth.consent({
          clientId,
          redirectUri,
          codeChallenge,
          ...(state ? { state } : {}),
          ...(scope ? { scope } : {}),
        }),
      );
    },
  });

  reg.register({
    path: "oauth grants",
    summary: "everything currently authorized to act for you",
    covers: ["oauth.grants"],
    async run(ctx) {
      ctx.printJson(await ctx.client.oauth.grants());
    },
  });

  reg.register({
    path: "oauth revoke",
    summary: "revoke one authorized connection (does not sign you out)",
    usage: "oauth revoke --id <grant_id>",
    covers: ["oauth.revokeGrant"],
    async run(ctx, args) {
      const id = flagStr(args, "id");
      if (!id) throw new Error("usage: oauth revoke --id <grant_id>");
      ctx.printJson(await ctx.client.oauth.revokeGrant(id));
    },
  });
}
