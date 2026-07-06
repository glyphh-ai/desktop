# Apps world — design + refactor plan

> The first wave of `.yo` apps: **Welcome**, **Vibe**, **Spec**, **Agent**.
> They sit alongside Council, Browser, Terminal, Context, Home in the internal
> `yo://` namespace. Each app is a primitive a user can mount any number of
> times to build their own layouts. The **right-rail .Yo** stays as the global
> wrapper agent. The worker-bee agents (configurable, foldered, per-instance)
> get a first-class app at `yo://agent`.

## 0. The frame

### Two kinds of agents — never the same code path

- **Right-rail .Yo** — the wrapper. One per yo-client window. **Always cwd-ed
  at `~/.glyphh/`**, covers every folder the user touches. Locked to Claude Code
  today. Carries the heavier orchestration burden.
- **Agent app instances** — the worker bees. Many per user. Each has its own
  identity (name, avatar, bio), tool whitelist by app+skill+ad-hoc, model
  choice, guardrails. Mounted as panels; each instance owns its own cwd.

### Two app categories

- **Folder-bound apps** (`requiresFolder: true`) — Agent, Vibe, Spec, Terminal,
  Files (coming). Need a working directory to function.
- **Free apps** (`requiresFolder: false`) — everything else: the 3500
  Pipedream/LLM apps, the system apps, the Browser, etc.

### Two visibility tiers (along an orthogonal axis)

- **User apps** — listed in the Apps registry (`yo://apps`), pickable in `+`,
  composable in Layouts. Examples: Agent, Vibe, Spec, Browser, Terminal,
  Council, Context, plus all the third-party LLM and productivity apps.
- **System apps** — the surfaces that used to live inline in the left rail.
  **Hidden** from the Apps registry, **hidden** from Layouts, but **listed**
  in the `+` picker and addressable by `.dip`. Examples: Dashboard, Apps
  (meta), Agents, Vibes, Councils, Schedules, Layouts, Skills, Drips,
  Settings, Welcome.

## 1. The folder model

There is no "workspace" abstraction. There are folders and apps that bind to
them.

### 1.1 Per-instance folder ownership

Each folder-bound app instance owns its own cwd. Two Vibes can coexist on
`/dev-a` and `/dev-b` simultaneously because each remembers its own folder.
Same for two Agents, two Terminals.

### 1.2 The picker lives in app chrome

The workdir picker currently in the right-rail `.Yo` (`index.html:241-265`)
moves out. Each folder-bound app's header gets the same picker (pick existing
+ create new + recents). This is the only place a folder is selected.

### 1.3 Folder-bound layouts

A layout's folder requirement is computed:

```
layout.folderRequired = layout.panels.some(p => app(p).requiresFolder)
```

When `folderRequired` is true:

- The **layout** owns the picker (one folder for the entire layout, hoisted
  into the layout chrome).
- Folder-bound panels inside the layout **hide their own picker** and read
  cwd from the layout. Mechanism: main passes
  `layoutContext: { folder, layoutId }` to the panel preload at mount; the
  panel checks for `layoutContext` on init and routes accordingly.
- A layout-level folder change re-cwds every folder-bound panel inside.

When `folderRequired` is false: no picker, no folder context.

### 1.4 Saving layouts

Saved layouts **do not bake in a folder**. Folder is provided at load time.
You can save a layout while panels happen to be on mixed folders — the
saved layout just records "panel A is Vibe, panel B is Spec, panel C is
Terminal." On load, the user picks one folder and all `requiresFolder`
panels bind to it.

## 2. The left rail

### 2.1 What's there

Top half: launcher buttons for the system apps (Dashboard, Apps, Agents,
Vibes, Councils, Schedules, Layouts, Skills, Drips). Click → opens that
system app in a panel.

Bottom half: **Recent** — chronological history of folder-bound app/layout
instances. Two-line rows:

```
Vibe                /Users/foo/project-a
Spec                /Users/foo/novel
Layout: fullstack   /Users/foo/project-a
Terminal            /Users/foo/yosup
```

Click → re-opens that app/layout at that folder. Only `requiresFolder` apps
and `folderRequired` layouts appear here; Gmail / Drips / Browser do not.

The two halves are separated by a draggable divider; the ratio is persisted
(`leftRailSplit`).

### 2.2 What moves out of the rail

- **Settings** → header gear icon, far right of the topbar, next to the
  right-rail (.Yo) icon. Clicking opens `yo://settings`.
