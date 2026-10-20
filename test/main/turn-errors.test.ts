import { describe, it, expect } from "vitest";
import { turnError } from "../../src/renderer/help/turn-errors";

describe("a failed turn is a card (his reports, 2026-09-29)", () => {
  it("no model is a door to the picker, not a riddle", () => {
    expect(turnError("⚠ Choose a model in the model picker below.")).toMatchObject({ kind: "no-model", title: "Choose a model", body: "Choose a model in the model picker below.", action: "models" });
    expect(turnError("⚠ Pick a model for the Glyphh loop: any model your organization runs on the gateway.")?.kind).toBe("no-model");
  });

  it("the provider refusing the key reads as the model being unreachable, naming it", () => {
    const e = turnError('⚠ gateway 401: litellm.AuthenticationError: AnthropicException - {"type":"error","error":{"type":"authentication_error","message":"API key is invalid."},"request_id":null}. Received Model Group=claude-opus-4-8 Available Model Group Fallbacks=None');
    expect(e).toMatchObject({ kind: "model-down", title: "claude-opus-4-8 isn't reachable right now", action: "models" });
    expect(e?.body).not.toContain("AuthenticationError");
    expect(e?.body).toContain("Settings › Models");
    expect(e?.raw).toContain("authentication_error");
  });

  it("an ordinary reply is not an error, and an unknown failure still gets a card", () => {
    expect(turnError("Here is the refactor you asked for.")).toBeNull();
    expect(turnError("⚠ gateway 400: something odd")).toMatchObject({ kind: "failed", body: "something odd" });
  });
});
