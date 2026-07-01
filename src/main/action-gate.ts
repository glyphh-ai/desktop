/**
 * Action Gate — permission mode helpers and tool label registry.
 *
 * Mode names match the Claude Agent SDK's `permissionMode` values 1:1 so the
 * mode can be passed straight through to `sdk.query({ options: { permissionMode } })`.
 *
 * The SDK's native permission handling governs tool execution. This module
 * provides mode persistence, label lookups for the approval UI, and the
 * gate() function that maps mode → decision without per-tool overrides.
 */

import { getPreference } from "./preferences";
import { isDestructiveTool } from "./substrate/tools";

export type AgentMode = "plan" | "default" | "acceptEdits" | "bypassPermissions";
export type ToolTier = "observe" | "mutate";

export type GateDecision = "execute" | "needs_approval" | "skip";

export const TOOL_LABELS: Record<string, string> = {
  // Orchestrator tools
  search_captures:   "Search captures",
  get_context:       "Get session context",
  format:            "Format with skill",
  save_memory:       "Save memory",
  search_notes:      "Search notes",
  read_file:         "Read file",
  list_files:        "List files",
  run_command:       "Run command",
  delegate_navigate: "Navigate panels",
  delegate_layout:   "Arrange layout",
  // Navigator sub-agent tools
  list_panels:       "List panels",
  scan_panel:        "Scan panel",
  grab_panel:        "Grab panel content",
  click_element:     "Click element",
  navigate_panel:    "Navigate panel",
  type_text:         "Type text",
  open_panel:        "Open panel",
  open_background:   "Open in background",
  screenshot_panel:  "Screenshot panel",
  wait_for_response: "Wait for response",
  refresh_panel:     "Refresh panel",
  // Layout sub-agent tools
  switch_panel:      "Switch panel",
  split_view:        "Split view",
  grid_layout:       "Grid layout",
  swap_cell:         "Swap cell",
  apply_layout:      "Apply layout",
  save_layout:       "Save layout",
  delete_layout:     "Delete layout",
  list_layouts:      "List layouts",
  go_back:           "Go back",
  close_panel:       "Close panel",
  add_app:           "Add app",
  zoom:              "Zoom",
  manage_tabs:       "Manage tabs",
  create_swarm:      "Create swarm",
};

export const TOOL_DESCRIPTIONS: Record<string, string> = {
  // Orchestrator tools
  search_captures:   "Vector search across all captured content",
  get_context:       "Read current session context (in-memory captures)",
  format:            "Apply a skill to format content",
  save_memory:       "Save a preference or pattern to agent memory",
  search_notes:      "Keyword search across saved notes in ~/yo/notes/",
  read_file:         "Read a file from the local filesystem",
  list_files:        "List files in a directory",
  run_command:       "Run a read-only shell command (git log, ls, etc.)",
  delegate_navigate: "Sub-agent: scan, click, type, navigate app panels",
  delegate_layout:   "Sub-agent: split views, grids, tabs, workspace layout",
  // Navigator sub-agent tools
  list_panels:       "List all open panel IDs",
  scan_panel:        "Read visible DOM content from a panel",
  grab_panel:        "Extract full page content from a panel",
  click_element:     "Click a button, link, or interactive element",
  navigate_panel:    "Navigate a panel to a URL",
  type_text:         "Type text into a focused input field",
  open_panel:        "Open a new panel with an app or URL",
  open_background:   "Open a hidden panel for background loading",
  screenshot_panel:  "Capture a screenshot of a panel",
  wait_for_response: "Wait for a panel to finish loading",
  refresh_panel:     "Reload a panel",
  // Layout sub-agent tools
  switch_panel:      "Switch the active/focused panel",
  split_view:        "Split the view into multiple panels",
  grid_layout:       "Arrange panels in a grid",
  swap_cell:         "Swap two panel positions in the grid",
  apply_layout:      "Apply a saved layout by name",
  save_layout:       "Save the current layout with a name",
  delete_layout:     "Delete a saved layout",
  list_layouts:      "List all saved layouts",
  go_back:           "Navigate the active panel back",
  close_panel:       "Close a panel",
  add_app:           "Add an app to the workspace",
  zoom:              "Zoom in or out on a panel",
  manage_tabs:       "Open, close, or switch browser tabs",
  create_swarm:      "Spin up a local swarm of agents to work a goal",
};

