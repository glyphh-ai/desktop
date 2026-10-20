/**
 * cli-route.test.ts — which route a CLI launch takes, and what each route
 * puts on the line: the gateway sources the router's address and token and
 * drops a shadowing Anthropic key; direct drops the router's variables so the
 * CLI rides its own login.
 */
import { describe, it, expect } from "vitest";
import {
  GATEWAY_BASE_ENV, GATEWAY_TOKEN_ENV, MODEL_ALIAS_ENV, SHADOWING_KEY_ENV,
  directModelFor, gatewayEnvFileBody, gatewayHint, gatewayModelFor, resolveCliRoute, routeEnvPrefix, routeModelVars,
} from "../../src/main/cli-route";

describe("route precedence: session → workspace cell → workspace → the member's default", () => {
  it("takes the session's pick over everything", () => {
    expect(resolveCliRoute("claude", { session: true, cell: false, layout: false }, false, true)).toBe("gateway");
    expect(resolveCliRoute("claude", { session: false, cell: true, layout: true }, true, true)).toBe("direct");
  });

  it("falls to the cell, then the workspace, when the session has no opinion", () => {
    expect(resolveCliRoute("claude", { session: null, cell: true, layout: false }, false, true)).toBe("gateway");
    expect(resolveCliRoute("claude", { cell: false, layout: true }, true, true)).toBe("direct");
    expect(resolveCliRoute("claude", { layout: true }, false, true)).toBe("gateway");
    expect(resolveCliRoute("claude", { session: null, cell: null, layout: false }, true, true)).toBe("direct");
  });

  it("falls to the member's default, and that defaults to direct", () => {
    expect(resolveCliRoute("claude", undefined, true, true)).toBe("gateway");
    expect(resolveCliRoute("claude", {}, false, true)).toBe("direct");
  });

  it("never takes the gateway without a chat model the router can call", () => {
    expect(resolveCliRoute("claude", { session: true }, true, false)).toBe("direct");
  });

  it("never puts a CLI the router cannot carry on the gateway", () => {
    for (const cli of ["codex", "gemini", "copilot", "cursor", "glyphh"] as const) {
      expect(resolveCliRoute(cli, { session: true }, true, true), cli).toBe("direct");
    }
  });

  it("reads a workspace's stored on/off as a hint", () => {
    expect(gatewayHint("on")).toBe(true);
    expect(gatewayHint("off")).toBe(false);
    expect(gatewayHint(undefined)).toBeUndefined();
    expect(gatewayHint("maybe")).toBeUndefined();
  });
});