- **Sign Out** → into `yo://settings` → General tab. Remove
  `files-rail-logout` (`index.html:402-405`).

## 3. Boot flow

```
boot → restore last panel layout if any
     → else show yo://welcome
```

Pref: `welcomeOnStartup` (default true). If unchecked and no panels to
restore, boot lands on an empty panel grid with the left rail and right rail
visible.

### 3.1 yo://welcome

System app. Layout top to bottom:

1. **Hero** — centered `.Yo` logo + rotating tagline.
2. **Two cards: Vibe · Spec** — the two fundamental dev planes. Click →
   picker dialog → opens that app on the picked folder.
3. **Recent** — same data source as the left-rail Recent + chat-history
   workdir picker.
4. **Footer** — "Show on startup" checkbox.

## 4. The Agent app (`yo://agent`)

The worker-bee primitive. URL forms:

- `yo://agent` — opens the agent named `default` (creates if missing using
  Settings → Agent Defaults).
- `yo://agent/<slug>` — opens a named agent.

A single Agent panel is **one identity** (one `AgentConfig`) running one
chat at a time. Multiple Agent panels can coexist, even pointed at the same
slug (separate chats, separate folders).

## 5. Worker-bee agents — reuse what already exists

`src/main/agent-store.ts:45-98` already defines the full identity + tool
model:

```ts
interface AgentConfig {
  id: string; name: string;            // identity
  avatar_url?: string; bio?: string;   // generative avatar fallback in UI
  role?: string; systemPrompt?: string;
  apps?: string[];                     // whitelisted apps
  appConfigs?: Record<string, { allowAll?: boolean; panelTools?: string[]; mcpTools?: string[] }>;
  skills?: string[];                   // whitelisted skills
  mcp_servers?: string[];
  builtin_tools?: string[];
  tool_permissions?: { shell, file_system, git, browser, mcp };
  model_provider?: string; model_name?: string;
  mode?: "full" | "readonly";
  guardrails?: Guardrails;
  joinable?: boolean; remote?: RemoteConfig;
}
```

This is the worker-bee schema. **We don't redesign it.** Changes:

- **Foldered, not flat.** Migrate `~/.glyphh/agents/{id}.json` →
  `~/.glyphh/agents/<slug>/` so `CLAUDE.md` (the editable system prompt) and
  `avatar.png` can live alongside. `agent.json` is the config file inside.
- **Runtime is per-folder, not per-workspace.** Chat history scopes to the
  folder the Agent panel is bound to:
  ```
  ~/.glyphh/agents/<slug>/
    agent.json
    CLAUDE.md
    avatar.png?

  <agent-cwd>/.yo/agents/<slug>/
    history/<chat-id>.jsonl
    state.json    # last chat id, ui prefs
  ```
  Identity follows the user; conversations stay with the folder they
  happened in.

## 6. Engine — reuse `agent-runner.ts`

`src/main/agent-runner.ts` (621 lines) already spawns Claude Agent SDK
instances per agent for cypher slots. Add an **interactive mode** so it can
also drive a single user-facing chat panel:

- New entry: `runner.startInteractive(agentInstanceId, agentSlug, cwd, callbacks)`
- Per-instance state, keyed by `agentInstanceId` (== panel webview id).
- Streams events on per-instance IPC channels: `agent:<id>:token`,
  `agent:<id>:tool-use`, `agent:<id>:tool-result`, `agent:<id>:done`,
  `agent:<id>:error`. No more "send to focused window."

`YoChat` (right-rail) stays untouched.

## 7. Shared UI — extract `YoAgentRenderer`

`renderer/yo-panel-ui.ts` (2015 lines) carves into two:

- **`renderer/yo-agent-renderer.ts`** — pure visual layer. Mounts into a
  host element, owns its own DOM (no shared IDs), owns per-instance state
  (perm, model, input history, messages, pending UI), exposes render
  methods + emits `onSend/onStop/onClear/onPermChange/onModelChange`
  callbacks. Multiple instances must coexist on one page.
- **`renderer/yo-panel-ui.ts`** (thin adapter) — overlay chrome: slide
  in/out, resize handle, close button, grid handle callback. Mounts a
  `YoAgentRenderer` and wires the existing `window.yo.onYoPanel*` IPC to
  renderer methods.

The Agent app shell uses the same `YoAgentRenderer`, wired to the
per-instance `agent:<id>:*` channels.

