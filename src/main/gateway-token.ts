/**
 * gateway-token.ts — the desktop end of the token exchange.
 *
 * THE LAST MILE of auth → gateway. A loop is someone else's CLI, so the only
 * way Glyphh governs what it reaches is the environment it starts in: point
 * the CLI's base-URL variable at the router and hand it a key minted for
 * THIS member. From there the router enforces the role's models, rate and
 * budget, and every call lands in that member's spend log.
 *
 * The credential comes from POST /api/gateway/token, which is idempotent —
 * the same key every session, per user. We cache it in memory for the
 * process and write it into the loop's 0600 env file, the same invisible
 * `set -a; . file; set +a` seam a BYOK key already rides, so it never types
 * into a visible terminal and never lands in agent.json.
 *
 * BYOK WINS. A loop with its own API key configured keeps using it — the
 * member chose that deliberately, and silently re-routing their traffic
 * through our meter would be the wrong surprise.
 */

import fs from "fs";
import path from "path";
import { homedir } from "os";
import { getClient } from "./glyphh-client.js";

/** What the CLI needs to talk to the gateway instead of the vendor. */
export interface GatewayCreds { baseUrl: string; token: string }

/** Which env var each CLI reads its key from, beside its base-URL var. */
const KEY_ENV: Record<string, string> = {
  claude: "ANTHROPIC_AUTH_TOKEN",
  codex: "OPENAI_API_KEY",
  gemini: "GEMINI_API_KEY",
};

let cached: GatewayCreds | null = null;
let inflight: Promise<GatewayCreds | null> | null = null;

/**
 * The member's gateway credential, or null when the gateway isn't available
 * to them — an expired trial, a plan without it, or simply offline.
 *
 * Null is a NORMAL answer, not an error: the loop then runs exactly as it
 * did before, on whatever the CLI is already logged into. Failing the open
 * would make a network hiccup look like a broken app.
 */
export async function gatewayCreds(): Promise<GatewayCreds | null> {
  if (cached) return cached;
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const r = await getClient().http.post<{ baseUrl?: string; token?: string }>("/api/gateway/token", {});
      if (!r?.baseUrl || !r?.token) return null;
      cached = { baseUrl: r.baseUrl, token: r.token };
      return cached;
    } catch {
      return null;
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

/** Drop the memo — after a sign-out, or an org switch. */
export function clearGatewayCreds(): void {
  cached = null;
}

const envFile = (id: string): string => path.join(homedir(), ".glyphh", "loops", id, "env");

/**
 * Write the gateway lines into a loop's env file so its next launch routes
 * through the router.
 *
 * Rewrites the file wholesale from what it already held minus the two
 * variables we own — appending would let a stale base URL from a previous
 * org sit above the new one, and the last assignment silently wins.
 */
export function writeGatewayEnv(
  id: string, cli: string, baseUrlVars: string[], creds: GatewayCreds,
): void {
  const keyVar = KEY_ENV[cli];
  const ours = new Set([...baseUrlVars, ...(keyVar ? [keyVar] : [])]);
  let kept = "";
  try {
    kept = fs.readFileSync(envFile(id), "utf-8")
      .split("\n")
      .filter((l) => { const n = /^(\w+)=/.exec(l)?.[1]; return l.trim() && (!n || !ours.has(n)); })
      .join("\n");
    if (kept) kept += "\n";
  } catch { /* first write */ }
  const lines = baseUrlVars.map((v) => `${v}="${creds.baseUrl}"`);
  if (keyVar) lines.push(`${keyVar}="${creds.token}"`);
  const dir = path.dirname(envFile(id));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(envFile(id), `${kept}${lines.join("\n")}\n`, { encoding: "utf-8", mode: 0o600 });
}

/** Strip the gateway lines, leaving anything the member set themselves. */
export function clearGatewayEnv(id: string, cli: string, baseUrlVars: string[]): void {
  const keyVar = KEY_ENV[cli];
  const ours = new Set([...baseUrlVars, ...(keyVar ? [keyVar] : [])]);
  let kept: string;
  try {
    kept = fs.readFileSync(envFile(id), "utf-8")
      .split("\n")
      .filter((l) => { const n = /^(\w+)=/.exec(l)?.[1]; return l.trim() && (!n || !ours.has(n)); })
      .join("\n");
  } catch {
    return;
  }
  if (kept) fs.writeFileSync(envFile(id), `${kept}\n`, { encoding: "utf-8", mode: 0o600 });
  else fs.rmSync(envFile(id), { force: true });
}
