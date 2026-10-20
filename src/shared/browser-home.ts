/**
 * The Browser panel's start page.
 *
 * One map and one resolver, shared by the main process (open_app "browser")
 * and the renderer's Browser panel — a new panel, a new tab and an agent-driven
 * open all have to land on the same configured page, and they only do that if
 * they read the preference through the same function.
 *
 * Deliberately free of electron imports: the renderer bundles this too.
 */

export const BROWSER_HOMES: Record<string, string> = {
  claude: "https://claude.ai",
  chatgpt: "https://chatgpt.com",
  gemini: "https://gemini.google.com",
};

export const DEFAULT_BROWSER_HOME = BROWSER_HOMES.claude;

/**
 * The stored preference pair as a loadable URL. "custom" with an empty (or
 * whitespace) URL falls back to the default — the panel must never open blank
 * because a setting was half-filled.
 */
export function resolveBrowserHome(pref: string | null | undefined, customUrl: string | null | undefined): string {
  if (pref === "custom") return (customUrl || "").trim() || DEFAULT_BROWSER_HOME;
  return BROWSER_HOMES[pref || ""] || DEFAULT_BROWSER_HOME;
}
