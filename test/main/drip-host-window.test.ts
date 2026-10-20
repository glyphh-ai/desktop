import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// A windowed overlay needs a parent window. These tests pin the FALLBACK:
// the manager must find the host through the shared ref even when nobody
// called setMainWindow (his report, 2026-09-25: Play did nothing in the
// shipped app, where that call sat behind an !app.isPackaged guard).
const made: Array<Record<string, unknown>> = [];
let ref: unknown = null;

vi.mock("electron", () => ({
  BrowserWindow: class {
    constructor(opts: Record<string, unknown>) { made.push(opts); }
    isDestroyed() { return false; }
    loadURL() {}
    setIgnoreMouseEvents() {}
    setAlwaysOnTop() {}
    setVisibleOnAllWorkspaces() {}
    showInactive() {}
    once() {}
    on() {}
    close() {}
    webContents = { on() {} };
  },
  screen: {
    getCursorScreenPoint: () => ({ x: 0, y: 0 }),
    getDisplayNearestPoint: () => ({ bounds: { x: 0, y: 0, width: 1920, height: 1080 } }),
  },
}));
vi.mock("../../src/main/local-db", () => ({ getLocalDb: () => { throw new Error("no db in test"); } }));
vi.mock("../../src/main/main-window-ref", () => ({ getMainWindowRef: () => ref }));

const { DripManager } = await import("../../src/main/drip-manager");

const hostWin = () => ({ isDestroyed: () => false, getBounds: () => ({ x: 10, y: 20, width: 800, height: 600 }) });

beforeEach(() => { made.length = 0; ref = null; vi.useFakeTimers(); });
afterEach(() => { vi.runOnlyPendingTimers(); vi.useRealTimers(); vi.restoreAllMocks(); });

/** execute() schedules each one-shot on a timer; play it out. */
const flush = () => vi.advanceTimersByTime(2000);

describe("a windowed drip finds its host window", () => {
  it("plays through the shared ref when setMainWindow was never called", () => {
    ref = hostWin();
    new DripManager().execute(["fireworks"], { preview: true });
    flush();
    expect(made, "the overlay was never created — the click would be swallowed").toHaveLength(1);
    expect(made[0]).toMatchObject({ width: 800, height: 600 });
  });

  it("says so in the log instead of failing silently when there is no window at all", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    new DripManager().execute(["fireworks"], { preview: true });
    flush();
    expect(made).toHaveLength(0);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("no host window"));
  });

  it("a FULL-SCREEN effect never needed the host window and still does not", () => {
    new DripManager().execute(["fireworks"]);
    flush();
    expect(made).toHaveLength(1);
    expect(made[0]).toMatchObject({ width: 1920, height: 1080, alwaysOnTop: true });
  });

  it("re-reads the ref after the window it held was destroyed", () => {
    const m = new DripManager();
    m.setMainWindow({ isDestroyed: () => true } as never);
    ref = hostWin();
    m.execute(["fireworks"], { preview: true });
    flush();
    expect(made).toHaveLength(1);
  });
});
