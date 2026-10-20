/**
 * @glyphh/sdk/runtime — the Node-only local runtime: the per-machine supervisor,
 * the governed model bridge, and the RUNNER that executes loops and skills. Shared by
 * every local client (CLI, desktop). Import from `@glyphh/sdk/runtime`; do not pull
 * into a browser/RN bundle.
 */

export {
  ensureLocalRuntime,
  localRuntimeStatus,
  stopLocalRuntime,
  type LocalRuntime,
  type EnsureRuntimeOptions,
} from "./supervisor.js";
export type { RuntimeRecord } from "./discovery.js";

// The machine's one LOCAL HARNESS POD (rrotor ROTOR_MODE=harness, auth off,
// loopback) — the local seat of "one harness everywhere". Shared by CLI + desktop.
export {
  ensureLocalHarnessPod,
  localHarnessPodStatus,
  stopLocalHarnessPod,
  resolveHarnessCommand,
  type LocalHarnessPodOptions,
} from "./harness-pod.js";

// The governed model bridge: resolve a rotor's role→model binding into rrotor's
// endpoint map, plus per-session model switching with an audit trail.
export {
  resolveModels,
  switchModel,
  sessionOverrides,
  clearSessionOverrides,
  type ModelEndpoint,
  type ResolvedModels,
  type ResolveModelsOptions,
  type SwitchModelOptions,
} from "./models.js";

// The loop/skill runner: one engine, one capability gate, one model egress.
export {
  runProgram,
  CapabilityError,
  type ProgramSource,
  type ProgramCapabilities,
  type RunProgramOptions,
  type RunnerHost,
  type RunResult,
  type RunUsage,
  type ProgressEvent,
  type ProgressType,
  type ProgressStatus,
} from "./runner.js";

// The local Anthropic endpoint an agent loop is pointed at: forward + stream, no
// decisions. Governance stays server-side, where the keys and the ledger are.
export {
  startInterceptor,
  type Interceptor,
  type InterceptorOptions,
} from "./interceptor.js";
export { startAttachHost, type AttachHost, type AttachHostOptions, type AttachHandler } from "./attach.js";
