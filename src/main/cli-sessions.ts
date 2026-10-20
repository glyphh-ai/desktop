/**
 * cli-sessions.ts — THE VENDOR CLIS' OWN SESSIONS: listed for the recents,
 * read back as chat turns when one is adopted, deleted from the rail.
 *
 * Each CLI's own store is the source; Glyphh keeps no copy:
 *
 *   claude   ~/.claude/projects/<munged-cwd>/<id>.jsonl, one file per session
 *   codex    ~/.codex/sessions/<yyyy>/<mm>/<dd>/rollout-<ts>-<id>.jsonl
 *   gemini   ~/.gemini/tmp/<project>/chats/*.jsonl (folder in .project_root)
 *   copilot  ~/.copilot/session-state/<id>/{events.jsonl, workspace.yaml}
 *   cursor   ~/.cursor/chats/<workspace>/<id>/{meta.json, store.db}
 *
 * The head of each file carries the real folder and the first user message;
 * mtime orders the merged list. The Glyphh loop's sessions are the panel's own
 * chats (agent-ipc.ts) and never appear here.
 *
 * Electron-free: the session watch, the IPC and the tests all read it.
 */

import fs from "fs";
import path from "path";
import { homedir } from "os";
import { execFileSync } from "child_process";
import type { VendorCliId } from "./cli-ids.js";

export type SessionCli = VendorCliId;
export interface CliSessionRow { id: string; cli: SessionCli; title: string; cwd: string; mtime: number }

/** Lines a CLI prints on its own that can land in a transcript as if typed —
 *  harness wrappers (the /resume caveat, slash-command echoes) and banners.
 *  None of them is ever a session's name. */
export const NOISE_TITLE = /^(For more information and help, consult|Electron Security Warning|<local-command-caveat|<command-name|<command-message|<command-args|<local-command-stdout|<system-reminder|<user-prompt-submit-hook|Caveat: The messages below were generated)/i;

/** The longest name a store row carries; the rail shortens it further. */
const TITLE_MAX = 80;
const oneLine = (s: string): string => s.replace(/\s+/g, " ").trim().slice(0, TITLE_MAX);

