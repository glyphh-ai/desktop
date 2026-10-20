/**
 * RefreshManager unit tests — deterministic, no server. A fake HttpClient + a
 * controllable clock exercise the logic every client relies on: proactive refresh,
 * single-flight (concurrent callers share ONE network refresh), single-use
 * rotation, and the signed-out signal when a refresh is unrecoverable.
 */

import { describe, it, expect, vi } from "vitest";
import { RefreshManager } from "../../src/auth/refresh-manager.js";
import { InMemoryTokenStore } from "../../src/auth/token-store.js";
import { AuthError, ConnectError } from "../../src/core/errors.js";
import type { HttpClient } from "../../src/core/http.js";
import type { IssuedSession } from "../../src/contract/auth.js";

/** A fake HttpClient recording calls; `post` is programmable per test. */
function fakeHttp(post: (path: string, body?: unknown) => Promise<unknown>) {
  const calls: { path: string; body?: unknown }[] = [];
  const http = {
    post: (path: string, body?: unknown) => {
      calls.push({ path, body });
      return post(path, body);
    },
    get: async () => undefined,
  } as unknown as HttpClient;
  return { http, calls };
}

const issued = (n: number): IssuedSession => ({ accessToken: `gy_at_${n}`, refreshToken: `gy_rt_${n}`, expiresIn: 900 });

async function seeded(store: InMemoryTokenStore, at: string, rt: string, expiresAt: number) {
  await store.save({ accessToken: at, refreshToken: rt, expiresAt });
}

describe("RefreshManager", () => {
  it("adopt() stamps an absolute expiry from expiresIn", async () => {
    const store = new InMemoryTokenStore();
    const { http } = fakeHttp(async () => issued(1));
    const rm = new RefreshManager(http, store, {}, () => 1_000_000);
    const s = await rm.adopt(issued(1));
    expect(s.expiresAt).toBe(1_000_000 + 900 * 1000);
  });

  it("returns the current token when it is not near expiry", async () => {
    const store = new InMemoryTokenStore();
    const now = 1_000_000;
    await seeded(store, "gy_at_live", "gy_rt_live", now + 500_000);
    const { http, calls } = fakeHttp(async () => issued(2));
    const rm = new RefreshManager(http, store, { refreshMarginMs: 60_000 }, () => now);
    expect(await rm.accessToken()).toBe("gy_at_live");
    expect(calls.length).toBe(0); // no refresh needed
  });

  it("proactively refreshes when within the margin", async () => {
    const store = new InMemoryTokenStore();
    const now = 1_000_000;
    await seeded(store, "gy_at_old", "gy_rt_old", now + 10_000); // 10s left, margin 60s
    const { http, calls } = fakeHttp(async () => issued(3));
    const rm = new RefreshManager(http, store, { refreshMarginMs: 60_000 }, () => now);
    expect(await rm.accessToken()).toBe("gy_at_3");
    expect(calls).toEqual([{ path: "/api/session/refresh", body: { refreshToken: "gy_rt_old" } }]);
  });

  it("is single-flight — concurrent refreshes share one network call", async () => {
    const store = new InMemoryTokenStore();
    await seeded(store, "gy_at_x", "gy_rt_x", 0);
    let resolve!: (v: IssuedSession) => void;
    const gate = new Promise<IssuedSession>((r) => (resolve = r));
    const { http, calls } = fakeHttp(() => gate);
    const rm = new RefreshManager(http, store, {}, () => 1_000_000);

    const a = rm.refresh();
    const b = rm.refresh();
    resolve(issued(9));
    const [ra, rb] = await Promise.all([a, b]);
    expect(calls.length).toBe(1); // ONE call for two callers
    expect(ra?.accessToken).toBe("gy_at_9");
    expect(rb?.accessToken).toBe("gy_at_9");
  });

  it("persists the rotated session (single-use)", async () => {
    const store = new InMemoryTokenStore();
    await seeded(store, "gy_at_1", "gy_rt_1", 0);
    const { http } = fakeHttp(async () => issued(2));
    const rm = new RefreshManager(http, store, {}, () => 1_000_000);
    await rm.refresh();
    expect((await store.load())?.refreshToken).toBe("gy_rt_2");
  });

  it("clears + signals signed-out on a 401 refresh", async () => {
    const store = new InMemoryTokenStore();
    await seeded(store, "gy_at_1", "gy_rt_1", 0);
    const onSignedOut = vi.fn();
    const { http } = fakeHttp(async () => {
      throw new AuthError({ code: "E_UNAUTHENTICATED", message: "reuse", httpStatus: 401 });
    });
    const rm = new RefreshManager(http, store, { onSignedOut }, () => 1_000_000);
    expect(await rm.refresh()).toBeNull();
    expect(await store.load()).toBeNull();
    expect(onSignedOut).toHaveBeenCalledOnce();
  });

  it("rethrows a transient (network) refresh error without signing out", async () => {
    const store = new InMemoryTokenStore();
    await seeded(store, "gy_at_1", "gy_rt_1", 0);
    const onSignedOut = vi.fn();
    const { http } = fakeHttp(async () => {
      throw new ConnectError("offline");
    });
    const rm = new RefreshManager(http, store, { onSignedOut }, () => 1_000_000);
    await expect(rm.refresh()).rejects.toBeInstanceOf(ConnectError);
    expect(await store.load()).not.toBeNull(); // session preserved
    expect(onSignedOut).not.toHaveBeenCalled();
  });

  it("accessToken() returns null when signed out", async () => {
    const store = new InMemoryTokenStore();
    const { http } = fakeHttp(async () => issued(1));
    const rm = new RefreshManager(http, store, {}, () => 1_000_000);
    expect(await rm.accessToken()).toBeNull();
  });

  it("signOut() logs out THIS device (best-effort) then clears even if the call fails", async () => {
    const store = new InMemoryTokenStore();
    await seeded(store, "gy_at_1", "gy_rt_1", Date.now() + 1_000_000);
    const { http, calls } = fakeHttp(async () => {
      throw new ConnectError("revoke failed");
    });
    const rm = new RefreshManager(http, store);
    await rm.signOut();
    // Per-device: the caller's own family only — never other devices' logins.
    expect(calls[0]?.path).toBe("/api/session/logout");
    expect(await store.load()).toBeNull(); // cleared regardless
  });

  it("signOutEverywhere() revokes every device's session, then clears", async () => {
    const store = new InMemoryTokenStore();
    await seeded(store, "gy_at_1", "gy_rt_1", Date.now() + 1_000_000);
    const { http, calls } = fakeHttp(async () => ({}));
    const rm = new RefreshManager(http, store);
    await rm.signOutEverywhere();
    expect(calls[0]?.path).toBe("/api/session/revoke");
    expect(await store.load()).toBeNull();
  });
});
