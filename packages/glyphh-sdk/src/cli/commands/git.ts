/**
 * commands/git.ts — link GitHub and list repos. `git connect` prints a URL to open;
 * once linked, `git repos` lists repositories, `git branches` a repo's branches, and
 * sessions created with a repo get a scoped clone token injected server-side.
 */

import { flagStr } from "../args.js";
import type { CommandRegistry } from "../registry.js";

export function registerGit(reg: CommandRegistry): void {
  reg.register({
    path: "git connect",
    summary: "link GitHub (prints a URL to open)",
    usage: "git connect [--return-to <url>]",
    covers: ["git.connect"],
    async run(ctx, args) {
      const returnTo = flagStr(args, "return-to");
      ctx.printJson(await ctx.client.git.connect(returnTo ? { returnTo } : {}));
    },
  });

  reg.register({
    path: "git complete",
    summary: "finish a GitHub link the callback parked (the link from ?github=pending, or your newest)",
    usage: "git complete [link]",
    covers: ["git.complete"],
    async run(ctx, args) {
      ctx.printJson(await ctx.client.git.complete(args.positional[0]));
    },
  });

  reg.register({
    path: "git status",
    summary: "whether GitHub is linked, and as whom",
    covers: ["git.status"],
    async run(ctx) {
      ctx.printJson(await ctx.client.git.status());
    },
  });

  reg.register({
    path: "git repos",
    summary: "list the connected account's repositories",
    covers: ["git.repos"],
    async run(ctx) {
      ctx.printJson(await ctx.client.git.repos());
    },
  });

  reg.register({
    path: "git branches",
    summary: "list a repo's branches, the default first",
    usage: "git branches <owner/repo>",
    covers: ["git.branches"],
    async run(ctx, args) {
      const repo = args.positional[0];
      if (!repo) throw new Error("usage: git branches <owner/repo>");
      ctx.printJson(await ctx.client.git.branches(repo));
    },
  });

  reg.register({
    path: "git clone-token",
    summary: "mint a short-lived clone token scoped to one repo",
    usage: "git clone-token <owner/repo>",
    covers: ["git.cloneToken"],
    async run(ctx, args) {
      const repo = args.positional[0];
      if (!repo) throw new Error("usage: git clone-token <owner/repo>");
      ctx.printJson(await ctx.client.git.cloneToken(repo));
    },
  });

  reg.register({
    path: "git disconnect",
    summary: "unlink GitHub",
    covers: ["git.disconnect"],
    async run(ctx) {
      await ctx.client.git.disconnect();
      ctx.printJson({ disconnected: true });
    },
  });
}