/** codex prepends AGENTS.md and its environment context as user messages. */
const CODEX_PRELUDE = /^(#|<INSTRUCTIONS|<environment_context|<ENVIRONMENT)/;

function readHead(file: string, bytes: number): string {
  try {
    const fd = fs.openSync(file, "r");
    try {
      const buf = Buffer.alloc(bytes);
      const n = fs.readSync(fd, buf, 0, buf.length, 0);
      return buf.toString("utf-8", 0, n);
    } finally {
      fs.closeSync(fd);
    }
  } catch { return ""; }
}

type SessionFile = { file: string; mtime: number; cli: SessionCli; cwd?: string };

// ── the stores ───────────────────────────────────────────────────────────────

function claudeSessionFiles(): SessionFile[] {
  const root = path.join(homedir(), ".claude", "projects");
  let dirs: string[] = [];
  try { dirs = fs.readdirSync(root); } catch { return []; }
  const files: SessionFile[] = [];
  for (const d of dirs) {
    const dir = path.join(root, d);
    let names: string[] = [];
    try { names = fs.readdirSync(dir).filter((n) => n.endsWith(".jsonl")); } catch { continue; }
    for (const n of names) {
      try {
        const st = fs.statSync(path.join(dir, n));
        if (st.size > 0) files.push({ file: path.join(dir, n), mtime: st.mtimeMs, cli: "claude" });
      } catch { /* raced */ }
    }
  }
  return files;
}

function codexSessionFiles(): SessionFile[] {
  const root = path.join(homedir(), ".codex", "sessions");
  const files: SessionFile[] = [];
  const walk = (dir: string, depth: number): void => {
    let names: string[] = [];
    try { names = fs.readdirSync(dir); } catch { return; }
    for (const n of names) {
      const p = path.join(dir, n);
      try {
        const st = fs.statSync(p);
        if (st.isDirectory()) { if (depth < 3) walk(p, depth + 1); }
        else if (n.endsWith(".jsonl") && st.size > 0) files.push({ file: p, mtime: st.mtimeMs, cli: "codex" });
      } catch { /* raced */ }
    }
  };
  walk(root, 0);
  return files;
}

function geminiSessionFiles(): SessionFile[] {
  const root = path.join(homedir(), ".gemini", "tmp");
  let projects: string[] = [];
  try { projects = fs.readdirSync(root); } catch { return []; }
  const files: SessionFile[] = [];
  for (const proj of projects) {
    const dir = path.join(root, proj, "chats");
    let cwd = "";
    try { cwd = fs.readFileSync(path.join(root, proj, ".project_root"), "utf-8").trim(); } catch { cwd = ""; }
    let names: string[] = [];
    try { names = fs.readdirSync(dir); } catch { continue; }
    for (const n of names) {
      if (!n.endsWith(".jsonl")) continue;
      try { const st = fs.statSync(path.join(dir, n)); if (st.size > 0) files.push({ file: path.join(dir, n), mtime: st.mtimeMs, cli: "gemini", cwd }); } catch { /* raced */ }
    }
  }
  return files;
}

function copilotSessionFiles(): SessionFile[] {
  const root = path.join(homedir(), ".copilot", "session-state");
  let ids: string[] = [];
  try { ids = fs.readdirSync(root); } catch { return []; }
  const files: SessionFile[] = [];
  for (const id of ids) {
    const file = path.join(root, id, "events.jsonl");
    let cwd = "";
    try { cwd = /^cwd:\s*(.+)$/m.exec(fs.readFileSync(path.join(root, id, "workspace.yaml"), "utf-8"))?.[1]?.trim() ?? ""; } catch { cwd = ""; }
    try { const st = fs.statSync(file); if (st.size > 0) files.push({ file, mtime: st.mtimeMs, cli: "copilot", cwd }); } catch { /* no events yet */ }
  }
  return files;
}

/** Cursor's chats: meta.json says whether there is a conversation, store.db holds it. */
function cursorSessionFiles(): SessionFile[] {
  const root = path.join(homedir(), ".cursor", "chats");
  let spaces: string[] = [];
  try { spaces = fs.readdirSync(root); } catch { return []; }
  const files: SessionFile[] = [];
  for (const ws of spaces) {
    let chats: string[] = [];
    try { chats = fs.readdirSync(path.join(root, ws)); } catch { continue; }
    for (const id of chats) {
      const dir = path.join(root, ws, id);
      let meta: { cwd?: string; updatedAtMs?: number; hasConversation?: boolean } = {};
      try { meta = JSON.parse(fs.readFileSync(path.join(dir, "meta.json"), "utf-8")) as typeof meta; } catch { continue; }
      if (meta.hasConversation === false) continue;
      files.push({ file: path.join(dir, "store.db"), mtime: Number(meta.updatedAtMs) || 0, cli: "cursor", cwd: meta.cwd || "" });
    }
  }
  return files;
}

// ── one session's head: id, folder, name ─────────────────────────────────────

/** Claude APPENDS its `type:"summary"` lines as the conversation moves on;
 *  the newest is the name its own --resume picker shows, and it sits at the
 *  tail, far past any head window. */
function claudeTailSummary(file: string): string {
  try {
    const st = fs.statSync(file);
    const want = Math.min(st.size, 65_536);
    if (!want) return "";
    const fd = fs.openSync(file, "r");
    let text = "";
    try {
      const buf = Buffer.alloc(want);
      const n = fs.readSync(fd, buf, 0, want, st.size - want);
      text = buf.toString("utf-8", 0, n);
    } finally {
      fs.closeSync(fd);
    }
    // A window that starts mid-file starts mid-line: the first line is a fragment.
    const lines = text.split("\n").slice(st.size > want ? 1 : 0);
    let found = "";
    for (const line of lines) {
      if (!line.trim() || !line.includes('"summary"')) continue;
      try {
        const j = JSON.parse(line) as Record<string, unknown>;
        if (j.type === "summary" && typeof j.summary === "string" && j.summary.trim()) found = j.summary;
      } catch { /* partial */ }
    }
    return found;
  } catch { return ""; }
}

/** The text of a user frame, whether the CLI stored a string or blocks. */
function userText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return (content.find((c) => (c as { type?: string }).type === "text") as { text?: string } | undefined)?.text ?? "";
  return "";
}

