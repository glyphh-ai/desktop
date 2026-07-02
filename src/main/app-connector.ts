/**
 * AppConnector — manages app configs with command-to-DOM mappings.
 *
 * Each app is a panel with a connector: mapped commands that know
 * how to grab content against the app's live DOM.
 *
 * Stored encrypted at rest in ~/yo/apps/{id}.json (see secure-store.ts) — the
 * MCP OAuth client secret must never sit in plaintext on disk.
 */

import fs from "fs";
import path from "path";
import os from "os";
import { encryptJson, decryptJson } from "./secure-store";
// ── Types ───────────────────────────────────────────────

/** Execution intelligence attached to a command — makes the agent reliable. */
export interface CommandGuide {
  /** What must be true before running, e.g. "compose window must be open" */
  pre?: string;
  /** What to expect after success, e.g. "email is sent, compose window closes" */
  post?: string;
  /** CSS selector to check after execution — confirms success */
  verify?: string;
  /** What to try if the command fails, e.g. "try the icon button instead" */
  recover?: string;
  /** Milliseconds to wait after executing before checking verify */
  delay?: number;
}

export interface CommandMapping {
  selector: string;
  action: "extractText" | "extractHTML" | "setValue" | "click" | "custom";
  description: string;
  text?: string; // element text for fallback matching when selector fails
  script?: string; // custom JS for action === "custom"
  waitFor?: string; // selector to wait for before executing
  /** Mini-skill: execution intelligence for reliable automation */
  guide?: CommandGuide;
}

// ── Panel tab: UI-driven interaction via DOM ──
export interface PanelConfig {
  commands: Record<string, CommandMapping>;
}

// ── Connection tab: API-driven via Pipedream OAuth ──
export interface ConnectionConfig {
  pipedreamSlug: string;
  accountId?: string;
  healthy?: boolean;
}

// ── MCP tab: external tool server ──
/**
 * OAuth2 client-credentials for an authenticated streamable-http MCP server.
 * When present, the client mints a short-lived bearer token from `tokenUrl`
 * (refreshing as it expires) and sends it as `Authorization: Bearer …` on every
 * request — the dynamic-token case that static `headers` can't handle. The
 * `clientSecret` is sensitive, which is why app configs are encrypted at rest.
 */
export interface McpOAuth {
  clientId: string;
  clientSecret: string;
  tokenUrl: string;
  scope?: string;
}

export interface McpConfig {
  transport: "stdio" | "sse" | "streamable-http";
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  oauth?: McpOAuth;
  enabled: boolean;
}

/** Visibility tier. `user` apps show in the Apps registry + Layouts builder.
 *  `system` apps only appear in the `+` picker and via `.dip` — they're the
 *  former left-rail surfaces wrapped as panels. */
export type AppKind = "user" | "system";

export interface AppConfig {
  id: string;
  name: string;

  // ── Dashboard ──
  url?: string;
  forceWeb?: boolean;
  meta?: {
    description: string;
    category?: string;
    capabilities: string[];
  };

  /** Where this app shows up. Defaults to "user" (registry + layouts + `+`). */
  kind?: AppKind;
  /** True if the app ships with .Yo (everything in INTERNAL_APPS). Internal
   *  apps are HIDDEN from the Apps registry (no CRUD — can't edit, rename, delete, or change
   *  URL), and stay visible in the `+` picker, `.dip`, and Layouts. The
   *  `kind: "system"` flag separately controls Layouts visibility. */
  internal?: boolean;
  /** True if the app needs a working folder. Folder-bound apps own a picker
   *  in their header (unless mounted inside a folder-bound layout, which
   *  hoists the picker to the layout). */
  requiresFolder?: boolean;

  // ── Panel (UI-driven) ──
  connected: boolean;
  commands: Record<string, CommandMapping>;
  panel?: PanelConfig;

  // ── Connection (Pipedream API) ──
  connection?: ConnectionConfig;

  // ── MCP (external tool server) ──
  mcp?: McpConfig;
}

/** Commands every app should map */
export const STANDARD_COMMANDS = [
  { key: "grab", description: "Extract main content/conversation from the page" },
  { key: "input", description: "Focus the primary text input (chat box, compose field, search bar)" },
  { key: "submit", description: "Click the primary submit/send button" },
  { key: "new", description: "Start a new item (new chat, compose email, new document)" },
  { key: "search", description: "Focus or open the search interface" },
] as const;

