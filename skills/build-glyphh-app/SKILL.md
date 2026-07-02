---
name: build-glyphh-app
description: Author a Glyphh app — a portable .yoapp bundle with a UI window and/or MCP tools that surface on the user's Glyphh relay so any LLM can orchestrate them. Use when a developer or user wants to build, package, or deploy a Glyphh app (e.g. "make a Glyphh app that…", "build an app to send messages / create calendar events"), or to expose a machine capability as an MCP tool for the user's Glyphh.
---

# Build a Glyphh App

A **Glyphh app** is a `.yoapp` bundle (a zip: `manifest.json` + `index.html` +
assets) that installs like any other app AND can expose **MCP tools** the user's
LLM tools (Claude Desktop, Cowork, Cursor) discover and call through the Glyphh
relay. Full contract: `docs/GLYPHH-APP-SPEC.md`.

## When to use

- The user wants a small UI to do a machine task (send a text, create an event).
- The user wants that task exposed as an MCP **tool** so Claude can orchestrate
  it (`app_call_tool`), not just click it.
- Both — an app usually ships a UI *and* a tool over the same capability.

## What you can build on

Apps never touch the OS directly. They call **host capabilities** the host
implements and gates per-app. Only declared capabilities are reachable.

Current capabilities (macOS):

| capability        | args               | returns                       |
|-------------------|--------------------|-------------------------------|
| `messages.send`   | `{ to, body }`     | `{ sent: true }`              |
| `contacts.search` | `{ query }`        | `[{ name, value }]`           |

If the app needs a capability that doesn't exist yet, it must be added to the
host first (`src/main/glyphh-app-host.ts` `runCapability` + `KNOWN_CAPABILITIES`)
and documented in the spec — apps can't invent capabilities.

## Steps

1. **Scaffold** under `apps/<name>/`:
   - `manifest.json` — set `kind:"glyphh-app"`, `name`, `slug` (`[a-z0-9_-]`),
     `entry:"index.html"`, `capabilities`, and (for the agent path) `tools`.
     Every `tools[].capability` MUST be in `capabilities`.
   - `index.html` — self-contained UI. Talk to the host via
     `window.glyphh.call("<capability>", args)` → `{ ok, result }` / `{ ok:false, error }`.
     Keep it dependency-free (inline CSS/JS); no external network unless needed.

2. **Declare tools** (optional but the point of the marketplace). Each tool:
   ```json
   { "name": "send_message",
     "description": "…for the LLM…",
     "capability": "messages.send",
     "inputSchema": { "type":"object", "properties": {…}, "required": [...] } }
   ```
   The tool's `inputSchema` IS the capability's argument shape (1:1 passthrough
   in v1). Write the description for an LLM deciding whether to call it.

3. **Package**: `npm run pack:apps` → `dist-apps/<name>.yoapp`.

4. **Install / deploy**:
   - Locally: Apps page → Import → pick the `.yoapp`.
   - Remotely (Claude deploying for a user over MCP): base64 the bundle and call
     the `app_install` relay tool with `{ bundleBase64 }`.

5. **Verify the tool surface**: `app_list_tools` should now show the app + its
   tools; `app_call_tool { app, tool, args }` runs it headlessly.

## Reference: the Send Message app

`apps/messages/` is the canonical example — a phone-number + message UI over
`messages.send`, plus a `send_message` MCP tool. Copy its shape.

## Guardrails

- Keep `slug` stable — it's the `.dip` key and the tool namespace; re-install
  updates in place.
- Don't request capabilities the app doesn't use — the manifest is the security
  contract users read before installing.
- The UI and the tool run the SAME capability; don't duplicate logic in JS —
  keep the app thin and let the host do the privileged work.