export function readClaudeSessionHead(file: string, mtime: number): CliSessionRow | null {
  const head = readHead(file, 32_768);
  if (!head) return null;
  let cwd = "";
  let title = claudeTailSummary(file);
  for (const line of head.split("\n")) {
    if (!line.trim()) continue;
    let j: Record<string, unknown>;
    try { j = JSON.parse(line) as Record<string, unknown>; } catch { continue; }
    if (!cwd && typeof j.cwd === "string") cwd = j.cwd;
    if (!title && j.type === "summary" && typeof j.summary === "string") title = j.summary;
    if (!title && j.type === "user") {
      const cand = userText((j.message as { content?: unknown } | undefined)?.content);
      if (cand.trim() && !NOISE_TITLE.test(cand.trim())) title = cand;
    }
    if (cwd && title) break;
  }
  if (!title) return null;
  return { id: path.basename(file, ".jsonl"), cli: "claude", title: oneLine(title), cwd, mtime };
}

function readCodexSessionHead(file: string, mtime: number): CliSessionRow | null {
  const head = readHead(file, 65_536);
  if (!head) return null;
  let id = "";
  let cwd = "";
  let title = "";
  for (const line of head.split("\n")) {
    if (!line.trim()) continue;
    let j: { type?: string; payload?: Record<string, unknown> };
    try { j = JSON.parse(line) as typeof j; } catch { continue; }
    const p = j.payload ?? {};
    if (j.type === "session_meta") {
      if (typeof p.id === "string") id = p.id;
      if (typeof p.cwd === "string") cwd = p.cwd;
    }
    if (!title && p.type === "message" && p.role === "user" && Array.isArray(p.content)) {
      const t = ((p.content as Array<{ type?: string; text?: string }>).find((c) => c.type === "input_text" && c.text)?.text ?? "").trim();
      if (t && !CODEX_PRELUDE.test(t) && !NOISE_TITLE.test(t)) title = t;
    }
    if (id && cwd && title) break;
  }
  if (!title) return null;
  if (!id) id = /rollout-[\dT-]+-([0-9a-f-]{36})\.jsonl$/.exec(path.basename(file))?.[1] ?? "";
  if (!id) return null;
  return { id, cli: "codex", title: oneLine(title), cwd, mtime };
}

type GeminiMsg = { type?: string; content?: Array<{ text?: string }> | string };
/** Gemini writes a chat as a JSON patch log: $set the messages, then $push them. */
function geminiMessages(j: { $set?: { messages?: GeminiMsg[] }; $push?: { messages?: GeminiMsg | GeminiMsg[] }; messages?: GeminiMsg[] }): GeminiMsg[] {
  const pushed = j.$push?.messages;
  return [...(j.$set?.messages ?? j.messages ?? []), ...(pushed ? (Array.isArray(pushed) ? pushed : [pushed]) : [])];
}
const geminiText = (m: GeminiMsg): string => (Array.isArray(m.content) ? m.content.map((c) => c.text || "").join("") : String(m.content || "")).trim();

function readGeminiSessionHead(file: string, mtime: number, cwd: string): CliSessionRow | null {
  const head = readHead(file, 131_072);
  if (!head) return null;
  let id = "";
  let title = "";
  for (const line of head.split("\n")) {
    if (!line.trim()) continue;
    let j: Parameters<typeof geminiMessages>[0] & { sessionId?: string };
    try { j = JSON.parse(line) as typeof j; } catch { continue; }
    if (typeof j.sessionId === "string") id = j.sessionId;
    for (const m of geminiMessages(j)) {
      if (title || m.type !== "user") continue;
      const t = geminiText(m);
      if (t && !t.startsWith("<session_context>") && !NOISE_TITLE.test(t)) title = t;
    }
    if (id && title) break;
  }
  if (!id || !title) return null;
  return { id, cli: "gemini", title: oneLine(title), cwd, mtime };
}

