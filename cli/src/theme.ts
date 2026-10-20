/**
 * theme.ts — the TUI palette registry. Each named theme mirrors a product theme (the
 * desktop's `data-theme` sets) reduced to the four roles a terminal actually paints:
 *   text   — primary content (the answer, the mascot, what you typed)
 *   muted  — secondary content (labels, receipts, the signed-in line)
 *   faint  — chrome (borders, box edges, hints)
 *   accent — the ONE brand color (focus, the wordmark, the active loop, the ● bullet)
 *
 * `theme` is a LIVE object: components read `theme.text` etc. at render, and
 * `applyTheme` swaps the four values IN PLACE so a pick re-colors the whole tree on the
 * next render without threading a context through every component.
 *
 * Colors are hex; Ink downsamples to the nearest 256 index on a 256-color terminal
 * (Terminal.app), and paints them exactly on a truecolor one (iTerm2, modern shells).
 */

export interface Palette {
  text: string;
  muted: string;
  faint: string;
  accent: string;
}

export interface ThemeDef {
  name: string;
  label: string;
  description: string;
  colors: Palette;
}

/** The available themes. `dark` is the default — brightened text so the screen reads
 *  crisp rather than drab. Values mirror the desktop `data-theme` palettes. */
export const THEMES: readonly ThemeDef[] = [
  {
    name: "dark",
    label: "Dark",
    description: "Bright text on ink — the default",
    colors: { text: "#ffffff", muted: "#c6c6c6", faint: "#6c6c6c", accent: "#af5fff" },
  },
  {
    name: "light",
    label: "Light",
    description: "Dark text for light terminals",
    colors: { text: "#1c1c1c", muted: "#4b5563", faint: "#9aa0a6", accent: "#7c3aed" },
  },
  {
    name: "highvis",
    label: "High Vis",
    description: "Maximum contrast — white on black, electric yellow",
    colors: { text: "#ffffff", muted: "#eaeaea", faint: "#b0b0b0", accent: "#ffd600" },
  },
  {
    name: "claude",
    label: "Claude",
    description: "Warm cream + Claude coral",
    colors: { text: "#f5f0e8", muted: "#c9bfb0", faint: "#8a8175", accent: "#d97757" },
  },
  {
    name: "aurora",
    label: "Aurora",
    description: "Deep violet with a lilac accent",
    colors: { text: "#f1ecf8", muted: "#c4b6da", faint: "#6e6188", accent: "#ad5df8" },
  },
];

export const DEFAULT_THEME = "dark";

/** The resolved theme for a saved name, falling back to the default. */
export function themeByName(name?: string): ThemeDef {
  return THEMES.find((t) => t.name === name) ?? THEMES[0]!;
}

/** The live palette every component reads. Initialized to the default; mutated in place
 *  by {@link applyTheme}. Never reassigned — the object identity is what keeps every
 *  `import { theme }` reference pointing at the current colors. */
export const theme: Palette = { ...THEMES[0]!.colors };

/** Swap the active palette in place and return the theme that won. */
export function applyTheme(name?: string): ThemeDef {
  const def = themeByName(name);
  Object.assign(theme, def.colors);
  return def;
}

export type ThemeColor = string;