describe("the gateway env", () => {
  const ENV = "/u/loops/claude/env";

  it("writes the router's address and token in the KEY=\"value\" format the line sources", () => {
    const body = gatewayEnvFileBody({ url: "http://127.0.0.1:52011", token: "glyphh-router-abc" });
    expect(body).toBe(`${GATEWAY_BASE_ENV}="http://127.0.0.1:52011"\n${GATEWAY_TOKEN_ENV}="glyphh-router-abc"\n`);
    expect(GATEWAY_BASE_ENV).toBe("ANTHROPIC_BASE_URL");
    expect(GATEWAY_TOKEN_ENV).toBe("ANTHROPIC_AUTH_TOKEN");
  });

  it("gateway: sources the env file and drops the key that would send the turn to Anthropic", () => {
    const p = routeEnvPrefix("claude", "gateway", ENV, "posix");
    expect(p).toBe(`set -a; . "${ENV}"; set +a; unset ${SHADOWING_KEY_ENV};`);
    expect(p).not.toContain("unset ANTHROPIC_BASE_URL");
    expect(p).not.toContain("unset ANTHROPIC_AUTH_TOKEN");
  });

  it("direct: drops the router's variables only when the token is ours, and sources nothing", () => {
    const p = routeEnvPrefix("claude", "direct", ENV, "posix");
    expect(p).toBe('case "$ANTHROPIC_AUTH_TOKEN" in glyphh-router-*) unset ANTHROPIC_BASE_URL ANTHROPIC_AUTH_TOKEN;; esac;');
    expect(p).not.toContain(ENV);
    expect(p).not.toContain(SHADOWING_KEY_ENV);
  });

  it("speaks PowerShell's words on Windows, never printing a value", () => {
    const gw = routeEnvPrefix("claude", "gateway", ENV, "powershell");
    expect(gw).toContain("Get-Content -LiteralPath");
    expect(gw).toContain("Remove-Item Env:\\ANTHROPIC_API_KEY");
    expect(gw).not.toContain("set -a");
    const direct = routeEnvPrefix("claude", "direct", ENV, "powershell");
    expect(direct).toContain("-like 'glyphh-router-*'");
    expect(direct).toContain("Remove-Item Env:\\ANTHROPIC_BASE_URL");
  });

  it("leaves every other CLI's line alone", () => {
    for (const cli of ["codex", "gemini", "copilot", "cursor", "glyphh"] as const) {
      expect(routeEnvPrefix(cli, "direct", ENV, "posix"), cli).toBe("");
      expect(routeEnvPrefix(cli, "gateway", ENV, "posix"), cli).toBe("");
    }
  });

  it("points every model alias at the session's model on the gateway only", () => {
    const vars = routeModelVars("claude", "gateway", "openai::gpt-5.1", "posix");
    for (const k of MODEL_ALIAS_ENV) expect(vars).toContain(`${k}="openai::gpt-5.1"`);
    expect(routeModelVars("claude", "direct", "claude-opus-5-5", "posix")).toBe("");
    expect(routeModelVars("claude", "gateway", "", "posix")).toBe("");
    expect(routeModelVars("codex", "gateway", "x", "posix")).toBe("");
  });
});

describe("the model a launch names", () => {
  const CHAT = ["anthropic::claude-opus-5-5", "openai::gpt-5.1"];

  it("gateway: the pick when it is one of the user's chat models, sent whole", () => {
    expect(gatewayModelFor("openai::gpt-5.1", CHAT, "anthropic::claude-opus-5-5")).toBe("openai::gpt-5.1");
  });

  it("gateway: the user's default for no pick or a pick the router cannot serve", () => {
    expect(gatewayModelFor("", CHAT, "anthropic::claude-opus-5-5")).toBe("anthropic::claude-opus-5-5");
    expect(gatewayModelFor("claude-opus-5-5", CHAT, "anthropic::claude-opus-5-5")).toBe("anthropic::claude-opus-5-5");
    expect(gatewayModelFor(undefined, CHAT, "")).toBe("");
  });

  const kinds: Record<string, string> = { anthropic: "anthropic", "work-openai": "openai", gem: "gemini" };
  const kindOf = (id: string): string | undefined => kinds[id];

  it("direct: a bare name is the CLI's own and passes as is", () => {
    expect(directModelFor("claude", "claude-opus-5-5", kindOf)).toBe("claude-opus-5-5");
    expect(directModelFor("cursor", "sonnet-4.5", kindOf)).toBe("sonnet-4.5");
  });

  it("direct: a router id names the CLI's model only when the provider is its own vendor", () => {
    expect(directModelFor("claude", "anthropic::claude-opus-5-5", kindOf)).toBe("claude-opus-5-5");
    expect(directModelFor("codex", "work-openai::gpt-5.1", kindOf)).toBe("gpt-5.1");
    expect(directModelFor("gemini", "gem::gemini-2.5-pro", kindOf)).toBe("gemini-2.5-pro");
  });

  it("direct: drops a model the CLI's login cannot have, so the CLI picks its own", () => {
    expect(directModelFor("claude", "work-openai::gpt-5.1", kindOf)).toBe("");
    expect(directModelFor("codex", "anthropic::claude-opus-5-5", kindOf)).toBe("");
    expect(directModelFor("copilot", "anthropic::claude-opus-5-5", kindOf)).toBe("");
    expect(directModelFor("claude", "", kindOf)).toBe("");
  });

  it("the Glyphh CLI takes the router id whole", () => {
    expect(directModelFor("glyphh", "openai::gpt-5.1", kindOf)).toBe("openai::gpt-5.1");
  });
});
