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
import { installLine } from "./cli-install.js";

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

/** A CLI refusal the app can explain but not fix on the user's behalf. */
export interface ExplainFix {
  kind: "explain";
  cli: string;
  message: string;
}

export type CliFix = AuthFix | ExplainFix;

/** Known CLI refusals and what they mean in the user's words. The CLI's own
 *  line is kept as the second sentence so nothing is hidden, only translated.
 *  His report, 2026-09-20: codex threw "Not inside a trusted directory and
 *  --skip-git-repo-check was not specified" and left him guessing. */
const KNOWN: Array<{ re: RegExp; cli?: string; say: (cli: string) => string }> = [
  {
    re: /not inside a trusted directory/i,
    say: (cli) => `${cli} refused to run in this folder because it is not a git repository and ${cli} was not told to skip that check. Open a folder that is a git checkout, or run \`git init\` in this one.`,
  },
  {
    re: /not supported when using codex with a chatgpt account/i,
    say: () => "This loop is on Codex's ChatGPT login, which only runs the models Codex itself lists (open Codex and type /model to see them). Pick one of those for the loop, or give the loop an OpenAI API key to use the full catalog.",
  },
  {
    re: /update available!?.*\d+\.\d+\.\d+.*->.*\d+\.\d+\.\d+/is,
    say: (cli) => `${cli} stopped on its own "update available" prompt. Update it from a terminal (\`brew upgrade --cask ${cli}\` or \`npm i -g\` as you installed it), or skip the prompt once in a terminal, then run the turn again.`,
  },
  {
    re: /no saved session found|session (id )?not found|could not find (a )?session/i,
    say: (cli) => `${cli} could not find the session this chat was continuing. Start a new session and try again.`,
  },
  {
    re: /command not found|ENOENT.*\b(claude|codex|gemini|copilot|cursor-agent)\b/i,
    say: (cli) => { const line = installLine(cli); return `${cli} is not installed, or is not on this machine's PATH.${line ? ` Install it from a terminal: ${line}` : ""}`; },
  },
  {
    re: /rate limit|too many requests|429/i,
    say: (cli) => `${cli}'s provider is rate limiting this account right now. Wait a minute and run the turn again.`,
  },
  {
    re: /(usage|quota) (limit )?(exceeded|reached)|out of (credits|quota)/i,
    say: (cli) => `${cli}'s account has hit its usage limit. Check the plan on the vendor's side, or switch this chat to another loop.`,
  },
];

/** The fix for a known CLI refusal: a sign-in when the login ran out, or a
 *  plain explanation of what the CLI refused and why. Null when the output
 *  is about something else entirely. */
export function cliFix(text: string, cli: string): CliFix | null {
  const auth = authFix(text, cli);
  if (auth) return auth;
  const s = String(text || "");
  if (!s) return null;
  for (const k of KNOWN) {
    if (k.cli && k.cli !== cli) continue;
    if (k.re.test(s)) return { kind: "explain", cli, message: `${k.say(cli)}\n\n${cli} said: ${firstLine(s)}` };
  }
  return null;
}

function firstLine(s: string): string {
  const line = s.split(/\r?\n/).map((l) => l.trim()).find((l) => l && !/^\s*[{[]/.test(l)) || s.trim();
  return line.length > 240 ? `${line.slice(0, 240)}…` : line;
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
