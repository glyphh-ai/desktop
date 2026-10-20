/**
 * commands/admin.ts — the super_admin platform CONSOLE: dashboard stats, org + user
 * management, plan/model pricing, usage rollups, and the audit log. One command per
 * SDK method (`covers` keeps the parity test honest). The catalog release commands
 * (admin provider/model/pricing) live in commands/catalog.ts.
 */

import type { CommandRegistry } from "../registry.js";
import type { CliArgs } from "../args.js";
import { flagStr } from "../args.js";
import type { AdminOrgPatch, AdminUserPatch, AdminPlanUpdate, AdminPlanCreate, AdminOrgPlanPatch, AdminModelUpdate } from "../../contract/admin.js";

function flagNum(args: CliArgs, name: string): number | undefined {
  const v = flagStr(args, name);
  if (v === undefined) return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}
function flagBool(args: CliArgs, name: string): boolean | undefined {
  if (!(name in args.flags)) return undefined;
  return String(args.flags[name]) === "true";
}

export function registerAdmin(reg: CommandRegistry): void {
  reg.register({
    path: "admin stats",
    summary: "platform dashboard totals (super_admin)",
    covers: ["admin.stats"],
    async run(ctx) {
      ctx.printJson(await ctx.client.admin.stats());
    },
  });

  // ── orgs ─────────────────────────────────────────────────────────────────────
  reg.register({
    path: "admin orgs",
    summary: "list orgs (super_admin)",
    usage: "admin orgs [--q <search>] [--page <n>] [--limit <n>]",
    covers: ["admin.orgs"],
    async run(ctx, args) {
      ctx.printJson(await ctx.client.admin.orgs({ q: flagStr(args, "q"), page: flagNum(args, "page"), limit: flagNum(args, "limit") }));
    },
  });
  reg.register({
    path: "admin org create",
    summary: "create a new org (super_admin)",
    usage: "admin org create --name <name> [--tier <tier>]",
    covers: ["admin.createOrg"],
    async run(ctx, args) {
      const name = flagStr(args, "name");
      if (!name) throw new Error("usage: admin org create --name <name> [--tier <tier>]");
      const tier = flagStr(args, "tier");
      ctx.printJson(await ctx.client.admin.createOrg({ name, ...(tier ? { tier } : {}) }));
    },
  });
  reg.register({
    path: "admin org",
    summary: "an org's detail (super_admin)",
    usage: "admin org <id>",
    covers: ["admin.org"],
    async run(ctx, args) {
      const id = args.positional[0];
      if (!id) throw new Error("usage: admin org <id>");
      ctx.printJson(await ctx.client.admin.org(id));
    },
  });
  reg.register({
    path: "admin org update",
    summary: "edit an org (name/tier/billing)",
    usage: "admin org update <id> [--name <n>] [--tier <t>] [--billing <status>]",
    covers: ["admin.updateOrg"],
    async run(ctx, args) {
      const id = args.positional[0];
      if (!id) throw new Error("usage: admin org update <id> [--name ..] [--tier ..] [--billing ..]");
      const patch: AdminOrgPatch = {};
      const name = flagStr(args, "name"); if (name !== undefined) patch.name = name;
      const tier = flagStr(args, "tier"); if (tier !== undefined) patch.tier = tier;
      const billing = flagStr(args, "billing"); if (billing !== undefined) patch.billingStatus = billing;
      ctx.printJson(await ctx.client.admin.updateOrg(id, patch));
    },
  });
  reg.register({
    path: "admin org lock",
    summary: "lock an org (billing → canceled)",
    usage: "admin org lock <id> [--reason <text>]",
    covers: ["admin.lockOrg"],
    async run(ctx, args) {
      const id = args.positional[0];
      if (!id) throw new Error("usage: admin org lock <id> [--reason ..]");
      ctx.printJson(await ctx.client.admin.lockOrg(id, flagStr(args, "reason")));
    },
  });
  reg.register({
    path: "admin org unlock",
    summary: "unlock an org (billing → active)",
    usage: "admin org unlock <id>",
    covers: ["admin.unlockOrg"],
    async run(ctx, args) {
      const id = args.positional[0];
      if (!id) throw new Error("usage: admin org unlock <id>");
      ctx.printJson(await ctx.client.admin.unlockOrg(id));
    },
  });
  reg.register({
    path: "admin org funds",
    summary: "add dollars to an org's budget (admin grant)",
    usage: "admin org funds <id> <usd> [--note <text>]",
    covers: ["admin.grantFunds"],
    async run(ctx, args) {
      const [id, usd] = args.positional;
      const n = Number(usd);
      if (!id || !Number.isFinite(n) || n <= 0) throw new Error("usage: admin org funds <id> <usd> [--note ..]");
      ctx.printJson(await ctx.client.admin.grantFunds(id, n, flagStr(args, "note")));
    },
  });

  // ── users ──────────────────────────────────────────────────────────────────
  reg.register({
    path: "admin users",
    summary: "list users (super_admin)",
    usage: "admin users [--q <search>] [--page <n>] [--limit <n>]",
    covers: ["admin.users"],
    async run(ctx, args) {
      ctx.printJson(await ctx.client.admin.users({ q: flagStr(args, "q"), page: flagNum(args, "page"), limit: flagNum(args, "limit") }));
    },
  });
  reg.register({
    path: "admin user",
    summary: "a user's detail (super_admin)",
    usage: "admin user <id>",
    covers: ["admin.user"],
    async run(ctx, args) {
      const id = args.positional[0];
      if (!id) throw new Error("usage: admin user <id>");
      ctx.printJson(await ctx.client.admin.user(id));
    },
  });
  reg.register({
    path: "admin user update",
    summary: "edit a user (tier/billing apply org-wide)",
    usage: "admin user update <id> [--first <n>] [--last <n>] [--email <e>] [--role <r>] [--status <s>] [--tier <t>] [--billing <b>]",
    covers: ["admin.updateUser"],
    async run(ctx, args) {
      const id = args.positional[0];
      if (!id) throw new Error("usage: admin user update <id> [--first ..] [--last ..] [--email ..] ...");
      const patch: AdminUserPatch = {};
      const first = flagStr(args, "first"); if (first !== undefined) patch.firstName = first;
      const last = flagStr(args, "last"); if (last !== undefined) patch.lastName = last;
      const email = flagStr(args, "email"); if (email !== undefined) patch.email = email;
      const role = flagStr(args, "role"); if (role !== undefined) patch.role = role;
      const status = flagStr(args, "status"); if (status !== undefined) patch.status = status;
      const tier = flagStr(args, "tier"); if (tier !== undefined) patch.tier = tier;
      const billing = flagStr(args, "billing"); if (billing !== undefined) patch.billingStatus = billing;
      ctx.printJson(await ctx.client.admin.updateUser(id, patch));
    },
  });
  reg.register({
    path: "admin user disable",
    summary: "disable a user",
    usage: "admin user disable <id> [--reason <text>]",
    covers: ["admin.disableUser"],
    async run(ctx, args) {
      const id = args.positional[0];
      if (!id) throw new Error("usage: admin user disable <id> [--reason ..]");
      ctx.printJson(await ctx.client.admin.disableUser(id, flagStr(args, "reason")));
    },
  });
  reg.register({
    path: "admin user enable",
    summary: "enable a user",
    usage: "admin user enable <id>",
    covers: ["admin.enableUser"],
    async run(ctx, args) {
      const id = args.positional[0];
      if (!id) throw new Error("usage: admin user enable <id>");
      ctx.printJson(await ctx.client.admin.enableUser(id));
    },
  });

  // ── plans + models pricing ────────────────────────────────────────────────────
  reg.register({
    path: "admin plans",
    summary: "list plans + pricing (super_admin)",
    covers: ["admin.plans"],
    async run(ctx) {
      ctx.printJson(await ctx.client.admin.plans());
    },
  });
  reg.register({
    path: "admin plan update",
    summary: "edit a plan (price/seats/active — the price is the monthly pool)",
    usage: "admin plan update <tier> [--name <n>] [--cents <usd_cents>] [--seats <n>] [--active true|false]",
    covers: ["admin.updatePlan"],
    async run(ctx, args) {
      const tier = args.positional[0];
      if (!tier) throw new Error("usage: admin plan update <tier> [--name ..] [--cents ..] [--seats ..] [--active ..]");
      const patch: AdminPlanUpdate = {};
      const name = flagStr(args, "name"); if (name !== undefined) patch.display_name = name;
      const cents = flagNum(args, "cents"); if (cents !== undefined) patch.monthly_usd_cents = cents;
      const seats = flagNum(args, "seats"); if (seats !== undefined) patch.max_seats = seats;
      const active = flagBool(args, "active"); if (active !== undefined) patch.active = active;
      ctx.printJson(await ctx.client.admin.updatePlan(tier, patch));
    },
  });

  reg.register({
    path: "admin plan create",
    summary: "create a NEW global tier (super_admin)",
    usage: "admin plan create <tier> --name <displayName> --cents <usd_cents> --seats <n> [--rpm <n>] [--active true|false]",
    covers: ["admin.createPlan"],
    async run(ctx, args) {
      const tier = args.positional[0];
      const name = flagStr(args, "name");
      if (!tier || !name) throw new Error("usage: admin plan create <tier> --name <displayName> --cents .. --seats ..");
      const input: AdminPlanCreate = {
        tier,
        display_name: name,
        monthly_usd_cents: flagNum(args, "cents") ?? 0,
        max_seats: flagNum(args, "seats") ?? 1,
      };
      const rpm = flagNum(args, "rpm"); if (rpm !== undefined) input.rate_limit_rpm = rpm;
      const active = flagBool(args, "active"); if (active !== undefined) input.active = active;
      ctx.printJson(await ctx.client.admin.createPlan(input));
    },
  });

  // ── platform provider keys (rotation: add + activate/deactivate) ─────────────
  reg.register({
    path: "admin providers",
    summary: "list providers + active platform-key counts (super_admin)",
    covers: ["admin.providers"],
    async run(ctx) {
      ctx.printJson(await ctx.client.admin.providers());
    },
  });
  reg.register({
    path: "admin provider keys",
    summary: "list a provider's platform keys (label + hint, never the secret)",
    usage: "admin provider keys <slug>",
    covers: ["admin.providerKeys"],
    async run(ctx, args) {
      const slug = args.positional[0];
      if (!slug) throw new Error("usage: admin provider keys <slug>");
      ctx.printJson(await ctx.client.admin.providerKeys(slug));
    },
  });
  reg.register({
    path: "admin provider key-add",
    summary: "add a platform key for a provider (encrypted at rest)",
    usage: "admin provider key-add <slug> --key <secret> [--label <name>]",
    covers: ["admin.addProviderKey"],
    async run(ctx, args) {
      const slug = args.positional[0];
      const key = flagStr(args, "key");
      if (!slug || !key) throw new Error("usage: admin provider key-add <slug> --key <secret> [--label <name>]");
      ctx.printJson(await ctx.client.admin.addProviderKey(slug, key, flagStr(args, "label")));
    },
  });
  reg.register({
    path: "admin provider key-active",
    summary: "activate/deactivate a platform key (rotation)",
    usage: "admin provider key-active <keyId> --active true|false",
    covers: ["admin.setProviderKeyActive"],
    async run(ctx, args) {
      const id = args.positional[0];
      const active = flagBool(args, "active");
      if (!id || active === undefined) throw new Error("usage: admin provider key-active <keyId> --active true|false");
      ctx.printJson(await ctx.client.admin.setProviderKeyActive(id, active));
    },
  });
  reg.register({
    path: "admin provider key-remove",
    summary: "remove a platform key outright",
    usage: "admin provider key-remove <keyId>",
    covers: ["admin.removeProviderKey"],
    async run(ctx, args) {
      const id = args.positional[0];
      if (!id) throw new Error("usage: admin provider key-remove <keyId>");
      await ctx.client.admin.removeProviderKey(id);
      ctx.printJson({ removed: id });
    },
  });

  // ── per-org bespoke (enterprise) plans ────────────────────────────────────────
  reg.register({
    path: "admin org-plan set",
    summary: "create/replace an org's bespoke plan (super_admin)",
    usage: "admin org-plan set <orgId> --seats <n> --cents <usd_cents> --name <displayName>",
    covers: ["admin.setOrgPlan"],
    async run(ctx, args) {
      const orgId = args.positional[0];
      const seats = flagNum(args, "seats");
      const cents = flagNum(args, "cents");
      const name = flagStr(args, "name");
      if (!orgId || seats === undefined || cents === undefined || !name) {
        throw new Error("usage: admin org-plan set <orgId> --seats <n> --cents <usd_cents> --name <displayName>");
      }
      ctx.printJson(await ctx.client.admin.setOrgPlan(orgId, { maxSeats: seats, monthlyUsdCents: cents, displayName: name }));
    },
  });
  reg.register({
    path: "admin org-plan update",
    summary: "edit an org's bespoke plan (super_admin)",
    usage: "admin org-plan update <orgId> [--seats <n>] [--cents <usd_cents>] [--name <displayName>]",
    covers: ["admin.updateOrgPlan"],
    async run(ctx, args) {
      const orgId = args.positional[0];
      if (!orgId) throw new Error("usage: admin org-plan update <orgId> [--seats ..] [--cents ..] [--name ..]");
      const patch: AdminOrgPlanPatch = {};
      const seats = flagNum(args, "seats"); if (seats !== undefined) patch.maxSeats = seats;
      const cents = flagNum(args, "cents"); if (cents !== undefined) patch.monthlyUsdCents = cents;
      const name = flagStr(args, "name"); if (name !== undefined) patch.displayName = name;
      ctx.printJson(await ctx.client.admin.updateOrgPlan(orgId, patch));
    },
  });
  reg.register({
    path: "admin org-plan remove",
    summary: "remove an org's bespoke plan, reverting to its global tier (super_admin)",
    usage: "admin org-plan remove <orgId>",
    covers: ["admin.removeOrgPlan"],
    async run(ctx, args) {
      const orgId = args.positional[0];
      if (!orgId) throw new Error("usage: admin org-plan remove <orgId>");
      ctx.printJson(await ctx.client.admin.removeOrgPlan(orgId));
    },
  });
  reg.register({
    path: "admin models",
    summary: "list catalog models (super_admin)",
    covers: ["admin.models"],
    async run(ctx) {
      ctx.printJson(await ctx.client.admin.models());
    },
  });
  reg.register({
    path: "admin model update",
    summary: "edit a model (name/active)",
    usage: "admin model update <provider> <model> [--name <n>] [--active true|false]",
    covers: ["admin.updateModel"],
    async run(ctx, args) {
      const [provider, model] = args.positional;
      if (!provider || !model) throw new Error("usage: admin model update <provider> <model> [--name ..] [--active ..]");
      const patch: AdminModelUpdate = {};
      const name = flagStr(args, "name"); if (name !== undefined) patch.display_name = name;
      const active = flagBool(args, "active"); if (active !== undefined) patch.active = active;
      ctx.printJson(await ctx.client.admin.updateModel(provider, model, patch));
    },
  });
  reg.register({
    path: "admin model delete",
    summary: "remove a catalog model + its org support (super_admin)",
    usage: "admin model delete <provider> <model>",
    covers: ["admin.deleteModel"],
    async run(ctx, args) {
      const [provider, model] = args.positional;
      if (!provider || !model) throw new Error("usage: admin model delete <provider> <model>");
      await ctx.client.admin.deleteModel(provider, model);
      ctx.print("deleted ✓");
    },
  });

  // ── plan price history ────────────────────────────────────────────────────────
  reg.register({
    path: "admin plan prices",
    summary: "a plan tier's Stripe price history (super_admin)",
    usage: "admin plan prices <tier>",
    covers: ["admin.planPrices"],
    async run(ctx, args) {
      const tier = args.positional[0];
      if (!tier) throw new Error("usage: admin plan prices <tier>");
      ctx.printJson(await ctx.client.admin.planPrices(tier));
    },
  });
  reg.register({
    path: "admin price add",
    summary: "append a Stripe price to a tier's history (super_admin)",
    usage: "admin price add <tier> <stripePriceId>",
    covers: ["admin.addPlanPrice"],
    async run(ctx, args) {
      const [tier, priceId] = args.positional;
      if (!tier || !priceId) throw new Error("usage: admin price add <tier> <stripePriceId>");
      ctx.printJson(await ctx.client.admin.addPlanPrice(tier, priceId));
    },
  });
  reg.register({
    path: "admin price activate",
    summary: "mark a price active for new checkouts (super_admin)",
    usage: "admin price activate <id>",
    covers: ["admin.activatePlanPrice"],
    async run(ctx, args) {
      const id = args.positional[0];
      if (!id) throw new Error("usage: admin price activate <id>");
      ctx.printJson(await ctx.client.admin.activatePlanPrice(id));
    },
  });
  reg.register({
    path: "admin price remove",
    summary: "remove a price from a tier's history (super_admin)",
    usage: "admin price remove <id>",
    covers: ["admin.removePlanPrice"],
    async run(ctx, args) {
      const id = args.positional[0];
      if (!id) throw new Error("usage: admin price remove <id>");
      await ctx.client.admin.removePlanPrice(id);
      ctx.print("removed ✓");
    },
  });

  // ── impersonation ─────────────────────────────────────────────────────────────
  reg.register({
    path: "admin impersonate",
    summary: "impersonate an org on this session (super_admin)",
    usage: "admin impersonate <orgId>",
    covers: ["admin.impersonate"],
    async run(ctx, args) {
      const orgId = args.positional[0];
      if (!orgId) throw new Error("usage: admin impersonate <orgId>");
      ctx.printJson(await ctx.client.admin.impersonate(orgId));
    },
  });
  reg.register({
    path: "admin unimpersonate",
    summary: "stop impersonating (back to your real scope)",
    covers: ["admin.stopImpersonate"],
    async run(ctx) {
      ctx.printJson(await ctx.client.admin.stopImpersonate());
    },
  });
  reg.register({
    path: "admin models rename",
    summary: "rename a model id in place (migrates support + bindings)",
    usage: "admin models rename <provider> <model> <newModel>",
    covers: ["admin.renameModel"],
    async run(ctx, args) {
      const [provider, model, newModel] = args.positional;
      if (!provider || !model || !newModel) throw new Error("usage: admin models rename <provider> <model> <newModel>");
      ctx.printJson(await ctx.client.admin.renameModel(provider, model, newModel));
    },
  });
  reg.register({
    path: "admin delete-org",
    summary: "PERMANENTLY delete an org and all its data (super_admin)",
    usage: "admin delete-org <orgId> --confirm-name <exact org name>",
    covers: ["admin.deleteOrg"],
    async run(ctx, args) {
      const orgId = args.positional[0];
      const confirmName = args.flags["confirm-name"];
      if (!orgId || typeof confirmName !== "string" || !confirmName) {
        throw new Error("usage: admin delete-org <orgId> --confirm-name <exact org name>");
      }
      ctx.printJson(await ctx.client.admin.deleteOrg(orgId, confirmName));
    },
  });

  // ── usage ────────────────────────────────────────────────────────────────────
  reg.register({
    path: "admin usage by-user",
    summary: "top users by usage (super_admin)",
    usage: "admin usage by-user [--days <n>]",
    covers: ["admin.usageByUser"],
    async run(ctx, args) {
      ctx.printJson(await ctx.client.admin.usageByUser(flagNum(args, "days")));
    },
  });
  reg.register({
    path: "admin usage daily",
    summary: "per-day usage series (super_admin)",
    usage: "admin usage daily <from> <to> [--tz <zone>] [--org <id>] [--user <id>]",
    covers: ["admin.usageDaily"],
    async run(ctx, args) {
      const [from, to] = args.positional;
      if (!from || !to) throw new Error("usage: admin usage daily <from> <to> [--tz ..] [--org ..] [--user ..]");
      ctx.printJson(await ctx.client.admin.usageDaily({ from, to, tz: flagStr(args, "tz"), orgId: flagStr(args, "org"), userId: flagStr(args, "user") }));
    },
  });

  reg.register({
    path: "admin usage by-runtime",
    summary: "usage per region × shared|dedicated × tier (super_admin)",
    usage: "admin usage by-runtime <from> <to> [--region <r>] [--mode shared|dedicated] [--tier <t>]",
    covers: ["admin.usageByRuntime"],
    async run(ctx, args) {
      const [from, to] = args.positional;
      if (!from || !to) {
        throw new Error("usage: admin usage by-runtime <from> <to> [--region ..] [--mode shared|dedicated] [--tier ..]");
      }
      const mode = flagStr(args, "mode");
      if (mode !== undefined && mode !== "shared" && mode !== "dedicated") {
        throw new Error("--mode must be 'shared' or 'dedicated'");
      }
      ctx.printJson(await ctx.client.admin.usageByRuntime({
        from, to, region: flagStr(args, "region"), mode, tier: flagStr(args, "tier"),
      }));
    },
  });

  // ── audit ────────────────────────────────────────────────────────────────────
  reg.register({
    path: "admin audit",
    summary: "the platform audit log (super_admin)",
    usage: "admin audit [--action <a>] [--actor <email>] [--days <n>] [--page <n>] [--limit <n>]",
    covers: ["admin.audit"],
    async run(ctx, args) {
      ctx.printJson(await ctx.client.admin.audit({
        action: flagStr(args, "action"), actor: flagStr(args, "actor"),
        days: flagNum(args, "days"), page: flagNum(args, "page"), limit: flagNum(args, "limit"),
      }));
    },
  });

  // ── support console ────────────────────────────────────────────────────────────
  reg.register({
    path: "admin support list",
    summary: "browse every org's tickets (super_admin)",
    usage: "admin support list [--q <search>] [--status <s>] [--page <n>] [--limit <n>]",
    covers: ["admin.supportTickets"],
    async run(ctx, args) {
      ctx.printJson(await ctx.client.admin.supportTickets({
        q: flagStr(args, "q"), status: flagStr(args, "status"),
        page: flagNum(args, "page"), limit: flagNum(args, "limit"),
      }));
    },
  });
  reg.register({
    path: "admin support show",
    summary: "one ticket + its full thread (super_admin)",
    usage: "admin support show <id>",
    covers: ["admin.supportTicket"],
    async run(ctx, args) {
      const id = args.positional[0];
      if (!id) throw new Error("usage: admin support show <id>");
      ctx.printJson(await ctx.client.admin.supportTicket(id));
    },
  });
  reg.register({
    path: "admin support reply",
    summary: "append an admin reply to a ticket (super_admin)",
    usage: "admin support reply <id> <body...>",
    covers: ["admin.supportReply"],
    async run(ctx, args) {
      const [id, ...rest] = args.positional;
      const body = rest.join(" ").trim();
      if (!id || !body) throw new Error("usage: admin support reply <id> <body...>");
      ctx.printJson(await ctx.client.admin.supportReply(id, body));
    },
  });
  reg.register({
    path: "admin support status",
    summary: "set a ticket's status (super_admin)",
    usage: "admin support status <id> <open|pending|resolved|closed>",
    covers: ["admin.setSupportStatus"],
    async run(ctx, args) {
      const [id, status] = args.positional;
      if (!id || !status) throw new Error("usage: admin support status <id> <open|pending|resolved|closed>");
      ctx.printJson(await ctx.client.admin.setSupportStatus(id, status));
    },
  });
  reg.register({
    path: "admin support read",
    summary: "mark a ticket read by the admin (super_admin)",
    usage: "admin support read <id>",
    covers: ["admin.markSupportRead"],
    async run(ctx, args) {
      const id = args.positional[0];
      if (!id) throw new Error("usage: admin support read <id>");
      ctx.printJson(await ctx.client.admin.markSupportRead(id));
    },
  });
  reg.register({
    path: "admin support unread",
    summary: "count of tickets needing admin attention (super_admin)",
    covers: ["admin.supportUnreadCount"],
    async run(ctx) {
      ctx.printJson(await ctx.client.admin.supportUnreadCount());
    },
  });
}
