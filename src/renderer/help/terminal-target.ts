/**
 * terminal-target.ts — WHERE a Terminal tile's shell runs, as one pure rule
 * (his report, 2026-10-04: "What happened to my terminals in the cloud?").
 *
 * A session's locus decides. A CLOUD session's shell is the pod's pty over
 * the harness lane (remote-terminal.ts target "worker"), in the thread's
 * workspace — on the desktop AND on app.glyphh.ai. A LOCAL session's shell
 * runs on the user's machine: the desktop spawns it itself (node-pty over
 * wb-term IPC); the web reaches it over the relay (target "desktop"). A slot
 * may pin its far side (a CLI session resumed off the machine's own stores
 * runs THERE, whatever the current session's locus): "desktop" means the
 * user's machine — the local pty on the desktop surface, the relay on the web.
 *
 * The decision is data in, data out, so both surfaces and the tests share it;
 * code-workbench.ts reads the live session and hands it in.
 */

export type TerminalSurface = "desktop" | "web";
export type TerminalFarSide = "worker" | "desktop";

/** What code-workbench knows about the current session's source. */
export interface TerminalSourceLike {
  kind: string;
  /** cloud-space: the thread id that keyed the pod workspace. */
  space?: string;
  /** A folder INSIDE the cloud workspace (relative), when one was picked. */
  dir?: string;
}

export interface TerminalTransportInput {
  surface: TerminalSurface;
  /** The current session's source (code.ts activeSource()); absent = none known. */
  source?: TerminalSourceLike | null;
  /** The current session's id — the worker shell's fs scope for a born cloud thread. */
  chatId?: string | null;
  /** The slot's own pinned far side, when a CLI session was resumed somewhere specific. */
  slotTarget?: TerminalFarSide;
}

export type TerminalTransport =
  /** The desktop's own pty (wb-term IPC). */
  | { kind: "local" }
  /** The pod's pty over /api/harness/pty — `scope` names the workspace, `cwd` a folder inside it. */
  | { kind: "remote"; target: "worker"; scope: string; cwd?: string }
  /** The attached desktop's pty over the relay (web only). */
  | { kind: "remote"; target: "desktop" };

/** Anything not local is the cloud (session-locus.ts's rule). No source = no locus. */
export function isCloudSource(source: TerminalSourceLike | null | undefined): boolean {
  return !!source && !!source.kind && source.kind !== "local";
}

/** The workspace a cloud session's shell runs in: a re-entered space's own
 *  id, else the thread's (remote-run.ts runThreadId — the same scope the run
 *  and the fs panels use). */
export function cloudScope(source: TerminalSourceLike | null | undefined, chatId: string | null | undefined): string {
  if (source?.kind === "cloud-space" && source.space) return String(source.space);
  return String(chatId || "");
}

export function terminalTransport(input: TerminalTransportInput): TerminalTransport {
  const { surface, source, chatId, slotTarget } = input;
  const worker = (): TerminalTransport => {
    const dir = (source?.dir || "").replace(/^\/+|\/+$/g, "");
    return { kind: "remote", target: "worker", scope: cloudScope(source, chatId), ...(dir ? { cwd: dir } : {}) };
  };
  // A pinned far side wins over the session's locus.
  if (slotTarget === "worker") return worker();
  if (slotTarget === "desktop") return surface === "desktop" ? { kind: "local" } : { kind: "remote", target: "desktop" };
  if (isCloudSource(source)) return worker();
  if (surface === "desktop") return { kind: "local" };
  // Web, a machine-bound session: the attached desktop. No session at all:
  // the web has no machine of its own — the worker is the only shell it has.
  return source?.kind === "local" ? { kind: "remote", target: "desktop" } : worker();
}
