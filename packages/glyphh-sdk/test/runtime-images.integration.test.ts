/**
 * Runtime images (§7b) ↔ live control plane. The org-scoped catalog read, the
 * default FREE binding, the org_admin image change riding the fleet seams (promote →
 * resize → demote against the local driver), the no-op/unknown refusals, the
 * registration-time image choice with fall-back-to-free, the billing-status hook,
 * and the super-admin CRUD gate (403 for a normal user). Needs the server on
 * GLYPHH_SERVER_URL (default :3001).
 */

import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { createClient, ForbiddenError, ValidationError, type Client } from "../src/index.js";

const url = process.env.GLYPHH_SERVER_URL ?? "http://127.0.0.1:3001";

async function signIn(): Promise<Client> {
  const client = createClient({ url });
  const start = await client.auth.startEmailLink(`rimg-${randomUUID()}@example.com`);
  await client.auth.verifyEmailLink(start.devToken!);
  return client;
}

describe("@glyphh/sdk — runtime images (org surface)", () => {
  it("lists the four seeded SKUs of the org's region, cheapest first", async () => {
    const client = await signIn();
    const images = await client.runtimeImages.list();
    expect(images.map((i) => i.key)).toEqual(["free", "small", "medium", "large"]);
    const small = images[1]!;
    expect(small.type).toBe("dedicated");
    expect(small.ramMb).toBe(1024);
    expect(small.monthlyCredits).toBeGreaterThan(0);
  });

  it("a fresh org is on FREE, realized as the shared runtime", async () => {
    const client = await signIn();
    const cur = await client.runtimeImages.current();
    expect(cur.key).toBe("free");
    expect(cur.mode).toBe("shared");
    expect(cur.image?.type).toBe("shared");
    expect(cur.image?.monthlyCredits).toBe(0);
    expect(cur.provisionedImageId).toBeNull();
  });

  it("changes ride the fleet: promote → resize → demote; no-ops and unknowns refused", async () => {
    const client = await signIn();

    await expect(client.runtimeImages.change("bogus")).rejects.toBeInstanceOf(ValidationError);
    await expect(client.runtimeImages.change("free")).rejects.toBeInstanceOf(ValidationError); // no-op

    const up = await client.runtimeImages.change("small");
    expect(up.key).toBe("small");
    expect(up.mode).toBe("dedicated");
    expect(up.provisionedImageId).not.toBeNull();

    await expect(client.runtimeImages.change("small")).rejects.toBeInstanceOf(ValidationError); // no-op

    const resized = await client.runtimeImages.change("medium");
    expect(resized.key).toBe("medium");
    expect(resized.mode).toBe("dedicated");
    expect(resized.provisionedImageId).not.toBe(up.provisionedImageId); // stamp follows the spec

    const down = await client.runtimeImages.change("free");
    expect(down.key).toBe("free");
    expect(down.mode).toBe("shared");
  });

  it("billing status exposes the current image + its monthly price (the billing hook)", async () => {
    const client = await signIn();
    const status = await client.billing.status();
    expect(status.runtimeImage).toMatchObject({ key: "free", monthlyCredits: 0 });
  });
});

describe("@glyphh/sdk — registration-time image choice", () => {
  it("signing up with an image key provisions that image's runtime", async () => {
    const client = createClient({ url });
    const start = await client.auth.startEmailLink(`rimg-reg-${randomUUID()}@example.com`);
    await client.auth.verifyEmailLink(start.devToken!, undefined, { runtimeImage: "small" });
    const cur = await client.runtimeImages.current();
    expect(cur.key).toBe("small");
    expect(cur.mode).toBe("dedicated");
    // Leave the throwaway org back on the shared runtime for the sweep.
    await client.runtimeImages.change("free");
  });

  it("an invalid image at signup falls back to FREE, never failing registration", async () => {
    const client = createClient({ url });
    const start = await client.auth.startEmailLink(`rimg-bad-${randomUUID()}@example.com`);
    await client.auth.verifyEmailLink(start.devToken!, undefined, { runtimeImage: "does-not-exist" });
    const cur = await client.runtimeImages.current();
    expect(cur.key).toBe("free");
    expect(cur.mode).toBe("shared");
  });
});

describe("@glyphh/sdk — admin runtime-image CRUD is super_admin-gated", () => {
  it("every admin method is forbidden for a normal user", async () => {
    const client = await signIn();
    await expect(client.admin.runtimeImages()).rejects.toBeInstanceOf(ForbiddenError);
    await expect(
      client.admin.createRuntimeImage({
        key: "xl", region: "local", displayName: "XL", type: "dedicated",
        ramMb: 16384, diskGb: 160, monthlyCredits: 16000, costPerSecondMicro: 6400,
      }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    await expect(client.admin.updateRuntimeImage("local", "small", { monthlyCredits: 1 })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(client.admin.deleteRuntimeImage("local", "small")).rejects.toBeInstanceOf(ForbiddenError);
  });
});
