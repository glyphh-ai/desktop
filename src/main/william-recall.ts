/**
 * william-recall — SHORT-TERM memory for the agent loop.
 *
 * Layered memory, by horizon:
 *   long-term  — Ada (schema-on-write facts, cross-session)   [exists]
 *   mid-term   — the rolling summary (compaction)              [exists]
 *   SHORT-TERM — this module: every turn of the current chat,
 *                embedded locally into turn_vectors. At each send, the
 *                turns most relevant to the NEW ask — beyond the verbatim
 *                tail the prompt already carries — come back word-for-word.
 *
 * This is what compaction loses: the summary keeps the shape of old work,
 * recall brings back its exact details (paths, decisions, error strings)
 * only when the current ask actually touches them. Costs ~one embedding
 * call at send time; zero when the runtime lacks embeddings.
 */

import { getLocalDb } from "./local-db";
import { embedText, embedTexts, dot, packVec, unpackVec } from "./william-embeddings";
import { loadSessions } from "./william-context";

const MIN_TURN_CHARS = 40;
const EMBED_TURN_CHARS = 1500;
const RECALL_K = 4;
const RECALL_MIN_SCORE = 0.35;
const RECALL_SNIPPET_CHARS = 400;
/** Newest turns are already verbatim in the prompt — recall skips them. */
const TAIL_SKIP = 8;

/** Embed any turns of `chatId` not yet in turn_vectors. Fire-and-forget
 *  after a run; a dead runtime just means nothing gets indexed this pass. */
export async function indexChatTurns(chatId: string): Promise<void> {
  let db;
  try { db = getLocalDb(); } catch { return; }
  const chat = loadSessions().chats.find((c) => c.id === chatId);
  if (!chat) return;
  const have = new Set(
    (db.prepare("SELECT at, role FROM turn_vectors WHERE chat_id = ?").all(chatId) as Array<{ at: number; role: string }>)
      .map((r) => `${r.at}\n${r.role}`),
  );
  const fresh = chat.messages.filter((m) =>
    !m.kind && m.text.length >= MIN_TURN_CHARS && !have.has(`${m.at}\n${m.role}`));
  if (!fresh.length) return;
  const vecs = await embedTexts(fresh.map((m) => m.text.slice(0, EMBED_TURN_CHARS)), "document");
  if (!vecs) return;
  const ins = db.prepare(
    "INSERT OR REPLACE INTO turn_vectors (chat_id, at, role, text, embedding) VALUES (?, ?, ?, ?, ?)",
  );
  fresh.forEach((m, i) => {
    ins.run(chatId, m.at, m.role, m.text.slice(0, EMBED_TURN_CHARS), packVec(vecs[i]));
  });
}

/** Older turns of this chat most relevant to `ask`, formatted as a prompt
 *  block — or "" when there's nothing worth injecting. */
export async function shortTermRecallBlock(chatId: string, ask: string): Promise<string> {
  let db;
  try { db = getLocalDb(); } catch { return ""; }
  if (!ask.trim()) return "";
  const rows = db.prepare(
    "SELECT at, role, text, embedding FROM turn_vectors WHERE chat_id = ? ORDER BY at DESC",
  ).all(chatId) as Array<{ at: number; role: string; text: string; embedding: Buffer }>;
  // Nothing beyond what the prompt tail already shows verbatim → skip the
  // embedding call entirely.
  const candidates = rows.slice(TAIL_SKIP);
  if (!candidates.length) return "";
  const q = await embedText(ask.slice(0, EMBED_TURN_CHARS), "query");
  if (!q) return "";
  const scored = candidates
    .map((r) => ({ r, score: dot(q, unpackVec(r.embedding)) }))
    .filter((x) => x.score >= RECALL_MIN_SCORE)
    .sort((a, b) => b.score - a.score)
    .slice(0, RECALL_K)
    .sort((a, b) => a.r.at - b.r.at); // chronological reads better
  if (!scored.length) return "";
  const lines = scored.map(({ r }) => {
    const who = r.role === "user" ? "User" : "William";
    const text = r.text.length > RECALL_SNIPPET_CHARS ? `${r.text.slice(0, RECALL_SNIPPET_CHARS)}…` : r.text;
    return `${who} (earlier): ${text}`;
  });
  return [
    "<relevant_earlier_context>",
    ...lines,
    "</relevant_earlier_context>",
    "(Verbatim earlier turns of THIS session that match the current ask — recalled because compaction may have summarized them away.)",
  ].join("\n");
}

/** Session housekeeping: drop vectors for chats that no longer exist. */
export function pruneTurnVectors(): void {
  try {
    const db = getLocalDb();
    const ids = new Set(loadSessions().chats.map((c) => c.id));
    const stored = db.prepare("SELECT DISTINCT chat_id FROM turn_vectors").all() as Array<{ chat_id: string }>;
    const gone = stored.map((r) => r.chat_id).filter((id) => !ids.has(id));
    const del = db.prepare("DELETE FROM turn_vectors WHERE chat_id = ?");
    for (const id of gone) del.run(id);
  } catch { /* store not up — next pass */ }
}
