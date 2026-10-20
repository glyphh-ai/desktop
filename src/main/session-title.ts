/**
 * session-title.ts — THE GENERATED SESSION TITLE's model call (his order,
 * 2026-10-05: do the same as Claude's titles). One small request through the
 * router on the user's own provider keys, the same lane a turn takes. The
 * renderer decides when to ask, builds the body and cleans the answer
 * (help/session-title.ts); this only carries the call.
 */

import { ipcMain } from "electron";
import { streamMessage } from "@glyphh/sdk/loop";
import { createRouterFetch } from "@glyphh/sdk/router";
import { routerConfig, routerCreds } from "./providers.js";

/** The Messages body the renderer builds (help/session-title.ts titleRequestBody). */
export interface TitleRequest {
  model: string;
  system: string;
  messages: Array<{ role: "user"; content: string }>;
  max_tokens: number;
  temperature: number;
}

const routerFetch = createRouterFetch(routerConfig);

/** The model's raw answer, or null — never throws (a title is not worth an
 *  error anywhere), and gives up on its own after 20 s. */
export async function askSessionTitle(body: TitleRequest): Promise<string | null> {
  if (!body?.model || !Array.isArray(body.messages)) return null;
  const creds = await routerCreds().catch(() => null);
  if (!creds) return null;
  try {
    const res = await streamMessage({ baseUrl: creds.baseUrl, token: creds.token, timeoutMs: 20_000, fetch: routerFetch, body: { ...body } });
    const text = res.content
      .map((b) => (b.type === "text" && typeof (b as { text?: unknown }).text === "string" ? (b as { text: string }).text : ""))
      .join("")
      .trim();
    return text || null;
  } catch {
    return null;
  }
}

export function registerSessionTitleIpc(): void {
  ipcMain.handle("session-title-generate", (_e, body: TitleRequest) => askSessionTitle(body));
}
