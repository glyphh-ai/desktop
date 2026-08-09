/**
 * glyphh-agent-prompt.ts — the ONE turn assembly, shared by every run path.
 *
 * A tool-bearing turn is the same turn whether its loop runs in this process
 * (the Agent SDK path) or on the machine's LOCAL HARNESS POD (the rrotor
 * path): same persona, same workspace extras, same skill resolution, same
 * layered-memory user block. Keeping it in one module is what makes the two
 * paths swappable — a divergence here would silently change the agent's
 * behaviour depending on which engine served the turn.
 *
 * Split out of glyphh-agent.ts when the harness path landed; nothing here
 * knows about Electron windows or transports.
 */

import { GLYPHH_APP_SPEC } from "@glyphh/sdk";
import { currentLoop, resolveRoles } from "./loop-selections";
import { fetchOrgApps } from "./org-apps";
import { getClient } from "./glyphh-client";
import { attachmentPromptBlock, type AttachRef } from "./glyphh-agent-attachments";
import { shortTermRecallBlock } from "./glyphh-agent-recall";
import { relevantFilesHint } from "./workspace-index";
import { getExplicitWorkingDirectory } from "./working-directory";

export interface ChatMessage { role: "system" | "user" | "assistant"; content: string }

/** The hosted harness speaks as "Claude Code" and hints at ITS OWN CLI flags —
 *  neither exists for Glyphh users. Re-voice harness errors as Glyphh's own
 *  before they reach the chat. Model ids like "claude-sonnet-5" are data, not
 *  branding, and pass through untouched. */
export function brandError(message: string): string {
  return message
    .replaceAll("Claude Code", "Glyphh")
    .replace(/Run --model to pick a different model\.?/g, "Pick a different model from the composer's model chip.")
    .replace(/Run \/login[^.]*\./g, "Sign in again from Settings.");
}

/** Extra workspace context appended to the system prompt (app library +
 *  connected accounts) so open_app and connector tools target real names.
 *  `workdirOverride` is the RUN's real folder — passed for a relayed run driven
 *  from another device, where the desktop's globally-selected folder is NOT this
 *  run's folder (the phone picked its own). Without it the agent is told the wrong
 *  cwd while its tools actually run in the picked one. */
export async function workspaceExtras(workdirOverride?: string): Promise<string> {
  let appList = "";
  try {
    const apps = await fetchOrgApps();
    appList = apps.slice(0, 48).map((a) => a.slug || a.name).join(", ");
  } catch { /* offline — open_app still resolves by name */ }
  let connList = "";
  try {
    const connections = await getClient().connections.list();
    connList = [...new Set(connections.map((c) => String(c.slug || "")).filter(Boolean))].join(", ");
  } catch { /* signed out */ }
  // The ACTIVE loop's role→model bindings are the user's standing instruction
  // for who does what — without this block the agent runs everything itself
  // and has to be TOLD "use mistral for the build" every session.
  let loopBlock = "";
  try {
    const loop = currentLoop();
    const roles = await resolveRoles(loop);
    if (roles.length > 1) {
      const lead = roles[0]!;
      const others = roles.slice(1).map((r) => `"${r.name}" → ${r.modelId ?? "(no model bound)"}`).join(", ");
      loopBlock =
        `ACTIVE LOOP: "${loop}". Your own turns run as its "${lead.name}" role (${lead.modelId ?? "default model"}). ` +
        `The user bound the other roles to specific models on purpose: ${others}. ` +
        `Work that belongs to another role — e.g. implementation/build packets when there is a "builder" or "worker" role — ` +
        `MUST be delegated with run_role(role, task) instead of done by you, automatically, without the user asking. ` +
        `Say which role executed what in your reply.`;
    }
  } catch { /* offline — the loop block is advisory */ }
  // WHERE THE AGENT IS. Without this the model has filesystem/shell access to
  // the picked folder but is never told it's on the user's Desktop or which
  // folder is the project root — so it asks "which folder?" or refuses local
  // work it can actually do. The UI shows the folder chip; the agent must know
  // the same thing. Folder-scoped, so it only invalidates the prompt cache when
  // the user actually switches folders (a genuinely new context).
  const wd = workdirOverride || getExplicitWorkingDirectory();
  const envLine = wd
    ? `ENVIRONMENT: You are running on the user's Desktop machine, with direct access to its local filesystem and shell. Your working folder — the current app's project ROOT — is "${wd.split(/[\\/]/).filter(Boolean).pop() || wd}" at ${wd}. Read, write, and run commands there directly; never ask the user where you are or which folder to use.`
    : `ENVIRONMENT: You are running on the user's Desktop machine, with direct access to its local filesystem and shell. No working folder is picked yet — ask the user to choose one with the folder chip before building or editing files.`;
  return [
    envLine,
    appList ? `The user's app library (use these names with open_app — prefer the specific app over 'browser'): ${appList}` : "",
    connList ? `Connected accounts: ${connList} — each one's API tools are FIRST-CLASS tools in your toolset (real schemas; call them directly, never invent names).` : "",
    loopBlock,
    "RULE: the working folder ROOT holds the current app's project — build it there. To install it as a LOCAL panel app on this machine, call update_app() (it packages the built dist/, never your source). After any change, rebuild + update_app or tool calls run the stale installed version.",
    // PUBLISHING is deliberately not described here. The pod lends itself the
    // control plane's app tools and appends its own publish policy (rrotor
    // glyphh-apps.ts), so the scaffold → build → create_app_entry → build_app
    // flow is stated ONCE, in the place both the desktop and a cloud pod read
    // it. Repeating it here is how the two surfaces would drift.
    "RULE: to SHOW the user an app, open it in the Browser panel — open_browser(<published URL>) — never the raw app panel. Only fall back to open_app(<slug>) when there is no reachable URL (a local-only install, or a published app that needs a login the embedded browser lacks).",
    "RULE: NEVER start a local web server to show something — no `python3 -m http.server`, no `npx serve`, no `vite preview`. Publish the app and open its URL instead.",
    "RULE: shipping goes through the tools — never a CLI, never npx, and NEVER any login/device-auth flow. Your session is already authenticated; initiating authentication is forbidden.",
    GLYPHH_APP_SPEC,
    "Ada is your catalog: ada_recall(\"find email\") finds tools/apps/layouts by meaning; ada_ask({op:\"who\", conditions:{\"entity.kind\":\"tool\",\"relational.object\":\"gmail\"}}) lists a connector's tools exactly.",
    "MEMORY: you have layers — Ada (long-term facts), the rolling summary (mid-term), and <relevant_earlier_context> blocks (short-term recall of this session's own turns). On unfamiliar code, semantic_search(query) FIRST — it finds the right spans by meaning; read_file the spans it names instead of whole files.",
  ].filter(Boolean).join("\n\n");
}

