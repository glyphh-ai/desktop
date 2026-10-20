/**
 * commands/org.ts — accounts commands (org profile, members, seats, invites). One
 * command per SDK method; `covers` keeps the parity test honest.
 */

import type { CommandRegistry } from "../registry.js";
import type { CliArgs } from "../args.js";
import { flagStr } from "../args.js";
import type { MemberRole, MemberSystemRole, GuardrailsPolicy } from "../../contract/org.js";

function asRole(v: string | undefined): MemberRole {
  return v === "org_admin" ? "org_admin" : "user";
}

function asSystemRole(v: string | undefined): MemberSystemRole {
  return v === "org_admin" ? "org_admin" : v === "admin" ? "admin" : "user";
}

/** Build a guardrails policy from numeric flags (undefined fields are omitted). */
function guardrailsFromFlags(args: CliArgs): GuardrailsPolicy {
  const policy: GuardrailsPolicy = {};
  const keys: (keyof GuardrailsPolicy)[] = ["maxInputTokens", "maxOutputTokens", "windowSeconds", "windowTokens", "windowCalls", "maxConcurrent"];
  for (const k of keys) {
    const v = flagStr(args, k);
    if (v !== undefined) {
      const n = Number(v);
      if (Number.isFinite(n)) policy[k] = n;
    }
  }
  return policy;
}

