/**
 * Rotor config ↔ live control plane. The seeded rotor catalog exposes base (1 role) +
 * planning (3 roles); a fresh workspace has no binding, so the resolved registry is empty
 * (the rotor then streams the basic-tier stub). Needs the server on :3001.
 */

import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { createClient, type Client } from "../src/index.js";

const url = process.env.GLYPHH_SERVER_URL ?? "http://127.0.0.1:3001";

async function signIn(): Promise<Client> {
  const client = createClient({ url });
  const start = await client.auth.startEmailLink(`cfg-${randomUUID()}@example.com`);
  await client.auth.verifyEmailLink(start.devToken!);
  return client;
}

describe("@glyphh/sdk — rotor config", () => {
  it("the seeded catalog exposes base (1 role) + planning (multi-role)", async () => {
    const rotors = await (await signIn()).rotorConfig.rotors();
    const bySlug = Object.fromEntries(rotors.map((r) => [r.slug, r]));
    expect(bySlug.base).toBeTruthy();
    expect(bySlug.base!.roles.map((r) => r.role)).toEqual(["assistant"]);
    expect(bySlug.planning!.roles.length).toBeGreaterThan(1);
    expect(bySlug.planning!.roles.map((r) => r.role)).toContain("planner");
  });

  it("a fresh workspace has no binding → an empty resolved registry", async () => {
    const client = await signIn();
    expect((await client.rotorConfig.binding("base")).roles).toEqual([]);
    const registry = await client.rotorConfig.registry("base");
    expect(registry.rotorSlug).toBe("base");
    expect(registry.models).toEqual([]);
  });
});
