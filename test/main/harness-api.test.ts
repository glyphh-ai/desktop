/**
 * harness-api.test.ts — the two doors to the harness bearer and origin: the
 * WEB's SDK handle, else the DESKTOP's preload bridge (its renderer never
 * holds the SDK; main hands the session token over glyphh-harness-token).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { harnessApiUrl, harnessToken, harnessWsUrl } from "../../src/renderer/help/harness-api";

type Doors = {
  __GLYPHH_API_URL__?: string;
  glyphhSdk?: { token?: () => Promise<string | null> };
  glyphh?: { apiUrl?: string; serverUrl?: string; harnessToken?: () => Promise<string | null> };
};
const setWindow = (w: Doors | undefined): void => {
  if (w === undefined) delete (globalThis as { window?: unknown }).window;
  else (globalThis as { window?: unknown }).window = w;
};
afterEach(() => setWindow(undefined));

describe("the API origin", () => {
  it("is the web bridge's stamp, trailing slashes off", () => {
    setWindow({ __GLYPHH_API_URL__: "https://api.dev.glyphh.app//", glyphh: { apiUrl: "https://wrong" } });
    expect(harnessApiUrl()).toBe("https://api.dev.glyphh.app");
  });
  it("is the desktop's SERVER_URL from preload when the web stamp is absent", () => {
    setWindow({ glyphh: { apiUrl: "http://127.0.0.1:3001/" } });
    expect(harnessApiUrl()).toBe("http://127.0.0.1:3001");
    setWindow({ glyphh: { serverUrl: "http://127.0.0.1:3002" } });
    expect(harnessApiUrl()).toBe("http://127.0.0.1:3002");
  });
  it("is the production API with no door at all", () => {
    setWindow({});
    expect(harnessApiUrl()).toBe("https://api.glyphh.ai");
    setWindow(undefined);
    expect(harnessApiUrl()).toBe("https://api.glyphh.ai");
  });
  it("names the pty socket with the bearer on the query", () => {
    setWindow({ glyphh: { apiUrl: "https://api.glyphh.ai" } });
    expect(harnessWsUrl("/pty/p1", "t k")).toBe("wss://api.glyphh.ai/api/harness/pty/p1?token=t%20k");
  });
});

describe("the bearer", () => {
  it("is the SDK handle's on the web", async () => {
    const bridge = vi.fn(async () => "desktop-token");
    setWindow({ glyphhSdk: { token: async () => "web-token" }, glyphh: { harnessToken: bridge } });
    expect(await harnessToken()).toBe("web-token");
    expect(bridge).not.toHaveBeenCalled();
  });
  it("is main's over the preload bridge on the desktop", async () => {
    setWindow({ glyphh: { harnessToken: async () => "desktop-token" } });
    expect(await harnessToken()).toBe("desktop-token");
  });
  it("is null signed out on either door, or with no door", async () => {
    setWindow({ glyphhSdk: { token: async () => null } });
    expect(await harnessToken()).toBeNull();
    setWindow({ glyphhSdk: { token: async () => { throw new Error("signed out"); } } });
    expect(await harnessToken()).toBeNull();
    setWindow({ glyphh: { harnessToken: async () => null } });
    expect(await harnessToken()).toBeNull();
    setWindow({ glyphh: { harnessToken: async () => { throw new Error("ipc gone"); } } });
    expect(await harnessToken()).toBeNull();
    setWindow({});
    expect(await harnessToken()).toBeNull();
  });
});
