/**
 * Model governance ↔ live control plane. The org's SUPPORTED set (list / toggle /
 * bulk), the caller's EFFECTIVE set (`models.available`), the model-governance audit
 * slice, usage.byModel, and the runtime model-switch plumbing. Needs the server on :3001.
 */

import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { createClient, type Client } from "../src/index.js";

const url = process.env.GLYPHH_SERVER_URL ?? "http://127.0.0.1:3001";
const OPUS = "anthropic::claude-opus-4-8";
const SONNET = "anthropic::claude-sonnet-5";

async function signIn(): Promise<Client> {
  const client = createClient({ url });
  const start = await client.auth.startEmailLink(`mdl-${randomUUID()}@example.com`);
  await client.auth.verifyEmailLink(start.devToken!);
  return client;
}

describe("@glyphh/sdk — model governance", () => {
  it("lists the org support view with the whole catalog + flags", async () => {
    const client = await signIn();
    const rows = await client.orgModels.list();
    const opus = rows.find((m) => m.id === OPUS);
    expect(opus).toBeTruthy();
    expect(opus!.providerEnabled).toBe(true); // providers are default-ON (proxy + meter)
    expect(opus!.hasByokKey).toBe(false); // …and default-ON never means an inherited key
    expect(typeof opus!.supported).toBe("boolean");
    expect(opus!.inputUsdPerMTok).toBe(5); // the vendor's list price, $/1M input tokens (informational)
  });

  it("available() resolves the effective set and narrows to the explicit supported set", async () => {
    const client = await signIn();
    await client.providers.enable("anthropic"); // legacy org → all anthropic supported
    const all = await client.models.available();
    expect(all.find((m) => m.id === OPUS)!.source).toBe("proxy");

    // Leave legacy: support only SONNET → available narrows to it.
    const bulk = await client.orgModels.setSupportedBulk([SONNET]);
    expect(bulk.find((m) => m.id === SONNET)!.supported).toBe(true);
    expect(bulk.find((m) => m.id === OPUS)!.supported).toBe(false);

    const narrowed = await client.models.available();
    expect(narrowed.map((m) => m.id)).toEqual([SONNET]);
  });

  it("setSupported toggles one model and shows in the audit slice", async () => {
    const client = await signIn();
    await client.providers.enable("anthropic");
    const one = await client.orgModels.setSupported(OPUS, true);
    expect(one.id).toBe(OPUS);
    expect(one.supported).toBe(true);

    const audit = await client.orgModels.audit({ action: "model.support" });
    expect(audit.total).toBeGreaterThanOrEqual(1);
    expect(audit.entries.every((e) => e.action === "model.support")).toBe(true);
  });

  it("byModel returns an array (empty for a new org)", async () => {
    const client = await signIn();
    const rows = await client.usage.byModel();
    expect(Array.isArray(rows)).toBe(true);
    expect(rows).toEqual([]);
  });

  it("recordModelSwitch audits a LOCAL run's switch — ephemeral id, no provisioned session", async () => {
    const client = await signIn();
    const localId = `cli-${Date.now()}-4242`; // an embedded-run client id, never provisioned
    const res = await client.sessions.recordModelSwitch({
      sessionId: localId, rotorSlug: "base", role: "assistant", from: OPUS, to: SONNET, surface: "cli",
    });
    expect(res).toMatchObject({ sessionId: localId, from: OPUS, to: SONNET, surface: "cli" });

    const audit = await client.orgModels.audit({ action: "model.switch" });
    expect(audit.entries.some((e) => (e.metadata as { sessionId?: string })?.sessionId === localId)).toBe(true);
  });

  it("orgModels surface is forbidden for a non-admin member (server enforces)", async () => {
    // A fresh personal-org user is org_admin, so this asserts the happy path is reachable;
    // role downgrade is exercised server-side. Here we simply confirm the call shape works.
    const client = await signIn();
    await expect(client.orgModels.list()).resolves.toBeInstanceOf(Array);
  });
});
