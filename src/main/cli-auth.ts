/**
 * cli-auth — a vendor CLI whose login has run out, said plainly.
 *
 * "Failed to authenticate: OAuth session expired and could not be refreshed"
 * is the CLI's own words and tells the user nothing they can act on. We cannot
 * refresh someone else's OAuth session, so the only useful thing the app can
 * do is name the problem and open the door to fixing it (cli-login).
 *
 * Pure on purpose: the matching is tested, and the bridge and the panel read
 * the same answer.
 */
import { installLine } from "./cli-install.js";

/** What the user runs to sign in again, per CLI. */
export const LOGIN_CMD: Record<string, string> = {
  claude: "claude",
  codex: "codex login",
  gemini: "gemini",
  copilot: "copilot",
  cursor: "cursor-agent login",
};

/** The extra sentence a CLI needs after its command, when signing in is not
 *  simply "run this". */
const AFTER: Record<string, string> = {
  claude: "Then type /login.",
  copilot: "Then type /login.",
  gemini: "Then type /auth and pick how to sign in.",
};

/** Phrasings that mean the CLI's OWN LOGIN is out and only a fresh sign-in
 *  fixes it. Each one is unambiguous on its own — a run reaches the sign-in
 *  card on the strength of a single match, so nothing vague belongs here —
 *  not even the bare word "unauthorized", which is what a refusal says too. */
const PATTERNS: RegExp[] = [
  /oauth session expired/i,
  /oauth token (is )?(expired|invalid)/i,
  /could not be refreshed/i,
  /please run \/login/i,
  /login expired/i,
  /failed to authenticate/i,
  /not logged in/i,
  /authentication (has )?expired/i,
  /invalid (api key|credentials)/i,
  /\b401\b/,
];

/** NOT a login problem: a step the user, a hook or the OS refused is a
 *  PERMISSION decision. The login is fine, and sending someone off to sign in
 *  again points them at a thing that was never broken. A denial phrase
 *  anywhere in the output VETOES the auth read. */
const DENIAL: RegExp[] = [
  /permissions? (denied|not granted|to use|request)/i,
  /requested? permissions?/i,
  /haven'?t granted/i,
  /\bnot allowed\b/i,
  /\bnot permitted\b/i,
  /operation not permitted/i,
  /\b(EACCES|EPERM)\b/,
  /user (denied|rejected|declined|doesn'?t want)/i,
  /doesn'?t want to (proceed|take)/i,
  /(rejected|denied|declined) (the |this )?(tool|command|action|edit|request)/i,
  /blocked by (a )?hook/i,
  /approval (was )?(denied|rejected)/i,
  /interrupted by user/i,
];

/** Was this run stopped by a permission decision rather than a broken login? */
export function isPermissionDenial(text: string): boolean {
  const s = String(text || "");
  return s.length > 0 && DENIAL.some((re) => re.test(s));
}

export function isAuthTrouble(text: string): boolean {
  const s = String(text || "");
  if (!s || isPermissionDenial(s)) return false;
  return PATTERNS.some((re) => re.test(s));
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
 *  line is kept as the second sentence so nothing is hidden, only translated. */
const KNOWN: Array<{ re: RegExp; cli?: string; say: (cli: string) => string }> = [
  {
    re: /not inside a trusted directory/i,
    say: (cli) => `${cli} refused to run in this folder because it is not a git repository and ${cli} was not told to skip that check. Open a folder that is a git checkout, or run \`git init\` in this one.`,
  },
  {
    re: /not supported when using codex with a chatgpt account/i,
    say: () => "This loop is on Codex's ChatGPT login, which only runs the models Codex itself lists (open Codex and type /model to see them). Pick one of those for the chat, or leave the model unset so Codex chooses.",
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
  // A refusal is read from the SAME list that vetoes the sign-in card, so the
  // two can never disagree about what a denial looks like.
  if (isPermissionDenial(s)) {
    return { kind: "explain", cli, message: `A step in this turn was not allowed, so ${cli} stopped there. The login is fine — approve the step when the app asks, loosen this chat's permission mode, or tell the agent to take a different route, then run the turn again.\n\n${cli} said: ${firstLine(s)}` };
  }
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
    // An API key the provider turned down is not an expired login: say so,
    // or the user signs in to the same rejected key again.
    message: /api key not valid|invalid api key/i.test(String(text))
      ? `${cli} is set to sign in with an API key, and the provider rejected it. Run \`${command}\` and sign in again with another key or another way.${after}`
      : `${cli}'s login has expired. Run \`${command}\` and sign in again.${after}`,
  };
}
