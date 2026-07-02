# Glyphh App Spec

A **Glyphh app** is a portable, installable unit that (a) runs a small UI window
on the user's machine and (b) can expose **MCP tools** that any consumer of the
user's Glyphh relay endpoint — Claude Desktop, Claude in Cowork, Cursor, a
scheduled agent — can discover and call. This is the marketplace unit: build an
app, share the bundle, install it, and its tools light up for the user's LLM
tools automatically.

This document is the contract. Version: **1**.

---

## 1. Anatomy

A Glyphh app ships as a `.yoapp` — a zip with the manifest and UI assets at the
root:

```
manifest.json      # required — the app contract (see §2)
index.html         # the app UI (the manifest `entry`)
…assets            # any CSS/JS/images the UI references (relative paths)
```

Install extracts it to `~/yo/custom-apps/<slug>/` and creates a normal Glyphh
saved-app row, so the app appears on the Apps page, in the command overlay,
answers to `.dip <slug>`, and can sit in a layout — **installed like any other
app**. Re-importing the same slug **updates** the existing install.

---

## 2. Manifest (`manifest.json`)

```jsonc
{
  "manifestVersion": 1,
  "kind": "glyphh-app",           // required — marks this as a Glyphh app
  "name": "Send Message",         // display name
  "slug": "send-message",         // stable id: [a-z0-9_-]; the .dip / tool key
  "entry": "index.html",          // UI entry, relative to the bundle root
  "description": "…",             // one line; shown in the app card
  "window": { "width": 440, "height": 520 },

  // Host capabilities this app is allowed to use. The host enforces this list
  // PER-APP: an app can only ever reach a capability it declared here. See §4.
  "capabilities": ["messages.send"],

  // MCP tools this app exposes to the relay (optional). Each maps to a host
  // capability the app also declared. See §3.
  "tools": [
    {
      "name": "send_message",
      "description": "Send an iMessage or SMS to a phone number or handle.",
      "capability": "messages.send",
      "inputSchema": {
        "type": "object",
        "properties": {
          "to":   { "type": "string", "description": "Phone number, email, or iMessage handle" },
          "body": { "type": "string", "description": "Message text" }
        },
        "required": ["to", "body"]
      }
    }
  ]
}
```

Rules:
- `slug` is unique per user. Re-install updates in place.
- Every `tools[].capability` MUST appear in `capabilities`. Install rejects a
  tool whose capability wasn't declared.
- `inputSchema` is a JSON Schema object. It's what the LLM sees and what the
  host validates args against before running. For v1 the tool's args are passed
  through to its capability 1:1 — the input schema IS the capability's argument
  shape. (Arg remapping is a future manifest field, not v1.)

---

## 3. Two faces: UI and tools

An app has two, independent surfaces. It can ship either or both.

- **UI** (`entry`) — a window the *user* opens (Apps page, `.dip`, command
  overlay). The UI talks to the host through `window.glyphh.call(method, args)`,
  where `method` is a declared capability. This is the human path.

- **Tools** (`tools[]`) — MCP tools the *LLM* discovers and calls through the
  relay, **headless** (no window needs to be open). This is the agent path.

Both run the same underlying host capabilities, gated by the same per-app
capability list. An app with no `tools[]` is a normal UI app. An app with no
`entry`… still needs an `entry` in v1 (the UI is the install anchor), but its
tools can be its whole point.

---

## 4. Capabilities (the host API)

Capabilities are implemented **in Glyphh**, never handed to app code — app code
only ever gets `glyphh.call(name, args)` / an MCP tool. The host owns the
implementation, the OS permission prompts, and the security boundary.

v1 capabilities (macOS; a Windows backend is follow-on):

| capability          | args                         | returns                              |
|---------------------|------------------------------|--------------------------------------|
| `messages.send`     | `{ to, body }`               | `{ sent: true }`                     |
| `contacts.search`   | `{ query }`                  | `[{ name, value }]` (phone/email)    |

New capabilities are added to the host (not by apps) and documented here. An app
declaring an unknown capability fails to install.

---

## 5. Discovery, invocation, deploy (the relay surface)

Everything an external LLM does goes through the user's single relay endpoint
(`https://api.glyphh.ai/mcp`, OAuth or token authed). Three generic MCP tools —
mirroring the existing `connector_list_tools` / `connector_call_tool` shape —
make **every installed app's tools discoverable and callable** without the
server registering per-user tools:

- **`app_list_tools`** → returns every installed app and its declared tools:
  `[{ app: slug, name, tools: [{ name, description, inputSchema }] }]`. This is
  how a consumer discovers what a specific user's Glyphh can do.

- **`app_call_tool { app, tool, args }`** → runs `<app>`'s `<tool>` headlessly
  on the user's machine and returns its result. The host validates that the tool
  exists, its capability was declared, and (best-effort) `args` against the
  tool's `inputSchema`.

- **`app_install { name?, bundleBase64 }`** → installs a `.yoapp` bundle for the
  user (create/update the saved app + register its tools). This is how Claude
  **deploys** an app it built, so it can immediately use the app's tools.

Under the hood each forwards to the user's live yo-client over the relay
WebSocket (`apps.listTools` / `apps.callTool` / `apps.install`), through the same
injection firewall + online check every relay tool uses.

### Orchestration loop

```
1. app_list_tools                     → discover what this user can do
2. app_install { bundleBase64 }       → (optional) deploy a new app Claude built
3. app_call_tool { app, tool, args }  → run it; use the result in the next step
```

A Claude skill (in Cowork or Claude Code) chains these: discover → deploy →
orchestrate. Because discovery is dynamic and per-user, a skill written once
adapts to whatever apps a given user has installed.

---

## 6. Security model

- **Per-app capability allowlist.** The host grants a window / tool exactly the
  capabilities its manifest declared — nothing else is reachable, even if the
  app's code asks. Enforced in the main process, not the sandbox.
- **Host-owned implementations.** Apps never get AppleScript, shell, or file
  access. They get capability calls the host implements and can rate-limit,
  prompt for, or revoke.
- **Injection firewall.** Every relay-forwarded call (including `app_call_tool`)
  is scanned before it reaches the user's machine; a hit short-circuits.
- **OS permissions still apply.** `messages.send` still triggers macOS's
  Automation prompt for Messages the first time — the host doesn't bypass the OS.

---

## 7. Building an app

1. Author `manifest.json` + `index.html` (+ assets) under `apps/<name>/`.
2. `npm run pack:apps` → `dist-apps/<name>.yoapp`.
3. Install: Apps page → Import, **or** `app_install { bundleBase64 }` over MCP.

The **`build-glyphh-app` skill** (`skills/build-glyphh-app/`) walks an LLM
through authoring a spec-conformant app end to end.

---

## 8. Versioning & compatibility

- `manifestVersion` gates the contract. This doc is v1.
- Unknown manifest fields are ignored (forward-compatible).
- A host that doesn't recognize a declared capability refuses to install the
  app rather than silently dropping it — better a clear failure than a partial
  install.