/** Strip an `mcp__<server>__` prefix, if present, to the bare tool name. */
function bareToolName(toolName: string): string {
  const m = toolName.match(/^mcp__[^_]+__(.+)$/);
  return m ? m[1] : toolName;
}

/**
 * Three-way classification used by the gate. `isDestructiveTool` only knows the
 * substrate (`yo.*`) tools, so the built-in claude_code preset tools must be
 * classified explicitly here — otherwise Edit/Write/Bash fall through as
 * "observe" and would auto-run in acceptEdits AND plan mode.
 *   observe — read-only (safe to auto-run while planning / in acceptEdits)
 *   edit    — file mutations (auto-accepted in acceptEdits; blocked while planning)
 *   mutate  — runs code / kills processes / destructive (always prompts)
 */
export type ToolClass = "observe" | "edit" | "mutate";

const OBSERVE_BUILTINS = new Set<string>([
  "Read", "Grep", "Glob", "WebFetch", "WebSearch",
  "BashOutput", "ListMcpResources", "ReadMcpResource", "TaskOutput",
]);
const EDIT_BUILTINS = new Set<string>([
  "Edit", "Write", "NotebookEdit",
]);
const MUTATE_BUILTINS = new Set<string>([
  "Bash", "KillShell", "KillBash", "TaskStop", "TodoWrite",
]);

export function classifyTool(toolName: string): ToolClass {
  const bare = bareToolName(toolName);
  if (OBSERVE_BUILTINS.has(bare)) return "observe";
  if (EDIT_BUILTINS.has(bare)) return "edit";
  if (MUTATE_BUILTINS.has(bare)) return "mutate";
  // Substrate / MCP tools: destructive-flagged or name heuristic → mutate;
  // everything else (search / list / get / read-style) → observe.
  return isDestructiveTool(toolName) ? "mutate" : "observe";
}

/** Back-compat 2-way tier: edit + mutate both count as "mutate". */
export function getToolTier(toolName: string): ToolTier {
  return classifyTool(toolName) === "observe" ? "observe" : "mutate";
}

/**
 * Tools that ARE the user interaction (or are harmless UI affordances) and so
 * must never be gated behind an approval card — gating them would double-prompt
 * the user (approve the tool, *then* answer the question it raises). Names can
 * arrive bare or MCP-namespaced (`mcp__glyphh__<name>`), so we compare on the bare
 * name.
 */
const ALWAYS_EXECUTE = new Set<string>([
  "ask_user_question", // drives the composer wizard — the wizard is the consent
  "preview_url",       // just loads a URL into the Workbench preview slot
  "request_dev_tools", // lazy-preset escalation — just loads more tools; the
                       // dev tools it unlocks (Read/Edit/Bash) are still gated
                       // per-mode when actually used, so this must not prompt
  "mcp_tools_list",    // read-only connected-app discovery (lists the catalog) —
  "mcp_tool_schema",   // and reads one tool's schema. Harmless; the actual
                       // connected-app action (mcp_tool_call) is still gated.
  "find_tools",        // read-only tool search — never executes anything. The
                       // real action runs via call_tool, which stays gated on
                       // its inner tool. (Do NOT add call_tool here.)
]);

export function getAgentMode(): AgentMode {
  const raw = getPreference<string>("agentMode", "default");
  if (raw === "bypass") return "bypassPermissions";
  if (raw === "swarm") return "default";
  return raw as AgentMode;
}

export function gate(toolName: string, mode: AgentMode): GateDecision {
  const bare = bareToolName(toolName);
  // Interactive / inherently-safe tools run regardless of mode (even in plan
  // mode — asking the user a clarifying question is exactly what planning wants).
  if (ALWAYS_EXECUTE.has(bare)) return "execute";
  if (mode === "plan") {
    // ExitPlanMode is how the agent presents its plan and asks to proceed —
    // route it to approval so the user accepts the plan (and leaves plan mode).
    if (bare === "ExitPlanMode") return "needs_approval";
    // Read-only exploration is allowed while planning; mutations are blocked
    // (skipped) so planning never changes anything.
    return getToolTier(toolName) === "observe" ? "execute" : "skip";
  }
  if (mode === "bypassPermissions") return "execute";
  if (mode === "acceptEdits") {
    // Auto-run read-only AND file-edit tools; still prompt for code execution
    // / destructive tools (Bash, kill, etc.).
    const cls = classifyTool(toolName);
    return cls === "observe" || cls === "edit" ? "execute" : "needs_approval";
  }
  return "needs_approval";
}
