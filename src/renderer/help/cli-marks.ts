/**
 * cli-marks.ts — the vendor marks the CLI agents wear (rail recents, the
 * wall's CLI tiles, the dock's traded slots): ONE table.
 *
 * On the desktop main fetches these (web-icon-fetch, no CORS); on the web the
 * front door proxies them from our own origin (web/webicon.mjs), and ONLY these
 * URLs — the proxy's allowlist is a copy this table is unit-tested against
 * (web/test/webicon.test.js), so a new mark is added here and there together.
 */
export const CLI_MARK_URLS: Readonly<Record<string, string>> = Object.freeze({
  claude: "https://claude.ai/favicon.ico",
  codex: "https://openai.com/favicon.ico",
  gemini: "https://www.google.com/s2/favicons?domain=gemini.google.com&sz=64",
  copilot: "https://github.com/favicon.ico",
  cursor: "https://cursor.com/favicon.ico",
});
