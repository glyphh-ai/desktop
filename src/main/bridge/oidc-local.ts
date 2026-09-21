/**
 * oidc-local.ts — the bridge as an OpenID provider to Claude Desktop alone
 * (BRIDGE-MODE.md §2). Pure node:crypto; every bit of state is process memory,
 * by the desktop's zero-local-storage law: a restart forgets the keys and
 * Claude Desktop signs in again, which is one browser hop when the member is
 * still signed in to Glyphh.
 *
 * Identity is NOT decided here. The caller hands in who the signed-in Glyphh
 * member is; this module only turns that into codes and tokens the client
 * understands. Glyphh first, then the bridge, then Claude Desktop.
 */

import { createHash, generateKeyPairSync, randomBytes, sign as cryptoSign, verify as cryptoVerify, type KeyObject } from "node:crypto";

export interface Member { userId: string; email: string; name: string | null; orgSlug: string | null }

export interface AuthorizeParams {
  client_id: string; redirect_uri: string; state: string; code_challenge: string; code_challenge_method?: string; scope?: string; nonce?: string; response_type?: string;
}

export type AuthorizeCheck = { ok: true; scope: string } | { ok: false; error: string; description: string };

export interface TokenSet { access_token: string; token_type: "Bearer"; expires_in: number; refresh_token: string; scope: string; id_token?: string }

export const SCOPES: ReadonlySet<string> = new Set(["openid", "profile", "email", "offline_access", "glyphh-gateway"]);
export const AUDIENCE = "glyphh-bridge";
const ACCESS_TTL_S = 3600;
const CODE_TTL_S = 300;
const REFRESH_TTL_S = 30 * 24 * 3600;
const LOOPBACK: ReadonlySet<string> = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

const b64url = (b: Buffer | string): string => Buffer.from(b).toString("base64url");
const hash = (s: string): string => createHash("sha256").update(s).digest("hex");

/** The server's rule, mirrored: a registered client redirects only where it registered;
 *  an unregistered public client may use a loopback address or a custom scheme, never https. */
export function redirectAllowed(uri: string, registered: string[] | null): boolean {
  if (!uri || uri.includes("#")) return false;
  if (registered && registered.length) return registered.includes(uri);
  let u: URL;
  try { u = new URL(uri); } catch { return false; }
  if (u.protocol === "http:") return LOOPBACK.has(u.hostname.toLowerCase());
  return !["", "https:", "javascript:", "data:", "file:"].includes(u.protocol);
}

export function pkceOk(verifier: string, challenge: string): boolean {
  if (!verifier || !challenge) return false;
  return b64url(createHash("sha256").update(verifier).digest()) === challenge;
}

interface Client { client_id: string; client_name: string; redirect_uris: string[] }
interface Code { client_id: string; redirect_uri: string; challenge: string; scope: string; nonce: string | null; sub: string; exp: number }
interface Refresh { sub: string; client_id: string; scope: string; exp: number }

export class LocalIssuer {
  private readonly priv: KeyObject;
  private readonly pub: KeyObject;
  readonly kid: string;
  private readonly clients = new Map<string, Client>();
  private readonly codes = new Map<string, Code>();
  private readonly refresh = new Map<string, Refresh>();
  private readonly members = new Map<string, Member>();
  private revokedAt = 0;

  constructor(private readonly issuerUrl: () => string, private readonly now: () => number = () => Date.now()) {
    const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    this.priv = privateKey;
    this.pub = publicKey;
    this.kid = randomBytes(8).toString("hex");
  }

  discovery(): Record<string, unknown> {
    const iss = this.issuerUrl();
    return {
      issuer: iss,
      authorization_endpoint: `${iss}/oauth/authorize`,
      token_endpoint: `${iss}/oauth/token`,
      jwks_uri: `${iss}/oauth/jwks`,
      userinfo_endpoint: `${iss}/oauth/userinfo`,
      registration_endpoint: `${iss}/oauth/register`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
      subject_types_supported: ["public"],
      id_token_signing_alg_values_supported: ["RS256"],
      scopes_supported: [...SCOPES],
    };
  }

  jwks(): Record<string, unknown> {
    const jwk = this.pub.export({ format: "jwk" }) as Record<string, unknown>;
    return { keys: [{ ...jwk, kid: this.kid, use: "sig", alg: "RS256" }] };
  }

