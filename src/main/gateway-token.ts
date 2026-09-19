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
import { userScopedPath } from "./app-paths.js";

/** What the CLI needs to talk to the gateway instead of the vendor. */
export interface GatewayCreds { baseUrl: string; token: string }

/** Which env var each CLI reads its key from, beside its base-URL var. */
export const KEY_ENV: Record<string, string> = {
  claude: "ANTHROPIC_AUTH_TOKEN",
  codex: "OPENAI_API_KEY",
  gemini: "GEMINI_API_KEY",
};

let cached: GatewayCreds | null = null;
let mcpCached: GatewayCreds | null = null;
let inflight: Promise<GatewayCreds | null> | null = null;

/** The member's credential for the server's REMOTE MCP (/mcp) — handed out
 *  whether or not the gateway lane is on. Null only when the server has no
 *  key for this member (offline, not signed in). */
export async function mcpCreds(): Promise<GatewayCreds | null> {
  if (mcpCached) return mcpCached;
  await gatewayCreds();
  return mcpCached;
}

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
      const r = await getClient().gateway.token();
      if (!r?.baseUrl || !r?.token) return null;
      mcpCached = { baseUrl: r.baseUrl, token: r.token };
      // gateway:false = the org's lane is OFF (his ruling, 2026-09-14: the
      // CLI rides its own login unless the org pays for / forces the
      // gateway). The credential still authenticates the server's /mcp.
      if (r.gateway === false) return null;
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

/**
 * PRIME every loop's env so a launch — ANY launch path — starts proxied.
 *
 * The composers source `~/.glyphh/loops/<id>/env` when it exists; only
 * `cli-agent-open` used to write it, so a loop started through the workbench's
 * synchronous compose path or a scheduled run began life unproxied (his
 * report, 2026-09-12: "I want us to start an agent with the url set for
 * proxy — it is an ease of use thing"). Priming at sign-in means the file is
 * always there and current before anything composes a command.
 *
 * BYOK still wins: a loop carrying its own key has the gateway lines STRIPPED
 * rather than written, which is also how a member's key surviving an org
 * change gets cleaned up.
 *
 * Best-effort and silent: no creds (no plan, closed trial, offline) simply
 * leaves every loop on whatever the CLI is already logged into.
 */
/**
 * THE BURN-DOWN DECIDES PER VENDOR (his order, 2026-09-18).
 *
 * An org spends the credits its vendor granted it FIRST: the CLI talks
 * straight to Anthropic or OpenAI on the org's own key, which never touches
 * our gateway and costs us nothing. Only when those credits are gone does that
 * vendor's loop get pointed at the gateway, and on the next interval it goes
 * back. A vendor with no allowance is in no burn-down and follows the org's
 * gateway switch the way it always has.
 */
export const LOOP_VENDOR: Record<string, string> = { claude: "anthropic", codex: "openai", gemini: "google" };

let routing: Record<string, string> = {};
let routingAt = 0;
const ROUTING_TTL_MS = 60_000;
/** HOW THE ORG SPENDS (his order, 2026-09-19). burn_down: a vendor stays
 *  direct while its own allowance lasts, then moves onto the proxy. reserved:
 *  the vendor's HEAVY models (Opus, Fable — the top price tier, named by the
 *  server) stay direct on the subscription while the allowance lasts and
 *  everything lighter rides the proxy on the org's credits. */
export type CreditStrategy = "burn_down" | "reserved";
let strategy: CreditStrategy = "burn_down";
let heavy: Record<string, string[]> = {};

async function vendorRouting(force = false): Promise<Record<string, string>> {
  if (!force && Date.now() - routingAt < ROUTING_TTL_MS) return routing;
  try {
    const gates = await getClient().plans.gates() as unknown as { vendorRouting?: Record<string, string>; creditStrategy?: string; heavyModels?: Record<string, string[]> };
    routing = gates?.vendorRouting ?? {};
    strategy = gates?.creditStrategy === "reserved" ? "reserved" : "burn_down";
    heavy = gates?.heavyModels ?? {};
    routingAt = Date.now();
  } catch { /* offline — the last answer stands, and absence means no burn-down */ }
  return routing;
}

