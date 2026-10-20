/**
 * Boot.tsx — the gate in front of the App: pick a theme on first run, then the
 * chat. There is no sign-in: turns run on the user's own key (local.ts), and
 * without one the chat itself says how to set it.
 */

import React, { useCallback, useState } from "react";
import { App } from "./App.js";
import { ThemePicker } from "./ThemePicker.js";
import { readPrefs, writePrefs } from "../prefs.js";
import { applyTheme } from "../theme.js";
import type { Effort, PermissionMode } from "../types.js";

export interface BootProps {
  version: string;
  cwd: string;
  /** `--model` — the model this session runs on. */
  initialModel?: string;
  /** `--effort` — the dial for this session. */
  initialEffort?: Effort;
  /** `--permission` — the permission chip to start on. */
  initialMode?: PermissionMode;
  /** An opening prompt from the command line — sent once the chat is up. */
  initialPrompt?: string;
  /** `--resume <id>` / `--continue`: the shared-store chat to open. */
  resumeId?: string;
  continueLast?: boolean;
  /** `--trust`: the folder question is already answered (the desktop chose it). */
  trusted?: boolean;
}

type Phase = "theme" | "chat";

export function Boot({ version, cwd, ...chat }: BootProps): React.ReactElement {
  // The saved theme applies synchronously on first render, so nothing paints
  // in the wrong palette; chat and picker read the same shared `theme` object.
  const [phase, setPhase] = useState<Phase>(() => {
    const saved = readPrefs().theme;
    applyTheme(saved);
    return saved ? "chat" : "theme";
  });

  const onPickTheme = useCallback((name: string) => {
    applyTheme(name);
    writePrefs({ theme: name });
    setPhase("chat");
  }, []);

  if (phase === "theme") return <ThemePicker current={readPrefs().theme} onPick={onPickTheme} />;
  return <App version={version} cwd={cwd} {...chat} />;
}