## 8. Right-rail .Yo changes

Three things change in the right rail:

1. **Workdir bar removed.** The `yo-workdir-bar` markup
   (`index.html:241-265`) and its wiring come out. The right-rail agent
   cwds to `~/.glyphh/` always.
2. **The picker that used to live here moves into folder-bound app
   chrome.** Same UI code, reparented.
3. **Chat history shows folders** — same data source the Welcome screen
   and left-rail Recent read.

## 9. Left-rail surfaces become system apps

Every section currently rendered inline in the left rail becomes its own
internal app:

| Left-rail section | App URL              |
|-------------------|----------------------|
| Dashboard         | `yo://dashboard`     |
| Apps              | `yo://apps`          |
| Agents            | `yo://agents`        |
| Vibes             | `yo://vibes`         |
| Councils          | `yo://councils`      |
| Schedules         | `yo://schedules`     |
| Layouts           | `yo://layouts`       |
| Skills            | `yo://skills`        |
| Drips             | `yo://drips`         |
| Settings          | `yo://settings`      |
| (boot fallback)   | `yo://welcome`       |

Visibility rules (system apps):

- ❌ Not listed in the Apps registry.
- ❌ Not listed in Layouts.
- ✅ Listed in the `+` panel picker.
- ✅ Addressable by `.dip <slug>`.

Mechanism: add `category: "user" | "system"` to `InternalApp` in
`src/main/app-connector.ts:161`. The Apps registry filters
`category !== "system"`. The Layouts picker does the same. The `+` picker
includes everything.

Most of these already exist as inline panels in `home.html` + `help.ts`.
The migration per section: create `renderer/<slug>.html` + a thin TS entry
that mounts the existing `help/<slug>.ts` controller, route `yo://<slug>`
in `main.ts`, add the `app-connector.ts` entry with `category: "system"`.

## 10. Per-instance IPC — the structural fix

Today the right-rail's IPC channels (`yo-panel:*`) target the focused
window. Multi-instance breaks under that model. The new pattern:

- Every Agent app webview generates an `agentInstanceId` on construction.
- All IPC carries `agentInstanceId` as the first arg.
- Main routes streamed events back via `webContents.send` to the specific
  webview, on channels keyed by id: `agent:<id>:token` etc.
- A small `AgentRegistry` (main) tracks live instances → engines.

The right-rail keeps its existing global channels. No conflict.

## 11. Settings → Agent Defaults (new tab)

Sits alongside Settings → Providers. Defaults for new agent creation:

- Default provider + model (from the Providers catalog)
- Default permission mode
- Default system prompt (a `CLAUDE.md` template)
- Default whitelisted apps + skills + MCP servers

Stored at `~/.glyphh/.agent-defaults.json`. Consumed by
`agent-store.createFromDefaults(slug)`.

## 12. Phased plan

Each phase is independently shippable. Don't start the next until the
previous is on main and the right-rail still works.

### Phase 0 — Folder model + Welcome
- `yo://welcome` app (HTML + preload + main wiring + app-connector entry,
  `category: "system"`).
- Boot routing: restore last panels → else Welcome.
- `Recent` data source extracted into a shared IPC, fed by folder-bound
  app/layout mounts.
- Remove `yo-workdir-bar` from the right-rail; right-rail always cwds
  `~/.glyphh/`. The picker UI is reparented (becomes a reusable component for
  app chrome).
- Pref: `welcomeOnStartup`.

**Acceptance:** Fresh launch shows Welcome. Click Vibe → folder picker →
existing vibe flow runs. Right-rail has no workdir picker. The Welcome
Recents and left-rail Recent show the same list.

### Phase 0a — System-app category + left-rail surfaces as apps
- Add `category: "user" | "system"` + `requiresFolder: boolean` to
  `InternalApp`.
- Wrap each left-rail section in a `yo://<slug>` app: thin shells that
  mount existing `help/<slug>.ts` controllers.
- Apps registry + Layouts picker filter out `category === "system"`.
- `+` picker shows system apps in a dedicated section.
- `.dip <slug>` resolves to the system app when slug matches.
- Header gear icon (far right, next to right-rail icon) → `yo://settings`.
- Remove `files-rail-logout`; move Sign Out into Settings → General.
- Left-rail buttons become quick-launchers that open the matching
  `yo://…` app in a panel.
- Left rail bottom = Recent history (folder-bound only). Draggable
  divider; persist `leftRailSplit`.

