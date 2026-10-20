/**
 * router/server.ts — THE ROUTER ON LOOPBACK, for the CLIs. Our own loop calls
 * the router in process (createRouterFetch); a CLI cannot be handed a
 * function, only a base URL. So a CLI launched on the gateway route gets
 * `ANTHROPIC_BASE_URL` = this listener and `ANTHROPIC_API_KEY` = its token,
 * and every Messages call it makes is answered by the user's own providers
 * through the same router — the direct and the gateway paths side by side on
 * one harness.
 *
 * It speaks the Anthropic Messages edge only (POST /v1/messages and
 * /v1/messages/count_tokens), which is what the claude CLI calls.
 *
 * SECURITY: it binds 127.0.0.1 on an ephemeral port and accepts only the
 * per-process token (as x-api-key or a bearer). Any local process can reach a
 * loopback port; without the token the machine's other software could spend
 * the user's keys through it.
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import type { AddressInfo } from "node:net";
import { ROUTER_BASE_URL, type FetchLike } from "./index.js";

export interface RouterServer {
  /** The base URL a CLI is pointed at (ANTHROPIC_BASE_URL). */
  url: string;
  /** The key a CLI must send (ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN). */
  token: string;
  close(): Promise<void>;
}

/** A presented credential matches the token, compared in constant time. */
export function tokenMatches(given: string | undefined, token: string): boolean {
  if (!given) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** The credential a request presents: x-api-key, else a bearer. */
export function presented(req: Pick<IncomingMessage, "headers">): string | undefined {
  const key = req.headers["x-api-key"];
  if (typeof key === "string" && key) return key;
  const auth = req.headers.authorization;
  return typeof auth === "string" && auth.startsWith("Bearer ") ? auth.slice(7) : undefined;
}

function sendError(res: ServerResponse, status: number, message: string): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify({ type: "error", error: { type: status === 401 ? "authentication_error" : "api_error", message } }));
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString("utf-8");
}

/** A rough token count for count_tokens: the router cannot ask every provider,
 *  and the CLI uses it only to pace its context. Four characters a token. */
export function roughTokens(body: string): number {
  return Math.ceil(body.length / 4);
}

/**
 * Start the loopback router. `route` is the router's fetch (createRouterFetch),
 * so the listener holds no keys and no config of its own.
 */
export async function startRouterServer(route: FetchLike): Promise<RouterServer> {
  const token = `glyphh-router-${randomBytes(24).toString("hex")}`;
  const server = createServer((req, res) => {
    void (async () => {
      const path = (req.url ?? "/").split("?")[0]!.replace(/\/+$/, "");
      if (!tokenMatches(presented(req), token)) { sendError(res, 401, "invalid router token"); return; }
      if (req.method !== "POST" || (path !== "/v1/messages" && path !== "/v1/messages/count_tokens")) {
        sendError(res, 404, `the Glyphh router serves POST /v1/messages, not ${req.method} ${path}`);
        return;
      }
      const body = await readBody(req);
      if (path === "/v1/messages/count_tokens") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ input_tokens: roughTokens(body) }));
        return;
      }
      const ctl = new AbortController();
      res.on("close", () => { if (!res.writableEnded) ctl.abort(); });
      let answer: Response;
      try {
        answer = await route(`${ROUTER_BASE_URL}/v1/messages`, { method: "POST", body, signal: ctl.signal });
      } catch (err) {
        if (!res.headersSent) sendError(res, 502, err instanceof Error ? err.message : String(err));
        return;
      }
      res.writeHead(answer.status, { "content-type": answer.headers.get("content-type") ?? "application/json", "cache-control": "no-cache" });
      const reader = answer.body?.getReader();
      try {
        for (;;) {
          const next = reader ? await reader.read() : { done: true as const, value: undefined };
          if (next.done) break;
          res.write(next.value);
        }
      } catch { /* the client went away mid-stream */ }
      res.end();
    })().catch((err) => { if (!res.headersSent) sendError(res, 500, err instanceof Error ? err.message : String(err)); else res.end(); });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    token,
    close: () => new Promise<void>((resolve) => { server.closeAllConnections?.(); server.close(() => resolve()); }),
  };
}
