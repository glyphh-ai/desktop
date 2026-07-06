# Multi-Agent Development with Claude Code — Plan

**Status:** Scoped — open questions locked, ready to build
**Owner:** Tim
**Date:** 2026-04-30 (updated 2026-05-03)

> **Command-surface note (2026-05-03):** `.yo .ws`, `.yo .code`, and `.council`
> have been retired. Workspaces, agents, and dev-space layouts are now managed
> from the in-app **Home** panel (Workspaces, Agents, Layouts pages). The
> underlying multi-agent infrastructure described in this document — the
> workspace MCP server, event log, inbox router, briefings, code-terminal
> panels — is unchanged and is being rebadged from "code-workspace" to
> "cypher-workspace" in a follow-up pass. Treat all `.yo .ws` / `.yo .code`
> example commands below as historical; the functionality lives, the
> command-bar entry points do not.

---

## 1. Outcome

A user opens a yo workspace bound to a project directory. Inside it they lay out
panels however they want — VS Code on one side, three named code terminals
running Claude Code on the other, the `.yo` agent in a side panel. Each terminal
has a name (`ui`, `server`, `web`) and a role. Every agent — including `.yo` —
can:

- Read what every other agent has done in this workspace
- Post updates the others can see
- Be told (by `.yo` or a peer) "stop, switch to this task"
- Stay completely independent if the developer wants

The user can scaffold this whole layout from a single prompt:

```
.yo .code create a dev space for yousup with 3 agents — ui, server, web
```

…and `.yo` produces the layout, names the terminals, seeds each agent with a
role-aware system prompt, and wires them to the shared workspace context.

The product's job is **piping**, not policy. The developer decides what work each
agent does and accepts the risk of parallel edits. We don't auto-resolve
conflicts. We don't sandbox writes. We don't pretend agents are safe to ignore.

---

## 2. Mental Model

Five nouns. Memorize these — every implementation decision falls out of them.

| Noun | Definition |
|---|---|
| **Workspace** | `{ name, rootDir }` — a slug + a directory on disk. Captures, terminals, and layouts are scoped to it. Today this is a string preference; in v3 it's a real object. |
| **Panel** | An app instance (built-in, vibe, or code-terminal). Has a unique slug in the workspace's panel namespace. Already exists post-v2.4.13. |
| **Agent** | A code-terminal panel running Claude Code with a name, role, and workspace binding. Agent name = panel slug. |
| **Context** | Append-only event log of what's happened in the workspace: file edits, agent posts, captures, decisions. Lives at `~/.glyphh/workspaces/<slug>/events.jsonl`. |
| **Subscription** | A tag-filter an agent registers; orchestrator delivers matching events to the agent's inbox. |

Three verbs:

- **post(body, tags?)** — agent appends to the workspace event log.
- **read(filter)** — agent queries the log (by tag, agent, time range).
- **subscribe(filter)** — agent registers a tag-filter; orchestrator drains matching events into `${rootDir}/.yo/inbox/<agent>.md` at the agent's next prompt boundary.

That's the whole protocol. Everything else is UX.

---

## 3. Architecture Decisions

### 3.1 Workspace becomes a real object (not a string)

Today: `activeWorkspace` is a string preference. Captures get tagged with it.

Change: Workspace = `{ slug, name, rootDir, createdAt }`. **Global slug registry**
— one `~/.glyphh/workspaces.json` index plus per-workspace dirs at
`~/.glyphh/workspaces/<slug>/`. Slugs share the reserved-keyword set with commands
(`yo`, `sup`, `dip`, `drip`, `peace`, `council`).

Two slugs may point at the same `rootDir` (different "lenses" on one project) —
allowed with a creation-time warning.

New commands:

- `.yo .ws new <slug> <path>` — create workspace bound to a directory
- `.yo .ws switch <slug>` — change active workspace (also sets cwd for new code-terminals)
- `.yo .ws list`

**Rationale:** "Subagents share context for the same codebase" is meaningless
without a directory binding. Workspace-as-string was always a placeholder. Flat
namespace keeps `.yo .ws switch <slug>` and MCP tool calls unambiguous.

### 3.2 New panel type: `code-terminal`

Distinct from regular terminal. A code-terminal has:

- `name` (workspace-scoped slug — **NOT** in the global app/vibe namespace; same
  name can be reused across workspaces)
