/**
 * Picker.tsx — the selector panel every agent CLI has (his order, 2026-09-21:
 * "/model lists the models, the user uses arrow keys or enters a number"):
 * a title, one line of description, numbered options with a detail column,
 * the current one ticked, a cursor, and the keys at the foot. ↑/↓ move, a
 * digit jumps, enter picks, an optional second key picks "this session only",
 * esc cancels. It sits in the strip above the composer, like the approval.
 */

import React from "react";
import { Box, Text } from "ink";
import { theme } from "../theme.js";

export interface PickerOption {
  id: string;
  label: string;
  detail?: string;
  /** Marked ✔ — the value in force now. */
  current?: boolean;
}

export interface PickerSpec {
  title: string;
  description?: string;
  options: PickerOption[];
  /** A second way to pick (e.g. `s` = this session only). */
  secondary?: { key: string; label: string };
  /** What enter does, for the foot line. */
  enterLabel?: string;
  onPick: (id: string, secondary: boolean) => void;
  onCancel?: () => void;
}

export interface PickerProps {
  width: number;
  spec: PickerSpec;
  selected: number;
}

/** Rows shown at once; the window follows the cursor. */
export const PICKER_ROWS = 10;

export function Picker({ width, spec, selected }: PickerProps): React.ReactElement {
  const start = Math.max(0, Math.min(selected - (PICKER_ROWS - 1), spec.options.length - PICKER_ROWS));
  const rows = spec.options.slice(start, start + PICKER_ROWS);
  const labelW = Math.min(36, Math.max(...spec.options.map((o) => o.label.length + (o.current ? 2 : 0))) + 2);
  return (
    <Box width={width} flexDirection="column" borderStyle="single" borderColor={theme.accent} borderBottom={false} borderLeft={false} borderRight={false} paddingX={1}>
      <Text color={theme.accent} bold>{spec.title}</Text>
      {spec.description ? <Text color={theme.muted} wrap="truncate-end">{spec.description}</Text> : null}
      <Text> </Text>
      {rows.map((o, i) => {
        const idx = start + i;
        const on = idx === selected;
        const label = `${o.label}${o.current ? " ✔" : ""}`.padEnd(labelW);
        return (
          <Text key={o.id || `opt-${idx}`} wrap="truncate-end">
            <Text color={on ? theme.accent : theme.faint}>{on ? " ❯ " : "   "}</Text>
            <Text color={theme.muted}>{`${String(idx + 1).padStart(2)}. `}</Text>
            <Text color={on ? theme.accent : theme.text} bold={on}>{label}</Text>
            {o.detail ? <Text color={theme.muted}>{o.detail}</Text> : null}
          </Text>
        );
      })}
      {spec.options.length > rows.length ? <Text color={theme.faint}>{`      … ${spec.options.length - rows.length} more · ↑/↓ or type a number`}</Text> : null}
      <Text> </Text>
      <Text color={theme.faint}>
        {`Enter to ${spec.enterLabel ?? "select"}${spec.secondary ? ` · ${spec.secondary.key} to ${spec.secondary.label}` : ""} · Esc to cancel`}
      </Text>
    </Box>
  );
}