  register(body: unknown): Record<string, unknown> {
    const o = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
    const uris = Array.isArray(o.redirect_uris) ? (o.redirect_uris as unknown[]).filter((u): u is string => typeof u === "string" && redirectAllowed(u, null)) : [];
    const client: Client = {
      client_id: `bridge_${randomBytes(9).toString("base64url")}`,
      client_name: typeof o.client_name === "string" ? o.client_name.slice(0, 80) : "",
      redirect_uris: uris,
    };
    this.clients.set(client.client_id, client);
    return { client_id: client.client_id, client_name: client.client_name, redirect_uris: client.redirect_uris, token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"], response_types: ["code"] };
  }

  clientName(clientId: string): string {
    return this.clients.get(clientId)?.client_name || clientId;
  }

  /** Everything about an authorize request except who the member is. */
  checkAuthorize(q: AuthorizeParams): AuthorizeCheck {
    const registered = this.clients.get(q.client_id)?.redirect_uris ?? null;
    if (!q.client_id || !redirectAllowed(q.redirect_uri, registered)) return { ok: false, error: "invalid_request", description: "client_id and an allowed redirect_uri are required" };
    if ((q.response_type ?? "code") !== "code") return { ok: false, error: "unsupported_response_type", description: "only response_type=code" };
    if (!q.code_challenge || (q.code_challenge_method ?? "S256") !== "S256") return { ok: false, error: "invalid_request", description: "PKCE with S256 is required" };
    const scope = (q.scope ?? "openid").split(/\s+/).filter((s) => SCOPES.has(s)).join(" ") || "openid";
    return { ok: true, scope };
  }

  /** The member said yes: a one-shot code, and the URL to send the browser to. */
  issueCode(q: AuthorizeParams, scope: string, member: Member): string {
    const code = randomBytes(32).toString("base64url");
    this.members.set(member.userId, member);
    this.codes.set(hash(code), { client_id: q.client_id, redirect_uri: q.redirect_uri, challenge: q.code_challenge, scope, nonce: q.nonce ?? null, sub: member.userId, exp: this.now() + CODE_TTL_S * 1000 });
    const sep = q.redirect_uri.includes("?") ? "&" : "?";
    return `${q.redirect_uri}${sep}code=${encodeURIComponent(code)}&state=${encodeURIComponent(q.state ?? "")}`;
  }

  token(form: Record<string, string>): TokenSet | { error: string; description: string } {
    const grant = form.grant_type;
    if (grant === "authorization_code") {
      const row = this.codes.get(hash(form.code ?? ""));
      this.codes.delete(hash(form.code ?? ""));
      if (!row || row.exp < this.now()) return { error: "invalid_grant", description: "unknown or expired code" };
      if (row.client_id !== form.client_id || row.redirect_uri !== form.redirect_uri) return { error: "invalid_grant", description: "client or redirect does not match" };
      if (!pkceOk(form.code_verifier ?? "", row.challenge)) return { error: "invalid_grant", description: "PKCE verification failed" };
      return this.mint(row.sub, row.client_id, row.scope, row.nonce);
    }
    if (grant === "refresh_token") {
      const key = hash(form.refresh_token ?? "");
      const row = this.refresh.get(key);
      if (!row || row.exp < this.now() || row.client_id !== form.client_id) return { error: "invalid_grant", description: "unknown or expired refresh token" };
      this.refresh.delete(key);
      return this.mint(row.sub, row.client_id, row.scope, null);
    }
    return { error: "unsupported_grant_type", description: "authorization_code or refresh_token" };
  }

  private mint(sub: string, clientId: string, scope: string, nonce: string | null): TokenSet {
    const member = this.members.get(sub);
    const iat = Math.floor(this.now() / 1000);
    const iss = this.issuerUrl();
    const access = this.jwt({ iss, sub, aud: AUDIENCE, iat, exp: iat + ACCESS_TTL_S, scope, client_id: clientId, email: member?.email, org: member?.orgSlug ?? undefined });
    const refreshRaw = randomBytes(32).toString("base64url");
    this.refresh.set(hash(refreshRaw), { sub, client_id: clientId, scope, exp: this.now() + REFRESH_TTL_S * 1000 });
    const set: TokenSet = { access_token: access, token_type: "Bearer", expires_in: ACCESS_TTL_S, refresh_token: refreshRaw, scope };
    if (scope.split(" ").includes("openid")) {
      set.id_token = this.jwt({ iss, sub, aud: clientId, iat, exp: iat + ACCESS_TTL_S, ...(nonce ? { nonce } : {}), email: member?.email, name: member?.name ?? undefined });
    }
    return set;
  }

  private jwt(claims: Record<string, unknown>): string {
    const clean = Object.fromEntries(Object.entries(claims).filter(([, v]) => v !== undefined));
    const head = b64url(JSON.stringify({ alg: "RS256", typ: "JWT", kid: this.kid }));
    const body = b64url(JSON.stringify(clean));
    const sig = cryptoSign("sha256", Buffer.from(`${head}.${body}`), this.priv);
    return `${head}.${body}.${b64url(sig)}`;
  }

  /** The claims of a live access token, or null: bad signature, expired, revoked, wrong audience. */
  verifyAccess(token: string): Record<string, unknown> | null {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    try {
      const ok = cryptoVerify("sha256", Buffer.from(`${parts[0]}.${parts[1]}`), this.pub, Buffer.from(parts[2], "base64url"));
      if (!ok) return null;
      const claims = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf-8")) as Record<string, unknown>;
      const nowS = Math.floor(this.now() / 1000);
      if (claims.aud !== AUDIENCE || typeof claims.exp !== "number" || claims.exp <= nowS) return null;
      if (typeof claims.iat === "number" && claims.iat * 1000 < this.revokedAt) return null;
      return claims;
    } catch { return null; }
  }

  userinfo(token: string): Record<string, unknown> | null {
    const claims = this.verifyAccess(token);
    if (!claims) return null;
    const m = this.members.get(String(claims.sub));
    return { sub: claims.sub, email: m?.email, name: m?.name ?? undefined, org: m?.orgSlug ?? undefined };
  }

  /** Sign-out: every token issued before now is dead and every refresh is gone. */
  revokeAll(): void {
    this.revokedAt = this.now();
    this.refresh.clear();
    this.codes.clear();
  }
}