- `role` (free-text — "ui", "server", "reviewer", whatever the user wants)
- `cwd` (defaults to workspace.rootDir)
- `agentCommand` (default: `claude`, override per-panel)
- `agentArgs` (default: `[]`, e.g. `["--model", "opus"]`)
- `subscriptions` (default: `[mentions_me, role:<mine>, broadcast]`)

When the panel boots:
1. Spawns a pty in `cwd`
2. Runs `${agentCommand} ${agentArgs.join(" ")}`
3. Auto-restarts on exit (so the agent persists across `/clear` and crashes)
4. Per-agent system prompt addon delivered via project-local CLAUDE.md (see §3.6)

The panel UI shows the agent's name + role in a header pill.

**Resolution rules for `.dip <name>`:**
1. If `<name>` is a workspace slug → switch workspace
2. Else if currently in a workspace and `<name>` matches a code-terminal there → focus it
3. Else fall back to global app/vibe resolution

Cross-workspace addressing: `.dip <workspace>/<panel>` (deferred to Phase 5
polish; default to current workspace everywhere first).

Reserved code-terminal names: command keywords + workspace slugs in current scope.

### 3.3 Transport: hybrid MCP + filesystem + orchestrator

**The user's question: is MCP the best way? Answer: MCP is necessary but not sufficient.**

| Concern | Mechanism | Why |
|---|---|---|
| Agent reads team state | MCP tools (`team_status`, `read_log`, `read_agent`) | Request/response fits "give me the state" |
| Agent posts an update | MCP tool that appends to `events.jsonl` | One write path, atomic, debuggable |
| Real-time delivery | Orchestrator drains relevant events into `${rootDir}/.yo/inbox/<agent>.md` | At next prompt boundary — no mid-tool-call interruption |
| Persistent record | `events.jsonl` (append-only, one per workspace) | Durable, greppable, version-controllable |
| Free-form artifacts | `~/.glyphh/workspaces/<slug>/agents/<name>.md` | Markdown scratchpad each agent owns |

**Event shape (locked):**
```typescript
{
  ts: number,
  from: string,           // agent name (panel name)
  to?: string,            // optional direct mention — fast-path delivery
  tags: string[],         // ["role:ui", "broadcast", "blocking", "t:auth"]
  kind: "post" | "status" | "question" | "answer" | "artifact",
  body: string,
  refs?: string[]         // file paths, commit shas, ts of replied-to event
}
```

**Tag conventions** (orchestrator auto-stamps): `role:<role>`, `from:<name>`,
`workspace:<slug>`. Free-form agent tags get a `t:` prefix (`t:auth`,
`t:refactor`) to avoid collision.

**Subscription = tag filter:**
```typescript
{ tags?: string[], from?: string[], mentions_me?: boolean }
```

**Default agent subscriptions** (orchestrator writes at panel creation):
- `mentions_me: true` (anything with `to: <my-name>`)
- `tags: ["role:<my-role>"]`
- `tags: ["broadcast"]`
- No per-author auto-subscribe.

**Delivery model — adaptive batching:**
- Orchestrator watches `events.jsonl`. When a new event matches an agent's
  subscription, it queues the event for that agent.
- At the agent's **next prompt boundary** (when the user — or the orchestrator's
  fast-path — sends input), pending events are appended to
  `${rootDir}/.yo/inbox/<agent>.md` as a rolling list (last N events).
- The agent's CLAUDE.md addon instructs: *"Read `.yo/inbox/<your-name>.md` at
  the start of each turn. Events above ts X are new since your last turn."*
  Orchestrator tracks last-read-ts per agent.
- **Fast-path:** events with `to: <agent>` or tag `blocking` skip batching —
  delivered within ~1s of detection at next safe boundary.
- **Why inbox-file vs PTY injection:** inbox-file is robust, debuggable, and
  works across agent restarts. PTY injection is more elegant but fragile.
  Defer PTY upgrade to v3.1 if inbox-file feels laggy.

**Sender-side conventions** (encoded in agent CLAUDE.md addon):
- Status updates → `tags: ["broadcast"]`
- Cross-role asks → `to: "<name>"` or `tags: ["role:<other>"]`
- Internal scratch → no tags (stays in log, not delivered)

### 3.4 Workspace MCP server lives inside yo-client

A new MCP server that the existing `mcp-manager` registers automatically when a
workspace is active. URL is local (stdio or unix socket). Each code-terminal's
Claude Code is configured to connect to it on boot.

