/**
 * Footer.tsx — the bottom line: the permission chip far left (the words every
 * agent CLI uses), the model the next turn runs on and its effort far right.
 */

import React from "react";
import { Box, Text } from "ink";
import { theme } from "../theme.js";
import type { PermissionMode } from "../types.js";

/** One resolved model slot: its label and the model that will fill it (null = unset). */
export interface FooterSlot {
  label: string;
  model: string | null;
}

export interface FooterProps {
  width: number;
  permissionMode: PermissionMode;
  /** The loop's name. */
  loop: string;
  /** The model slots (empty while loading/offline). */
  slots: FooterSlot[];
  /** The effort dial's label ("Medium"), shown beside the model. */
  effort?: string;
}

/** The chip, worded like the other CLIs' status lines. */
export const MODE_GLYPH: Record<PermissionMode, string> = {
  default: "◈ default",
  acceptEdits: "✎ accept edits on",
  plan: "⏸ plan mode on",
  bypass: "⏵⏵ bypass permissions on",
};

/** One slot chip. A single-slot loop shows just its model; a multi-slot loop prefixes each with its label. */
function Slot({ slot, solo }: { slot: FooterSlot; solo: boolean }): React.ReactElement {
  const set = slot.model !== null;
  return (
    <Text>
      {solo ? null : <Text color={theme.muted}>{slot.label} </Text>}
      <Text color={set ? theme.accent : theme.faint}>{slot.model ?? "resolving…"}</Text>
    </Text>
  );
}

export function Footer({ width, permissionMode, loop, slots, effort }: FooterProps): React.ReactElement {
  const solo = slots.length === 1;
  const mode = MODE_GLYPH[permissionMode];
  // The model and loop on the right never clip: the chip's hint gives way
  // first, and the chip itself truncates before anything else does.
  return (
    <Box width={width} paddingX={1} justifyContent="space-between" gap={2}>
      <Box flexShrink={1} minWidth={0}>
        <Text wrap="truncate-end">
          <Text color={permissionMode === "bypass" ? "red" : theme.muted}>{mode}</Text>
          {width >= 110 ? <Text color={theme.faint}>{"  shift+tab cycles"}</Text> : null}
        </Text>
      </Box>
      <Box flexShrink={0}>
        {slots.length === 0 ? (
          <Text color={theme.faint}>no model</Text>
        ) : (
          slots.map((s, i) => (
            <React.Fragment key={s.label}>
              {i > 0 ? <Text color={theme.faint}> · </Text> : null}
              <Slot slot={s} solo={solo} />
            </React.Fragment>
          ))
        )}
        {effort ? (
          <Text>
            <Text color={theme.faint}> · </Text>
            <Text color={theme.muted}>effort </Text>
            <Text color={theme.accent}>{effort}</Text>
          </Text>
        ) : null}
        <Text color={theme.faint}>{"   ·   "}</Text>
        <Text color={theme.muted}>loop </Text>
        <Text color={theme.accent}>{loop}</Text>
      </Box>
    </Box>
  );
}
