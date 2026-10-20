/**
 * resources/guest.ts — the anonymous (no-account) chat surface.
 *
 * A landing visitor has no session. It mints a self-verifying GUEST token
 * (`POST /api/auth/guest`) and chats through the SAME gateway every authed turn
 * uses (`POST /api/gateway/guest/v1/messages`) — the server forces the model to
 * Mistral, rate-limits + budget-caps the caller's IP, and meters the turn like any
 * other. This client is the thin app-side entrypoint: mint a token, then send a
 * guest turn carrying it.
 *
 * It rides the UNAUTHENTICATED HttpClient (a guest token is not a session bearer),
 * and returns the raw streaming Response for `messages` so an interceptor can relay
 * it untouched — the same contract as GatewayClient.messages.
 */

import type { HttpClient } from "../core/http.js";
import type { GuestToken, GuestTurnInput } from "../contract/gateway.js";

export class GuestClient {
  constructor(private readonly http: HttpClient) {}

  /**
   * Mint (or renew) a guest token. Pass a previously returned `guestId` to keep the
   * ephemeral session id stable across a device; omit it on a first visit. The spend
   * budget is keyed on the client IP server-side, not this id.
   */
  token(guestId?: string): Promise<GuestToken> {
    return this.http.post<GuestToken>("/api/auth/guest", guestId ? { guestId } : {});
  }

  /**
   * One guest chat turn, as the RAW Anthropic-Messages response (SSE or JSON), body
   * untouched — the caller reads status + stream themselves. The `token` is the
   * guest bearer minted by {@link token}. The model is forced to Mistral server-side.
   */
  messages(
    token: string,
    body: GuestTurnInput & { stream?: boolean },
    opts: { headers?: Record<string, string>; signal?: AbortSignal } = {},
  ): Promise<Response> {
    return this.http.stream("/api/gateway/guest/v1/messages", body, { ...opts, bearer: token });
  }

  /**
   * The convenience path: mint a fresh guest token (or reuse one) and send a
   * NON-streaming turn, returning the parsed Anthropic message. Throws on a non-2xx
   * (402 when the guest hit its monthly cap, 429 when over the per-IP rate).
   */
  async chat(
    body: GuestTurnInput,
    opts: { token?: string; guestId?: string } = {},
  ): Promise<{ token: string; message: unknown }> {
    const token = opts.token ?? (await this.token(opts.guestId)).token;
    const res = await this.messages(token, { ...body, stream: false });
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`guest chat failed (${res.status}): ${text.slice(0, 300)}`);
    }
    return { token, message: text ? JSON.parse(text) : null };
  }
}
