/**
 * RunStore — persistence for skill/schedule task runs.
 *
 * Lifted out of the (now-deleted) YoAgent's chat-persistence code. Pure file
 * I/O, no LLM involved — writes/reads markdown "run" records to
 * ~/yo/chats/run-*.md (same on-disk shape YoAgent used, so existing files and
 * the Schedules UI's run-history view keep working unchanged).
 */

import fs from "fs";
import path from "path";
import os from "os";
import crypto from "crypto";

const CHATS_DIR = path.join(os.homedir(), "yo", "chats");

/** A persisted chat/run message. Assistant turns may carry the ordered
 *  tool calls that ran during them so reloaded history is complete. */
export interface ChatMessage {
  role: string;
  content: string;
  tools?: Array<{ name: string; input?: unknown }>;
}

/** A persisted task run, surfaced in the Activity view + schedule detail. */
export interface RunSummary {
  id: string;
  skillName: string;
  title: string;
  created: string;
  trigger: string;
  ok: boolean;
}

export class RunStore {
  /** Delete all persisted run-*.md chats for a given task/skill name. */
  deleteRunsForSkill(skillName: string): number {
    let removed = 0;
    try {
      for (const f of fs.readdirSync(CHATS_DIR).filter((f) => f.startsWith("run-") && f.endsWith(".md"))) {
        try {
          const raw = fs.readFileSync(path.join(CHATS_DIR, f), "utf-8");
          const m = raw.match(/^skillName:\s*(.+)$/m);
          if (m && m[1].trim() === skillName) { fs.unlinkSync(path.join(CHATS_DIR, f)); removed++; }
        } catch { /* skip */ }
      }
    } catch { /* no dir */ }
    return removed;
  }

  /**
   * Persist a completed task run as a special `type: run` chat so it can be
   * listed in Activity / the schedule detail.
   */
  saveRunChat(opts: {
    skillName: string;
    trigger: string;
    output?: unknown;
    error?: string;
    startedAt: number;
    instructions?: string;
  }): string {
    fs.mkdirSync(CHATS_DIR, { recursive: true });
    const id = `run-${opts.startedAt}-${crypto.randomBytes(3).toString("hex")}`;
    const label = opts.trigger === "schedule" ? "Ran scheduled task" : "Ran task";
    const outText = opts.error
      ? `**Run failed**\n\n${opts.error}`
      : (typeof opts.output === "string" ? opts.output : "```json\n" + JSON.stringify(opts.output ?? null, null, 2) + "\n```");
    const messages: ChatMessage[] = [
      { role: "run", content: label, tools: [{ name: opts.skillName }] },
      ...(opts.instructions ? [{ role: "user", content: opts.instructions } as ChatMessage] : []),
      { role: "assistant", content: outText },
    ];
    const startedIso = new Date(Number.isFinite(opts.startedAt) ? opts.startedAt : Date.now()).toISOString();
    const lines = [
      "---",
      `title: ${opts.skillName}`,
      `created: ${startedIso}`,
      `messages: 1`,
      `type: run`,
      `skillName: ${opts.skillName}`,
      `trigger: ${opts.trigger}`,
      ...(opts.error ? ["status: error"] : ["status: ok"]),
      "---",
      "",
      "```json",
      JSON.stringify(messages, null, 2),
      "```",
    ];
    fs.writeFileSync(path.join(CHATS_DIR, `${id}.md`), lines.join("\n"), "utf-8");
    // Keep run history bounded — prune oldest run files beyond a cap.
    this.pruneRuns();
    return id;
  }

  /** Read a single run's display messages. */
  getRun(id: string): { title: string; messages: Array<{ role: string; text: string; tools?: Array<{ name: string; input?: unknown }> }> } | null {
    const filepath = path.join(CHATS_DIR, `${id}.md`);
    if (!fs.existsSync(filepath)) return null;
    try {
      const parsed = this.parseChatFile(fs.readFileSync(filepath, "utf-8"));
      return { title: parsed.title, messages: parsed.display };
    } catch { return null; }
  }

  /** List persisted task runs (optionally for one skill), newest first. */
  listRuns(skillName?: string): RunSummary[] {
    fs.mkdirSync(CHATS_DIR, { recursive: true });
    try {
      return fs.readdirSync(CHATS_DIR)
        .filter((f) => f.startsWith("run-") && f.endsWith(".md"))
        .map((f) => {
          const raw = fs.readFileSync(path.join(CHATS_DIR, f), "utf-8");
          const fm = raw.match(/^---\n([\s\S]*?)\n---/)?.[1] || "";
          const get = (k: string) => fm.match(new RegExp(`^${k}:\\s*(.+)$`, "m"))?.[1].trim() || "";
          return {
            id: f.replace(/\.md$/, ""),
            skillName: get("skillName") || get("title"),
            title: get("title"),
            created: get("created"),
            trigger: get("trigger") || "manual",
            ok: get("status") !== "error",
          } as RunSummary;
        })
        .filter((r) => !skillName || r.skillName === skillName)
        .sort((a, b) => (b.created || "").localeCompare(a.created || ""));
    } catch { return []; }
  }

  /** Cap stored run files (keep the newest 100). */
  private pruneRuns(): void {
    try {
      const runs = fs.readdirSync(CHATS_DIR).filter((f) => f.startsWith("run-") && f.endsWith(".md")).sort();
      const excess = runs.length - 100;
      for (let i = 0; i < excess; i++) {
        try { fs.unlinkSync(path.join(CHATS_DIR, runs[i])); } catch {}
      }
    } catch {}
  }

  private parseChatFile(raw: string): {
    title: string;
    display: Array<{ role: string; text: string; tools?: Array<{ name: string; input?: unknown }> }>;
  } {
    let title = "";
    const fmMatch = raw.match(/^---\n([\s\S]*?)\n---/);
    if (fmMatch) {
      const t = fmMatch[1].match(/^title:\s*(.+)$/m);
      if (t) title = t[1].trim();
    }

    const jsonMatch = raw.match(/```json\n([\s\S]*?)\n```/);
    let messages: ChatMessage[] = [];
    if (jsonMatch) {
      try { messages = JSON.parse(jsonMatch[1]); } catch {}
    }

    const display = messages.map((m) => ({
      role: m.role,
      text: m.content || "",
      ...(m.tools && m.tools.length > 0 ? { tools: m.tools } : {}),
    }));

    return { title, display };
  }
}
