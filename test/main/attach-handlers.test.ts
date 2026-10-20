/**
 * attach-handlers.test.ts — the machine's relay handlers: the folder picker's
 * browse, the native apps, the headless scrape — and no record store and no
 * app install riding the registry.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";

const root = mkdtempSync(join(tmpdir(), "glyphh-attach-lib-"));
const handlers = new Map<string, (params: unknown) => Promise<unknown>>();

vi.mock("electron", () => ({ BrowserWindow: class {}, shell: { openExternal: async () => undefined } }));
vi.mock("../../src/main/relay-client.js", () => ({
  registerRelayHandler: (m: string, h: (params: unknown) => Promise<unknown>) => { handlers.set(m, h); },
}));
vi.mock("../../src/main/app-paths.js", () => ({ userScopedPath: (seg: string) => join(root, seg) }));
vi.mock("../../src/main/installed-apps.js", () => ({ listInstalledApps: () => [], findInstalledApp: () => null, launchInstalledApp: () => undefined }));
beforeAll(async () => {
  const { installAttachHandlers } = await import("../../src/main/attach-handlers.js");
  installAttachHandlers();
});

describe("the machine's relay handlers", () => {
  it("reads no record off this machine: no sessions.*, layouts.*, panelApps.list (his order, 2026-10-06)", () => {
    for (const m of ["sessions.list", "sessions.get", "sessions.put", "sessions.delete", "layouts.list", "layouts.get", "layouts.save", "panelApps.list"]) expect(handlers.has(m)).toBe(false);
    for (const m of ["fs.list", "fs.gitInfo", "fs.mkdir", "machine.appsList", "scrape.page"]) expect(handlers.has(m)).toBe(true);
  });

  it("no app install or app tool rides the registry: the cloud apps are gone", () => {
    expect(handlers.has("apps.install")).toBe(false);
    expect(handlers.has("fs.installApp")).toBe(false);
    expect(handlers.has("apps.listTools")).toBe(false);
    expect(handlers.has("apps.callTool")).toBe(false);
  });
});
