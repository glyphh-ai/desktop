/**
 * router-server.test.ts — ONE loopback router for every CLI on the gateway
 * route: started on first ask (concurrent asks share it), token-guarded, and
 * closed on quit.
 */
import { describe, it, expect, vi, afterAll } from "vitest";

vi.mock("../../src/main/providers", () => ({ routerConfig: () => ({ providers: [], models: [] }) }));

const R = await import("../../src/main/router-server");

afterAll(async () => { await R.stopRouterServer(); });

describe("the router's listener", () => {
  it("is not started until a launch asks for it", () => {
    expect(R.routerServerRunning()).toBe(false);
  });

  it("starts once, however many launches ask at the same time", async () => {
    const [a, b] = await Promise.all([R.routerEndpoint(), R.routerEndpoint()]);
    expect(a).toEqual(b);
    expect(a.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(a.token).toMatch(/^glyphh-router-[0-9a-f]{48}$/);
    expect(R.routerServerRunning()).toBe(true);
    expect(await R.routerEndpoint()).toEqual(a);
  });

  it("refuses a caller without its token", async () => {
    const { url } = await R.routerEndpoint();
    const res = await fetch(`${url}/v1/messages`, { method: "POST", body: "{}" });
    expect(res.status).toBe(401);
  });

  it("closes on quit, and a later launch gets a fresh token", async () => {
    const before = await R.routerEndpoint();
    await R.stopRouterServer();
    expect(R.routerServerRunning()).toBe(false);
    const after = await R.routerEndpoint();
    expect(after.token).not.toBe(before.token);
  });
});
