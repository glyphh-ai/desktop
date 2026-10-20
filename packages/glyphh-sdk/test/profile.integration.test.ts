/**
 * Self-profile ↔ live control plane. get() + update() (name + timezone; email/role
 * read-only). Needs the server on :3001.
 */

import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { createClient, type Client } from "../src/index.js";

const url = process.env.GLYPHH_SERVER_URL ?? "http://127.0.0.1:3001";

async function signIn(): Promise<Client> {
  const client = createClient({ url });
  const start = await client.auth.startEmailLink(`profile-${randomUUID()}@example.com`);
  await client.auth.verifyEmailLink(start.devToken!);
  return client;
}

describe("@glyphh/sdk — profile", () => {
  it("get() returns the editable profile; update() sets name (derived first/last) + timezone", async () => {
    const client = await signIn();
    const me = await client.profile.get();
    expect(typeof me.id).toBe("string");
    expect(me.email).toContain("@");
    expect(me.timezone).toBe("UTC");
    expect(typeof me.role).toBe("string");

    const updated = await client.profile.update({ firstName: "Ada", lastName: "Lovelace", timezone: "America/New_York" });
    expect(updated).toMatchObject({ name: "Ada Lovelace", firstName: "Ada", lastName: "Lovelace", timezone: "America/New_York" });
  });

  it("avatar: imageUrl defaults null (avatarUrl → gravatar); set() sets both; null clears back to gravatar", async () => {
    const client = await signIn();
    const before = await client.profile.get();
    expect(before.imageUrl).toBeNull();
    expect(before.avatarUrl).toMatch(/^https:\/\/www\.gravatar\.com\/avatar\//);

    const set = await client.profile.update({ imageUrl: "https://cdn.example.com/me.png" });
    expect(set.imageUrl).toBe("https://cdn.example.com/me.png");
    expect(set.avatarUrl).toBe("https://cdn.example.com/me.png");

    const cleared = await client.profile.update({ imageUrl: null });
    expect(cleared.imageUrl).toBeNull();
    expect(cleared.avatarUrl).toMatch(/^https:\/\/www\.gravatar\.com\/avatar\//);
  });
});
