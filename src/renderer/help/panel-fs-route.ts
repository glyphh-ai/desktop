/**
 * panel-fs-route.ts — WHERE the Files / Diff / Editor panels (and the git
 * chip) read and write, as one pure rule (his report, 2026-10-04: "the
 * workpanels like files, diff etc. are not adjusting to the cloud directories").
 *
 * The SESSION's locus decides, never the surface: a CLOUD session's panels
 * read its worker workspace over the harness fs — on the desktop through
 * main's cloud lane (main/cloud-fs.ts, IPC cloud-fs-* / cloud-git-*), on
 * app.glyphh.ai through the SDK's harness client (web/src/wb-pod.js). A LOCAL
 * session's panels read the machine's disk: the desktop's own (window.wb →
 * files:*), or on the web the attached desktop over the relay (wb-relay.js).
 *
 * The scope a cloud route carries is the workspace key the pod serves — the
 * same id the run threads on (remote-run.ts runThreadId / terminal-target.ts
 * cloudScope): a re-entered space's id, else the thread's.
 *
 * Data in, data out: code-workbench.ts (desktop router, help/wb-cloud.ts),
 * code.ts (the git chip) and the web's selector hand the live session in, and
 * the unit tests run it bare.
 */

import { cloudScope, isCloudSource, type TerminalSourceLike } from "./terminal-target.js";

export type PanelSurface = "desktop" | "web";

/** The three far sides a panel can read: this machine, the session's cloud
 *  workspace, or (web only) the attached desktop over the relay. */
export type PanelFsRouteKind = "local" | "cloud" | "relay-desktop";

export type PanelFsRoute =
  | { route: "local" }
  | { route: "relay-desktop" }
  | { route: "cloud"; scope: string };

export interface PanelFsRouteInput {
  surface: PanelSurface;
  /** The current session's source (code.ts activeSource()); absent = none known. */
  source?: TerminalSourceLike | null;
  /** The current session's id — a born cloud thread's workspace key. */
  chatId?: string | null;
}

export function panelFsRoute(input: PanelFsRouteInput): PanelFsRoute {
  const { surface, source, chatId } = input;
  if (isCloudSource(source)) return { route: "cloud", scope: cloudScope(source, chatId) };
  // No cloud source: the machine. On the desktop that is this process; on the
  // web it is the attached desktop (the selector's "everything else → relay").
  return surface === "desktop" ? { route: "local" } : { route: "relay-desktop" };
}

/** The verbs the pod's fs surface does not serve (rrotor harness/fs-routes.ts,
 *  2026-10-04). A cloud session's panel says so in one line — never local data. */
export const CLOUD_FS_UNSERVED = ["mkdir", "delete", "rename", "stat", "git status", "git log"] as const;

export const CLOUD_FS_NOT_YET = "Not available for cloud sessions yet.";
export const CLOUD_FS_NO_MKDIR = "Not available for cloud sessions yet — create a file instead (folders appear with their first file).";
