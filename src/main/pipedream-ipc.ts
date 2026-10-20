/**
 * pipedream-ipc.ts — SETTINGS › CONNECTIONS' Pipedream lanes (pipedream.ts).
 *
 * Every answer is an `{ ok, data | error }` envelope. The client secret never
 * crosses to the renderer: the config comes back as a view with a masked
 * hint. A connect runs the whole flow in main (token, system browser, poll)
 * and narrates it on `pipedream:connect-progress`; anything that changes the
 * connected apps is announced on `pipedream:changed`, and the loops' tool
 * lists follow (mcp-connections.ts re-dials, model-watch re-reads the lane).
 */

import { ipcMain } from "electron";
import {
  cachedPdAccounts, clearPdConfig, isPdAppEnabled, pdAccounts, pdApps, pdCategories, pdConfigView, pdConnect, pdDeleteAccount,
  pdTest, readPdConfig, savePdConfig, setPdAppEnabled, type PdAccount,
} from "./pipedream.js";
import { connectionTools, pdConnectionId, resetConnection } from "./mcp-connections.js";
import { broadcast } from "./broadcast.js";
import { refreshModelState } from "./model-watch.js";

type Env<T> = { ok: true; data: T } | { ok: false; error: string };

async function run<T>(work: () => T | Promise<T>): Promise<Env<T>> {
  try { return { ok: true, data: await work() }; }
  catch (err) { return { ok: false, error: err instanceof Error ? err.message : String(err) }; }
}

/** An account as the page shows it: with whether its app is turned on. */
export type PdAccountRow = PdAccount & { enabled: boolean };
const rowsOf = (accounts: PdAccount[]): PdAccountRow[] => accounts.map((a) => ({ ...a, enabled: isPdAppEnabled(a.app) }));

/** The connected apps moved: the next call re-dials the app, the lane's
 *  on/off is re-read, and every surface is told. */
async function changed(app?: string): Promise<void> {
  if (app) await resetConnection(pdConnectionId(app)).catch(() => undefined);
  void refreshModelState().catch(() => undefined);
  broadcast("pipedream:changed");
}

/** Connects in flight, by app, so Cancel can stop the poll. */
const inFlight = new Map<string, AbortController>();

export function registerPipedreamIpc(): void {
  ipcMain.handle("pipedream-config-get", () => run(() => pdConfigView()));
  ipcMain.handle("pipedream-config-set", (_e, input: { projectId?: string; environment?: string; clientId?: string; clientSecret?: string }) =>
    run(async () => {
      const view = savePdConfig(input ?? {});
      await changed();
      return view;
    }));
  ipcMain.handle("pipedream-config-clear", () => run(async () => {
    for (const c of inFlight.values()) c.abort();
    const apps = new Set(cachedPdAccounts().map((a) => a.app));
    clearPdConfig();
    for (const app of apps) await resetConnection(pdConnectionId(app)).catch(() => undefined);
    await changed();
    return pdConfigView();
  }));
  ipcMain.handle("pipedream-test", () => run(async () => {
    const r = await pdTest();
    await changed();
    return r;
  }));
  ipcMain.handle("pipedream-apps", (_e, o: { q?: string; after?: string; category?: string } = {}) =>
    run(() => pdApps({ q: String(o?.q ?? ""), after: String(o?.after ?? ""), category: String(o?.category ?? "") })));
  ipcMain.handle("pipedream-categories", () => run(() => pdCategories()));
  /** `refresh` reads Pipedream; otherwise the cache answers (no network). */
  ipcMain.handle("pipedream-accounts", (_e, refresh?: boolean) => run(async () => {
    if (!readPdConfig()) return [] as PdAccountRow[];
    return rowsOf(refresh ? await pdAccounts() : cachedPdAccounts());
  }));
  ipcMain.handle("pipedream-connect", (e, app: string) => run(async () => {
    const slug = String(app ?? "").trim();
    if (!slug) throw new Error("Which app?");
    if (inFlight.has(slug)) throw new Error("Already connecting this app — finish in your browser, or cancel.");
    const ctl = new AbortController();
    inFlight.set(slug, ctl);
    try {
      const r = await pdConnect(slug, {
        // The renderer opens the link in Glyphh's browser panel on "waiting".
        open: () => undefined,
        signal: ctl.signal,
        onProgress: (p) => { if (!e.sender.isDestroyed()) e.sender.send("pipedream:connect-progress", p); },
      });
      if (r.ok) await changed(slug);
      return r;
    } finally {
      inFlight.delete(slug);
    }
  }));
  ipcMain.handle("pipedream-connect-cancel", (_e, app: string) => run(() => {
    const ctl = inFlight.get(String(app ?? ""));
    ctl?.abort();
    return { cancelled: !!ctl };
  }));
  ipcMain.handle("pipedream-disconnect", (_e, accountId: string) => run(async () => {
    const id = String(accountId ?? "");
    const app = cachedPdAccounts().find((a) => a.id === id)?.app;
    await pdDeleteAccount(id);
    await changed(app);
    return rowsOf(cachedPdAccounts());
  }));
  ipcMain.handle("pipedream-app-enable", (_e, app: string, on: boolean) => run(async () => {
    setPdAppEnabled(String(app ?? ""), on !== false);
    await changed(String(app ?? ""));
    return rowsOf(cachedPdAccounts());
  }));
  /** One connected app's tools, as its MCP server publishes them. */
  ipcMain.handle("pipedream-tools", (_e, app: string) => run(async () => {
    const tools = await connectionTools(pdConnectionId(String(app ?? "")));
    return tools.map((t) => ({ name: t.name, description: t.description }));
  }));

  // The cache answers until Pipedream does: refresh it once at start, so an
  // account connected or removed elsewhere shows up without a visit to Settings.
  if (readPdConfig()) void pdAccounts().then(() => changed(), () => undefined);
}
