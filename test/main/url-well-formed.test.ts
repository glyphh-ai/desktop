/**
 * url-well-formed.test.ts — the one address check a tab must pass
 * (src/renderer/help/url-well-formed.ts; his report, 2026-10-07).
 */
import { describe, it, expect } from "vitest";
import { wellFormedUrl } from "../../src/renderer/help/url-well-formed.js";

describe("wellFormedUrl", () => {
  it("completes a bare host to https", () => {
    expect(wellFormedUrl("mail.google.com")).toBe("https://mail.google.com/");
  });
  it("keeps a full address, path and query included", () => {
    expect(wellFormedUrl("https://x.y/path?q=1")).toBe("https://x.y/path?q=1");
  });
  it("completes localhost to plain http", () => {
    expect(wellFormedUrl("localhost:3000")).toBe("http://localhost:3000/");
  });
  it("accepts an IPv4 host", () => {
    expect(wellFormedUrl("127.0.0.1:8080/x")).toBe("https://127.0.0.1:8080/x");
  });
  it("refuses a non-http scheme", () => {
    expect(wellFormedUrl("ftp://x.y")).toBeNull();
  });
  it("refuses text that is not an address", () => {
    expect(wellFormedUrl("not a url")).toBeNull();
    expect(wellFormedUrl("mail")).toBeNull();
  });
  it("refuses an empty field", () => {
    expect(wellFormedUrl("")).toBeNull();
    expect(wellFormedUrl("   ")).toBeNull();
  });
  it("trims whitespace", () => {
    expect(wellFormedUrl("  https://a.b  ")).toBe("https://a.b/");
  });
});