function readCopilotSessionHead(file: string, mtime: number, cwdIn: string): CliSessionRow | null {
  const head = readHead(file, 131_072);
  if (!head) return null;
  let id = "";
  let title = "";
  let cwd = cwdIn;
  for (const line of head.split("\n")) {
    if (!line.trim()) continue;
    let j: { type?: string; data?: { sessionId?: string; content?: string; context?: { cwd?: string } } };
    try { j = JSON.parse(line) as typeof j; } catch { continue; }
    if (j.type === "session.start") { id = j.data?.sessionId || id; cwd = cwd || j.data?.context?.cwd || ""; }
    if (j.type === "user.message" && !title && typeof j.data?.content === "string" && !NOISE_TITLE.test(j.data.content.trim())) title = j.data.content.trim();
    if (id && title) break;
  }
  if (!id) id = path.basename(path.dirname(file));
  if (!title) return null;
  return { id, cli: "copilot", title: oneLine(title), cwd, mtime };
}

/** Cursor's name lives in its sqlite store: one sqlite3 shell-out per chat per
 *  change, remembered by mtime so a poll never re-reads an unchanged chat. */
const cursorTitles = new Map<string, { mtime: number; title: string }>();

function readCursorSessionHead(file: string, mtime: number, cwd: string): CliSessionRow | null {
  const id = path.basename(path.dirname(file));
  const seen = cursorTitles.get(file);
  let title = seen && seen.mtime === mtime ? seen.title : "";
  if (!seen || seen.mtime !== mtime) {
    title = "";
    if (fs.existsSync(file)) {
      try {
        const hex = execFileSync("sqlite3", ["-readonly", file, "select hex(value) from meta where key = '0' limit 1"], {
          encoding: "utf-8", timeout: 3_000, stdio: ["ignore", "pipe", "ignore"],
        }).trim();
        if (hex) title = String((JSON.parse(Buffer.from(hex, "hex").toString("utf-8")) as { name?: string }).name || "");
      } catch { title = ""; }
    }
    cursorTitles.set(file, { mtime, title });
    if (cursorTitles.size > 500) for (const k of [...cursorTitles.keys()].slice(0, 100)) cursorTitles.delete(k);
  }
  if (!title) return null;
  return { id, cli: "cursor", title: oneLine(title), cwd, mtime };
}

const READERS: Record<SessionCli, (f: SessionFile) => CliSessionRow | null> = {
  claude: (f) => readClaudeSessionHead(f.file, f.mtime),
  codex: (f) => readCodexSessionHead(f.file, f.mtime),
  gemini: (f) => readGeminiSessionHead(f.file, f.mtime, f.cwd || ""),
  copilot: (f) => readCopilotSessionHead(f.file, f.mtime, f.cwd || ""),
  cursor: (f) => readCursorSessionHead(f.file, f.mtime, f.cwd || ""),
};

const STORES: Record<SessionCli, () => SessionFile[]> = {
  claude: claudeSessionFiles, codex: codexSessionFiles, gemini: geminiSessionFiles, copilot: copilotSessionFiles, cursor: cursorSessionFiles,
};

/** The newest sessions across the given CLIs' stores (every vendor CLI by
 *  default), newest first. A session with no real first message (a CLI opened
 *  and closed) has no name and is skipped. */
export function listCliSessions(limit = 40, clis: readonly SessionCli[] = Object.keys(STORES) as SessionCli[]): CliSessionRow[] {
  const files = clis.flatMap((cli) => STORES[cli]());
  files.sort((a, b) => b.mtime - a.mtime);
  const out: CliSessionRow[] = [];
  for (const f of files.slice(0, limit * 3)) {
    const row = READERS[f.cli](f);
    if (row) out.push(row);
    if (out.length >= limit) break;
  }
  return out;
}

// ── one session as chat turns (adoption) ─────────────────────────────────────

export type Turn = { role: "user" | "assistant"; text: string };
export type Transcript = { ok: true; cli: SessionCli; title: string; cwd: string; turns: Turn[] };
export type TranscriptResult = Transcript | { ok: false; error: string };

