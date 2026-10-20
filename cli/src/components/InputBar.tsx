/**
 * InputBar.tsx — the composer, one line between two rules, the way the other
 * CLIs draw it: the prompt glyph, the text with a REAL cursor (the text before
 * it, an inverted cell at it, the text after), and a faint hint at the right
 * while the line is empty. While a turn runs it names the key that stops it.
 */

import React from "react";
import { Box, Text } from "ink";
import { theme } from "../theme.js";

export interface InputBarProps {
  width: number;
  value: string;
  /** Cursor index into `value` (code points). Defaults to the end. */
  cursor?: number;
  busy: boolean;
  /** A one-line hint shown in place of the placeholder (e.g. "press ctrl+c again to quit"). */
  hint?: string;
}

export function InputBar({ width, value, cursor, busy, hint }: InputBarProps): React.ReactElement {
  const chars = [...value];
  const hasText = chars.length > 0;
  const at = Math.max(0, Math.min(cursor ?? chars.length, chars.length));
  const before = chars.slice(0, at).join("");
  const under = chars[at] ?? " ";
  const after = chars.slice(at + 1).join("");
  return (
    <Box
      width={width}
      borderStyle="single"
      borderColor={busy ? "red" : hasText ? theme.accent : theme.faint}
      borderLeft={false}
      borderRight={false}
      paddingX={1}
      justifyContent="space-between"
    >
      <Box>
        <Text color={busy ? "red" : theme.accent}>{"❯ "}</Text>
        {busy ? (
          <Text color={theme.faint}>{hint ?? "working… esc to stop"}</Text>
        ) : hasText ? (
          <Text>
            <Text color={theme.text}>{before}</Text>
            <Text inverse color={theme.text}>{under}</Text>
            <Text color={theme.text}>{after}</Text>
          </Text>
        ) : (
          <Text>
            <Text inverse color={theme.text}>{" "}</Text>
            <Text color={theme.faint}>{hint ?? "type a message, or / for commands"}</Text>
          </Text>
        )}
      </Box>
      {!busy && !hasText ? <Text color={theme.faint}>{"? for shortcuts"}</Text> : null}
    </Box>
  );
}
