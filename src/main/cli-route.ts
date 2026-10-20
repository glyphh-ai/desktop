/**
 * cli-route.ts — WHICH ROUTE A CLI LAUNCH TAKES, and what that route puts in
 * front of its command line. Pure: no electron, no fs, so every rule is
 * proved by a test.
 *
 *   direct   the CLI on its own login (the user's Claude, ChatGPT, Google,
 *            GitHub or Cursor account). Nothing of ours rides the line; the
 *            router's variables are dropped only when they are ours (a
 *            terminal that ran a gateway launch keeps them in its shell), so a
 *            proxy the user set up themselves is left alone.
 *   gateway  the CLI pointed at the local router (@glyphh/sdk/router,
 *            router-server.ts), which answers with the user's own providers
 *            and models (providers.ts). Only a CLI that speaks the wire the
 *            router serves can take it.
 *
 * The router speaks Anthropic Messages, so the gateway route is Claude's
 * alone today. Codex speaks OpenAI Responses and Gemini validates model names
 * against Google's own catalogue; Copilot and Cursor have no base-URL seam at
 * all. They stay direct until the router serves their wire.
 */

import { CLI_VENDOR, type CliId } from "./cli-ids.js";
import { setVar, sourceEnvFile, unsetVar, type Dialect } from "./shell-dialect.js";

export type CliRoute = "direct" | "gateway";

/** The CLIs the router can carry. */
export const GATEWAY_CLIS: ReadonlySet<CliId> = new Set<CliId>(["claude"]);

/** Where the route was chosen, most specific first. Each is a yes/no when
 *  that level has an opinion and absent (or null) when it leaves the choice
 *  to the next one. */
export interface RouteHints {
  /** The session's own pick (the composer's route chip). */
  session?: boolean | null;
  /** The workspace cell the agent opened in (cell config `gateway`). */
  cell?: boolean | null;
  /** The workspace itself (layout `gateway`). */
  layout?: boolean | null;
}

/** The preference that holds the member's default route (Settings). Off until they turn it on. */
export const CLI_GATEWAY_PREF = "cliGateway";

/** A workspace's stored "on" | "off" as a hint. */
export const gatewayHint = (v: unknown): boolean | undefined => (v === "on" ? true : v === "off" ? false : undefined);

/**
 * The route for one launch: the session's pick, then the workspace cell's,
 * then the workspace's, then the member's default — and the gateway only for
 * a CLI the router can carry, with a chat model it can call. Without one the
 * router would refuse every turn, so the CLI keeps its own login.
 */
export function resolveCliRoute(cli: CliId, hints: RouteHints | undefined, prefDefault: boolean, hasChatModel: boolean): CliRoute {
  if (!GATEWAY_CLIS.has(cli) || !hasChatModel) return "direct";
  const pick = [hints?.session, hints?.cell, hints?.layout].find((v): v is boolean => typeof v === "boolean");
  return (pick ?? prefDefault) ? "gateway" : "direct";
}

// ── what the gateway route puts on the line (claude) ─────────────────────────

/** The router's address and credential, sourced from the loop's env file so
 *  the token never types into a visible terminal. AUTH_TOKEN rides as a
 *  bearer and, unlike an API key, never asks the CLI's "use this key?" question. */
export const GATEWAY_BASE_ENV = "ANTHROPIC_BASE_URL";
export const GATEWAY_TOKEN_ENV = "ANTHROPIC_AUTH_TOKEN";
/** An Anthropic key in the user's shell would win over the bearer and send
 *  the turn to Anthropic directly: it is dropped for a gateway launch. */
export const SHADOWING_KEY_ENV = "ANTHROPIC_API_KEY";
/** The names Claude Code reads for the models behind its own aliases (sub-agents
 *  on "sonnet", background calls on the small model). On the gateway each one
 *  is the session's model, so no call asks the router for a model the user
 *  has not set up. */
export const MODEL_ALIAS_ENV: readonly string[] = [
  "ANTHROPIC_DEFAULT_OPUS_MODEL", "ANTHROPIC_DEFAULT_SONNET_MODEL", "ANTHROPIC_DEFAULT_HAIKU_MODEL", "ANTHROPIC_SMALL_FAST_MODEL",
];

