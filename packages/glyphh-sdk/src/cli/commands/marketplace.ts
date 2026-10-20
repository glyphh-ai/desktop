/**
 * commands/marketplace.ts — marketplace developer profiles + developer reviews.
 * Mirrors the apps review verbs: developers carry stars exactly like apps.
 */

import { readFileSync } from "node:fs";
import type { CommandRegistry } from "../registry.js";
import { flagStr } from "../args.js";
import type { CreateDeveloperInput, UpdateDeveloperInput, PayoutConfigInput } from "../../contract/marketplace.js";

export function registerMarketplace(reg: CommandRegistry): void {
  reg.register({
    path: "marketplace developer create",
    summary: "create your developer profile (personal or your org's)",
    usage: "marketplace developer create --scope personal|org --handle <h> --name <display> [--bio <text>] [--website <url>] [--support-email <email>]",
    covers: ["marketplace.createDeveloper"],
    async run(ctx, args) {
      const scope = flagStr(args, "scope") as CreateDeveloperInput["scope"] | undefined;
      const handle = flagStr(args, "handle");
      const displayName = flagStr(args, "name");
      if (!scope || !handle || !displayName) {
        throw new Error("usage: marketplace developer create --scope personal|org --handle <h> --name <display>");
      }
      const input: CreateDeveloperInput = { scope, handle, displayName };
      const bio = flagStr(args, "bio");
      const website = flagStr(args, "website");
      const supportEmail = flagStr(args, "support-email");
      if (bio) input.bio = bio;
      if (website) input.website = website;
      if (supportEmail) input.supportEmail = supportEmail;
      ctx.printJson(await ctx.client.marketplace.createDeveloper(input));
    },
  });

  reg.register({
    path: "marketplace developer me",
    summary: "your own developer profiles (personal + org)",
    covers: ["marketplace.myDevelopers"],
    async run(ctx) {
      ctx.printJson(await ctx.client.marketplace.myDevelopers());
    },
  });

  reg.register({
    path: "marketplace developer get",
    summary: "one developer profile by handle",
    usage: "marketplace developer get <handle>",
    covers: ["marketplace.developer"],
    async run(ctx, args) {
      const handle = args.positional[0];
      if (!handle) throw new Error("usage: marketplace developer get <handle>");
      ctx.printJson(await ctx.client.marketplace.developer(handle));
    },
  });

  reg.register({
    path: "marketplace developer edit",
    summary: "edit your developer profile (the handle is immutable)",
    usage: "marketplace developer edit <handle> [--name <display>] [--bio <text>] [--website <url>] [--support-email <email>]",
    covers: ["marketplace.updateDeveloper"],
    async run(ctx, args) {
      const handle = args.positional[0];
      if (!handle) throw new Error("usage: marketplace developer edit <handle> [--name …]");
      const patch: UpdateDeveloperInput = {};
      const displayName = flagStr(args, "name");
      const bio = flagStr(args, "bio");
      const website = flagStr(args, "website");
      const supportEmail = flagStr(args, "support-email");
      if (displayName) patch.displayName = displayName;
      if (bio !== undefined) patch.bio = bio;
      if (website !== undefined) patch.website = website;
      if (supportEmail !== undefined) patch.supportEmail = supportEmail;
      ctx.printJson(await ctx.client.marketplace.updateDeveloper(handle, patch));
    },
  });

  reg.register({
    path: "marketplace developer avatar",
    summary: "upload your profile's avatar (PNG/JPEG/GIF/WebP, ≤0.5MB)",
    usage: "marketplace developer avatar <handle> --file <path>",
    covers: ["marketplace.uploadDeveloperAvatar"],
    async run(ctx, args) {
      const handle = args.positional[0];
      const file = flagStr(args, "file");
      if (!handle || !file) throw new Error("usage: marketplace developer avatar <handle> --file <path>");
      const bytes = new Uint8Array(readFileSync(file));
      ctx.printJson(await ctx.client.marketplace.uploadDeveloperAvatar(handle, bytes));
    },
  });

  // ── the developer program (M7): consent, payout config, earnings, payouts ──

  reg.register({
    path: "marketplace program enroll",
    summary: "enroll in the developer program by accepting the current agreement",
    usage: "marketplace program enroll <handle> --agreement-version <version>",
    covers: ["marketplace.enrollProgram"],
    async run(ctx, args) {
      const handle = args.positional[0];
      const version = flagStr(args, "agreement-version");
      if (!handle || !version) {
        throw new Error("usage: marketplace program enroll <handle> --agreement-version <version>");
      }
      ctx.printJson(await ctx.client.marketplace.enrollProgram(handle, version));
    },
  });

  reg.register({
    path: "marketplace program get",
    summary: "your profile's program state (enrollment, consent, payout config)",
    usage: "marketplace program get <handle>",
    covers: ["marketplace.program"],
    async run(ctx, args) {
      const handle = args.positional[0];
      if (!handle) throw new Error("usage: marketplace program get <handle>");
      ctx.printJson(await ctx.client.marketplace.program(handle));
    },
  });

  reg.register({
    path: "marketplace program payout-config",
    summary: "set your payout config (Stripe Connect account + threshold)",
    usage: "marketplace program payout-config <handle> [--account acct_…|none] [--threshold <credits>]",
    covers: ["marketplace.setPayoutConfig"],
    async run(ctx, args) {
      const handle = args.positional[0];
      if (!handle) throw new Error("usage: marketplace program payout-config <handle> [--account …] [--threshold …]");
      const patch: PayoutConfigInput = {};
      const account = flagStr(args, "account");
      const threshold = flagStr(args, "threshold");
      if (account !== undefined) patch.stripeConnectAccountId = account === "none" ? null : account;
      if (threshold !== undefined) patch.payoutThresholdCredits = Number(threshold);
      ctx.printJson(await ctx.client.marketplace.setPayoutConfig(handle, patch));
    },
  });

  reg.register({
    path: "marketplace program stripe-onboard",
    summary: "start (or resume) self-serve Stripe Connect onboarding — prints the hosted url",
    usage: "marketplace program stripe-onboard <handle> [--country <ISO 3166-1 alpha-2, default US>]",
    covers: ["marketplace.startStripeOnboarding"],
    async run(ctx, args) {
      const handle = args.positional[0];
      if (!handle) throw new Error("usage: marketplace program stripe-onboard <handle> [--country US]");
      const country = flagStr(args, "country");
      ctx.printJson(await ctx.client.marketplace.startStripeOnboarding(handle, country ? { country } : {}));
    },
  });

  reg.register({
    path: "marketplace program earnings",
    summary: "your revenue-share ledger + lifetime totals",
    usage: "marketplace program earnings <handle> [--limit <n>] [--offset <n>]",
    covers: ["marketplace.developerEarnings"],
    async run(ctx, args) {
      const handle = args.positional[0];
      if (!handle) throw new Error("usage: marketplace program earnings <handle>");
      const limit = flagStr(args, "limit");
      const offset = flagStr(args, "offset");
      ctx.printJson(await ctx.client.marketplace.developerEarnings(handle, {
        ...(limit ? { limit: Number(limit) } : {}),
        ...(offset ? { offset: Number(offset) } : {}),
      }));
    },
  });

  reg.register({
    path: "marketplace program payouts",
    summary: "your payouts, newest first",
    usage: "marketplace program payouts <handle>",
    covers: ["marketplace.developerPayouts"],
    async run(ctx, args) {
      const handle = args.positional[0];
      if (!handle) throw new Error("usage: marketplace program payouts <handle>");
      ctx.printJson(await ctx.client.marketplace.developerPayouts(handle));
    },
  });

  reg.register({
    path: "marketplace program suspend",
    summary: "suspend a developer's program participation (platform admin)",
    usage: "marketplace program suspend <handle>",
    covers: ["marketplace.suspendDeveloperProgram"],
    async run(ctx, args) {
      const handle = args.positional[0];
      if (!handle) throw new Error("usage: marketplace program suspend <handle>");
      ctx.printJson(await ctx.client.marketplace.suspendDeveloperProgram(handle));
    },
  });

  reg.register({
    path: "marketplace program reinstate",
    summary: "reinstate a suspended developer (platform admin)",
    usage: "marketplace program reinstate <handle>",
    covers: ["marketplace.reinstateDeveloperProgram"],
    async run(ctx, args) {
      const handle = args.positional[0];
      if (!handle) throw new Error("usage: marketplace program reinstate <handle>");
      ctx.printJson(await ctx.client.marketplace.reinstateDeveloperProgram(handle));
    },
  });

  reg.register({
    path: "marketplace payouts-queue",
    summary: "the payout queue across every developer (platform admin)",
    usage: "marketplace payouts-queue [--status pending|paid|failed]",
    covers: ["marketplace.adminPayouts"],
    async run(ctx, args) {
      const status = flagStr(args, "status") as "pending" | "paid" | "failed" | undefined;
      ctx.printJson(await ctx.client.marketplace.adminPayouts(status));
    },
  });

  reg.register({
    path: "marketplace earnings-admin",
    summary: "earnings per developer, biggest unpaid first (platform admin)",
    covers: ["marketplace.adminDeveloperEarnings"],
    async run(ctx) {
      ctx.printJson(await ctx.client.marketplace.adminDeveloperEarnings());
    },
  });

  // ── developer reviews (mirroring app reviews) ───────────────────────────────

  reg.register({
    path: "marketplace developer reviews",
    summary: "a developer's reviews, newest first",
    usage: "marketplace developer reviews <handle> [--limit <n>] [--offset <n>]",
    covers: ["marketplace.developerReviews"],
    async run(ctx, args) {
      const handle = args.positional[0];
      if (!handle) throw new Error("usage: marketplace developer reviews <handle>");
      const limit = flagStr(args, "limit");
      const offset = flagStr(args, "offset");
      ctx.printJson(await ctx.client.marketplace.developerReviews(handle, {
        ...(limit ? { limit: Number(limit) } : {}),
        ...(offset ? { offset: Number(offset) } : {}),
      }));
    },
  });

  reg.register({
    path: "marketplace developer review",
    summary: "create or edit YOUR review of a developer (1–5 stars)",
    usage: "marketplace developer review <handle> --stars <1-5> [--body <text>]",
    covers: ["marketplace.reviewDeveloper"],
    async run(ctx, args) {
      const handle = args.positional[0];
      const stars = flagStr(args, "stars");
      if (!handle || !stars) throw new Error("usage: marketplace developer review <handle> --stars <1-5> [--body <text>]");
      const body = flagStr(args, "body");
      ctx.printJson(await ctx.client.marketplace.reviewDeveloper(handle, {
        stars: Number(stars), ...(body ? { body } : {}),
      }));
    },
  });

  reg.register({
    path: "marketplace developer review-remove",
    summary: "delete your own review of a developer",
    usage: "marketplace developer review-remove <handle>",
    covers: ["marketplace.removeDeveloperReview"],
    async run(ctx, args) {
      const handle = args.positional[0];
      if (!handle) throw new Error("usage: marketplace developer review-remove <handle>");
      await ctx.client.marketplace.removeDeveloperReview(handle);
      ctx.printJson({ ok: true });
    },
  });

  reg.register({
    path: "marketplace developer review-respond",
    summary: "reply publicly to a review of your profile",
    usage: "marketplace developer review-respond <handle> --review <id> --response <text>",
    covers: ["marketplace.respondToDeveloperReview"],
    async run(ctx, args) {
      const handle = args.positional[0];
      const review = flagStr(args, "review");
      const response = flagStr(args, "response");
      if (!handle || !review || !response) {
        throw new Error("usage: marketplace developer review-respond <handle> --review <id> --response <text>");
      }
      ctx.printJson(await ctx.client.marketplace.respondToDeveloperReview(handle, review, response));
    },
  });

  reg.register({
    path: "marketplace developer review-report",
    summary: "flag a review of your profile for platform moderation",
    usage: "marketplace developer review-report <handle> --review <id> --reason <text>",
    covers: ["marketplace.reportDeveloperReview"],
    async run(ctx, args) {
      const handle = args.positional[0];
      const review = flagStr(args, "review");
      const reason = flagStr(args, "reason");
      if (!handle || !review || !reason) {
        throw new Error("usage: marketplace developer review-report <handle> --review <id> --reason <text>");
      }
      ctx.printJson(await ctx.client.marketplace.reportDeveloperReview(handle, review, reason));
    },
  });

  reg.register({
    path: "marketplace developer reviews-flagged",
    summary: "the flagged developer-review queue (platform admin)",
    covers: ["marketplace.flaggedDeveloperReviews"],
    async run(ctx) {
      ctx.printJson(await ctx.client.marketplace.flaggedDeveloperReviews());
    },
  });

  reg.register({
    path: "marketplace developer review-moderate",
    summary: "settle a flagged developer review: restore | remove (platform admin)",
    usage: "marketplace developer review-moderate --review <id> --action restore|remove",
    covers: ["marketplace.moderateDeveloperReview"],
    async run(ctx, args) {
      const review = flagStr(args, "review");
      const action = flagStr(args, "action") as "restore" | "remove" | undefined;
      if (!review || !action) {
        throw new Error("usage: marketplace developer review-moderate --review <id> --action restore|remove");
      }
      ctx.printJson(await ctx.client.marketplace.moderateDeveloperReview(review, action));
    },
  });
}
