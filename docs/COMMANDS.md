# YoSup Command Reference

Three verbs: `.yo` (search/retrieve), `.sup` (capture), `.dip` (navigate).
One effect: `.drip` (animations). One gesture: `.peace` (sign off).

Workspaces, agents, and dev-space layouts are managed from the in-app
**Home** panel — there are no top-level commands for them anymore.

## Keyboard Shortcuts

| Shortcut | Action |
|---|---|
| **Cmd+.** | Open command bar |
| **Cmd+>** (Cmd+Shift+.) | Toggle the .Yo agent panel |
| **Cmd+Y** | Summon / dismiss the app (global hotkey) |
| **Cmd+L** | Focus the URL bar |
| **Cmd+R** | Refresh the active panel |
| **Cmd++** / **Cmd+-** | Zoom in / out |
| **Cmd+0** | Reset zoom |
| **Esc** | Close current overlay |

## `.yo` — Search & Retrieve (the brain)

| Command | Action |
|---|---|
| `.yo` (bare) | Open search widget / library browser |
| `.yo <query>` | Search context store → open inline widget with results |
| `.yo . <skill>` | Process **last capture** (from `.sup`) with skill → inject |
| `.yo . <prompt>` | Process **last capture** with prompt → inject |
| `.yo <query> . <skill>` | Search memory + process with skill → inject |
| `.yo <query> . <prompt>` | Search memory + process with prompt → inject |

The `.` separates query from processor. No query + `.` = use the last `.sup` capture as input.

## `.sup` — Capture (screen → memory)

| Command | Action |
|---|---|
| `.sup` | Capture active panel → context store + clipboard |
| `.sup .` | Capture active panel (explicit dot modifier) |
| `.sup . <skill>` | Capture → process with skill → inject result |
| `.sup . <prompt>` | Capture → process with prompt → inject result |
| `.sup . .dip <panel>` | Capture, then navigate (chainable with .dip) |

## `.dip` — Navigate

| Command | Action |
|---|---|
| `.dip <panel>` | Switch to panel |
| `.dip <layout>` | Apply saved layout (auto-detected by name) |
| `.dip <url>` | Navigate active panel to URL |
| `.dip . <panel>` | Swap calling panel within current grid |
| `.dip back` | Previous panel |
| `.dip split <a> <b> ...` | Side-by-side split |
| `.dip grid <cells> / <cells>` | Full grid with spans and custom widths |
| `.dip add <url>` | Add new app panel |
| `.dip list` | List all apps and layouts |
| `.dip refresh [panel]` | Refresh panel |
| `.dip zoom <val>` | Set zoom level |
| `.dip clear-session [panel]` | Clear panel session data |

## `.drip` — Effects

| Command | Action |
|---|---|
| `.drip <animation>` | Play a CSS animation effect |

## `.peace` — Sign Off

| Command | Action |
|---|---|
| `.peace [count]` | Particle peace-sign gesture |

## Workspaces & Multi-Agent Dev Spaces

A **workspace** = `{ slug, name, rootDir }`. It binds a yo session to a project
directory. Captures, agents, and layouts are scoped to it. The active workspace
persists across app restarts.

A **code-terminal** is a named pty panel running an LLM CLI (default: `claude`)
in the workspace's `rootDir`. Each agent has a name, a role, and a workspace
binding. They coordinate through a shared event log + per-agent inboxes.

Workspaces, agents, and dev-space layouts are managed from the in-app **Home**
panel (Workspaces, Agents, Layouts pages). The cypher abstraction will subsume
this surface in a follow-up cleanup pass.

Storage: `~/.glyphh/workspaces.json` (index) + `~/.glyphh/workspaces/<slug>/` (per-workspace
state — events log, agent metadata, inbox state).

### How agents coordinate

Each code-terminal boots with `YO_AGENT_NAME` and `YO_WORKSPACE` in its env,
plus a project-local `CLAUDE.md` dispatcher and a `.mcp.json` pointing at the
workspace MCP server. Agents see a personalized briefing at
`${rootDir}/.yo/agents/<name>.md`.

The workspace MCP server (loopback HTTP, no auth) exposes:

| Tool | Purpose |
|---|---|
| `team_status()` | List agents, roles, last-post timestamps |
| `read_log(filter?)` | Read the workspace event log; filter by tag/from/to/kind/time |
| `read_agent(name, kind?)` | Read another agent's scratchpad or post history |
| `post(body, tags?, kind?, refs?)` | Append to the team event log |
| `post_to(agent, body, tags?)` | Direct message — fast-path delivery |
| `subscribe(filter)` | Register a tag-filter for inbox delivery |
| `unsubscribe(id)` | Remove a subscription |

**Default subscriptions** (auto-added on agent creation):
`mentions_me`, `role:<my-role>`, `broadcast`.

**Sender conventions** (followed by all agents):
- Status updates → `post(body, tags: ["broadcast"])`
- Cross-role asks → `post_to("server", body)` or `post(body, tags: ["role:server"])`
- Internal scratch → `post(body)` with no tags (logged but not delivered)
- Use tag `blocking` for anything that requires a teammate response

### Inbox delivery

When an event lands and an agent has a matching subscription, the orchestrator
appends it to `${rootDir}/.yo/inbox/<agent>.md` (rolling tail of the last 50
events). Each agent's `CLAUDE.md` instructs them to read this file at the start
of every turn — events newer than their last activity are new.

### Storage layout

```
~/.glyphh/workspaces.json                              # workspace index
~/.glyphh/workspaces/<slug>/agents.json                # agent roster + subscriptions
~/.glyphh/workspaces/<slug>/events.jsonl               # append-only event log
~/.glyphh/workspaces/<slug>/inbox-state.json           # per-agent lastDeliveredTs
${rootDir}/.mcp.json                              # MCP config (managed)
${rootDir}/CLAUDE.md                              # dispatcher section (managed)
${rootDir}/.yo/agents/<name>.md                   # per-agent role briefing
${rootDir}/.yo/inbox/<name>.md                    # per-agent inbox (auto-populated)
```

### Embedded VS Code

The built-in `vscode` panel is a `code serve-web` instance that runs the user's
locally installed VS Code. On first launch, the user's Desktop VS Code
`settings.json` and `keybindings.json` are copied into the embedded data dir so
the editor inherits their preferences. Agents and the editor share `rootDir`,
so file changes from agents appear live in the editor's file watcher.

## Utilities

| Command | Action |
|---|---|
| `.yo help` | Help overlay |
| `.yo skill` | Skills manager |
| `.yo layout` | Layouts manager |
