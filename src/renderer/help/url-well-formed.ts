/**
 * url-well-formed — the ONE test a tab's web address must pass before it is
 * saved (his report, 2026-10-07: a tab saved with a half-typed address could
 * never load). Pure, so it is unit-tested; apps.ts uses it on the add form and
 * the detail form.
 *
 *   "mail.google.com"     → "https://mail.google.com/"   (scheme completed)
 *   "localhost:3000"      → "http://localhost:3000/"     (a dev server is plain http)
 *   "https://x.y/p?q=1"   → kept as typed
 *   "ftp://x.y", "not a url", "" → null
 */
export function wellFormedUrl(raw: string): string | null {
  const trimmed = (raw || "").trim();
  if (!trimmed) return null;
  const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed);
  const bareLocal = !hasScheme && /^localhost(?=[:/?#]|$)/i.test(trimmed);
  const candidate = hasScheme ? trimmed : `${bareLocal ? "http" : "https"}://${trimmed}`;
  let url: URL;
  try { url = new URL(candidate); } catch { return null; }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  const host = url.hostname.toLowerCase();
  if (!host) return null;
  const ipv4 = /^\d{1,3}(\.\d{1,3}){3}$/.test(host);
  if (!(host === "localhost" || ipv4 || host.includes("."))) return null;
  return url.href;
}
