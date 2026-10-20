/**
 * ThemePicker.tsx — the one-time (or `/theme`) theme chooser. Arrows move; the highlighted
 * theme applies LIVE (the whole screen recolors as you move, because `applyTheme` swaps the
 * shared palette in place), so the list is its own preview. Enter commits + persists.
 */

import React, { useEffect, useState } from "react";
import { Box, Text, useApp, useInput } from "ink";
import { theme, applyTheme, THEMES } from "../theme.js";

export function ThemePicker({
  current,
  onPick,
}: {
  current?: string | undefined;
  onPick: (name: string) => void;
}): React.ReactElement {
  const { exit } = useApp();
  const startIdx = Math.max(0, THEMES.findIndex((t) => t.name === current));
  const [idx, setIdx] = useState(startIdx === -1 ? 0 : startIdx);

  // Live preview: paint the highlighted theme as the cursor moves.
  useEffect(() => {
    applyTheme(THEMES[idx]!.name);
  }, [idx]);

  useInput((input, key) => {
    if (key.ctrl && input === "c") exit();
    if (key.upArrow || input === "k") setIdx((i) => (i - 1 + THEMES.length) % THEMES.length);
    if (key.downArrow || input === "j") setIdx((i) => (i + 1) % THEMES.length);
    if (key.return) onPick(THEMES[idx]!.name);
  });

  return (
    <Box flexDirection="column" alignItems="center" justifyContent="center" flexGrow={1} paddingY={2}>
      <Text color={theme.accent} bold>
        Choose your theme
      </Text>
      <Text color={theme.faint}>arrows move · enter selects · you can change it later with /theme</Text>
      <Box
        flexDirection="column"
        marginTop={1}
        borderStyle="round"
        borderColor={theme.accent}
        paddingX={2}
        paddingY={1}
      >
        {THEMES.map((t, i) => {
          const on = i === idx;
          return (
            <Box key={t.name}>
              <Text color={on ? theme.accent : theme.faint} bold={on}>
                {on ? "▸ " : "  "}
              </Text>
              <Text color={on ? theme.text : theme.muted} bold={on}>
                {t.label.padEnd(10)}
              </Text>
              <Text color={theme.accent}>● </Text>
              <Text color={theme.faint}>{t.description}</Text>
            </Box>
          );
        })}
      </Box>
      <Box marginTop={1}>
        <Text color={theme.muted}>The quick brown fox — </Text>
        <Text color={theme.accent} bold>
          accent
        </Text>
        <Text color={theme.muted}> · </Text>
        <Text color={theme.text}>text</Text>
        <Text color={theme.faint}> · faint</Text>
      </Box>
    </Box>
  );
}
