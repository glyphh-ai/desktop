/**
 * loop/index.ts — `@glyphh/sdk/loop` (Node-only): THE GLYPHH LOOP, one agent
 * loop for every host. The desktop's Agent panel and the `glyphh` CLI both run
 * `GlyphhLoop`; a host supplies the gateway credential, the MCP servers it
 * lends, and a sink for the loop's events. Files and the shell are built in
 * (tools.ts), so the module needs a real machine, not a browser.
 */

export {
  GlyphhLoop,
  GATEWAY_OFF_MESSAGE, NO_MODEL_MESSAGE, NO_FOLDER_MESSAGE, BUSY_MESSAGE, LOOP_EFFORTS,
  type LoopAgentDef, type LoopAgentRef, type LoopEffort,
  type LoopDeps, type LoopEmit, type LoopEvent, type LoopGateway, type LoopMcpServer, type LoopSpace, type LoopTurn,
} from "./loop.js";
export {
  gate, toolKind, readsByName, seedFromChat, shouldCompact, safeToolName, toolTitle, preview, systemPrompt,
  COMPACT_AT_TOKENS, MAX_TOOL_ROUNDS, MAX_TOKENS_OUT, roundsPausedMessage,
  type Gate, type LoopHost, type LoopMessage, type LoopPermission, type PromptExtras, type SeedTurn, type ToolKind,
} from "./core.js";
export { BUILTIN_TOOLS, runBuiltin, globToRegExp, type BuiltinResult, type ToolDef, type ToolDetail } from "./tools.js";
export {
  ARTIFACT_PUBLISH, ARTIFACT_PUBLISH_TOOL, ARTIFACT_READ, ARTIFACT_READ_TOOL, ARTIFACT_READ_CAP, ARTIFACT_SIZE_CAP, extensionFor, inferMime, isTextMime, nameWithExtension,
  runArtifactPublish, runArtifactRead, type ArtifactMeta, type LoopArtifacts, type PublishContext, type ReadContext,
} from "./artifacts.js";
export { lineDiff, type DiffHunk, type DiffLine, type FileDiff } from "./diff.js";
export { insideFolder, shellLaunch, shellProfile, OutsideFolderError } from "./sandbox.js";
export { streamMessage, assembleStream, sseEvents, isThinkingBlock, type AssembledMessage, type ContentBlock, type ImageParam, type MessageParam, type MessagesBody, type ThinkingBlock, type ToolSpec } from "./messages.js";
export { McpHttpClient, resultText, type McpCallResult, type McpToolAnnotations, type McpToolInfo } from "./mcp.js";
export { CALL_TOOL, FIND_TOOL, familyOf, searchCatalog, type LoopCatalogEntry, type LoopSkill } from "./catalog.js";