const bare = (model: string): string => model.trim().toLowerCase().replace(/^[a-z0-9_-]+\//, "");
function isHeavy(vendor: string, model: string): boolean {
  const m = bare(model);
  return !!m && (heavy[vendor] ?? []).some((h) => bare(h) === m);
}

/** WHERE ONE REQUEST GOES, decided by the model it names. Synchronous on the
 *  cached gates so the command composers can ask at launch. */
export function requestUsesGateway(cli: string, model: string, hasOwnKey: boolean): boolean {
  if (hasOwnKey) return false;
  const vendor = LOOP_VENDOR[cli] ?? "";
  const lane = routing[vendor];
  if (lane === "gateway") return !!cached;
  if (lane === "direct") return strategy === "reserved" && !!cached && !isHeavy(vendor, model);
  return !!cached;
}

/** Whether ANY of this loop's turns may go to the gateway — what decides if
 *  its env file carries the credential. A heavy request under "reserved"
 *  strips the vars at launch instead. */
export async function loopGoesToGateway(cli: string, hasOwnKey: boolean): Promise<boolean> {
  if (hasOwnKey) return false;
  const lane = (await vendorRouting())[LOOP_VENDOR[cli] ?? ""];
  if (lane === "direct") return strategy === "reserved" && !!(await gatewayCreds());
  if (lane === "gateway") return true;
  return !!(await gatewayCreds());
}

export async function primeGatewayEnv(
  loops: Array<{ id: string; cli: string; hasOwnKey: boolean }>,
  baseUrlVarsFor: (cli: string) => string[],
): Promise<void> {
  const creds = await gatewayCreds();
  await vendorRouting(true);
  for (const l of loops) {
    const vars = baseUrlVarsFor(l.cli);
    if (!vars.length) continue; // copilot / cursor have no base-URL seam
    try {
      if (creds && await loopGoesToGateway(l.cli, l.hasOwnKey)) writeGatewayEnv(l.id, l.cli, vars, creds);
      else clearGatewayEnv(l.id, l.cli, vars);
    } catch { /* one unreadable loop must not stop the rest */ }
  }
}

/**
 * Forget the credential entirely — memo AND the copies on disk.
 *
 * Called on LOGOUT. Without this a minted router key survives sign-out in
 * every loop's env file, so the next person at the machine keeps
 * authenticating as the last one and billing their org. The memo alone is
 * not enough: the env files are what the CLI actually reads.
 */
export function clearGatewayCreds(): void {
  cached = null;
  mcpCached = null;
  let ids: string[] = [];
  try { ids = fs.readdirSync(userScopedPath("loops")); } catch { return; }
  for (const id of ids) {
    // Strip every variable we could have written, whatever CLI the loop is —
    // a loop's vendor may have changed since the key was put there.
    const vars = [...ALL_BASE_URL_VARS, ...Object.values(KEY_ENV)];
    try { stripVars(id, vars); } catch { /* a loop we cannot read is one we cannot leak from */ }
  }
}

/** Every base-URL variable any loop could carry. */
const ALL_BASE_URL_VARS = [
  "ANTHROPIC_BASE_URL", "OPENAI_BASE_URL", "GOOGLE_GEMINI_BASE_URL",
];

/** Remove `vars` from a loop's env file, keeping whatever else is in it. */
function stripVars(id: string, vars: string[]): void {
  const ours = new Set(vars);
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

const envFile = (id: string): string => userScopedPath("loops", id, "env");

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
  stripVars(id, [...baseUrlVars, ...(keyVar ? [keyVar] : [])]);
}

/** Write ONLY the base-URL vars (no key line) — the memory bridge's lane for
 *  loops on their own auth: the CLI keeps its login/key, the traffic just
 *  routes through the loopback bridge. */
export function writeBaseUrlOnly(id: string, cli: string, baseUrlVars: string[], baseUrl: string): void {
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
  const lines = baseUrlVars.map((v) => `${v}="${baseUrl}"`);
  const dir = path.dirname(envFile(id));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(envFile(id), `${kept}${lines.join("\n")}\n`, { encoding: "utf-8", mode: 0o600 });
}