export function registerOrg(reg: CommandRegistry): void {
  reg.register({
    path: "org infra",
    summary: "the org's runtime infra + region-choice state",
    covers: ["org.infra"],
    async run(ctx) {
      ctx.printJson(await ctx.client.org.infra());
    },
  });

  reg.register({
    path: "org infra set",
    summary: "make the region/tier choice: --region <id> [--tier shared]",
    covers: ["org.chooseInfra"],
    async run(ctx, args) {
      const region = flagStr(args, "region");
      if (!region) throw new Error("--region is required");
      const tier = flagStr(args, "tier") ?? "shared";
      ctx.printJson(await ctx.client.org.chooseInfra({ region, tier }));
    },
  });

  reg.register({
    path: "org show",
    summary: "the caller's organization",
    covers: ["org.get"],
    async run(ctx) {
      ctx.printJson(await ctx.client.org.get());
    },
  });

  reg.register({
    path: "org image",
    summary: "set the organization's image (org_admin only)",
    usage: "org image <file>",
    covers: ["org.uploadImage"],
    async run(ctx, args) {
      const file = args.positional[0];
      if (!file) throw new Error("usage: org image <file>");
      const { readFileSync } = await import("node:fs");
      ctx.printJson(await ctx.client.org.uploadImage(new Uint8Array(readFileSync(file))));
    },
  });
  // Marketplace app blocklist (org_admin): which listed apps this org bars.
  reg.register({
    path: "org app-blocks",
    summary: "the marketplace apps blocked for this org",
    covers: ["org.appBlocks"],
    async run(ctx) {
      ctx.printJson(await ctx.client.org.appBlocks());
    },
  });
  reg.register({
    path: "org block-app",
    summary: "bar a marketplace app for this org (org_admin only)",
    usage: "org block-app <slug-or-id>",
    covers: ["org.blockApp"],
    async run(ctx, args) {
      const ref = args.positional[0];
      if (!ref) throw new Error("usage: org block-app <slug-or-id>");
      ctx.printJson(await ctx.client.org.blockApp(ref));
    },
  });
  reg.register({
    path: "org unblock-app",
    summary: "lift an org's marketplace app block (org_admin only)",
    usage: "org unblock-app <slug-or-id>",
    covers: ["org.unblockApp"],
    async run(ctx, args) {
      const ref = args.positional[0];
      if (!ref) throw new Error("usage: org unblock-app <slug-or-id>");
      await ctx.client.org.unblockApp(ref);
      ctx.print("unblocked");
    },
  });

  reg.register({
    path: "org update",
    summary: "update the org (name; org_admin only)",
    usage: "org update --name <name>",
    covers: ["org.update"],
    async run(ctx, args) {
      const name = flagStr(args, "name");
      if (!name) throw new Error("usage: org update --name <name>");
      ctx.printJson(await ctx.client.org.update({ name }));
    },
  });

  reg.register({
    path: "members list",
    summary: "list org members",
    covers: ["members.list"],
    async run(ctx) {
      ctx.printJson(await ctx.client.members.list());
    },
  });

  reg.register({
    path: "members invite",
    summary: "invite a member (org_admin; fills a seat)",
    usage: "members invite <email> [--role org_admin|user]",
    covers: ["members.invite"],
    async run(ctx, args) {
      const email = args.positional[0];
      if (!email) throw new Error("usage: members invite <email> [--role user|org_admin]");
      const created = await ctx.client.members.invite(email, asRole(flagStr(args, "role")));
      ctx.print(`invited ${email} — token: ${created.token}`);
    },
  });

  reg.register({
    path: "members remove",
    summary: "remove a member (frees the seat)",
    usage: "members remove <userId>",
    covers: ["members.remove"],
    async run(ctx, args) {
      const userId = args.positional[0];
      if (!userId) throw new Error("usage: members remove <userId>");
      await ctx.client.members.remove(userId);
      ctx.print("removed ✓");
    },
  });

  reg.register({
    path: "members role",
    summary: "set a member's system role",
    usage: "members role <userId> <org_admin|admin|user>",
    covers: ["members.setRole"],
    async run(ctx, args) {
      const [userId, role] = args.positional;
      if (!userId || !role) throw new Error("usage: members role <userId> <org_admin|admin|user>");
      ctx.printJson(await ctx.client.members.setRole(userId, asSystemRole(role)));
    },
  });

  reg.register({
    path: "members profile",
    summary: "set a member's name (org_admin)",
    usage: "members profile <userId> [--firstName <s>] [--lastName <s>]",
    covers: ["members.updateProfile"],
    async run(ctx, args) {
      const userId = args.positional[0];
      if (!userId) throw new Error("usage: members profile <userId> [--firstName <s>] [--lastName <s>]");
      const patch: { firstName?: string; lastName?: string } = {};
      const first = flagStr(args, "firstName");
      const last = flagStr(args, "lastName");
      if (first !== undefined) patch.firstName = first;
      if (last !== undefined) patch.lastName = last;
      ctx.printJson(await ctx.client.members.updateProfile(userId, patch));
    },
  });

  reg.register({
    path: "members workspace",
    summary: "assign a member to a workspace (or --clear to the base)",
    usage: "members workspace <userId> <workspaceId | --clear>",
    covers: ["members.assignWorkspace"],
    async run(ctx, args) {
      const userId = args.positional[0];
      if (!userId) throw new Error("usage: members workspace <userId> <workspaceId | --clear>");
      const workspaceId = "clear" in args.flags ? null : args.positional[1] ?? null;
      ctx.printJson(await ctx.client.members.assignWorkspace(userId, workspaceId));
    },
  });

  reg.register({
    path: "org guardrails",
    summary: "the org's runtime guardrails policy (org_admin)",
    covers: ["org.guardrails"],
    async run(ctx) {
      ctx.printJson(await ctx.client.org.guardrails());
    },
  });

  reg.register({
    path: "org guardrails set",
    summary: "set/clear the org guardrails policy (org_admin)",
    usage: "org guardrails set [--clear] [--maxInputTokens n] [--maxOutputTokens n] [--windowSeconds n] [--windowTokens n] [--windowCalls n] [--maxConcurrent n]",
    covers: ["org.setGuardrails"],
    async run(ctx, args) {
      if ("clear" in args.flags) {
        ctx.printJson(await ctx.client.org.setGuardrails(null));
        return;
      }
      const policy = guardrailsFromFlags(args);
      if (Object.keys(policy).length === 0) throw new Error("usage: org guardrails set [--clear] [--maxInputTokens n] …");
      ctx.printJson(await ctx.client.org.setGuardrails(policy));
    },
  });

  reg.register({
    path: "invite peek",
    summary: "preview an invite token (public)",
    usage: "invite peek <token>",
    covers: ["invites.peek"],
    async run(ctx, args) {
      const token = args.positional[0];
      if (!token) throw new Error("usage: invite peek <token>");
      ctx.printJson(await ctx.client.invites.peek(token));
    },
  });

  reg.register({
    path: "invite accept",
    summary: "accept an invite (joins the org)",
    usage: "invite accept <token>",
    covers: ["invites.accept"],
    async run(ctx, args) {
      const token = args.positional[0];
      if (!token) throw new Error("usage: invite accept <token>");
      ctx.printJson(await ctx.client.invites.accept(token));
    },
  });
}
