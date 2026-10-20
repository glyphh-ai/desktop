/**
 * cli-ids.ts — THE LOOP TABLE, pure. Which loops the app knows, their names
 * and binaries, and what each can do with no terminal. No electron, no fs:
 * the route rules (cli-route.ts), the session readers and the renderer-facing
 * lists read this without pulling in cli-agents.ts's open lane.
 *
 * A loop is either ours — `glyphh`, the SDK loop in process (glyphh-loop.ts),
 * whose terminal is the Glyphh CLI — or a vendor CLI the user installed and
 * signed in to themselves.
 */

export type CliId = "glyphh" | "claude" | "codex" | "gemini" | "copilot" | "cursor";

/** The vendor CLIs: every loop but our own. */
export type VendorCliId = Exclude<CliId, "glyphh">;

export const CLI_NAMES: Record<CliId, string> = {
  glyphh: "Glyphh", claude: "Claude", codex: "Codex", gemini: "Gemini", copilot: "Copilot", cursor: "Cursor",
};
export const CLI_BIN: Record<CliId, string> = {
  glyphh: "glyphh", claude: "claude", codex: "codex", gemini: "gemini", copilot: "copilot", cursor: "cursor-agent",
};
/** Glyphh first: it is the default loop, and lists show it first. */
export const CLI_IDS = Object.keys(CLI_NAMES) as CliId[];
export const VENDOR_CLI_IDS = CLI_IDS.filter((id): id is VendorCliId => id !== "glyphh");

export const isCliId = (v: unknown): v is CliId => typeof v === "string" && (CLI_IDS as string[]).includes(v);

/** The loop a chat runs on when it names none. */
export const DEFAULT_LOOP: CliId = "glyphh";

/** The CLIs with an UNATTENDED print mode — a prompt in, text out, nobody to
 *  answer a tool prompt: claude -p, codex exec, gemini -p. A task slot or a
 *  schedule can run these (cli-agents.ts runCliHeadless). */
export const HEADLESS_CLIS: ReadonlySet<CliId> = new Set<CliId>(["claude", "codex", "gemini"]);

/** The provider kind whose model names a CLI's own login understands — how a
 *  picked `<provider>::<model>` is read on the direct route. Copilot and
 *  Cursor sell many vendors' models under their own names, so none maps. */
export const CLI_VENDOR: Partial<Record<VendorCliId, "anthropic" | "openai" | "gemini">> = {
  claude: "anthropic", codex: "openai", gemini: "gemini",
};
