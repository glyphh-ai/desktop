/**
 * The attach host over a scripted socket: hello with the live capability
 * table, req → handler → res, push frames up, refreshHello after a late
 * registration, and the drop hook.
 */
import { describe, it, expect } from "vitest";
import { startAttachHost } from "../../src/runtime/attach.js";

class FakeSocket {
  static last: FakeSocket | null = null;
  readyState = 0;
  sent: string[] = [];
  private listeners = new Map<string, Array<(ev: unknown) => void>>();
  constructor(readonly url: string) { FakeSocket.last = this; }
  addEventListener(type: string, fn: (ev: unknown) => void): void { this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]); }
  send(s: string): void { if (this.readyState !== 1) throw new Error("not open"); this.sent.push(s); }
  close(): void { this.readyState = 3; this.fire("close", {}); }
  open(): void { this.readyState = 1; this.fire("open", {}); }
  receive(frame: unknown): void { this.fire("message", { data: JSON.stringify(frame) }); }
  fire(type: string, ev: unknown): void { for (const fn of this.listeners.get(type) ?? []) fn(ev); }
  frames(): Array<Record<string, unknown>> { return this.sent.map((s) => JSON.parse(s) as Record<string, unknown>); }
}

const client = { token: async () => "gy_at_test" } as never;
const tick = () => new Promise((r) => setTimeout(r, 0));

describe("startAttachHost", () => {
  it("dials with the token, says hello with its name and table, answers requests, and pushes frames", async () => {
    const handlers: Record<string, (p: unknown) => Promise<unknown>> = { "machine.appsList": async () => ({ apps: ["Safari"] }) };
    const dropped: number[] = [];
    const host = startAttachHost({ client, server: "https://api.glyphh.test/", app: "glyphh-desktop", version: "1.2.3", name: "chris-mac", handlers: () => handlers, WebSocketImpl: FakeSocket as never, onDown: () => dropped.push(1) });
    await tick();
    const sock = FakeSocket.last!;
    expect(sock.url).toBe("wss://api.glyphh.test/ws/attach?token=gy_at_test");
    expect(host.attached()).toBe(false);
    expect(host.push("run:1", { type: "delta" }), "nothing rides a closed socket").toBe(false);

    sock.open();
    expect(host.attached()).toBe(true);
    expect(sock.frames()[0]).toEqual({ t: "hello", app: "glyphh-desktop", version: "1.2.3", name: "chris-mac", capabilities: ["machine.appsList"] });

    sock.receive({ t: "ping" });
    sock.receive({ t: "req", id: "r1", method: "machine.appsList", params: {} });
    sock.receive({ t: "req", id: "r2", method: "nope", params: {} });
    await tick();
    const after = sock.frames().slice(1);
    expect(after[0]).toEqual({ t: "pong" });
    // the two replies settle on their own microtasks; order between them is not the contract
    expect(after.slice(1).sort((a, b) => String(a.id).localeCompare(String(b.id)))).toEqual([
      { t: "res", id: "r1", ok: true, result: { apps: ["Safari"] } },
      { t: "res", id: "r2", ok: false, error: "unknown method: nope" },
    ]);

    expect(host.push("run:abc", { type: "delta", delta: "hi" })).toBe(true);
    expect(sock.frames().at(-1)).toEqual({ t: "push", channel: "run:abc", data: { type: "delta", delta: "hi" } });

    // a handler registered after the socket opened: refreshHello advertises it
    handlers["agent.run"] = async () => ({ started: true });
    host.refreshHello();
    expect(sock.frames().at(-1)).toMatchObject({ t: "hello", capabilities: ["machine.appsList", "agent.run"] });

    sock.close();
    expect(host.attached()).toBe(false);
    expect(dropped).toEqual([1]);
    host.stop();
  });

  it("names its granted folders in every hello, and stops for good when the org refuses it", async () => {
    let folders = ["/Users/ada/code"];
    const refused: string[] = [];
    const dropped: number[] = [];
    const host = startAttachHost({ client, server: "https://api.glyphh.test", app: "glyphh-cli", handlers: {}, WebSocketImpl: FakeSocket as never, folders: () => folders, onRefused: (r) => refused.push(r), onDown: () => dropped.push(1) });
    await tick();
    const sock = FakeSocket.last!;
    sock.open();
    expect(sock.frames()[0]).toMatchObject({ t: "hello", folders: ["/Users/ada/code"] });
    folders = ["/Users/ada/code", "/Users/ada/notes"];
    host.refreshHello();
    expect(sock.frames().at(-1)).toMatchObject({ folders: ["/Users/ada/code", "/Users/ada/notes"] });

    sock.readyState = 3;
    sock.fire("close", { code: 4403, reason: "remote control is off for your organization" });
    expect(refused).toEqual(["remote control is off for your organization"]);
    expect(dropped).toEqual([1]);
    expect(host.attached()).toBe(false);
    await new Promise((r) => setTimeout(r, 1100));
    expect(FakeSocket.last, "no reconnect after a refusal").toBe(sock);
    host.stop();
  });

  it("stop is idempotent and ends reconnection", async () => {
    const host = startAttachHost({ client, server: "http://127.0.0.1:1", app: "t", handlers: {}, WebSocketImpl: FakeSocket as never });
    await tick();
    host.stop();
    host.stop();
    expect(host.attached()).toBe(false);
  });
});
