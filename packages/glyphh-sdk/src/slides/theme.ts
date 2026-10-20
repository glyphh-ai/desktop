/**
 * slides/theme.ts — the deck THEME registry.
 *
 * A theme is a flat set of `--slide-*` CSS custom properties. The engine emits
 * them on `:root` (part of the deck shell, not agent content, so the structure
 * lock never touches them) and every layout renders against `var(--slide-*)`.
 * "midnight" reproduces the pre-theme palette exactly, so decks that don't pick
 * a theme render byte-for-byte as before.
 *
 * Fonts are SYSTEM stacks only — a deck is self-contained (no network fonts).
 */

export interface SlideTheme {
  /** Stable key used by tools + `create_slides(theme)`. */
  name: string;
  /** One-line human label for pickers. */
  label: string;
  mode: "dark" | "light";
  /** `--slide-*` custom properties (without the `--slide-` prefix). */
  vars: Record<string, string>;
  /** A few representative hexes for a swatch preview. */
  swatches: string[];
}

const SANS = 'Inter, -apple-system, system-ui, "Segoe UI", Roboto, Helvetica, Arial, sans-serif';
const SERIF = 'Georgia, "Iowan Old Style", "Times New Roman", serif';
const MONO = '"SF Mono", "JetBrains Mono", "Roboto Mono", Menlo, Consolas, monospace';

/** Every theme fills the same key set; only colours + display font vary. */
function theme(
  name: string,
  label: string,
  mode: "dark" | "light",
  c: {
    bg: string; fg: string; muted: string; accent: string; accent2: string;
    surface: string; border: string; display?: string;
  },
): SlideTheme {
  return {
    name,
    label,
    mode,
    swatches: [c.bg, c.accent, c.accent2, c.fg],
    vars: {
      bg: c.bg,
      fg: c.fg,
      muted: c.muted,
      accent: c.accent,
      accent2: c.accent2,
      surface: c.surface,
      border: c.border,
      "font-display": c.display ?? SANS,
      "font-body": SANS,
      "font-mono": MONO,
      pad: "110px",
      gap: "40px",
      radius: "22px",
    },
  };
}

export const SLIDE_THEMES: Record<string, SlideTheme> = {
  midnight: theme("midnight", "Midnight — the Glyphh default: near-black with electric purple", "dark", {
    bg: "#0d0d0f", fg: "#f1f1f1", muted: "#8e8e9c", accent: "#8c3bf2", accent2: "#c9a2ff",
    surface: "#17171b", border: "#2a2a31",
  }),
  paper: theme("paper", "Paper — clean light deck, purple accent", "light", {
    bg: "#ffffff", fg: "#16161a", muted: "#6b6b76", accent: "#8c3bf2", accent2: "#b98bff",
    surface: "#f5f5f7", border: "#e4e4ea",
  }),
  mono: theme("mono", "Mono — monochrome, high-contrast, no colour", "dark", {
    bg: "#0a0a0a", fg: "#fafafa", muted: "#9a9a9a", accent: "#fafafa", accent2: "#c4c4c4",
    surface: "#161616", border: "#2c2c2c",
  }),
  editorial: theme("editorial", "Editorial — warm dark, serif display, amber accent", "dark", {
    bg: "#12100e", fg: "#f3ede2", muted: "#b3a793", accent: "#d98a3d", accent2: "#f0c07a",
    surface: "#1c1915", border: "#332d25", display: SERIF,
  }),
  neon: theme("neon", "Neon — deep space with cyan/violet glow", "dark", {
    bg: "#07070d", fg: "#eaf6ff", muted: "#7d8ba8", accent: "#12f7d6", accent2: "#7c5cff",
    surface: "#0e0e1a", border: "#20223a",
  }),
  corporate: theme("corporate", "Corporate — crisp light, confident blue", "light", {
    bg: "#ffffff", fg: "#0f1b2d", muted: "#5a6b82", accent: "#2563eb", accent2: "#60a5fa",
    surface: "#f1f5fb", border: "#dbe4f0",
  }),
  warm: theme("warm", "Warm — cream paper, burnt-orange accent", "light", {
    bg: "#fbf5ec", fg: "#2a2018", muted: "#8a7a66", accent: "#e0562d", accent2: "#f2a65a",
    surface: "#f4ead8", border: "#e7d8c2",
  }),
  ocean: theme("ocean", "Ocean — teal-on-deep-navy, calm and technical", "dark", {
    bg: "#06141b", fg: "#e6f2f4", muted: "#7fa5ac", accent: "#2dd4bf", accent2: "#38bdf8",
    surface: "#0c1f28", border: "#163540",
  }),
};

export const DEFAULT_THEME = "midnight";

/** Resolve a theme by name (case-insensitive), falling back to the default. */
export function resolveTheme(name?: string | null): SlideTheme {
  const key = String(name ?? "").trim().toLowerCase();
  return SLIDE_THEMES[key] ?? SLIDE_THEMES[DEFAULT_THEME]!;
}

/** Emit a theme's `:root { … }` declaration body (no braces). */
export function themeVars(t: SlideTheme): string {
  return Object.entries(t.vars).map(([k, v]) => `--slide-${k}: ${v};`).join(" ");
}

/**
 * Derive a theme from an org design system's compiled CSS (the string returned
 * by `client.designs.css(file)`), overlaying its `--design-*` tokens onto a base
 * theme. This is the design-system spine: a deck picks up brand colours + fonts
 * with one `design` argument, and matches the org's docs by construction.
 *
 * We read the tokens leniently (the design contract may name them a few ways)
 * and only override what we find — anything absent keeps the base theme's value.
 */
export function themeFromDesign(designCss: string, base: SlideTheme = SLIDE_THEMES[DEFAULT_THEME]!): SlideTheme {
  const pick = (...names: string[]): string | undefined => {
    for (const n of names) {
      const m = designCss.match(new RegExp(`--${n}\\s*:\\s*([^;}]+)`, "i"));
      if (m && m[1]) return m[1].trim();
    }
    return undefined;
  };
  const vars = { ...base.vars };
  const map: Array<[string, string[]]> = [
    ["bg", ["design-background", "design-bg", "background", "color-bg"]],
    ["fg", ["design-text", "design-foreground", "design-ink", "text", "color-text"]],
    ["muted", ["design-muted", "design-subtle", "design-text-muted", "muted"]],
    ["accent", ["design-primary", "design-accent", "design-brand", "accent", "primary"]],
    ["accent2", ["design-secondary", "design-accent-2", "secondary"]],
    ["surface", ["design-surface", "design-card", "design-panel", "surface"]],
    ["border", ["design-border", "design-line", "border"]],
    ["font-display", ["design-font-display", "design-font-heading", "font-display", "font-heading"]],
    ["font-body", ["design-font-body", "design-font-text", "design-font", "font-body"]],
    ["font-mono", ["design-font-mono", "design-font-code", "font-mono"]],
  ];
  let touched = false;
  for (const [key, names] of map) {
    const found = pick(...names);
    if (found) { vars[key] = found; touched = true; }
  }
  if (!touched) return base;
  return { ...base, name: "design", label: "From the org design system", vars };
}
