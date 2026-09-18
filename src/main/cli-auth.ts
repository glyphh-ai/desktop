/**
 * cli-auth — a vendor CLI whose login has run out, said plainly.
 *
 * His report, 2026-09-17: every chat turn and every task step came back with
 * "Failed to authenticate: OAuth session expired and could not be refreshed",
 * which is the CLI's own words and tells the user nothing they can act on. We
 * cannot refresh someone else's OAuth session, so the only useful thing the
 * app can do is name the problem and open the door to fixing it.
 *
 * Pure on purpose: the matching is tested, and the bridge, the task runner and
 * the panel all read the same answer.
 */

export type Cli = "claude" | "codex" | "gemini" | "cursor" | string;

/** What the user runs to sign in again, per CLI. */
export const LOGIN_CMD: Record<string, string> = {
  claude: "claude",
  codex: "codex login",
  gemini: "gemini",
  cursor: "cursor-agent login",
};

/** The extra sentence a CLI needs after its command, when signing in is not
 *  simply "run this". */
const AFTER: Record<string, string> = {
  claude: "Then type /login.",
};

const PATTERNS: RegExp[] = [
  /oauth session expired/i,
  /could not be refreshed/i,
  /please run \/login/i,
  /login expired/i,
  /failed to authenticate/i,
  /not logged in/i,
  /authentication (has )?expired/i,
  /invalid (api key|credentials)/i,
  /unauthorized/i,
];

/** Does this output say the CLI could not authenticate? */
export function isAuthTrouble(text: string): boolean {
  const s = String(text || "");
  return s.length > 0 && PATTERNS.some((re) => re.test(s));
}

export interface AuthFix {
  kind: "signin";
  cli: string;
  /** The command that signs this CLI in again. */
  command: string;
  /** One line the user can act on. */
  message: string;
}

/** The fix for an authentication failure, or null when the output is about
 *  something else entirely. */
export function authFix(text: string, cli: string): AuthFix | null {
  if (!isAuthTrouble(text)) return null;
  const command = LOGIN_CMD[cli] ?? cli;
  const after = AFTER[cli] ? ` ${AFTER[cli]}` : "";
  return {
    kind: "signin",
    cli,
    command,
    message: `${cli}'s login has expired. Run \`${command}\` and sign in again.${after}`,
  };
}
