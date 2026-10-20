/**
 * SubFooter.tsx — the status line above the composer: the spinner and the
 * running verb while a turn works (with the model's thinking as one dim line
 * beneath, until the answer starts), else the settle line (verb, duration, tokens).
 */

import React from "react";
import { Box, Text } from "ink";
import { theme } from "../theme.js";
import type { ChatTurn } from "../types.js";

export interface SubFooterProps {
  width: number;
  busy: boolean;
  /** Live elapsed seconds for the running turn. */
  elapsed: number;
  /** The newest assistant turn (running or settled), if any. */
  last?: ChatTurn | undefined;
  /** This turn's working verb pair (✽ Verbing… / ✻ Verbed for Ns). */
  verb: { ing: string; past: string };
  /** The model's thinking so far (a preview); absent = none, or the answer began. */
  thinking?: string;
}

/** A thought as one line: whitespace folded, clipped to the width. */
export function thinkingLine(text: string, width: number): string {
  const head = "Thinking… ";
  const room = Math.max(0, width - 2 - head.length);
  const flat = text.replace(/\s+/g, " ").trim();
  const chars = [...flat];
  const body = chars.length <= room ? flat : `${chars.slice(0, Math.max(0, room - 1)).join("")}…`;
  return `${head}${body}`;
}

/** The spinner's frames — stepped by the turn clock (4 fps), not a timer of
 *  its own: every frame is a full Ink redraw, so a fast spinner is a flicker. */
const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export function SubFooter({ width, busy, elapsed, last, verb, thinking }: SubFooterProps): React.ReactElement {
  if (busy && last) {
    const burn = last.tokensUp + last.tokensDown > 0 ? ` · ${last.tokensUp}↑ ${last.tokensDown}↓ tok` : "";
    const frame = FRAMES[Math.floor(elapsed * 4) % FRAMES.length]!;
    return (
      <Box width={width} paddingX={1} flexDirection="column">
        <Text>
          <Text color={theme.accent}>{frame}</Text>
          <Text color={theme.muted}> {verb.ing}… </Text>
          <Text color={theme.faint}>
            ({elapsed.toFixed(1)}s{burn} · esc to stop)
          </Text>
        </Text>
        {thinking ? <Text color={theme.faint} dimColor wrap="truncate-end">{thinkingLine(thinking, width)}</Text> : null}
      </Box>
    );
  }
  if (last && last.status !== "running") {
    const cost: string[] = [];
    if (last.durationMs !== undefined) cost.push(`${verb.past} for ${(last.durationMs / 1000).toFixed(1)}s`);
    if (last.tokensUp + last.tokensDown > 0) cost.push(`${last.tokensUp}↑ ${last.tokensDown}↓ tok`);
    if (last.status === "error") cost.push("failed");
    if (last.status === "stopped") cost.push("stopped");
    return (
      <Box width={width} paddingX={1} flexDirection="column">
        <Text color={theme.faint} wrap="truncate-end">
          ✻ {cost.join(" · ")}
        </Text>
      </Box>
    );
  }
  return <Box width={width} paddingX={1} />;
}