/** The last turns are what a chat shows; a long session is not painted whole. */
const TURNS_MAX = 200;

/** A session id as the stores spell them: a uuid-ish word, never a path. */
const SAFE_ID = /^[\w-]{1,128}$/;

function claudeTranscript(file: string): TranscriptResult {
  const turns: Turn[] = [];
  let title = "";
  let cwd = "";
  try {
    for (const line of fs.readFileSync(file, "utf-8").split("\n")) {
      if (!line.trim()) continue;
      let j: Record<string, unknown>;
      try { j = JSON.parse(line) as Record<string, unknown>; } catch { continue; }
      if (!cwd && typeof j.cwd === "string") cwd = j.cwd;
      // The LAST summary: the newest is the name claude's own picker shows.
      if (j.type === "summary" && typeof j.summary === "string" && j.summary.trim()) title = j.summary;
      if (j.type !== "user" && j.type !== "assistant") continue;
      const content = (j.message as { content?: unknown } | undefined)?.content;
      const text = typeof content === "string" ? content
        : Array.isArray(content) ? (content as Array<{ type?: string; text?: string }>).filter((b) => b.type === "text" && b.text).map((b) => b.text as string).join("\n")
        : "";
      // Tool results ride user frames with no text: they are the tool lane, not a turn.
      if (text.trim()) turns.push({ role: j.type as Turn["role"], text: text.trim() });
    }
  } catch (err) { return { ok: false, error: err instanceof Error ? err.message : String(err) }; }
  if (!title) title = turns.find((t) => t.role === "user" && !NOISE_TITLE.test(t.text))?.text ?? "Claude session";
  return { ok: true, cli: "claude", title: oneLine(title), cwd, turns: turns.filter((t) => !NOISE_TITLE.test(t.text)).slice(-TURNS_MAX) };
}

function codexTranscript(file: string): TranscriptResult {
  const turns: Turn[] = [];
  let cwd = "";
  try {
    for (const line of fs.readFileSync(file, "utf-8").split("\n")) {
      if (!line.trim()) continue;
      let j: { type?: string; payload?: Record<string, unknown> };
      try { j = JSON.parse(line) as typeof j; } catch { continue; }
      const p = j.payload ?? {};
      if (j.type === "session_meta" && typeof p.cwd === "string") cwd = p.cwd;
      if (j.type !== "response_item" || p.type !== "message") continue;
      const role = p.role === "user" ? "user" : p.role === "assistant" ? "assistant" : null;
      if (!role || !Array.isArray(p.content)) continue;
      const text = (p.content as Array<{ type?: string; text?: string }>)
        .filter((c) => (c.type === "input_text" || c.type === "output_text" || c.type === "text") && c.text)
        .map((c) => c.text as string).join("\n").trim();
      if (!text || (role === "user" && CODEX_PRELUDE.test(text))) continue;
      turns.push({ role, text });
    }
  } catch (err) { return { ok: false, error: err instanceof Error ? err.message : String(err) }; }
  const title = turns.find((t) => t.role === "user")?.text ?? "Codex session";
  return { ok: true, cli: "codex", title: oneLine(title), cwd, turns: turns.slice(-TURNS_MAX) };
}

function geminiTranscript(file: string, cwd: string): TranscriptResult {
  const turns: Turn[] = [];
  try {
    for (const line of fs.readFileSync(file, "utf-8").split("\n")) {
      if (!line.trim()) continue;
      let j: Parameters<typeof geminiMessages>[0];
      try { j = JSON.parse(line) as typeof j; } catch { continue; }
      for (const m of geminiMessages(j)) {
        const role = m.type === "user" ? "user" : m.type === "gemini" ? "assistant" : null;
        const text = geminiText(m);
        if (!role || !text || (role === "user" && (text.startsWith("<session_context>") || NOISE_TITLE.test(text)))) continue;
        turns.push({ role, text });
      }
    }
  } catch (err) { return { ok: false, error: err instanceof Error ? err.message : String(err) }; }
  const title = turns.find((t) => t.role === "user")?.text ?? "Gemini session";
  return { ok: true, cli: "gemini", title: oneLine(title), cwd, turns: turns.slice(-TURNS_MAX) };
}

