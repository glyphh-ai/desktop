/**
 * web.fetch / web.read — the sanctioned road to web content.
 *
 * Workers stay network-free BY DESIGN; these capabilities run HERE in the
 * host, declared in the manifest like any other capability (visible at
 * install). Guardrails: http(s) only, public hosts only (SSRF-guarded,
 * every redirect hop re-validated), 12s timeout, 1.5MB cap. web.read adds
 * a readability pass — tags stripped to clean text — sized for llm.complete
 * summarization. Electron-free so the guards are unit-testable.
 */

const MAX_BYTES = 1_500_000;
const MAX_REDIRECTS = 3;
const TIMEOUT_MS = 12_000;
const READ_CAP = 40_000;

function assertPublicHttpUrl(raw: unknown): URL {
  let u: URL;
  try { u = new URL(String(raw || "")); } catch { throw new Error("web.fetch needs a valid absolute http(s) url"); }
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error("web.fetch supports only http/https");
  const h = u.hostname.toLowerCase();
  if (
    h === "localhost" || h.endsWith(".local") || h === "[::1]" || h === "::1" ||
    /^127\./.test(h) || /^10\./.test(h) || /^192\.168\./.test(h) ||
    /^169\.254\./.test(h) || /^0\./.test(h) || /^172\.(1[6-9]|2\d|3[01])\./.test(h)
  ) {
    throw new Error("web.fetch refuses local/private addresses");
  }
  return u;
}

async function fetchCapped(rawUrl: unknown): Promise<{ status: number; contentType: string; text: string; url: string }> {
  let url = assertPublicHttpUrl(rawUrl);
  let res: Response | null = null;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    res = await fetch(url, {
      redirect: "manual",
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { "User-Agent": "Glyphh/1.0 (+https://glyphh.ai)", Accept: "text/html,application/xhtml+xml,application/json,application/rss+xml,text/plain,*/*" },
    });
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get("location");
      if (!loc || hop === MAX_REDIRECTS) throw new Error(`too many redirects (${url.hostname})`);
      url = assertPublicHttpUrl(new URL(loc, url).toString()); // every hop re-validated
      continue;
    }
    break;
  }
  if (!res) throw new Error("fetch failed");
  const reader = res.body?.getReader();
  let text = "";
  if (reader) {
    const dec = new TextDecoder();
    let received = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.length;
      text += dec.decode(value, { stream: true });
      if (received >= MAX_BYTES) { void reader.cancel(); text += "\n…(truncated at 1.5MB)"; break; }
    }
  }
  return { status: res.status, contentType: res.headers.get("content-type") || "", text, url: url.toString() };
}

/** Raw-ish fetch — status, content type, body (capped). */
export async function webFetch(args: Record<string, unknown>): Promise<{ status: number; contentType: string; body: string; url: string }> {
  const r = await fetchCapped(args.url);
  return { status: r.status, contentType: r.contentType, body: r.text, url: r.url };
}

/** Readability pass: strip markup to clean text (title + body), sized for
 *  summarization. The 90% case for news/pages/RSS. */
export async function webRead(args: Record<string, unknown>): Promise<{ status: number; title: string; text: string; url: string }> {
  const r = await fetchCapped(args.url);
  const title = (r.text.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || "").replace(/\s+/g, " ").trim();
  const text = r.text
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<(?:nav|footer|header|aside|form|noscript|svg|iframe)[\s\S]*?<\/(?:nav|footer|header|aside|form|noscript|svg|iframe)>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<br\s*\/?>|<\/p>|<\/div>|<\/li>|<\/h[1-6]>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"')
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n\s*/g, "\n")
    .trim();
  return {
    status: r.status,
    title,
    text: text.length > READ_CAP ? `${text.slice(0, READ_CAP)}\n…(truncated)` : text,
    url: r.url,
  };
}
