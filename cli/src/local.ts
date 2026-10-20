/**
 * local.ts — THE TERMINAL'S SEAM ONTO THE DESKTOP'S OWN DATA. There is no
 * Glyphh server: this machine has one user (LOCAL_USER_ID), and the terminal
 * agent scopes to it at import exactly as the desktop does at boot, so every
 * file it reads or writes is the desktop's own:
 *
 *   ~/.glyphh/users/local/providers.json        the providers, models and keys
 *   ~/.glyphh/users/local/agent-sessions.json   the chats, shared both ways
 *
 * The modules imported here live in the desktop's src/main and are
 * Electron-free (app-paths, providers), so one definition serves both.
 */

import { homedir } from "node:os";
import { GLYPHH_DIR, LOCAL_USER_ID, setActiveUserIdState, userScopedPath } from "../../src/main/app-paths.js";
import { hasChatModel } from "../../src/main/providers.js";

setActiveUserIdState(LOCAL_USER_ID);

/** The data root the desktop uses (~/.glyphh) — prefs and the log live here. */
export const GLYPHH_HOME = GLYPHH_DIR;

/** Is there a chat model with a provider that can be called (Settings › Models,
 *  or a key in the environment)? */
export function hasProviderKey(): boolean {
  return hasChatModel();
}

/** The chat store: the desktop's file when it launched us, else the local
 *  user's own — the same path the desktop's Agent panel reads. */
export function chatStoreFile(): string {
  return process.env.GLYPHH_APP_SESSIONS || userScopedPath("agent-sessions.json");
}

/** A path as a person reads it: $HOME collapsed to `~`, so a note stays one line. */
const shown = (p: string): string => (p.startsWith(homedir()) ? `~${p.slice(homedir().length)}` : p);

/** What the TUI says when no provider is set up: where to add one. */
export const NO_KEY_LINES: readonly string[] = [
  "No model provider is set up. Glyphh calls your providers directly with your own keys.",
  "Add one in the desktop app (glyphh desktop → Settings › Models),",
  "or set ANTHROPIC_API_KEY, OPENAI_API_KEY or GEMINI_API_KEY and start glyphh again.",
  `Providers and models live in ${shown(userScopedPath("providers.json"))}.`,
];
