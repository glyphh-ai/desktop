/**
 * doc-styles.ts — Glyphh Docs styling: named doc THEMES + org design-system
 * binding, stored in-band as a leading `:::glyphh <css-vars>` directive so a
 * document carries its own look (no schema change). The tool (main) resolves a
 * theme/design to `--doc-*` vars and writes the directive; the panel just reads
 * the vars and applies them to the paper. Parallel to the Slides theme engine —
 * so a deck and a document authored for the same org share one identity.
 */

export interface DocTheme { name: string; label: string; vars: Record<string, string> }

const SERIF = "Georgia, 'Iowan Old Style', 'Times New Roman', serif";
const SANS = "Inter, -apple-system, system-ui, 'Segoe UI', Roboto, sans-serif";
const MONO = "'SF Mono', 'JetBrains Mono', Menlo, Consolas, monospace";

function t(name: string, label: string, v: Partial<DocTheme["vars"]>): DocTheme {
  return { name, label, vars: v as DocTheme["vars"] };
}

/** Built-in doc themes (the `--doc-*` vars the panel applies to the paper). */
export const DOC_THEMES: Record<string, DocTheme> = {
  classic: t("classic", "Classic — serif body, clean sans headings (the default)", { "font-body": SERIF, "font-head": SANS, accent: "#8c3bf2", maxw: "760px" }),
  editorial: t("editorial", "Editorial — all-serif, warm and literary", { "font-body": SERIF, "font-head": SERIF, accent: "#b3541e", maxw: "720px" }),
  modern: t("modern", "Modern — all-sans, tight and product-like", { "font-body": SANS, "font-head": SANS, accent: "#2563eb", maxw: "780px" }),
  technical: t("technical", "Technical — sans body, monospaced headings", { "font-body": SANS, "font-head": MONO, accent: "#2dd4bf", maxw: "820px" }),
  contract: t("contract", "Contract — dense serif for legal/formal documents", { "font-body": "'Times New Roman', Georgia, serif", "font-head": "'Times New Roman', serif", accent: "#334155", maxw: "740px" }),
};

export const DEFAULT_DOC_THEME = "classic";

/** A theme's `--doc-*` vars as a css declaration string (no braces). */
export function docThemeCss(name?: string | null): string {
  const theme = DOC_THEMES[String(name ?? "").toLowerCase()] ?? DOC_THEMES[DEFAULT_DOC_THEME]!;
  return Object.entries(theme.vars).map(([k, v]) => `--doc-${k}:${v}`).join(";");
}

/** Derive `--doc-*` vars from an org design system's compiled CSS (the string
 *  from client.designs.css) — the design-system spine for docs. */
export function docStyleFromDesign(designCss: string): string {
  const pick = (...names: string[]): string | undefined => {
    for (const n of names) {
      const m = designCss.match(new RegExp(`--${n}\\s*:\\s*([^;}]+)`, "i"));
      if (m && m[1]) return m[1].trim();
    }
    return undefined;
  };
  const out: string[] = [];
  const map: Array<[string, string[]]> = [
    ["fg", ["design-text", "design-ink", "design-foreground"]],
    ["bg", ["design-surface", "design-background", "design-bg"]],
    ["accent", ["design-primary", "design-accent", "design-brand"]],
    ["muted", ["design-muted", "design-subtle"]],
    ["font-body", ["design-font-body", "design-font-text", "design-font"]],
    ["font-head", ["design-font-display", "design-font-heading"]],
  ];
  for (const [key, names] of map) { const v = pick(...names); if (v) out.push(`--doc-${key}:${v}`); }
  return out.join(";");
}

const DIRECTIVE = /^:::glyphh[ \t]+([^\n]*)\n?/;

/** Read the leading style directive's `--doc-*` vars (empty string if none). */
export function parseDocStyle(md: string): string {
  return DIRECTIVE.exec(md)?.[1]?.trim() ?? "";
}

/** Upsert the leading `:::glyphh <vars>` directive (empty vars removes it). */
export function writeDocStyle(md: string, vars: string): string {
  const body = md.replace(DIRECTIVE, "");
  return vars ? `:::glyphh ${vars}\n${body.startsWith("\n") ? "" : "\n"}${body}` : body;
}