**Acceptance:** Every left-rail click opens the section in a panel.
System apps appear in `+` and `.dip` but NOT in `yo://apps` or Layouts.
Gear opens Settings. Sign Out is in Settings → General.

### Phase 1 — Folder-bound layouts
- `layout.folderRequired` computed from contained panels.
- Layout chrome gets the picker when `folderRequired`.
- `layoutContext: { folder, layoutId }` passed to panel preloads.
- Folder-bound app shells hide their own picker if `layoutContext` exists
  on init.
- Saving a layout: discard per-panel folder bindings (folder provided at
  load time).

**Acceptance:** Build a "fullstack" layout containing Vibe + Spec +
Terminal. Save it. Reload it on a different folder — all three rebind.
Standalone Vibe still shows its own picker.

### Phase 2 — Spec stub
- `yo://spec` app (`category: "user"`, `requiresFolder: true`): forces
  workdir pick, shows "Spec — coming soon" + cwd.
- Welcome → Spec card uses the same picker flow as Vibe.

### Phase 3 — `YoAgentRenderer` extraction
Refactor `yo-panel-ui.ts`. No behavior change. Tests: open the right-rail
panel, send a message, see tokens stream, tool calls render — no
regressions.

### Phase 4 — `agent-runner` interactive mode + per-instance IPC
Add `runner.startInteractive(...)` + the `AgentRegistry` + the
`agent:<id>:*` channels. Prove with a scratch IPC call.

### Phase 5 — Foldered agent storage + per-folder runtime + migration
- Foldered `~/.glyphh/agents/<slug>/agent.json` + `CLAUDE.md`. One-shot
  migration of existing flat files.
- Per-folder `<agent-cwd>/.yo/agents/<slug>/history/*.jsonl` +
  `state.json`.

### Phase 6 — `yo://agent` app shell
- `renderer/agent.html`, `renderer/agent.ts`, `main/agent-preload.ts`.
- Routes for `yo://agent` and `yo://agent/<slug>`.
- App declares `requiresFolder: true` — header picker (unless in a
  folder-bound layout).
- Mounts `YoAgentRenderer`, spins an `agent-runner` interactive engine,
  wires events.

**Acceptance:** Open `yo://agent` in a panel. Pick a folder. Send a
message. Get a reply. Open a second panel to `yo://agent/<other>` on a
different folder. Both run independently.

### Phase 7 — Agents left-rail upgrade
Existing `renderer/help/agents.ts` already has CRUD. Add:
- "Open as app" button per row → `yo://agent/<slug>` in a new panel.
- Avatar render (use existing `avatar_url`; identicon fallback).

### Phase 8 — Settings → Agent Defaults tab
New tab in `settings.ts`. Storage at `~/.glyphh/.agent-defaults.json`. Wired
into `createFromDefaults()`.

## 13. Resolved decisions

1. **Single-window, always.** Multi-window negates the .yo premise of one
   workspace per window. No `BrowserWindow` multiplication.
2. **No migrations.** Greenfield. Foldered `~/.glyphh/agents/<slug>/` from day
   one. No flat-file migration path.
3. **Default Agent `CLAUDE.md` seed depends on entry point:**
   - Open `yo://agent` from `+` (no slug → default agent) → full Claude
     Code preamble baked in.
   - Create from Agents app → empty system prompt + a "default" button
     that seeds the full preamble. Form also supports "create with agent"
     (AI-assisted) the way Skills does.
   - Alternative entry: the right-rail .Yo gets a `create-agent` skill
     that creates and opens an agent.
   - Save button in an Agent app panel → opens the same create form for
     saving the current chat config as a new named agent.
4. **Per-layout folder mode.** The Layout builder has a config: **single-folder
   layout** (layout owns the picker, all folder-bound panels share) vs
   **multi-folder layout** (each folder-bound panel keeps its own picker).
   User picks per layout. Default = single-folder.
5. **Recent history**: keep last 20 entries, paginate at 10, with search.

## 14. Non-goals

- Touching `YoChat` (right-rail engine).
- Replacing `~/.glyphh/.providers.json`.
- A second SDK / engine. Phase 0-8 all run on Claude Agent SDK. Other
  providers come later via a future `LocalAgentEngine` / `OpenAIAgentEngine`
  swap-in to `agent-runner`.
- Building the full Spec app. Phase 2 ships a stub only.
