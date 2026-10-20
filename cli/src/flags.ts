/**
 * flags.ts — the command line. What the desktop passes when it opens the Glyphh
 * loop in a terminal card, and what a person types. Pure, so it is tested.
 * (`glyphh desktop` never reaches here: bin/glyphh.js takes it first.)
 */

import { EFFORTS, effortOf, permissionModeOf, type Effort, type PermissionMode } from "./types.js";

export interface Flags {
  model?: string;
  permission?: PermissionMode;
  /** `--effort <low|medium|high|xhigh|max>`: the dial for THIS run (over the device's pick). */
  effort?: Effort;
  prompt?: string;
  /** `--resume <chatId>`: open that chat from the shared store. */
  resume?: string;
  /** `--continue`: open the most recent Glyphh-loop chat. */
  continueLast?: boolean;
  /** `--trust`: this folder is trusted — skip the question (the desktop chose it). */
  trust?: boolean;
  /** `--help`: print the usage and exit. */
  help?: boolean;
  /** `--version`: print the version and exit. */
  version?: boolean;
}

export const USAGE = `usage: glyphh [--model <id>] [--permission default|acceptEdits|plan|bypass] [--effort ${EFFORTS.join("|")}] [--resume <chatId> | --continue] [--trust] [prompt…]
       glyphh desktop [args…]     open the desktop app
       glyphh --help | --version`;

/** What `--help` prints: the usage, and where providers come from. */
export const HELP = `glyphh — the Glyphh agent in your terminal, on your own model providers.

${USAGE}

  --model <id>          the model this session runs on (/model lists them)
  --permission <mode>   default asks · acceptEdits · plan reads only · bypass runs everything
  --effort <level>      how hard the model thinks: ${EFFORTS.join(", ")}
  --resume <chatId>     open a conversation shared with the desktop (-r)
  --continue            open the most recent one (-c)
  --trust               skip the trust-this-folder question

Providers, models and keys: Settings › Models in the desktop app (glyphh desktop),
kept in ~/.glyphh/users/local/providers.json; a key in ANTHROPIC_API_KEY,
OPENAI_API_KEY or GEMINI_API_KEY also works.`;

/** `--effort` takes exactly the dial's words; anything else is refused (exit 2). */
function effortFlag(raw: string): Effort {
  const e = effortOf(raw);
  if (e) return e;
  process.stderr.write(`glyphh: --effort must be one of ${EFFORTS.join(", ")} (got ${JSON.stringify(raw)})\n${USAGE}\n`);
  process.exit(2);
}

/** The permission words every Glyphh surface uses → this TUI's chip. */
export function permissionFlag(raw: string): PermissionMode | undefined {
  return permissionModeOf(raw);
}

/** Parse argv. Unknown `--flags` are refused with a usage line; bare words are the prompt. */
export function parseFlags(argv: string[]): Flags {
  const out: Flags = {};
  const words: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] ?? "";
    if (a === "--model") { const v = argv[++i]; if (v) out.model = v; continue; }
    if (a.startsWith("--model=")) { out.model = a.slice(8); continue; }
    if (a === "--permission" || a === "--permission-mode") { const p = permissionFlag(argv[++i] ?? ""); if (p) out.permission = p; continue; }
    if (a.startsWith("--permission=") || a.startsWith("--permission-mode=")) { const p = permissionFlag(a.slice(a.indexOf("=") + 1)); if (p) out.permission = p; continue; }
    if (a === "--dangerously-skip-permissions") { out.permission = "bypass"; continue; }
    if (a === "--effort") { out.effort = effortFlag(argv[++i] ?? ""); continue; }
    if (a.startsWith("--effort=")) { out.effort = effortFlag(a.slice(9)); continue; }
    if (a === "--resume" || a === "-r") { const v = argv[++i]; if (v && /^[A-Za-z0-9_-]{1,64}$/.test(v)) out.resume = v; continue; }
    if (a.startsWith("--resume=")) { const v = a.slice(9); if (/^[A-Za-z0-9_-]{1,64}$/.test(v)) out.resume = v; continue; }
    if (a === "--continue" || a === "-c") { out.continueLast = true; continue; }
    if (a === "--trust") { out.trust = true; continue; }
    if (a === "--help" || a === "-h") { out.help = true; continue; }
    if (a === "--version" || a === "-v") { out.version = true; continue; }
    if (a.startsWith("--")) {
      process.stderr.write(`glyphh: unknown flag ${a}\n${USAGE}\n`);
      process.exit(2);
    }
    words.push(a);
  }
  const prompt = words.join(" ").trim();
  if (prompt) out.prompt = prompt;
  return out;
}
