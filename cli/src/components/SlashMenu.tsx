/**
 * SlashMenu.tsx — the command palette that opens above the composer when a
 * line starts with "/" (the same affordance every agent CLI has): matching
 * commands with their summaries, one highlighted; ↑/↓ move, tab completes,
 * enter runs, esc closes.
 */

import React from "react";
import { Box, Text } from "ink";
import { theme } from "../theme.js";
import type { SlashCommand } from "../commands.js";

export interface SlashMenuProps {
  width: number;
  items: SlashCommand[];
  selected: number;
}

/** How many rows the menu shows at once. */
export const SLASH_MENU_ROWS = 7;

export function SlashMenu({ width, items, selected }: SlashMenuProps): React.ReactElement | null {
  if (!items.length) return null;
  // Keep the selection in view.
  const start = Math.max(0, Math.min(selected - (SLASH_MENU_ROWS - 1), items.length - SLASH_MENU_ROWS));
  const rows = items.slice(start, start + SLASH_MENU_ROWS);
  const nameW = Math.max(...items.map((c) => (c.usage ?? `/${c.name}`).length)) + 2;
  return (
    <Box width={width} paddingX={2} flexDirection="column">
      {rows.map((c, i) => {
        const on = start + i === selected;
        const label = (c.usage ?? `/${c.name}`).padEnd(nameW);
        return (
          <Text key={c.name} wrap="truncate-end">
            <Text color={on ? theme.accent : theme.faint}>{on ? "▸ " : "  "}</Text>
            <Text color={on ? theme.accent : theme.text} bold={on}>{label}</Text>
            <Text color={theme.muted}>{c.summary}</Text>
          </Text>
        );
      })}
      {items.length > rows.length ? <Text color={theme.faint}>{`    … ${items.length - rows.length} more · keep typing to narrow`}</Text> : null}
    </Box>
  );
}
