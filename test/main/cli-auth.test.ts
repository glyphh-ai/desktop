import { describe, it, expect } from "vitest";
import { isAuthTrouble, authFix, LOGIN_CMD } from "../../src/main/cli-auth.js";

describe("cli-auth", () => {
  it("recognizes what the CLIs actually print when a login runs out", () => {
    for (const said of [
      "Failed to authenticate: OAuth session expired and could not be refreshed",
      "Login expired · Please run /login",
      "Error: not logged in",
      "401 Unauthorized",
    ]) expect(isAuthTrouble(said), said).toBe(true);
  });

  it("does not claim an auth problem for an ordinary failure", () => {
    for (const said of [
      "the program exports no run(ctx, input) function",
      "ENOENT: no such file or directory",
      "the gateway refused this model: out of credits",
      "",
    ]) expect(isAuthTrouble(said), said).toBe(false);
  });

  it("names the command that fixes it, per CLI", () => {
    const fix = authFix("Failed to authenticate: OAuth session expired", "claude");
    expect(fix?.kind).toBe("signin");
    expect(fix?.command).toBe("claude");
    expect(fix?.message).toContain("/login");
    expect(authFix("not logged in", "codex")?.command).toBe(LOGIN_CMD.codex);
    expect(authFix("not logged in", "cursor")?.command).toBe("cursor-agent login");
    // An unknown CLI still gets a command: its own name.
    expect(authFix("unauthorized", "someagent")?.command).toBe("someagent");
  });

  it("stays out of the way when nothing is wrong with the login", () => {
    expect(authFix("exited 1", "claude")).toBeNull();
  });
});