/** Category-specific commands the connector agent should discover */
export const CATEGORY_COMMANDS: Record<string, Array<{ key: string; description: string }>> = {
  chat: [
    { key: "read-latest", description: "Extract the most recent response/message" },
    { key: "list-threads", description: "List conversation threads in sidebar" },
    { key: "new-chat", description: "Start a new conversation" },
    { key: "stop", description: "Stop/cancel an in-progress generation" },
    { key: "copy-last", description: "Copy the last assistant response" },
  ],
  email: [
    { key: "compose", description: "Open compose/new email window" },
    { key: "reply", description: "Reply to the current email" },
    { key: "inbox", description: "Navigate to inbox" },
    { key: "read-email", description: "Extract the currently open email content" },
    { key: "to-field", description: "Focus the To recipient field" },
    { key: "subject-field", description: "Focus the Subject field" },
    { key: "body-field", description: "Focus the email body field" },
    { key: "send", description: "Click the send button" },
  ],
  project: [
    { key: "create-item", description: "Create a new issue/task/ticket" },
    { key: "list-items", description: "List visible issues/tasks" },
    { key: "comment", description: "Add a comment to the current item" },
    { key: "assign", description: "Open the assignee picker" },
    { key: "status", description: "Open the status/state picker" },
  ],
  docs: [
    { key: "new-doc", description: "Create a new document" },
    { key: "title-field", description: "Focus the document title" },
    { key: "body-field", description: "Focus the document body editor" },
    { key: "share", description: "Open the share dialog" },
  ],
  social: [
    { key: "post", description: "Open new post/tweet composer" },
    { key: "feed", description: "Extract visible feed content" },
    { key: "notifications", description: "Navigate to notifications" },
    { key: "like", description: "Like/heart the focused item" },
  ],
  code: [
    { key: "file-tree", description: "Extract the visible file tree" },
    { key: "open-file", description: "Open the file finder/picker" },
    { key: "terminal", description: "Focus or open the terminal" },
    { key: "run", description: "Run/execute the current file or test" },
  ],
  search: [
    { key: "read-result", description: "Click/open the first search result" },
    { key: "images", description: "Switch to image search results" },
    { key: "news", description: "Switch to news search results" },
  ],
};

// Internal apps — these use yo:// protocol.
// `kind: "system"` apps are hidden from the Apps registry + Layouts builder.
// Every entry here gets `internal: true` applied below — they all ship
// with .Yo and must never be CRUD-able in the Apps registry, never
// captured, etc. `kind: "system"` is a separate axis controlling whether
// the app appears in Layouts (rail surfaces don't; user-mountable
// internal apps like Agent/Vibe/Spec do).
// Dashboard shell (5a): Agents/Schedules/Layouts/Skills/Drips/Settings/Home
// are no longer local internal apps — that management UI is server-side
// (yo-platform's Build/Manage pages) now, not a local panel. Only real local
// execution surfaces stay: Browser and Terminal, plus the Dashboard's own
// Apps/Settings tabs (which aren't the old left-rail CRUD pages — "apps" is
// the Apps-tab webview container, "dashboard-settings" is the trimmed
// General/Appearance/MCP settings panel).
const INTERNAL_APPS: Array<{ id: string; name: string; url: string; kind?: AppKind; requiresFolder?: boolean }> = [
  { id: "term", name: "Terminal", url: "yo://terminal", requiresFolder: true },
  { id: "browser", name: "Browser", url: "yo://browser" },
  { id: "apps", name: "Apps", url: "yo://apps", kind: "system" },
  { id: "layouts", name: "Layouts", url: "yo://layouts", kind: "system" },
  { id: "drips", name: "Drips", url: "yo://drips", kind: "system" },
  { id: "skills", name: "Skills", url: "yo://skills", kind: "system" },
  { id: "dashboard-settings", name: "Settings", url: "yo://dashboard-settings", kind: "system" },
  { id: "about", name: "About", url: "yo://about", kind: "system" },
];

// ── AppConnector ───────────────────────────────────────

