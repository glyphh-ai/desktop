/**
 * sessions.ts — ONE HISTORY WITH THE DESKTOP (his report, 2026-09-21: "the cli
 * has a different session state than the agent view"). The desktop keeps its
 * chats in `~/.glyphh/users/local/agent-sessions.json` (src/main/agent-ipc.ts),
 * merged by chat id with the newer `updatedAt` winning, so several writers can
 * share it. This TUI is one more writer: it opens a chat from that file
 * (`--resume <id>`, `--continue`, /resume), writes its turns after every
 * answer, and the desktop's rail and Agent panel pick them up (main watches
 * the file). The path is local.ts chatStoreFile(); the desktop points us at
 * the file explicitly when it launches us (GLYPHH_APP_SESSIONS).
 *
 * The shape is the desktop's CodeChat, written field-for-field so the panel
 * renders a terminal's chat like its own.
 */

import { dirname } from "node:path";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mergeChats } from "../../src/main/chat-store-repair.js";
import type { PermissionMode } from "./types.js";

export interface StoredMsg { role: "user" | "assistant"; text: string; at: number; kind?: string }
export interface StoredChat {
  id: string;
  title: string;
  createdAt: number;
  updatedAt?: number;
  messages: StoredMsg[];
  workdir?: string;
  loop?: string;
  mode?: "chat" | "cowork" | "code";
  source?: { kind: "local"; path: string } | { kind: string; [k: string]: unknown };
  /** The desktop's permission words: ask | plan | acceptEdits | auto. */
  permission?: string;
  cliSessionIds?: Record<string, string>;
  [k: string]: unknown;
}

interface Snapshot { chats: StoredChat[]; currentId: string | null }

export function loadStore(file: string): Snapshot {
  try {
    const j = JSON.parse(readFileSync(file, "utf-8")) as Partial<Snapshot>;
    return { chats: Array.isArray(j.chats) ? (j.chats as StoredChat[]).filter((c) => c && typeof c.id === "string") : [], currentId: typeof j.currentId === "string" ? j.currentId : null };
  } catch {
    return { chats: [], currentId: null };
  }
}

/** When a chat was last touched: its stamp, else its last message, else its birth. */
export function touchedAt(c: StoredChat): number {
  const last = c.messages?.length ? c.messages[c.messages.length - 1]!.at : 0;
  return Math.max(c.updatedAt ?? 0, last || 0, c.createdAt || 0);
}

export function findChat(file: string, id: string): StoredChat | null {
  return loadStore(file).chats.find((c) => c.id === id) ?? null;
}

/** The Glyphh loop's chats, newest first (/resume, --continue). */
export function listGlyphhChats(file: string, limit = 20): StoredChat[] {
  return loadStore(file).chats
    .filter((c) => c.loop === "glyphh" && Array.isArray(c.messages) && c.messages.length > 0)
    .sort((a, b) => touchedAt(b) - touchedAt(a))
    .slice(0, limit);
}

/** Save ONE chat by the desktop's own rule (src/main/chat-store-repair.ts
 *  mergeChats): merged by id, the newer updatedAt wins, the chat saved first in
 *  the list. Launched by the desktop, this terminal is the seat the user is
 *  looking at, so the store's CURRENT chat follows it — the hop back opens it. */
export function saveChat(file: string, chat: StoredChat, opts: { current?: boolean } = {}): void {
  try {
    const have = loadStore(file);
    const cur = have.chats.find((c) => c.id === chat.id);
    if (cur && (cur.updatedAt ?? 0) > (chat.updatedAt ?? 0)) return; // the desktop wrote something newer
    const chats = mergeChats(have.chats, [chat]);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify({ chats, currentId: opts.current ? chat.id : have.currentId }), "utf-8");
  } catch {
    /* a failed save loses nothing but the shared recents — the transcript stands */
  }
}

/** A chat id in the desktop's own style (client-minted, sortable). */
export const mintChatId = (): string => `c${Date.now().toString(36)}`;

/** The desktop's permission word for our chip. */
export function desktopPermission(mode: PermissionMode): string {
  return mode === "bypass" ? "auto" : mode === "default" ? "ask" : mode;
}

/** A fresh chat in this folder, as the desktop would have made it. */
export function newChat(cwd: string, mode: PermissionMode, id: string = mintChatId()): StoredChat {
  const now = Date.now();
  return {
    id, title: "New session", createdAt: now, updatedAt: now, messages: [],
    workdir: cwd, loop: "glyphh", mode: "code", source: { kind: "local", path: cwd }, permission: desktopPermission(mode),
    cliSessionIds: { glyphh: id },
  };
}

/** The chat's title: the first user line, first line only, bounded. */
export function titleOf(firstUserText: string): string {
  const line = firstUserText.trim().split("\n")[0]?.trim() ?? "";
  if (!line) return "New session";
  return line.length > 64 ? `${line.slice(0, 63)}…` : line;
}

/** The plain user/assistant turns of a chat — what seeds the transcript and the loop. */
export function conversationOf(chat: StoredChat): Array<{ role: "user" | "assistant"; text: string }> {
  const out: Array<{ role: "user" | "assistant"; text: string }> = [];
  for (const m of chat.messages ?? []) {
    if ((m.role !== "user" && m.role !== "assistant") || m.kind) continue;
    if (!m.text?.trim()) continue;
    out.push({ role: m.role, text: m.text });
  }
  return out;
}

/** Compact "how long ago" for a list (epoch ms → `3h ago`). */
export function agoLabel(atMs: number, now: number = Date.now()): string {
  const s = Math.max(0, (now - atMs) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}
