/**
 * Billing ↔ live control plane. Plans catalog, a new org's status + free credit
 * balance, and the "Stripe not configured" path for subscribe. Needs the server on
 * :3001 (Stripe runs unconfigured in dev → subscribe is a clean 404).
 */

import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { createClient, type Client } from "../src/index.js";

const url = process.env.GLYPHH_SERVER_URL ?? "http://127.0.0.1:3001";

async function signIn(): Promise<Client> {
  const client = createClient({ url });
  const start = await client.auth.startEmailLink(`bill-${randomUUID()}@example.com`);
  await client.auth.verifyEmailLink(start.devToken!);
  return client;
}

describe("@glyphh/sdk — billing", () => {
  it("lists the seeded plans (Free/Basic/Pro/Enterprise)", async () => {
    const plans = await (await signIn()).billing.plans();
    const byTier = Object.fromEntries(plans.map((p) => [p.tier, p]));
    // The pool is the plan price, dollar for dollar (free = $1).
    expect(byTier.free!.poolUsdPerMonth).toBe(1);
    expect(byTier.basic!.poolUsdPerMonth).toBe(byTier.basic!.monthlyUsdCents / 100);
    expect(byTier.pro!.poolUsdPerMonth).toBe(byTier.pro!.monthlyUsdCents / 100);
    expect(byTier.enterprise!.sso).toBe(true);
  });

  it("a new org is on the free tier with its $1 Pipedream pool", async () => {
    const client = await signIn();
    const status = await client.billing.status();
    expect(status.tier).toBe("free");
    expect(status.maxSeats).toBe(1);
    const b = await client.billing.balance();
    expect(b.planUsd).toBe(1);
    expect(b.fundsUsd).toBe(0);
    expect(b.spentUsd).toBe(0);
    expect(b.remainingUsd).toBe(1);
  });

  it("subscribe returns a Stripe checkout URL", async () => {
    const client = await signIn();
    const { url } = await client.billing.subscribe("basic");
    expect(url).toMatch(/^https:\/\/checkout\.stripe\.com\//);
  });

  it("balance() derives from the seeded free plan's pool", async () => {
    const client = await signIn();
    // Derived from the seeded free plan rather than a hardcoded constant: a fresh
    // org's whole budget IS its plan's monthly pool. Re-pricing the free tier
    // moves this test with the seed.
    const free = (await client.billing.plans()).find((p) => p.tier === "free")!;
    const b = await client.billing.balance();
    expect(b.planUsd).toBe(free.poolUsdPerMonth);
    expect(b.remainingUsd).toBe(free.poolUsdPerMonth);
  });

  it("autotopup() defaults to disabled and setAutotopup() round-trips (dollars)", async () => {
    const client = await signIn();
    expect(await client.billing.autotopup()).toEqual({ enabled: false, thresholdUsd: 0, topupUsd: 0 });
    const set = await client.billing.setAutotopup({ enabled: true, thresholdUsd: 5, topupUsd: 20 });
    expect(set).toEqual({ enabled: true, thresholdUsd: 5, topupUsd: 20 });
    expect((await client.billing.autotopup()).enabled).toBe(true);
  });

  it("changePlan() on a free org yields a Checkout fallback URL", async () => {
    const client = await signIn();
    const change = await client.billing.changePlan("pro");
    expect(change.effect).toBe("checkout");
    expect(change.url).toMatch(/^https:\/\/checkout\.stripe\.com\//);
  });

  it("topup() returns a Stripe checkout URL", async () => {
    const client = await signIn();
    const { url } = await client.billing.topup({ usd: 20 });
    expect(url).toMatch(/^https:\/\/checkout\.stripe\.com\//);
  });

  it("invoices() returns an array (empty for a new org)", async () => {
    const client = await signIn();
    expect(await client.billing.invoices()).toEqual([]);
  });
});
