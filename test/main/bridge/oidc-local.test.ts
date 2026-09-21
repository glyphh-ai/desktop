import { createHash, randomBytes } from "node:crypto";
import { describe, it, expect } from "vitest";
import { LocalIssuer, pkceOk, redirectAllowed } from "../../../src/main/bridge/oidc-local.js";

const MEMBER = { userId: "u-1", email: "ada@acme.co", name: "Ada", orgSlug: "acme" };
const pkce = () => {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
};

describe("redirects and PKCE", () => {
  it("lets an unregistered public client use loopback or a custom scheme, never https", () => {
    expect(redirectAllowed("http://127.0.0.1:53000/callback", null)).toBe(true);
    expect(redirectAllowed("http://localhost:3/cb", null)).toBe(true);
    expect(redirectAllowed("claude://oauth/callback", null)).toBe(true);
    expect(redirectAllowed("https://evil.example/cb", null)).toBe(false);
    expect(redirectAllowed("http://evil.example/cb", null)).toBe(false);
    expect(redirectAllowed("http://127.0.0.1/cb#frag", null)).toBe(false);
  });
  it("holds a registered client to what it registered", () => {
    expect(redirectAllowed("https://claude.ai/cb", ["https://claude.ai/cb"])).toBe(true);
    expect(redirectAllowed("http://127.0.0.1/cb", ["https://claude.ai/cb"])).toBe(false);
  });
  it("checks S256", () => {
    const { verifier, challenge } = pkce();
    expect(pkceOk(verifier, challenge)).toBe(true);
    expect(pkceOk(verifier + "x", challenge)).toBe(false);
  });
});

describe("LocalIssuer", () => {
  it("runs the whole sign-in: register, authorize, code for tokens, verify, refresh, revoke", () => {
    let now = 1_000_000_000_000;
    const iss = new LocalIssuer(() => "http://127.0.0.1:4747", () => now);
    const disc = iss.discovery();
    expect(disc.issuer).toBe("http://127.0.0.1:4747");
    expect(disc.token_endpoint).toBe("http://127.0.0.1:4747/oauth/token");

    const reg = iss.register({ client_name: "Claude Desktop", redirect_uris: ["https://claude.ai/cb", "http://127.0.0.1:9/x"] });
    expect(String(reg.client_id)).toMatch(/^bridge_/);
    expect(reg.redirect_uris).toEqual(["http://127.0.0.1:9/x"]);
    const clientId = String(reg.client_id);

    const { verifier, challenge } = pkce();
    const q = { client_id: clientId, redirect_uri: "http://127.0.0.1:9/x", state: "s1", code_challenge: challenge, scope: "openid email offline_access glyphh-gateway bogus" };
    const check = iss.checkAuthorize(q);
    expect(check).toEqual({ ok: true, scope: "openid email offline_access glyphh-gateway" });
    expect(iss.checkAuthorize({ ...q, redirect_uri: "https://claude.ai/cb" }).ok).toBe(false);
    expect(iss.checkAuthorize({ ...q, code_challenge: "" }).ok).toBe(false);

    const back = new URL(iss.issueCode(q, "openid email offline_access glyphh-gateway", MEMBER));
    expect(back.origin + back.pathname).toBe("http://127.0.0.1:9/x");
    expect(back.searchParams.get("state")).toBe("s1");
    const code = back.searchParams.get("code")!;

    const bad = iss.token({ grant_type: "authorization_code", code, client_id: clientId, redirect_uri: q.redirect_uri, code_verifier: "wrong" });
    expect("error" in bad && bad.error).toBe("invalid_grant");
    const replay = iss.token({ grant_type: "authorization_code", code, client_id: clientId, redirect_uri: q.redirect_uri, code_verifier: verifier });
    expect("error" in replay, "a code is one-shot, even after a failed exchange").toBe(true);

    const back2 = new URL(iss.issueCode(q, "openid email offline_access glyphh-gateway", MEMBER));
    const tokens = iss.token({ grant_type: "authorization_code", code: back2.searchParams.get("code")!, client_id: clientId, redirect_uri: q.redirect_uri, code_verifier: verifier });
    if ("error" in tokens) throw new Error(tokens.description);
    expect(tokens.token_type).toBe("Bearer");
    expect(tokens.id_token, "openid was asked for").toBeTruthy();
    const claims = iss.verifyAccess(tokens.access_token)!;
    expect(claims.sub).toBe("u-1");
    expect(claims.email).toBe("ada@acme.co");
    expect(claims.org).toBe("acme");
    expect(iss.userinfo(tokens.access_token)).toMatchObject({ sub: "u-1", email: "ada@acme.co", name: "Ada" });
    expect(iss.verifyAccess(tokens.access_token.slice(0, -2) + "xx")).toBeNull();

    now += 3601 * 1000;
    expect(iss.verifyAccess(tokens.access_token), "expired").toBeNull();
    const refreshed = iss.token({ grant_type: "refresh_token", refresh_token: tokens.refresh_token, client_id: clientId });
    if ("error" in refreshed) throw new Error(refreshed.description);
    expect(iss.verifyAccess(refreshed.access_token)?.sub).toBe("u-1");
    const again = iss.token({ grant_type: "refresh_token", refresh_token: tokens.refresh_token, client_id: clientId });
    expect("error" in again, "refresh rotates: the old one is spent").toBe(true);

    now += 1000;
    iss.revokeAll();
    expect(iss.verifyAccess(refreshed.access_token), "sign-out kills every token issued before").toBeNull();
    expect("error" in iss.token({ grant_type: "refresh_token", refresh_token: refreshed.refresh_token, client_id: clientId })).toBe(true);
  });

  it("publishes the signing key it uses", () => {
    const iss = new LocalIssuer(() => "http://127.0.0.1:1");
    const keys = (iss.jwks().keys as Array<Record<string, unknown>>);
    expect(keys).toHaveLength(1);
    expect(keys[0]).toMatchObject({ kty: "RSA", alg: "RS256", use: "sig", kid: iss.kid });
  });
});