/**
 * A leading `/slug` is a SKILL reference (the composer's "/" menu, or a
 * "Create with AI" seed): resolve it to the skill's instruction body so the
 * model runs the skill instead of guessing what the token means. Unknown slugs
 * resolve to "" — the text may just be a path.
 */
export async function skillSeedFor(ask: string): Promise<string> {
  const slashRef = /^\/([a-z0-9_-]+)\b/.exec(ask.trim());
  if (!slashRef) return "";
  try {
    const skill = await getClient().skills.get(slashRef[1]!);
    return `## Skill: ${skill.name}\n${skill.prompt}`;
  } catch {
    return ""; // not a skill — send as typed
  }
}

export interface ComposedTurn {
  /** The system prompt: persona + memory + summary + workspace extras. Byte-
   *  stable between runs so the model's prompt cache keeps hitting. */
  system: string;
  /** The user turn: prior turns, layered memory, skill body, the ask, and the
   *  attachment/file hints. Messages churn anyway — per-turn context rides
   *  HERE, never in the cached system prefix. */
  lastUser: string;
  /** The raw ask (the composer's text), for callers that need it separately. */
  ask: string;
}

/**
 * Assemble one tool-bearing turn from the context-assembled message list.
 *
 * System prompt = assembled base system + workspace extras, and NOTHING that
 * changes per turn: Anthropic's prompt cache is prefix-based (tools → system →
 * messages), so a byte-stable block means every send within the cache TTL
 * re-reads the big prefix at 10% price instead of re-writing it.
 */
export async function composeTurn(
  base: ChatMessage[],
  chatId: string,
  attachments: AttachRef[] = [],
  workdir?: string,
): Promise<ComposedTurn> {
  const ask = String(base[base.length - 1]?.content ?? "");
  const history = base.slice(1, -1)
    .map((m) => `${m.role === "user" ? "User" : "Glyphh"}: ${m.content}`)
    .join("\n");
  const [extras, skillSeed, recallBlock, filesHint] = await Promise.all([
    workspaceExtras(workdir),
    skillSeedFor(ask),
    chatId ? shortTermRecallBlock(chatId, ask).catch(() => "") : Promise.resolve(""),
    (async () => {
      const wd = workdir || getExplicitWorkingDirectory();
      return wd ? relevantFilesHint(wd, ask).catch(() => "") : "";
    })(),
  ]);
  const system = [base[0]?.content ?? "", extras].filter(Boolean).join("\n\n");
  const lastUser = [
    history ? `<conversation_so_far>\n${history}\n</conversation_so_far>` : "",
    recallBlock,
    skillSeed,
    ask,
    attachmentPromptBlock(attachments),
    filesHint,
  ].filter(Boolean).join("\n\n");
  return { system, lastUser, ask };
}