export class AppConnector {
  private apps: Map<string, AppConfig> = new Map();
  private appsDir: string;
  private onChange: (() => void) | null = null;
  private watcher: fs.FSWatcher | null = null;
  private syncTimer: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    this.appsDir = path.join(os.homedir(), "yo", "apps");
    fs.mkdirSync(this.appsDir, { recursive: true });
    this.loadAll();
    this.ensureDefaults();
  }

  /** Register a callback fired (debounced) whenever the apps directory changes
   *  on disk. Lets the main process broadcast a refresh to the renderer so an
   *  app dropped into ~/yo/apps appears without restarting yo. */
  setOnChange(cb: () => void): void {
    this.onChange = cb;
  }

  /** Begin watching ~/yo/apps for added/changed/removed app json files. Safe to
   *  call once (idempotent); a burst of writes is debounced into one reload. */
  startWatching(): void {
    if (this.watcher) return;
    try {
      this.watcher = fs.watch(this.appsDir, { persistent: false }, () => {
        if (this.syncTimer) clearTimeout(this.syncTimer);
        this.syncTimer = setTimeout(() => {
          this.syncTimer = null;
          if (this.syncFromDisk()) this.onChange?.();
        }, 150);
      });
    } catch (err) {
      console.warn("[app-connector] failed to watch apps dir:", (err as Error).message);
    }
  }

  /** Stop the apps-dir watcher (e.g. on shutdown). */
  stopWatching(): void {
    if (this.syncTimer) { clearTimeout(this.syncTimer); this.syncTimer = null; }
    this.watcher?.close();
    this.watcher = null;
  }

  /** Re-read the apps directory, picking up added / changed / removed json
   *  files. Read-only (never writes) so it can't trigger its own watcher.
   *  Returns true if the in-memory map actually changed. */
  private syncFromDisk(): boolean {
    if (!fs.existsSync(this.appsDir)) return false;
    let changed = false;
    const onDisk = new Set<string>();
    for (const file of fs.readdirSync(this.appsDir)) {
      if (!file.endsWith(".json")) continue;
      try {
        const app = decryptJson<AppConfig>(fs.readFileSync(path.join(this.appsDir, file)));
        if (!app?.id) continue;
        onDisk.add(app.id);
        const prev = this.apps.get(app.id);
        if (!prev || JSON.stringify(prev) !== JSON.stringify(app)) {
          this.apps.set(app.id, app);
          changed = true;
        }
      } catch {
        // Skip corrupt / mid-write files — the next watcher tick re-reads them.
      }
    }
    // Drop user apps whose backing file was deleted. Never drop internal apps:
    // they're re-seeded from INTERNAL_APPS and may be momentarily mid-rewrite.
    for (const [id, app] of [...this.apps]) {
      if (!onDisk.has(id) && !app.internal) {
        this.apps.delete(id);
        changed = true;
      }
    }
    return changed;
  }

  /** Seed internal + default apps on first launch */
  private ensureDefaults(): void {
    // Purge stale internal entries persisted to ~/yo/apps/<id>.json on a
    // prior launch. Dropping them from INTERNAL_APPS alone leaves them in
    // the app list, so we explicitly delete the entry + the file.
    //   - drop, files, vscode, monaco, code, yo-editor  → removed builds
    //   - context                                       → removed feature
    //   - *-app suffixed ids                            → left over from
    //     a Phase 0a rename where each left-rail section briefly used a
    //     "<slug>-app" id alongside the cleaner "<slug>" id, leaving two
    //     of every system app in the + picker on already-installed clients.
    const STALE_IDS = [
      "drop", "files", "monaco", "code", "yo-editor",
      "context",
      "agents-app", "apps-app", "councils-app", "drips-app",
      "layouts-app", "schedules-app", "settings-app", "skills-app",
      "vibes-app", "dashboard-app",
      "vibe", "vibes", "council", "councils", "spec", "welcome",
    ];
    for (const staleId of STALE_IDS) {
      const stale = this.apps.get(staleId);
      if (stale && stale.url?.startsWith("yo://")) {
        this.apps.delete(staleId);
        try { fs.unlinkSync(path.join(this.appsDir, `${staleId}.json`)); } catch { /* ignore */ }
        console.log(`[app-connector] purged removed internal app: ${staleId}`);
      }
    }

    // Apps removed from the product entirely (Agent / Plan / Ada panels, and
    // — Dashboard shell (5a) — the left-rail CRUD pages now server-side on
    // yo-platform) — purge unconditionally; these ids aren't real apps any more.
    const REMOVED_IDS = [
      "agent", "plan", "ada", "adal", "workbench", "vscode",
      "home", "agents", "schedules", "layouts", "skills", "drips", "settings",
    ];
    for (const id of REMOVED_IDS) {
      if (this.apps.has(id)) {
        this.apps.delete(id);
        try { fs.unlinkSync(path.join(this.appsDir, `${id}.json`)); } catch { /* ignore */ }
        console.log(`[app-connector] purged removed app: ${id}`);
      }
    }

    for (const def of INTERNAL_APPS) {
      if (!this.apps.has(def.id)) {
        const app = this.add(def.id, def.name, def.url);
        app.internal = true;
        let dirty = true; // we just set internal
        if (def.kind) { app.kind = def.kind; dirty = true; }
        if (def.requiresFolder) { app.requiresFolder = def.requiresFolder; dirty = true; }
        if (dirty) this.save(app);
      } else {
        const app = this.apps.get(def.id)!;
        let dirty = false;
        if (app.url !== def.url) { app.url = def.url; dirty = true; }
        if (!app.internal) { app.internal = true; dirty = true; }
        if (def.kind && app.kind !== def.kind) { app.kind = def.kind; dirty = true; }
        if (def.requiresFolder && app.requiresFolder !== def.requiresFolder) { app.requiresFolder = def.requiresFolder; dirty = true; }
        if (dirty) this.save(app);
      }
    }

    // Apps are server-authoritative now (the Apps tab reads /api/panel-apps).
    // Any real-URL app still sitting in the local ~/yo/apps store is a stale
    // seed from an older build — purge it (entry + file) so it stops showing
    // up anywhere the local registry is read (e.g. the Layouts cell picker).
    // Only the yo:// internal surfaces stay local: Browser, Terminal, and the
    // system config pages (Apps/Layouts/Drips/Settings/About).
    for (const [id, app] of [...this.apps]) {
      if (app.url && !app.url.startsWith("yo://")) {
        this.apps.delete(id);
        try { fs.unlinkSync(path.join(this.appsDir, `${id}.json`)); } catch { /* ignore */ }
        console.log(`[app-connector] purged local app (now server-authoritative): ${id}`);
      }
    }
  }

  /** Import a full app config (from exported JSON). Overwrites if same id exists. */
  importApp(config: AppConfig): AppConfig {
    const app: AppConfig = {
      id: config.id,
      name: config.name,
      url: config.url,
      connected: Object.keys(config.commands || {}).length > 0,
      commands: config.commands || {},
      ...(config.forceWeb ? { forceWeb: config.forceWeb } : {}),
      ...(config.meta ? { meta: config.meta } : {}),
    };
    this.apps.set(app.id, app);
    this.save(app);
    return app;
  }

  /** Add a new app */
  add(id: string, name: string, url?: string, forceWeb?: boolean): AppConfig {
    const app: AppConfig = {
      id,
      name,
      connected: false,
      commands: {},
      ...(url ? { url } : {}),
      ...(forceWeb ? { forceWeb } : {}),
    };
    this.apps.set(id, app);
    this.save(app);
    // Notify listeners (left-rail Apps list, panel pickers) so the new app shows
    // up immediately. The file watcher won't catch this — add() already updated
    // the in-memory map, so syncFromDisk() sees no diff and never fires onChange.
    this.onChange?.();
    return app;
  }

  /** Update an app's name */
  updateName(id: string, name: string): boolean {
    const app = this.apps.get(id);
    if (!app) return false;
    app.name = name;
    this.save(app);
    this.onChange?.();
    return true;
  }

  updateUrl(id: string, url: string): boolean {
    const app = this.apps.get(id);
    if (!app) return false;
    app.url = url;
    this.save(app);
    return true;
  }

  updateForceWeb(id: string, forceWeb: boolean): boolean {
    const app = this.apps.get(id);
    if (!app) return false;
    if (forceWeb) {
      app.forceWeb = true;
    } else {
      delete app.forceWeb;
    }
    this.save(app);
    return true;
  }

  /** True when the app ships with .Yo (INTERNAL_APPS). Hides it from the
   *  Apps registry (no CRUD), but it still mounts. */
  isInternal(id: string): boolean {
    const baseId = id.replace(/-\d+$/, "");
    const app = this.apps.get(id) || this.apps.get(baseId);
    return !!app?.internal;
  }

  /** Update an app's ID (renames file and map entry) */
  updateId(oldId: string, newId: string): boolean {
    newId = newId.toLowerCase().replace(/[^a-z0-9_-]/g, "-");
    if (!newId || oldId === newId) return false;
    const app = this.apps.get(oldId);
    if (!app || this.apps.has(newId)) return false;
    // Remove old file
    const oldPath = path.join(this.appsDir, `${oldId}.json`);
    try { fs.unlinkSync(oldPath); } catch { /* ok */ }
    // Update map
    this.apps.delete(oldId);
    app.id = newId;
    this.apps.set(newId, app);
    this.save(app);
    this.onChange?.();
    return true;
  }

  /** Check if an ID is a directly registered app (not an instance resolution) */
  hasDirect(id: string): boolean {
    return this.apps.has(id);
  }

  /** Get an app config */
  get(id: string): AppConfig | null {
    const direct = this.apps.get(id);
    if (direct) return direct;
    // Instance IDs: "gmail-2" → "gmail", "browse-3" → "browser"
    if (id.startsWith("browse-")) return this.apps.get("browser") ?? null;
    const dash = id.lastIndexOf("-");
    if (dash > 0 && /^\d+$/.test(id.slice(dash + 1))) {
      return this.apps.get(id.slice(0, dash)) ?? null;
    }
    return null;
  }

  /** List all apps */
  list(): AppConfig[] {
    return Array.from(this.apps.values());
  }

  /** Update an app's command mappings (from agent or picker) */
  updateCommands(id: string, commands: Record<string, CommandMapping>, meta?: AppConfig["meta"]): boolean {
    const app = this.apps.get(id);
    if (!app) return false;
    app.commands = { ...app.commands, ...commands };
    if (meta) app.meta = meta;
    app.connected = Object.keys(app.commands).length > 0;
    this.save(app);
    return true;
  }

  /** Update a single command mapping (from DOM picker) */
  setCommand(id: string, commandKey: string, mapping: CommandMapping): boolean {
    const app = this.apps.get(id);
    if (!app) return false;
    app.commands[commandKey] = mapping;
    app.connected = true;
    this.save(app);
    return true;
  }

  /** Remove a command mapping */
  removeCommand(id: string, commandKey: string): boolean {
    const app = this.apps.get(id);
    if (!app) return false;
    delete app.commands[commandKey];
    app.connected = Object.keys(app.commands).length > 0;
    this.save(app);
    return true;
  }

  /** Delete an app entirely */
  remove(id: string): boolean {
    if (!this.apps.has(id)) return false;
    this.apps.delete(id);
    const filePath = path.join(this.appsDir, `${id}.json`);
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    this.onChange?.(); // refresh the rail/pickers (watcher won't — in-memory already changed)
    return true;
  }

  // ── Connection (Pipedream) ─────────────────────────

  setConnection(id: string, connection: ConnectionConfig): boolean {
    const app = this.apps.get(id);
    if (!app) return false;
    app.connection = connection;
    this.save(app);
    return true;
  }

  removeConnection(id: string): boolean {
    const app = this.apps.get(id);
    if (!app || !app.connection) return false;
    delete app.connection;
    this.save(app);
    return true;
  }

  /** All apps that have a Pipedream connection configured */
  listConnected(): AppConfig[] {
    return [...this.apps.values()].filter((a) => a.connection?.accountId);
  }

  /** Find an app by its Pipedream slug */
  findByPipedreamSlug(slug: string): AppConfig | null {
    for (const app of this.apps.values()) {
      if (app.connection?.pipedreamSlug === slug) return app;
    }
    return null;
  }

  // ── MCP (external tool server) ─────────────────────

  setMcp(id: string, mcp: McpConfig): boolean {
    const app = this.apps.get(id);
    if (!app) return false;
    app.mcp = this.preserveOAuthSecret(mcp, app.mcp);
    this.save(app);
    return true;
  }

  updateMcp(id: string, updates: Partial<McpConfig>): boolean {
    const app = this.apps.get(id);
    if (!app || !app.mcp) return false;
    const merged = { ...app.mcp, ...updates };
    app.mcp = this.preserveOAuthSecret(merged, app.mcp);
    this.save(app);
    return true;
  }

  /** The OAuth client secret is redacted before it ever reaches the renderer
   *  (see apps-ipc), so an incoming config with a blank secret means "keep the
   *  one already on disk". Only a non-empty secret actually replaces it. */
  private preserveOAuthSecret(next: McpConfig, prev: McpConfig | undefined): McpConfig {
    if (next.oauth && !next.oauth.clientSecret && prev?.oauth?.clientSecret) {
      return { ...next, oauth: { ...next.oauth, clientSecret: prev.oauth.clientSecret } };
    }
    return next;
  }

  removeMcp(id: string): boolean {
    const app = this.apps.get(id);
    if (!app || !app.mcp) return false;
    delete app.mcp;
    this.save(app);
    return true;
  }

  /** All apps that have an MCP server configured */
  listMcp(): AppConfig[] {
    return [...this.apps.values()].filter((a) => a.mcp);
  }

  /** Get MCP configs in the format McpManager expects */
  getMcpConfigs(): Array<McpConfig & { id: string; name: string }> {
    return this.listMcp().map((a) => ({
      ...a.mcp!,
      id: a.id,
      name: a.name,
    }));
  }

  // ── Persistence ─────────────────────────────────────
  //
  // Internal apps (INTERNAL_APPS) are never written to disk — they're
  // static, fully re-derivable from code on every boot, and used to get
  // needlessly persisted as individually safeStorage-encrypted files. That
  // meant every boot decrypted ~15 files with nothing sensitive in them,
  // hitting the OS keychain every single launch.
  //
  // User app files are plain JSON. The one genuinely sensitive field — a
  // custom MCP server's OAuth client secret — is encrypted individually
  // (only when actually present), not the whole file.

  private save(app: AppConfig): void {
    if (app.internal) return;
    const secret = app.mcp?.oauth?.clientSecret;
    const toWrite: AppConfig = secret
      ? { ...app, mcp: { ...app.mcp!, oauth: { ...app.mcp!.oauth!, clientSecret: encryptSecretField(secret) } } }
      : app;
    fs.writeFileSync(
      path.join(this.appsDir, `${app.id}.json`),
      JSON.stringify(toWrite, null, 2),
      { mode: 0o600 },
    );
  }

  /** Read one app file — plain JSON (current format), with a one-time
   *  fallback to the legacy whole-file-encrypted format (self-migrates: the
   *  next save() call rewrites it as plain JSON with only the secret field
   *  encrypted, so the legacy path only ever runs once per file). */
  private readAppFile(filePath: string): AppConfig | null {
    const raw = fs.readFileSync(filePath);
    try {
      const app = JSON.parse(raw.toString("utf-8")) as AppConfig;
      const secret = app.mcp?.oauth?.clientSecret;
      if (secret) app.mcp = { ...app.mcp!, oauth: { ...app.mcp!.oauth!, clientSecret: decryptSecretField(secret) } };
      return app;
    } catch {
      // Legacy whole-file-encrypted format — decrypt once via safeStorage,
      // then immediately rewrite in the new plain format.
      const legacy = decryptJson<AppConfig>(raw);
      if (legacy) { try { this.save(legacy); } catch { /* best-effort */ } }
      return legacy;
    }
  }

  private loadAll(): void {
    if (!fs.existsSync(this.appsDir)) return;
    for (const file of fs.readdirSync(this.appsDir)) {
      if (!file.endsWith(".json")) continue;
      try {
        const app = this.readAppFile(path.join(this.appsDir, file));
        if (app?.id) this.apps.set(app.id, app);
      } catch {
        // skip corrupt files
      }
    }
  }
}

/** Encrypt just the OAuth client secret string (base64-encoded ciphertext) —
 *  not the whole app config. Only touches safeStorage when an app actually
 *  has a custom MCP server with a client secret configured, which is rare. */
function encryptSecretField(plaintext: string): string {
  return encryptJson(plaintext).toString("base64");
}

function decryptSecretField(value: string): string {
  try {
    const decoded = decryptJson<string>(Buffer.from(value, "base64"));
    return typeof decoded === "string" ? decoded : value;
  } catch {
    return value;
  }
}