Tools:

```
team_status() → { agents: [{name, role, lastPost, status}], workspace, rootDir }
read_log(filter?: {tags, from, since, limit}) → events
read_agent(name, kind?: "scratchpad" | "log") → text or events
post(body, tags?, kind?, refs?) → {ts}
post_to(agent, body, tags?) → {ts}     // direct message — sets `to` field, fast-path
subscribe(filter: {tags?, from?, mentions_me?}) → {id}
unsubscribe(id) → ok
list_files(rootDir? | agent?) → paths  // optional convenience over filesystem MCP
```

Tags are free-text with the `t:` prefix convention for user-defined tags.
Channels are a UI rendering of tag filters — never a storage concept.

### 3.5 `.yo` gets a `.code` mode

`.code` is a sub-mode of `.yo`, not a sibling command. (Keeps the grammar tight.)
Triggered by `.yo .code <prompt>`. Behavior:

- Reads the workspace
- Has access to layout-creation tools (`split`, `grid`), code-terminal-creation
  tools, and the workspace MCP server tools
- The prompt is interpreted as "build me this dev environment"

Example:
```
.yo .code create a dev space for yousup with 3 agents — ui, server, web
```
→ `.yo` calls:
1. `dip grid 3` (or whatever split layout fits)
2. For each name: `create_code_terminal(name, role, cwd=workspace.rootDir)`
3. Each terminal boots with auto-generated role briefing
4. `.yo` posts a startup event to the log: "team initialized: ui, server, web"