function copilotTranscript(file: string): TranscriptResult {
  const turns: Turn[] = [];
  let cwd = "";
  try {
    for (const line of fs.readFileSync(file, "utf-8").split("\n")) {
      if (!line.trim()) continue;
      let j: { type?: string; data?: { content?: string; context?: { cwd?: string }; response?: { content?: string } } };
      try { j = JSON.parse(line) as typeof j; } catch { continue; }
      if (j.type === "session.start") cwd = j.data?.context?.cwd || cwd;
      const said = (j.type === "user.message" ? j.data?.content : j.type === "model.response" ? j.data?.response?.content : j.type === "chat" ? j.data?.content : undefined)?.trim();
      if (!said) continue;
      if (j.type === "user.message") { if (!NOISE_TITLE.test(said)) turns.push({ role: "user", text: said }); }
      else if (!said.startsWith("<session-title>")) turns.push({ role: "assistant", text: said });
    }
  } catch (err) { return { ok: false, error: err instanceof Error ? err.message : String(err) }; }
  const title = turns.find((t) => t.role === "user")?.text ?? "Copilot session";
  return { ok: true, cli: "copilot", title: oneLine(title), cwd, turns: turns.slice(-TURNS_MAX) };
}

/**
 * One session from whichever store holds it, as plain chat turns — tool
 * frames and meta stay in the terminal view where they belong. Cursor keeps
 * its turns in a database, so its session opens with its name and folder and
 * no history painted.
 */
export function cliTranscript(sessionId: string): TranscriptResult {
  const id = String(sessionId ?? "");
  if (!SAFE_ID.test(id)) return { ok: false, error: "bad session id" };
  const claude = claudeSessionFiles().find((f) => path.basename(f.file) === `${id}.jsonl`);
  if (claude) return claudeTranscript(claude.file);
  const codex = codexSessionFiles().find((f) => f.file.endsWith(`-${id}.jsonl`));
  if (codex) return codexTranscript(codex.file);
  const gemini = geminiSessionFiles().find((f) => readHead(f.file, 400).includes(`"sessionId":"${id}"`));
  if (gemini) return geminiTranscript(gemini.file, gemini.cwd || "");
  const copilot = path.join(homedir(), ".copilot", "session-state", id, "events.jsonl");
  if (fs.existsSync(copilot)) return copilotTranscript(copilot);
  const cursor = cursorSessionFiles().find((f) => path.basename(path.dirname(f.file)) === id);
  if (cursor) {
    const head = readCursorSessionHead(cursor.file, cursor.mtime, cursor.cwd || "");
    return { ok: true, cli: "cursor", title: head?.title || "Cursor session", cwd: cursor.cwd || "", turns: [] };
  }
  return { ok: false, error: "session not found" };
}

/** Remove one session from its CLI's own store. Throws when no store holds it. */
export function deleteCliSession(sessionId: string): void {
  const id = String(sessionId ?? "");
  if (!SAFE_ID.test(id)) throw new Error("bad session id");
  const claude = claudeSessionFiles().find((f) => path.basename(f.file) === `${id}.jsonl`);
  if (claude) { fs.rmSync(claude.file); return; }
  const codex = codexSessionFiles().find((f) => f.file.endsWith(`-${id}.jsonl`));
  if (codex) { fs.rmSync(codex.file); return; }
  const gemini = geminiSessionFiles().find((f) => readHead(f.file, 400).includes(`"sessionId":"${id}"`));
  if (gemini) { fs.rmSync(gemini.file); return; }
  // copilot and cursor keep a folder per session; the folder is the id.
  const copilot = path.join(homedir(), ".copilot", "session-state", id);
  if (fs.existsSync(path.join(copilot, "events.jsonl"))) { fs.rmSync(copilot, { recursive: true, force: true }); return; }
  const cursor = cursorSessionFiles().find((f) => path.basename(path.dirname(f.file)) === id);
  if (cursor) { fs.rmSync(path.dirname(cursor.file), { recursive: true, force: true }); return; }
  throw new Error("session not found");
}
