/**
 * Unit tests for the small auth primitives: the error factory, the in-memory token
 * store, and the credential providers.
 */

import { describe, it, expect } from "vitest";
import { apiErrorFor, AuthError, ForbiddenError, ValidationError, ApiError, SdkError } from "../../src/core/errors.js";
import { InMemoryTokenStore } from "../../src/auth/token-store.js";
import { sessionTokenProvider, staticTokenProvider } from "../../src/auth/credential-provider.js";
import type { RefreshManager } from "../../src/auth/refresh-manager.js";

describe("error factory", () => {
  it("selects the subclass by status", () => {
    expect(apiErrorFor({ code: "E_UNAUTHENTICATED", message: "m", httpStatus: 401 })).toBeInstanceOf(AuthError);
    expect(apiErrorFor({ code: "E_FORBIDDEN", message: "m", httpStatus: 403 })).toBeInstanceOf(ForbiddenError);
    expect(apiErrorFor({ code: "E_VALIDATION", message: "m", httpStatus: 400 })).toBeInstanceOf(ValidationError);
    const other = apiErrorFor({ code: "E_INTERNAL", message: "m", httpStatus: 500 });
    expect(other).toBeInstanceOf(ApiError);
    expect(other).not.toBeInstanceOf(AuthError);
  });
  it("SdkError carries a code and a subclass name", () => {
    const e = new SdkError("E_X", "boom");
    expect(e.code).toBe("E_X");
    expect(e.name).toBe("SdkError");
  });
});

describe("InMemoryTokenStore", () => {
  it("round-trips save/load/clear", async () => {
    const store = new InMemoryTokenStore();
    expect(await store.load()).toBeNull();
    await store.save({ accessToken: "a", refreshToken: "r", expiresAt: 1 });
    expect(await store.load()).toEqual({ accessToken: "a", refreshToken: "r", expiresAt: 1 });
    await store.clear();
    expect(await store.load()).toBeNull();
  });
});

describe("credential providers", () => {
  it("sessionTokenProvider returns the access token, or throws when signed out", async () => {
    const signedIn = { accessToken: async () => "gy_at_live" } as unknown as RefreshManager;
    expect(await sessionTokenProvider(signedIn)()).toBe("gy_at_live");
    const signedOut = { accessToken: async () => null } as unknown as RefreshManager;
    await expect(sessionTokenProvider(signedOut)()).rejects.toThrow(/not authenticated/);
  });
  it("staticTokenProvider returns the key unchanged", async () => {
    expect(await staticTokenProvider("gy_ak_key")()).toBe("gy_ak_key");
  });
});
