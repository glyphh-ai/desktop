/**
 * glyphh-skill-export — generate a provider-tailored "skill" file that teaches
 * an external LLM (Claude, Gemini, OpenAI) how to drive the user's Glyphh
 * through the MCP relay: open apps/layouts, run installed apps' tools, and
 * orchestrate tasks. The user saves it into that tool's
 * skills / custom instructions.
 *
 * The BODY is the same everywhere (it's the same relay + tools); only the
 * wrapper differs per provider (Claude wants SKILL.md frontmatter; Gemini /
 * OpenAI want a plain system-instruction preamble).
 */

export type SkillProvider = "claude" | "gemini" | "openai";

const ENDPOINT = "https://api.glyphh.ai/mcp";

const BODY = `## What Glyphh is

Glyphh is the user's workspace on their own machine. Through this MCP connection
you can open their apps and saved layouts as native windows, run tools their
installed apps expose. Everything executes
on the user's machine; you send commands, Glyphh runs them.

## Connect

Add Glyphh's MCP endpoint to your connectors/tools:

    ${ENDPOINT}

Use OAuth if your client supports it (approve the "Glyphh" connection). Otherwise
paste a token generated in Glyphh → Settings → MCP as a Bearer header.

## Tools

**Windows & layouts**
- \`panels_open { app }\` — open an app ("browser", "terminal", or a saved-app slug) in its own native window.
- \`panels_list\` — list open app windows (slug, name, url, title, focused).
- \`panels_switch { app }\` / \`panels_close { app }\` — focus / close a window.
- \`layouts_open { name }\` — open a saved layout: its apps tiled across the display as real OS windows.

**Installed app tools (the marketplace)**
- \`app_list_tools\` — discover the MCP tools the user's installed Glyphh apps expose: \`[{ app, name, tools: [{ name, description, inputSchema }] }]\`.
- \`app_call_tool { app, tool, args }\` — run one of those tools headlessly (e.g. send a message, create an event). \`args\` must match the tool's inputSchema.
- \`app_install { path }\` — install/update a .glyphh bundle already on the user's machine (absolute path — preferred). Also accepts { url } to download, or { bundleBase64 } for tiny bundles only.

**Connected accounts**
- \`connector_list_tools\` / \`connector_call_tool { slug, name, args }\` — call the user's connected apps' APIs (Slack, GitHub, Notion, …).

## How to work

1. **Discover first.** Call \`app_list_tools\` (and \`panels_list\` / \`connector_list_tools\` as needed) to see what THIS user can do — their installed apps differ, so never assume a tool exists.
2. **Use declared tools.** If an installed app exposes \`app_call_tool\`, use it — it's deterministic and runs headlessly.
3. **Chain.** Use one tool's result as the next tool's input. Example: \`app_list_tools\` → find a "send_message" tool → \`app_call_tool { app, tool:"send_message", args:{ to, body } }\`.

## Guardrails

- These tools act on the user's real machine and accounts. Confirm before anything destructive or outward-facing (sending messages, posting, deleting).
- If a call returns "yo-client isn't connected", the user's Glyphh app is closed or offline — ask them to open it.
`;

function frontmatterClaude(): string {
  return `---
name: glyphh
description: Drive the user's Glyphh workspace over MCP — open their apps and saved layouts as native windows, run tools their installed apps expose, and call their connected accounts. Use when the user asks to open/arrange apps, send a message or perform an action through one of their Glyphh apps, or automate something on their machine.
---

# Glyphh

`;
}

function preamble(provider: "gemini" | "openai"): string {
  const name = provider === "gemini" ? "Gemini" : "your assistant";
  return `# Glyphh skill

Paste this into ${name}'s custom instructions (${provider === "gemini" ? "a Gem's instructions" : "a Custom GPT's instructions or a system prompt"}) after connecting Glyphh's MCP endpoint. It teaches you to drive the user's Glyphh workspace.

`;
}

/** Build the skill file (name + content) for a provider. */
export function generateGlyphhSkill(provider: SkillProvider): { filename: string; content: string } {
  if (provider === "claude") {
    return { filename: "SKILL.md", content: frontmatterClaude() + BODY };
  }
  if (provider === "gemini") {
    return { filename: "glyphh-gemini-instructions.md", content: preamble("gemini") + BODY };
  }
  return { filename: "glyphh-openai-instructions.md", content: preamble("openai") + BODY };
}
