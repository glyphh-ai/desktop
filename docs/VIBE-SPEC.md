# Vibe — spec

> A **spec-driven** vibe-coding workspace (Cursor-ish) that runs **real Claude Code**
> against a consistent, editable spec + plan and shows agent · plan · live preview in
> one layout. **Vibe is a yo app that produces yo apps.**

## Product thesis: spec-driven, and it *is* Claude
The tension we're resolving: we built a vendor-agnostic layer (skills, agents, apps) on
top of Claude — which risks feeling like *a wrapper on Claude*, and developers want
**Claude**, not a wrapper. But architecturally the `.yo` agent already **is** Claude Code
(in-process SDK, the user's own subscription via `cc-bootstrap`). So this is a
transparency + identity problem, not an architecture one. Devs reject wrappers only when
the model/tools are hidden or nerfed, the prompt/context is uneditable, there's no escape
to the real tool, or their work is locked in. We avoid all four.

**Identity principles (make devs feel Claude is the thing running it):**
- **Provenance, always visible.** Badge it — *".yo · running on your Claude Code · Opus 4.7."* Real subscription, real model, shown.
- **Show the work.** Real tool calls + thinking + the actual `CLAUDE.md` in play. No black box.
- **Escape hatch.** One keystroke drops to the raw `claude` TUI in the project dir (reuse `terminal-renderer.ts`; cc-auth already lives there). Cockpit and CLI share the same repo + `CLAUDE.md`, so they're provably the same agent.
- **Everything is files + git.** Spec, plan, `CLAUDE.md`, skills all live in the repo — nothing trapped in app state, fully portable.
- **Claude-native packaging, not a wrapper.** yo skills are authored/run as **Claude Code skills** (`.claude/skills/`) that also work in raw `claude`; agents are CC subagents. Vendor-agnostic (BYOK other providers) is an **opt-in escape hatch**, not the default identity.

**One pipeline, run from whichever app fits you:**
```
SPEC.md   →   plan.md   →   Claude Code builds   →   preview   →   ship
(intent,      (living        (the real agent,         (browser tab) (.glyphh / repo)
 durable,      checklist      same in every app)
 reviewable)   it maintains)
```
**Yo is the single place — you never leave it.** It's LLM-agnostic and has everything you
need to build, develop, and ship, so there's no reason to alt-tab to another tool. The
build surfaces are not one morphing layout — they're **distinct yo apps** you switch
between (the whole "everything is a yo app" thesis), all sharing one agent + one `SPEC.md`
+ one real repo (`~/yo/vibes/<id>/`):

| App (`yo://…`) | Surface | For | Code |
|----------------|---------|-----|------|
| **Vibe workspace** (`yo://vibe`) | Spec checklist + Preview. Describe → watch → approve. | vibe coders | none |
| **Yo Editor** (`yo://editor`) | *Super lightweight* Monaco — a glance: files, diff, SPEC.md. "Just a flash," **not an IDE.** | mid-road / prosumers | a peek |
| **VS Code** (`yo://vscode`) | Full embedded VS Code (`code serve-web`) — the real thing, **inside Yo**. | real devs | full |
| **Terminal** (`yo://terminal`) | Raw `claude` / shell in the project dir. | real devs | full |

**Not parallel silos — same project, different app.** A vibe coder opens the Vibe app; a
dev opens the embedded VS Code or Terminal app; all point at the same `vibeCodeDir`, the
same agent drives, the same `SPEC.md` is the source of truth. We don't try to *beat* VS
Code — we **embed** it as one of the apps, so even the power user never leaves Yo. This
re-affirms apps + the app switcher as **core** to the product (not something to strip).

## Layout — the **Yo Editor** tier (mid-road), reborn and spec-driven
This is the **middle tier** — deliberately *super lightweight, "just a flash"*: a glance at
files/diff/spec, **not** an attempt at VS Code. Don't move the agent or rebuild a shell —
**keep the `.yo` agent where it is (right, all its tooling) and revive the Yo Editor as the
center.** It still lives on `main` (`code-workspace.*`, `monaco.html`, `workspace-manager.ts`,
`files-ipc.ts`, `code-index/`) — frozen, not gone. The **Vibe workspace** tier is this same
layout with the editor columns collapsed (Spec checklist + agent only); the **VS Code /
terminal** tier is one click out (see "Open in VS Code / terminal" below). Bring it back,
keep it thin, make it spec-driven with Claude driving.
```
┌──────────────┬──────────────────────────────────┬──────────────┐
│ FILES (top)  │  YO EDITOR — center, tabbed        │  .yo AGENT   │
│  file tree   │  ┌ Spec ─┬ SPEC.md ─┬ app.ts ─┐    │  (right,     │
│              │  │ check  │ (fancy   │ (Monaco)│    │  unchanged)  │
├──────────────┤  │ list:  │ Monaco   │         │    │  all tooling │
│ DIFF (bottom)│  │ tasks, │ editor   │         │    │  DRIVING     │
│  git diff of │  │ which  │ for the  │         │    │  provenance  │
│  working set │  │ item,  │ spec     │         │    │  badge +     │
│              │  │ start/ │ page     │         │    │  ⌥ raw claude│
│              │  │ stop   │ type)    │         │    │              │
└──────────────┴──────────────────────────────────┴──────────────┘
  Preview = a browser tab opened on demand (existing tab/app system) — no reserved region
```
- **Far left, split:** Files (top, the working-dir tree) + **Diff** (bottom, git diff of the working set so you watch the agent's changes land).
- **Center = the Yo Editor** (Monaco, tabbed):
  - **Spec checklist tab** (the light-Kiro view): renders `plan.md` as tasks with live progress (which item the agent is on) + **start/stop controls** per part.
  - **SPEC.md tab:** the durable intent, in a *fancy Monaco editor specialized for the spec page type* (custom rendering/affordances for that file type, not a plain text buffer).
  - **Code file tabs:** normal Monaco — open any file from the tree.
- **Right = the `.yo` agent (Claude), exactly where it is now**, with all its tooling. It drives; provenance badge + ⌥-drop to raw `claude` keep it legibly Claude.
- **Preview = an on-demand browser tab** (reuse the existing tab/app/browser system). No dedicated region — don't eat space for something you open occasionally.

**Why this over a fresh shell:** the Yo Editor is built and is the differentiator. Vibe
coders live in the Spec checklist + a Preview tab; developers live in Files/Diff + the
Monaco editor; both share the same Claude agent on the right. Spec-driven for devs,
vibe-coding for everyone — one surface. **This means we build forward from `main` (editor
intact), not from `os-overlay` (which deleted it).**

## Core concept: everything is a yo app
- `council`, `vibe`, `home`, `browser` … are all **yo apps** (`INTERNAL_APPS` in `app-connector.ts`, `yo://<id>`).
- **The output of a vibe is itself a yo app** — when a vibe finishes building something, the result is registered as a yo app the user can add to their apps list.
- yo apps are a **standard, portable unit**: importable / exportable as a `.glyphh` bundle (manifest + assets/code). Marketplace later; for now local import/export + "add to my apps."

## The workspace (implementation) — reuse what exists, don't spawn a parallel agent
- **Center — Yo Editor (revive).** Bring back `code-workspace.*` + `monaco.html` (the tabbed Monaco shell) + `files-ipc.ts` (tree, read/write) + `code-index/` (search). Tabs host: code files (Monaco), the **SPEC.md** editor (a custom view for the spec page type, not a plain buffer), and the **Spec checklist** (renders `plan.md` as tasks + live progress + start/stop controls). `cwd = vibeCodeDir(id)`.
- **Far-left split — Files (top) + Diff (bottom).** File tree from `files-ipc`; Diff renders `git diff` of the working set so the agent's edits are watchable as they land (new IPC or extend `files-ipc`).
- **Right — the existing `.yo` agent (NOT a new PTY).** Use the in-process Claude Code SDK agent panel that's already wired — all tools, MCP, permissions. It edits files in the workspace `cwd`; the Diff + open tabs update live. *This is the agent; "it has all the tooling" is exactly why we reuse it.*
- **Tier-3 escalation — Open in VS Code / terminal (the real-dev exit).** Two one-click outs from the Yo Editor: **"Open in VS Code"** (reuse the `vscode-bridge`) opens the same `vibeCodeDir` in real VS Code; **"Open terminal"** drops to raw `claude` in the project dir (PTY via `terminal-renderer.ts`; cc-auth already lives there). Same repo + `CLAUDE.md` ⇒ provably the same agent. This is *why* the Yo Editor can stay thin — anyone who needs more leaves to a real tool, we don't chase parity.
- **Preview — on-demand browser tab.** Open `meta.dev_server_url` in a normal tab when building something visual; no reserved region (don't eat space for an occasional view).

## Vibe registry (persistence) — `src/main/vibe-store.ts`
Mirror `agent-store`/`council-store` per-item-on-disk pattern under `~/yo/vibes/<id>/`:
```
~/yo/vibes/<id>/
  meta.json        # VibeMeta (below)
  SPEC.md          # durable intent — the source of truth (the layer above plan)
  plan.md          # living task list, derived from SPEC.md, maintained by the agent
  CLAUDE.md        # the methodology fed to the coding agent (editable per project)
  code/            # the project being built (agent cwd)
  .runs/<runId>.json
```
`VibeMeta = { id, name, description?, status, createdAt, updatedAt, council_id?, dev_server_port?, dev_server_url?, outputAppId? }`.
API: `listVibes()`, `getVibe(id)`, `saveVibe(meta)`, `deleteVibe(id)`, `vibeCodeDir(id)`, `vibeSpecPath(id)`, `vibePlanPath(id)`, `vibeClaudePath(id)`, run records.

**SPEC.md ↔ plan.md relationship:** SPEC.md is *what + why* (durable intent, reviewed/edited by humans); plan.md is *how + progress* (derived, agent-maintained, checked off task-by-task). The agent regenerates/updates plan.md from SPEC.md; editing SPEC.md is the steering wheel for both audiences. Both are plain markdown in the repo so they diff in git.

## Vibes in the left rail
Persisted Vibes list in the rail (on `main` the rail is light — add a Vibes list/toggle, or fold into the nicer rail when ported). Each Vibe row → opens the `vibe` panel bound to that `id` (restores agent cwd + plan + preview). `+ New Vibe` → create flow.

## vibe-planner skill — `~/.claude/skills/vibe-planner/`
A real yo skill (the reusable methodology). `SKILL.md` (Read/Write tools) takes `{ prompt, cwd, councilSynthesis? }` and writes `plan.md` + `CLAUDE.md` into the vibe dir. Invoked from main via `skillEngine.runSkill("vibe-planner", { prompt, cwd })` at vibe creation. Output is **per-project editable** (skill seeds; user edits).

## Council → vibe feed
On "plan with a council": `createCouncil(...)` → run → `summarizeCouncil(id)` → `{ text }` synthesis → pass as `councilSynthesis` into `vibe-planner` → `plan.md`. Multi-LLM decides *what/how*; Claude Code *builds it*. (Council events can also stream into the vibe via `setCouncilForwardWc`.)

## yo app package (import / export) — later phase
- **Manifest** (extend the app-connector app shape): `{ id, name, url | entry(html), commands?, mcp?, capturePolicy, version, kind:"web"|"bundled" }`.
- **Export**: zip the app's manifest + (for bundled) its `code/` build → `<name>.glyphh`.
- **Import**: unzip → register via `app-connector.add(...)` → appears in the user's apps.
- **Vibe output → app**: on "ship", register the built project as a yo app (web: url to its server; bundled: its built assets), set `meta.outputAppId`. The user adds it to their apps list.

## Build order — v1 (shipped in v4.2.0)
1. **Workspace shell** — `vibe.html`/`vibe.ts` real 3-region layout; Claude Code PTY agent in region 1 (cwd = a scratch dir for now); plan pane (region 2) editing a plan.md; `<webview>` preview (region 3). Single agent.
2. **Vibe registry + rail** — `vibe-store.ts`, `vibe-ipc.ts` (list/get/create/delete + open), rail Vibes list, open-by-id binds the workspace to `~/yo/vibes/<id>/`.
3. **vibe-planner skill** — generate `plan.md` + `CLAUDE.md` from a goal on create.
4. **Council → vibe feed** — synthesis seeds the plan.
5. **yo app import/export** — `.glyphh` bundle; vibe "ship" registers the output as an app.

## Build order — spec-driven refactor (current work)
Three sibling yo apps share one agent + spec + repo. **VS Code (`yo://vscode`) is already
fully implemented** — no work there; it's the tier-3 app. Build the other two:
1. **SPEC.md layer** — `vibe-store`: add `vibeSpecPath` + `STARTER_SPEC`, scaffold `SPEC.md` on create; `vibe-ipc`: `vibe-spec-read`/`vibe-spec-write`. SPEC.md is the durable source of truth above `plan.md`. *(start here — self-contained, no agent-type dependency)*
2. **Vibe app refactor** — reshape `vibe.html` from terminal/plan/preview into the vibe-coder surface: **SPEC.md (editable) + a rendered plan checklist** (parse `plan.md` tasks → checkboxes + progress + current-item), preview as an on-demand browser tab (drop the always-on `<webview>` region). Keep the agent driving.
3. **Yo Editor app (`yo://editor`)** — revive `code-workspace.*` + `monaco.html` + `files-ipc` into the *thin* mid-tier: Files (top) + Diff (bottom) left; tabbed Monaco center hosting code files + a SPEC.md tab + the Spec checklist tab. Register as a yo app.
4. **Spec checklist controls + provenance** — start/stop per task; the "running on your Claude Code · <model>" badge; the open-`yo://vscode` / open-`yo://terminal` escalation buttons.
5. **Glue** — agent points at `vibeCodeDir`; checklist ↔ `plan.md` bidirectional sync; diff watches the working set.

## Gotchas (from recon)
- PTY: first `resize` must come from the renderer (xterm reports cols/rows) or the `claude` TUI wraps wrong; `env.PATH` via `getShellPath()` so `claude` resolves; auto-respawn on exit, permanent kill on wc destroy.
- Webview: `webviewTag:true`, contextIsolation → preload for IPC; local dev server may want its own session.
- CC auth: `ensureCcAuth()` is non-blocking (shows a modal); `spawnCcLogin()` for first login.
- Council sessions are in-memory — `summarizeCouncil()` persists; capture synthesis before `endCouncil()`.
- Skill `Write plan.md` lands relative to the agent cwd → pass the vibe dir.

## Status (as of v4.2.0 tag)
Phases 1–5 built + the Vibes left-rail item. **Compile-verified only — not yet run.** First smoke test: `npm run dev` → open a Vibe → confirm the Claude Code agent boots, "Generate plan" writes a plan.md, the preview loads.

## Next iteration — make the plan dynamic + agent-driven (not yet built)
First-pass notes from dogfooding; the static planner (Phase 3) is the seed, this makes it live:
- **Agent owns the plan.** The vibe's `CLAUDE.md` IS the coding agent's system prompt (Claude Code reads it in the project dir). Put the rails there: on load, **ask the user what they want to build**; create/maintain `plan.md`; progress task-by-task and check items off as it goes.
- **Feed the URL to the agent.** Pass the vibe's preview/publish URL into the agent (env var + written into `CLAUDE.md`) so it knows where to serve and "publish to"; the preview pane points at the same URL.
- **Live plan pane.** Watch `plan.md` for the agent's edits → re-render the pane; user edits write back. Bidirectional, not a one-shot read.
- **Controls on the building page.** A control strip in the vibe panel: start/stop the agent, run the dev server, ship, advance-to-next-task. Shape it as it firms up.
- **Re-seed note:** `seedBuiltinSkills()` skips an existing on-disk `vibe-planner/SKILL.md`, so prompt changes (e.g. the council-synthesis instruction) won't reach already-seeded users until re-seeded (version the skill or re-write on bump).

## Known tech debt — the hidden nav
`home.html` has a hidden `#help-nav` (`display:none`) whose `.help-nav-item[data-section]` buttons are **load-bearing state** for the section switcher (`activeSection()`/`switchToSection()`/`loadActiveSection()` in `navigation.ts`). The visible nav is the app's left rail (`#files-rail-nav` in `index.html`), which drives sections via `openHomeSection → gotoSection` (flipping the hidden nav's active classes). Leftover from migrating nav to the rail without rewriting the switcher. Footgun: every section must be wired in **two** places (hidden nav for state + visible rail for display) — caused "Vibes missing from rail" and "always loads dashboard". Cleanup (a refactor): drive section state from the rail/a state var and delete `#help-nav` + the `.help-nav-item` coupling so there's one nav.
