/**
 * mobile-theme.ts — ONE theme on every surface (his report, 2026-10-05: the
 * phone wore purple buttons while the web and the desktop did not).
 *
 * The wide web and the desktop read the member's theme from the SERVER
 * preference map (`theme`); the phone read only a device-local key and
 * defaulted to High Vis dark, whose accent IS purple, and its picker did not
 * even offer the Modern pair. So a member on Modern Dark saw white buttons
 * on the web and purple ones on the phone. The server preference now wins on
 * the phone too, and a pick on the phone writes it back. Pure; tested.
 */

/** The theme ids the phone can paint — the desktop's picker, same ids. */
export const PHONE_THEME_IDS: ReadonlyArray<string> = Object.freeze([
  "system", "light", "dark", "modern-dark", "modern-light", "purple", "aurora", "prism", "github", "highvis",
  "claude", "chatgpt", "gemini", "dracula", "nord", "synthwave", "matrix",
]);

/** The theme to paint: the server's when it names one the phone knows, else
 *  the device's own, else High Vis dark. */
export function themeToApply(serverTheme: unknown, local: string | null | undefined): string {
  const server = typeof serverTheme === "string" ? serverTheme.trim() : "";
  if (server && PHONE_THEME_IDS.includes(server)) return server;
  const own = (local || "").trim();
  return own && PHONE_THEME_IDS.includes(own) ? own : "dark";
}
