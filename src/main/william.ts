/**
 * William — the local agent loop's serving bridge.
 *
 * Streams chat completions from the William model served by llama-server
 * (OpenAI-compatible /v1/chat/completions, default 127.0.0.1:8089) into the
 * renderer: `william-run` starts a streamed run and deltas arrive on
 * `william:delta`, terminated by `william:done` (or `william:error`).
 * One run at a time; `william-stop` aborts the active one.
 *
 * v1 = prompt → thinking → streamed response. The generate→validate→repair
 * bundle loop (emission format + oracle) layers on top of this later.
 */

import { ipcMain, type WebContents } from "electron";
import { getPreference } from "./preferences";

interface ChatMessage { role: "system" | "user" | "assistant"; content: string }

const SERVE_HINT =
  "William isn't serving. Start it:\n" +
  "  cd ~/development/yo/glyphh-william && \\\n" +
  "  llama-server -m models/william-14b-q4km.gguf --port 8089 --jinja -c 16384 -ngl 99";

let active: { id: string; ctrl: AbortController } | null = null;

function baseUrl(): string {
  return String(getPreference("williamBaseUrl", "http://127.0.0.1:8089")).replace(/\/+$/, "");
}

export function isWilliamRunActive(): boolean {
  return !!active;
}

export function registerWilliamIpc(): void {
  ipcMain.handle("william-run", (e, payload: { messages: ChatMessage[] }) => {
    if (active) throw new Error("a run is already in progress");
    const messages = Array.isArray(payload?.messages) ? payload.messages : [];
    if (!messages.length) throw new Error("no messages");
    const id = `run-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`;
    const ctrl = new AbortController();
    active = { id, ctrl };
    void stream(e.sender, id, messages, ctrl).finally(() => {
      if (active?.id === id) active = null;
    });
    return { runId: id };
  });

  ipcMain.handle("william-stop", () => {
    active?.ctrl.abort();
    return true;
  });

  ipcMain.handle("william-status", async () => {
    try {
      const r = await fetch(`${baseUrl()}/health`, { signal: AbortSignal.timeout(1500) });
      return { up: r.ok };
    } catch {
      return { up: false };
    }
  });
}

async function stream(wc: WebContents, runId: string, messages: ChatMessage[], ctrl: AbortController): Promise<void> {
  const emit = (channel: string, data: Record<string, unknown>) => {
    try { if (!wc.isDestroyed()) wc.send(channel, { runId, ...data }); } catch { /* panel gone */ }
  };
  try {
    const res = await fetch(`${baseUrl()}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages, stream: true, temperature: 0.3, max_tokens: 4096 }),
      signal: ctrl.signal,
    });
    if (!res.ok || !res.body) throw new Error(`William server answered HTTP ${res.status}`);

    // OpenAI-style SSE: "data: {json}" lines, closed by "data: [DONE]".
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (data === "[DONE]") continue;
        try {
          const j = JSON.parse(data) as { choices?: Array<{ delta?: { content?: string } }> };
          const delta = j.choices?.[0]?.delta?.content;
          if (delta) emit("william:delta", { delta });
        } catch { /* keep-alive / partial line */ }
      }
    }
    emit("william:done", { stopped: false });
  } catch (err) {
    if (ctrl.signal.aborted) {
      emit("william:done", { stopped: true });
      return;
    }
    const msg = err instanceof Error ? err.message : String(err);
    // A connection refusal means llama-server isn't up — say how to start it.
    const friendly = /fetch failed|ECONNREFUSED|ENOTFOUND|socket/i.test(msg) ? SERVE_HINT : msg;
    emit("william:error", { error: friendly });
  }
}