/** The env file's body for the gateway route, in the KEY="value" format
 *  shell-dialect.sourceEnvFile reads in both dialects. */
export function gatewayEnvFileBody(endpoint: { url: string; token: string }): string {
  const line = (k: string, v: string): string => `${k}="${v.replace(/(["\\$`])/g, "\\$1")}"`;
  return `${line(GATEWAY_BASE_ENV, endpoint.url)}\n${line(GATEWAY_TOKEN_ENV, endpoint.token)}\n`;
}

/** Every router token starts with this (@glyphh/sdk/router startRouterServer). */
export const ROUTER_TOKEN_PREFIX = "glyphh-router-";

/** Drop the router's variables when, and only when, the token in the shell is
 *  ours: a gateway launch earlier in the same terminal left them there. */
export function dropOurGatewayVars(d: Dialect): string {
  return d === "powershell"
    ? ` if ($env:${GATEWAY_TOKEN_ENV} -like '${ROUTER_TOKEN_PREFIX}*') { Remove-Item Env:\\${GATEWAY_BASE_ENV}, Env:\\${GATEWAY_TOKEN_ENV} -ErrorAction SilentlyContinue };`
    : ` case "$${GATEWAY_TOKEN_ENV}" in ${ROUTER_TOKEN_PREFIX}*) unset ${GATEWAY_BASE_ENV} ${GATEWAY_TOKEN_ENV};; esac;`;
}

/**
 * What leads the whole line (before any `cd`): on the gateway, the env file
 * sourced and the shadowing key dropped; direct, the router's variables
 * dropped if a gateway launch left them in this shell, so the CLI talks to its
 * own vendor on its own login. "" for a CLI the route never touches.
 */
export function routeEnvPrefix(cli: CliId, route: CliRoute, envFile: string, d: Dialect): string {
  if (!GATEWAY_CLIS.has(cli)) return "";
  const prefix = route === "gateway"
    ? `${sourceEnvFile(envFile, d)}${unsetVar(SHADOWING_KEY_ENV, d)}`
    : dropOurGatewayVars(d);
  return prefix.trim();
}

/** What sits directly before the CLI's own command on the gateway: the alias
 *  models, set for that command alone (POSIX) or the rest of the line
 *  (PowerShell). "" off the gateway or with no model. */
export function routeModelVars(cli: CliId, route: CliRoute, model: string, d: Dialect): string {
  if (route !== "gateway" || !GATEWAY_CLIS.has(cli) || !model) return "";
  return MODEL_ALIAS_ENV.map((k) => setVar(k, model, d)).join("").trim();
}

// ── which model a launch names ───────────────────────────────────────────────

/** A picked model as the app stores it: `<provider>::<model>`, or a bare name. */
const splitId = (picked: string): { provider: string; model: string } | null => {
  const i = picked.indexOf("::");
  return i > 0 ? { provider: picked.slice(0, i), model: picked.slice(i + 2) } : null;
};

/**
 * The model a gateway launch sends: the pick when it is one of the user's
 * chat models, else their default chat model. The router resolves the full
 * id, so it is sent whole.
 */
export function gatewayModelFor(picked: string | undefined, chatModels: readonly string[], fallback: string): string {
  const p = String(picked ?? "").replace(/"/g, "").trim();
  return p && chatModels.includes(p) ? p : fallback;
}

/**
 * The model a direct launch sends, in the CLI's own vocabulary: a bare name is
 * the CLI's (its login's picker), a `<provider>::<model>` only when that
 * provider is the CLI's own vendor. Anything else — an OpenAI model on Claude's
 * login — is dropped and the CLI runs its own default, rather than failing on
 * a model its account cannot have.
 */
export function directModelFor(cli: CliId, picked: string | undefined, kindOf: (providerId: string) => string | undefined): string {
  const p = String(picked ?? "").replace(/"/g, "").trim();
  if (!p) return "";
  const id = splitId(p);
  if (!id) return p;
  if (cli === "glyphh") return p;
  const vendor = CLI_VENDOR[cli];
  return vendor && kindOf(id.provider) === vendor ? id.model : "";
}