`.yo` is the orchestrator **by default** but doesn't have to be. Any agent can
take that role by calling `claim_orchestrator()` via MCP. Multiple orchestrators
is allowed but discouraged (we just don't prevent it).

### 3.6 Per-agent system prompt addon (via project-local CLAUDE.md)

**Delivery mechanism:** orchestrator writes to `${rootDir}/.yo/agents/<name>.md`
and a top-level `${rootDir}/CLAUDE.md` `@include`s the right file based on
agent name (passed via env var `YO_AGENT_NAME` when the panel spawns
`claude`). Claude Code already reads project-local CLAUDE.md at startup — no
new injection surface needed.

Format (terse, fits in ~500 tokens):

```
You are agent "ui" in workspace "yousup" (cwd: /Users/.../yousup).
Role: ui
Teammates: server, web
Orchestrator: yo

At the start of every turn, read `.yo/inbox/ui.md` — events above ts <last>
are new since your last turn.

Workspace MCP tools: team_status, read_log, read_agent, post, post_to,
subscribe. Use them.

Sender conventions:
- Status updates → post(body, tags: ["broadcast"])
- Cross-role asks → post_to("server", body) or post(body, tags: ["role:server"])
- Internal scratch → post(body) with no tags (stays in log, not delivered)
- Use tag "blocking" for anything that requires teammate response before you continue

The user is the final authority — defer to them on scope.
```

Editable per workspace via `~/.glyphh/workspaces/<slug>/agent-prompt-template.md`.
Power users will tweak this constantly; that's fine.

### 3.7 Capture-store integration (the workspace-tagging gap)

This is the prerequisite the audit surfaced. Before any of the above ships:

- `yo-agent.ts:435`, `cloud-sync.ts:95`, `mcp-expose.ts:392, 448` must pass
  `workspaceGetter()` to `captureStore.ingest()`.
- The capture store's listener system already pushes to subscribed context
  panels — so once the gap is closed, `.yo`'s output and MCP tool outputs land
  in the workspace context alongside terminal captures.
- The workspace MCP server's `read_log` should merge events.jsonl + relevant
  captures from `captureStore.searchWorkspace()`. One unified stream.

### 3.8 Editor wiring — bundled VS Code Server with config copy

`code serve-web` (Microsoft's official VS Code Server, NOT OSS code-server) is
already the editor surface in `vscode-server.ts`. It runs the user's installed
VS Code via the `code` CLI — full extension marketplace works because it's
their VS Code binary.

For v3:
- **Default in `.yo .code` layouts:** code-editor panel is included by default
  (one-pane-of-glass demo). User can close it and use external Desktop VS Code
  if they prefer.
- **Config copy at workspace creation:** copy user's `~/Library/Application
  Support/Code/User/{settings.json, keybindings.json}` and the extensions list
  into the workspace's code-server data dir on first open. Feels like their
  editor on first launch.
- **`vscode://` deeplinks:** "open in your Desktop VS Code" escape hatch from
  `.yo` chat / file references (Phase 6 polish).
- **File sync:** agents and editor share `rootDir`. code-server's file watcher
  picks up agent edits live. No bridge needed.

**Out of scope for v3:**
- Live cursor sharing between agents and editor
- Embedding the user's *running* Desktop VS Code (impossible — separate
  Electron process)
- Multi-editor splits inside one panel
- MS official `code tunnel` integration

### 3.9 Layouts page integration

Layouts already pull panels by slug from `appConnector.list()` (post-v2.4.13).
For v3:

- Layouts can include code-terminal panels by name (e.g., `ui`, `server`)
- Saving a layout in a workspace records the agent names and roles
- Loading a layout in a workspace creates the code-terminals if missing
- A layout is *portable* between workspaces — names are reused, but `cwd` is
  resolved per-workspace

This means `.yo .code` can save its scaffolded layout, and the user can recall
it next time they want the same team shape.

---

## 4. Phases

Ship in order. Each phase is independently testable and provides value alone.

### Phase 0 — Pre-work (must land first, ~1 day)
- **Resolve real shell PATH at startup.** Run `zsh -ilc 'echo -n $PATH'` once
  at app boot, cache the result, use for *all* spawns (vscode-server, terminal,
  future code-terminals, vibe runners). Fixes the bug where VS Code panel's
  git extension can't find `git` because Electron's sanitized PATH lacks
  `/opt/homebrew/bin` / `/usr/local/bin`. Same root cause would also break
  npm/pnpm/yarn/asdf detection inside the editor.
- Fix workspace tagging gaps in `yo-agent.ts:435`, `cloud-sync.ts:95`,
  `mcp-expose.ts:392, 448` — every capture path passes `workspaceGetter()` to
  `captureStore.ingest()`.
- Without these, every later phase has a hole.
- Tag as v2.4.14, ship before v3 work begins.

### Phase 1 — Workspace as a real object (~2 days)
- Workspace data model + persistence (`workspace.json`)
- Commands: `.yo .ws new | switch | list`
- All capture paths use the active workspace's slug + rootDir
- Migration: existing `activeWorkspace` string becomes the slug of a default workspace bound to `~`
- **Demo:** `ws new yousup ~/dev/yousup`, switch to it, captures land in `~/.glyphh/workspaces/yousup/`.

### Phase 2 — Code-terminal panel type (~3 days)
- New panel type with name, role, cwd, agentCommand, prompt addon
- UI: terminal header pill showing agent name + role
- Spawned via `dip code <name> [role]` or programmatically
- System-prompt addon written to terminal stdin on first prompt
- **Demo:** open three named code-terminals manually, each running Claude Code, each briefed with role + teammates.

### Phase 3 — Workspace MCP server (~3 days)
- New MCP server registered when a workspace is active
- Tools: `team_status`, `read_log`, `read_agent`, `post`, `post_to`, `subscribe`
- `events.jsonl` storage at `~/.glyphh/workspaces/<slug>/events.jsonl`
- Per-agent scratchpad at `~/.glyphh/workspaces/<slug>/agents/<name>.md`
- Code-terminals auto-configured with the server URL on boot
- **Demo:** agent ui posts a decision; agent server reads it via `read_log`.

### Phase 4 — Orchestrator-mediated push (~2 days)
- Subscriptions stored alongside agent state
- When a relevant event lands and an agent has a subscription, `.yo`
  (or whoever holds the orchestrator role) injects a brief into that agent's
  next prompt
- Mechanism: prepend a `[team update]` line to the agent's next stdin write
- **Demo:** ui posts to "blockers"; server (subscribed) sees the brief at the
  top of its next message without having polled.

### Phase 5 — `.yo .code` mode + editor config copy (~3 days)
- New sub-mode in command-parser + agent definition
- Tools available: layout-creation, code-terminal-creation, workspace MCP
- Recipe-style prompts: "create a dev space with N agents named X, Y, Z"
- Saves the resulting layout for replay
- Default layout includes a code-editor panel (vscode-server)
- Workspace creation copies user's VS Code `settings.json`, `keybindings.json`,
  and extensions list into the code-server data dir
- **Demo:** the headline prompt from §1 produces a working three-agent dev space (with editor) in one command.

### Phase 6 — Polish (~2 days)
- Layouts page surfaces code-terminal templates by workspace
- Onboarding flow for first-time multi-agent setup
- Per-agent prompt template editing UI
- User-editable subscriptions: `.yo .ws sub <agent> add tag:t:auth`
- `vscode://` deeplinks for "open in your Desktop VS Code" escape hatch
- Cross-workspace `<workspace>/<panel>` addressing
- Documentation update (COMMANDS.md, dev space recipes)

**Rough total:** ~14 working days of focused build. Phase 0 should ship as a
patch (v2.4.14). Phases 1–6 ship together as v3.0.

---

## 5. Risks & Open Questions

### Risks

1. **Context window bloat.** Three agents × shared event log = each agent's
   context fills with team chatter. Mitigation: `read_log` defaults to the last
   N events; subscriptions are explicit; orchestrator filters to relevance.
2. **Parallel edits to the same file.** Two agents both editing
   `src/foo.ts` will collide at git/save time. **Decision per the user: this is
   the developer's risk.** We do not detect or prevent it. Document loudly.
3. **Claude Code's own prompt format.** We're injecting a system-prompt addon
   into the first message. If Claude Code already reserves system messages for
   its own use, our injection might fight with it. Need to verify — possibly
   route via a config file Claude Code reads at startup instead of stdin.
4. **MCP auth.** The workspace MCP server is local. Stdio is fine. If we ever
   expose it over network (multi-machine collaboration), auth is a separate
   project.
5. **Long-running terminal sessions.** Today, closing a terminal kills the pty.
   Agent state lives in Claude Code's own session; closing breaks continuity.
   Mitigation in v3.1: pty session resume.

### Locked decisions (2026-05-01)

| # | Question | Decision |
|---|---|---|
| Q1 | Workspace slug scope | **Global registry**, single `workspaces.json`. Reserved set = command keywords. Multiple slugs may target same `rootDir` (warning). |
| Q2 | Default agent command | **`claude`** + per-panel `agentCommand` / `agentArgs` override. Auto-restart on exit. |
| Q3 | Channel namespace | **Flat `events.jsonl`**, virtual channels via tag subscriptions. Channels are UI-only. |
| Q4 | Push timing | **Adaptive batching** at next prompt boundary. Delivery via `${rootDir}/.yo/inbox/<agent>.md`. `to:` mentions and `blocking` tag = fast-path (~1s). PTY injection deferred to v3.1. |
| Q5 | Relevance criteria | **Subscription-driven** tag filters. Default subs: `mentions_me`, `role:<mine>`, `broadcast`. No author auto-subscribe. |
| Q6 | Code-terminal namespace | **Workspace-scoped**, separate from global app/vibe namespace. `<workspace>/<panel>` for cross-workspace addressing (Phase 6). |
| Q7 | Editor wiring | **Bundled `code serve-web`** is default in `.yo .code` layouts. Config copy at workspace creation. `vscode://` deeplinks as escape hatch (Phase 6). |

### Things explicitly NOT in v3.0

- Cross-workspace context (workspaces are isolated)
- Auto-conflict resolution for parallel file edits
- Visual graph of agent activity
- Agent-to-agent direct streaming (it's all log-mediated)
- Cloud sync of workspaces (local-only for v1)
- Permission model (all agents in a workspace see everything)
- Agent quotas / rate limiting

---

## 6. Pre-Work Required Before Phase 1

1. **Land Phase 0** (PATH resolution + workspace tagging gaps). Ships as
   v2.4.14 patch. Unblocks every later phase.
2. **Verify Claude Code's prompt-injection surface.** Confirm project-local
   CLAUDE.md is read at startup (it is) and that env var `YO_AGENT_NAME` is
   readable inside the agent's environment for conditional includes.

Open questions are locked — see §5.

---

## 7. What Defines "Done" for v3.0

A new user can run, in order:

```
.yo .ws new yousup ~/dev/yousup
.yo .ws switch yousup
.yo .code create a dev space for yousup with 3 agents — ui, server, web
```

…and within 30 seconds have a three-pane layout where each terminal is running
a named Claude Code agent, all three can see what the others are doing via
`read_log`, and `.yo` is routing relevant updates between them. Closing the app
and reopening it restores the layout, the agent names, and the workspace
context.

If that demo works without hand-holding, v3.0 ships.
