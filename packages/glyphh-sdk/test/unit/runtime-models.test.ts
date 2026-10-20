/**
 * runtime-models.test.ts — the governed SDK↔rrotor model bridge: resolveModels turns a
 * TASK's resolved slots (`tasks.roles` — the same call every picker reads) into gateway
 * endpoints (root url + provider + bearer + metered, `provider::` stripped), exposes the
 * primary slot for role aliasing, and switchModel audits every switch while updating the
 * in-process override the next resolve layers on.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

import {
  resolveModels,
  switchModel,
  sessionOverrides,
  clearSessionOverrides,
} from "../../src/runtime/index.js";
import type { Client } from "../../src/index.js";
import type { ResolvedTaskRole } from "../../src/contract/tasks.js";

const choice = (id: string) => ({
  id,
  name: id,
  providerSlug: id.split("::")[0] ?? "",
  modality: "chat",
  contextWindow: null,
  maxOutputTokens: null,
  inputUsdPerMTok: 1,
  outputUsdPerMTok: 1,
  isPlatformDefault: false,
});

/** One anthropic default slot + one openai-family coder slot. */
function roles(): ResolvedTaskRole[] {
  return [
    {
      name: "default", label: "Model", description: "", modality: "chat", modelId: "anthropic::claude-sonnet-5",
      source: "platform", choices: [choice("anthropic::claude-sonnet-5")],
    },
    {
      name: "coder", label: "Coder", description: "", modality: "chat", modelId: "openai::gpt-5",
      source: "loop", choices: [choice("openai::gpt-5")],
    },
  ];
}

/** A minimal Client stub: only the resources the bridge touches. */
function fakeClient(
  result: ResolvedTaskRole[] | Error,
  record: ReturnType<typeof vi.fn> = vi.fn(async () => ({})),
): { client: Client; rolesFn: ReturnType<typeof vi.fn> } {
  const rolesFn = vi.fn(async () => {
    if (result instanceof Error) throw result;
    return result;
  });
  return {
    client: { tasks: { roles: rolesFn }, sessions: { recordModelSwitch: record } } as unknown as Client,
    rolesFn,
  };
}

const OPTS = { loop: "default", token: "TKN", server: "https://api.glyphh.ai/" };

beforeEach(() => {
  clearSessionOverrides("s1");
});

describe("resolveModels", () => {
  it("maps every slot to the metering gateway with bearer + provider + bare model id", async () => {
    const { client } = fakeClient(roles());
    const out = await resolveModels(client, OPTS);
    expect(out).toBeDefined();
    // The gateway root — the runtime appends /v1/messages | /v1/chat/completions,
    // landing on the exact endpoints the desktop's interceptor targets.
    expect(out!.registry.default).toEqual({
      url: "https://api.glyphh.ai/api/gateway",
      provider: "anthropic",
      model: "claude-sonnet-5",
      headers: { authorization: "Bearer TKN" },
      metered: true,
    });
    expect(out!.registry.coder).toMatchObject({ provider: "openai", model: "gpt-5", metered: true });
    // The primary is the first resolved slot — callers alias their rotor roles to it.
    expect(out!.primary).toBe(out!.registry.default);
  });

  it("passes overrides through to the server-side resolver (governance filters there)", async () => {
    const { client, rolesFn } = fakeClient(roles());
    await resolveModels(client, { ...OPTS, overrides: { default: "anthropic::claude-haiku-5" } });
    expect(rolesFn).toHaveBeenCalledWith("default", { default: "anthropic::claude-haiku-5" }, { context: "local" });
  });

  it("returns undefined when no slot resolves a model", async () => {
    const none = roles().map((r) => ({ ...r, modelId: null }));
    const { client } = fakeClient(none);
    expect(await resolveModels(client, OPTS)).toBeUndefined();
  });

  it("returns undefined when the control plane can't resolve the loop", async () => {
    const { client } = fakeClient(new Error("unknown loop"));
    expect(await resolveModels(client, OPTS)).toBeUndefined();
  });
});

describe("switchModel", () => {
  it("audits the switch and stores the override so the next resolveModels picks it up", async () => {
    const record = vi.fn(async () => ({ sessionId: "s1", from: null, to: "x", surface: "cli" }));
    const { client, rolesFn } = fakeClient(roles(), record);

    await switchModel(client, {
      sessionId: "s1",
      rotorSlug: "default",
      role: "default",
      from: "anthropic::claude-sonnet-5",
      to: "anthropic::claude-haiku-5",
      surface: "cli",
    });

    // (a) The switch is audited with the full context.
    expect(record).toHaveBeenCalledWith({
      sessionId: "s1",
      rotorSlug: "default",
      role: "default",
      to: "anthropic::claude-haiku-5",
      surface: "cli",
      from: "anthropic::claude-sonnet-5",
    });
    // (b) The override is stored…
    expect(sessionOverrides("s1", "default")).toEqual({ default: "anthropic::claude-haiku-5" });
    // …and the next resolve hands it to the server-side resolver.
    await resolveModels(client, { ...OPTS, overrides: sessionOverrides("s1", "default") });
    expect(rolesFn).toHaveBeenLastCalledWith("default", { default: "anthropic::claude-haiku-5" }, { context: "local" });
  });

  it("audits again on a second switch (haiku→sonnet) and updates the override", async () => {
    const record = vi.fn(async () => ({ sessionId: "s1", from: null, to: "x", surface: "cli" }));
    const { client } = fakeClient(roles(), record);

    await switchModel(client, { sessionId: "s1", rotorSlug: "default", role: "default", to: "anthropic::claude-haiku-5", surface: "cli" });
    await switchModel(client, { sessionId: "s1", rotorSlug: "default", role: "default", to: "anthropic::claude-sonnet-5", surface: "cli" });

    expect(record).toHaveBeenCalledTimes(2);
    expect(sessionOverrides("s1", "default")).toEqual({ default: "anthropic::claude-sonnet-5" });
  });

  it("omits `from` from the audit call when not supplied", async () => {
    const record = vi.fn(async (_input: Record<string, unknown>) => ({ sessionId: "s1", from: null, to: "x", surface: "cli" }));
    const { client } = fakeClient(roles(), record);
    await switchModel(client, { sessionId: "s1", rotorSlug: "default", role: "default", to: "anthropic::claude-haiku-5", surface: "cli" });
    expect(record.mock.calls[0]![0]).not.toHaveProperty("from");
  });
});
