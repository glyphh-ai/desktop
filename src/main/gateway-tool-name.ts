/**
 * gateway-tool-name.ts — which of the gateway's tools an app+tool means.
 *
 * The gateway prefixes every tool with the SERVER's registered name, and a
 * connection's server is named for the org and the account
 * (`pd_<org>_google_drive_u_<user>`), never for the app slug. Asking for
 * `google_drive-list_files` matched no server, and the proxy's permission
 * check refuses a server it cannot identify, which reads as "User not allowed
 * to call this tool" (his report, 2026-09-17).
 *
 * Pure on purpose: this is the part worth testing, and it has no business
 * knowing about transports.
 */

/** The tool's own name, without whatever server prefix it arrived with. */
export const bareToolName = (tool: string): string =>
  tool.includes("-") ? tool.slice(tool.lastIndexOf("-") + 1) : tool;

/**
 * Pick the gateway's own name for `app`'s `tool` out of `names`, or null.
 *
 * An exact name always wins, so a caller that already knows the full name is
 * never second-guessed. Otherwise only tools whose server mentions the app are
 * considered, most specific first, so `gmail` never answers for
 * `google_calendar` just because both end in the same verb.
 */
export function pickToolName(names: readonly string[], app: string, tool: string): string | null {
  if (names.includes(tool)) return tool;
  const slug = app.toLowerCase();
  const bare = bareToolName(tool);
  const mine = names.filter((n) => n.toLowerCase().includes(slug));
  return mine.find((n) => n === `${app}-${tool}`)
    ?? mine.find((n) => n.endsWith(`-${tool}`))
    ?? mine.find((n) => n.endsWith(`-${bare}`))
    ?? mine.find((n) => n.toLowerCase().endsWith(bare.toLowerCase()))
    ?? null;
}

/** What this app can actually do, for an error a person can act on. */
export const toolsOfApp = (names: readonly string[], app: string): string[] =>
  names.filter((n) => n.toLowerCase().includes(app.toLowerCase()));
