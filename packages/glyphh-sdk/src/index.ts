/**
 * The public surface of @glyphh/sdk. This slice ships the control-plane (auth)
 * half; the rotor streaming transport (session/turn/reconnect) exports here next.
 */

export { createClient } from "./client.js";
export type { Client, ClientOptions, OpenSessionOptions, OpenHarnessOptions, RunTurnOptions, RunHandle } from "./client.js";
export type { AuthedHttp } from "./core/authed-http.js";

export { Session } from "./session/session.js";
export type { SessionConfig } from "./session/session.js";
export { SseTransport } from "./transport/sse-transport.js";
export type { Transport, TurnRequest } from "./transport/transport.js";
export type { Run, RunOptions } from "./transport/run.js";
export { WIRE_VERSION, isWireEvent } from "./protocol/events.js";
export type { WireEvent, WireEventKind, TurnEvent, LifecycleEvent, RunResult } from "./protocol/events.js";

export { HarnessClient, HarnessRun } from "./transport/harness.js";
export type { HarnessClientOptions, HarnessRunOptions, HarnessStartOptions, HarnessWsFactory, HarnessWsLike } from "./transport/harness.js";
export { HARNESS_WIRE_VERSION, isHarnessTerminal, isHarnessWireFrame } from "./contract/harness.js";
export type {
  HarnessFrame, HarnessWireFrame, HarnessAskQuestion, HarnessActionKind, HarnessMode,
  HarnessPermission, HarnessRunBody, HarnessRunAck, HarnessAnswer, HarnessRunResult,
  HarnessAttachmentRef, HarnessChatTurn, HarnessMcpServerRef, HarnessImageRef, HarnessSurface,
} from "./contract/harness.js";

export { AuthClient } from "./auth/auth-client.js";
export { InMemoryTokenStore } from "./auth/token-store.js";
export type { TokenStore } from "./auth/token-store.js";
export { sessionTokenProvider, staticTokenProvider } from "./auth/credential-provider.js";
export type { TokenProvider } from "./auth/credential-provider.js";

export {
  SdkError, ConnectError, ApiError, AuthError, ForbiddenError, ValidationError, NotFoundError,
  ProtocolError, UnsupportedError, RUNTIME_ERROR_CODES,
} from "./core/errors.js";
export type { RuntimeErrorCode } from "./core/errors.js";
export { createTtlCache } from "./core/cache.js";
export type { TtlCache, TtlCacheOptions } from "./core/cache.js";
export { createLogger } from "./core/logger.js";
export type { Logger, LogSink, LogEntry, LogLevel, LogFields, LoggerOptions } from "./core/logger.js";

export type {
  Identity,
  IssuedSession,
  StoredSession,
  MagicLinkStart,
  OrgSsoStart,
  OrgSsoParams,
  AppleName,
  DeviceAuthStart,
  DevicePrompt,
  DevicePoll,
  DevicePollStatus,
  DeviceLoginOptions,
} from "./contract/auth.js";

export { OrgClient } from "./resources/org.js";
export { MembersClient } from "./resources/members.js";
export { MembershipsClient } from "./resources/memberships.js";
export type { Membership, EffectiveContext } from "./contract/membership.js";
export { InvitesClient } from "./resources/invites.js";
export { WorkspacesClient } from "./resources/workspaces.js";
export type { Workspace, WorkspaceInput, EffectiveGrants, Grant } from "./contract/workspace.js";
export { BillingClient } from "./resources/billing.js";
export type { Plan, Subscription, Balance, MemberBudget, HostedUrl, UpcomingInvoice } from "./contract/billing.js";
export { ReleasesClient } from "./resources/releases.js";
export type { Release, ReleaseAsset, ReleaseAssetUrl } from "./contract/releases.js";
export { RuntimeImagesClient } from "./resources/runtime-images.js";
export type {
  RuntimeImage, RuntimeImageType, OrgRuntimeImage,
  AdminRuntimeImageCreate, AdminRuntimeImageUpdate,
} from "./contract/runtime-images.js";
export type { AppServerImage, AdminAppServerImageCreate, AdminAppServerImageUpdate } from "./contract/app-servers.js";
export { CatalogClient } from "./resources/catalog.js";
export { ProvidersClient } from "./resources/providers.js";
export { AdminClient } from "./resources/admin.js";
export type {
  Provider,
  Model,
  ProviderKind,
  EnableProviderInput,
  ProviderCreate,
  ModelCreate,
  ModelPricing,
  HfRepo,
  HfRecommended,
  HfSearchResult,
  HfQuant,
} from "./contract/catalog.js";
export type {
  AdminStats,
  AdminOrgListItem,
  AdminOrgsPage,
  AdminOrgMember,
  AdminOrgDetail,
  AdminOrgPatch,
  AdminUser,
  AdminUsersPage,
  AdminUserPatch,
  AdminPlan,
  AdminPlanUpdate,
  AdminModel,
  AdminModelUpdate,
  AdminPlanPrice,
  AuditEntry,
  AuditPage,
  AuditQuery,
  AdminUsageByUser,
  AdminUsageDay,
  AdminUsageByRuntime,
  AdminRuntimeUsageQuery,
  RuntimeMode,
  AdminDailyQuery,
  AdminListQuery,
} from "./contract/admin.js";
export { MarketingClient } from "./resources/marketing.js";
export type {
  MarketingLink,
  MarketingClick,
  ClicksByDay,
  MarketingLinksPage,
  MarketingStats,
  CreateLinkInput,
  UpdateLinkInput,
  LinksQuery,
  MarketingStatsQuery,
} from "./contract/marketing.js";
export { TasksClient } from "./resources/tasks.js";
export type { Task, TaskSummary, TaskManifest, TaskRole, ResolvedTaskRole, CreateTaskInput, UpdateTaskInput } from "./contract/tasks.js";
export { ConnectionsClient } from "./resources/connections.js";
export type {
  Connection,
  ConnectionKind,
  CustomMcpInput,
  ConnectLink,
  ConnectorApp,
  ConnectorTool,
  ResolvedConnection,
  RunToolResult,
  PersonalConnection,
  PersonalConnectSession,
  OrgMcpConnection,
  OrgMcpInput,
  OrgMcpPatch,
  OrgMcpCreateResult,
  OrgPipedreamConnection,
  McpOAuthStart,
} from "./contract/connections.js";
export { UsageClient } from "./resources/usage.js";
export type { UsageSummary, UsageDay, UsageDailyQuery, UsageByModelRow, UsageByModelQuery } from "./contract/usage.js";
export { ApiKeysClient } from "./resources/api-keys.js";
// THE licensing read — one place, everything checks it (resources/plans.ts).
export { PlansClient, type PlanGates, type PlanCapability } from "./resources/plans.js";
// LOOPS — the CLI pre-configs, governed by vendor.
export { OrgLibraryClient } from "./resources/org-library.js";
export type { OrgLibraryKind, OrgLibraryItem, OrgLibraryPending, OrgLibraryPromoteInput, OrgLibraryPromoteResult } from "./contract/org-library.js";
export type { GatewayToken } from "./contract/loops.js";
export type { ApiKey, ApiKeyInput, CreatedApiKey } from "./contract/api-keys.js";
export { SessionsClient } from "./resources/sessions.js";
export type {
  RuntimeSession,
  CreateSessionInput,
  ProvisionedSession,
  SessionLocus,
  SessionStatus,
  ModelSwitchInput,
  ModelSwitchResult,
  ModelSwitchSurface,
} from "./contract/runtime.js";
export type {
  SessionThread,
  SessionThreadMeta,
  SessionThreadMessage,
  PushThreadInput,
  PushThreadResult,
  ThreadTranscriptUrl,
  AppendThreadMessagesInput,
  AppendThreadMessagesResult,
} from "./contract/threads.js";
export { FilesClient } from "./resources/files.js";
export type { FileArtifact, FileKind, ListFilesQuery, CreateFileInput } from "./contract/files.js";
export { OfficeSlidesClient, OfficeDocsClient, OfficeDriveClient, OfficeSheetsClient } from "./resources/office.js";
export { DesignsClient } from "./resources/design.js";
export { StatorClient } from "./resources/stator.js";
export { MediaClient } from "./resources/media.js";
export type { MediaProject } from "./resources/media.js";
export { MusicClient } from "./resources/music.js";
export type { MusicArtist, MusicSong, MusicInstrument, MusicLibInstrument, MusicArtistInput, MusicSongInput } from "./resources/music.js";
export type {
  OfficeSlide, OfficeSlideMeta,
  OfficeDoc, OfficeDocMeta, OfficeSuggestion, CreateSuggestionInput,
  OfficeDocTemplate, OfficeFolder, OfficeDriveFile, OfficeDriveListing,
  OfficeSheet, OfficeSheetMeta, Workbook, Worksheet, SheetColumn, SheetCell,
} from "./contract/office.js";
export type {
  Design, DesignMeta, DesignSystem, DesignColor, DesignFont, DesignAsset, DesignSource, DesignImageryRef, DesignCanvas, UploadDesignAssetInput,
} from "./contract/design.js";
export type {
  GlyphFact, StatorRecallInput, StatorRecallResult, StatorBrowseInput, StatorBrowseResult,
  StatorCreateInput, StatorCreateResult, StatorGraphInput, StatorGraphNode, StatorGraphResult,
  StatorForgetInput, StatorForgetResult, StatorAmendInput, StatorAmendResult,
} from "./contract/stator.js";
export type {
  MediaAsset, MediaKind, MediaUploadTicket, MediaUploadInput, MediaFinalizeInput, MediaGenerateInput, MediaJob,
} from "./contract/media.js";
export { GitClient } from "./resources/git.js";
export type { GitConnection, GitConnectLink, GitInstallation, Repo } from "./contract/git.js";
export { EnvironmentsClient } from "./resources/environments.js";
export { DEFAULT_ENVIRONMENT_ID, ENVIRONMENT_NETWORKS, ENVIRONMENT_NETWORK_LABELS } from "./contract/environments.js";
export type {
  Environment, EnvironmentSummary, EnvironmentVar, EnvironmentNetwork, CreateEnvironmentInput, UpdateEnvironmentInput,
} from "./contract/environments.js";
export { ArtifactsClient, ArtifactCommentsClient } from "./resources/artifacts.js";
export { ARTIFACT_ACCESSES, ARTIFACT_SIZE_CAP } from "./contract/artifacts.js";
export type {
  Artifact, ArtifactAccess, ArtifactScope, ArtifactComment, ArtifactCommentAuthor, ArtifactRegion,
  CreateArtifactInput, UpdateArtifactInput, ShareArtifactResult, AddArtifactCommentInput,
} from "./contract/artifacts.js";
export { AppInstancesClient } from "./resources/app-instances.js";
export type {
  AppInstance, AppInstanceKind, AppInstanceAccess, AppInstanceStatus, AppInstanceManifest,
  AppRelease, AppUpload, AppInvokeResult, AppBuildResult,
  CreateAppInstanceInput, PatchAppInstanceInput,
} from "./contract/app-instances.js";
export { MarketplaceClient } from "./resources/marketplace.js";
export type {
  DeveloperScope,
  MarketplaceDeveloper,
  CreateDeveloperInput,
  UpdateDeveloperInput,
  DeveloperReview,
  FlaggedDeveloperReview,
} from "./contract/marketplace.js";
export { LibraryClient } from "./resources/library.js";
export type { LibraryItem, LibraryKind, LibraryScope, SaveLibraryItemInput } from "./contract/library.js";
export { MemberLibraryClient } from "./resources/member-library.js";
export { MEMBER_LIBRARY_KINDS } from "./contract/member-library.js";
export type {
  MemberLibraryKind, MemberLibraryRow, MemberLibraryItem, MemberLibraryFile, MemberLibraryFileUrls,
  ListMemberLibraryOptions, PutMemberLibraryInput, PutMemberLibraryResult, RemoveMemberLibraryInput,
} from "./contract/member-library.js";
export { RelayClient } from "./resources/relay.js";
export { AttachClient, type AttachStatus, type AttachedMachine, type FsEntry, type FsListing } from "./resources/attach.js";
export { RunStreamClient, type RunStreamHandle, type RunStreamFrame } from "./resources/run-stream.js";
export type {
  RelayPolicy,
  RelayDevice,
  RelayDeviceStatus,
  RelayStatus,
  EnableRelayInput,
} from "./contract/relay.js";
export { RotorConfigClient } from "./resources/rotor-config.js";
export type { RotorRole, RotorCatalogEntry } from "./contract/rotors.js";
export { OrgModelsClient } from "./resources/org-models.js";
export type { GatewayMetrics, GatewayDay, GatewayBreakdownRow } from "./resources/gateway.js";
export { ModelsClient, pickUtilityModel, utilityCost } from "./resources/models.js";
export { AgentsClient } from "./resources/agents.js";
export type {
  Agent,
  AgentSummary,
  AgentScope,
  AgentSelections,
  AgentTask,
  AgentTaskKind,
  LiveAgent,
  GuardrailsPolicy as AgentGuardrailsPolicy,
  CreateAgentInput,
  UpdateAgentInput,
  CreateAgentTaskInput,
  UpdateAgentTaskInput,
} from "./contract/agents.js";
export { SkillsClient } from "./resources/skills.js";
export type {
  Skill,
  SkillSummary,
  SkillManifest,
  SkillIO,
  CreateSkillInput,
  UpdateSkillInput,
} from "./contract/skills.js";
export { GatewayClient } from "./resources/gateway.js";
export {
  SystemOneClient, jevDecide, jevRoute, pickBranch, decisionSummary, decisionLine, routeRequest, branchKeys, validateDecideRequest,
  JEV_DEFAULT_MODEL, JEV_MAX_CHOICES, JEV_MIN_SCORE_LEVELS, JEV_MAX_SCORE_LEVELS, ROUTE_QUESTION_KEY,
} from "./resources/systemone.js";
export type {
  JevValue, JevText, JevState, JevNoulQuestion, JevChoiceQuestion, JevScoreQuestion, JevQuestion, JevQuestions,
  JevNoulAnswer, JevChoiceAnswer, JevScoreAnswer, JevAnswer, JevAnswerFor, JevUsage, JevConnection, JevAnswerSummary,
  DecideRequest, DecideResponse, RouteBranches, RouteOptions, RouteDecision, RouteResult,
} from "./resources/systemone.js";
export { GuestClient } from "./resources/guest.js";
export type {
  GatewayMessage,
  GatewayCompletionInput,
  GatewayChoice,
  GatewayUsage,
  GatewayCompletion,
  MessageTool,
  MessageTurn,
  MessageTurnInput,
  ToolUse,
  GuestToken,
  GuestTurnInput,
} from "./contract/gateway.js";
export type {
  OrgModel,
  AvailableModel,
  ModelSource,
  ModelAuditQuery,
  ModelAuditEntry,
  ModelAuditPage,
  CustomModel,
  CustomModelInput,
  CustomProvider,
  CustomProviderInput,
} from "./contract/models.js";
export type {
  ModelTransport,
  RoleBinding,
  RotorBinding,
  SetBindingInput,
  ResolvedModel,
  RotorRegistry,
} from "./contract/bindings.js";
export type {
  SupportTicketInput,
  SupportTicketAck,
  SupportTicketStatus,
  SupportUnread,
  SupportMessage,
  SupportTicket,
  SupportThread,
  SupportTicketCreate,
  AdminSupportMessage,
  AdminSupportTicket,
  AdminSupportThread,
  AdminSupportPage,
  AdminSupportQuery,
} from "./contract/support.js";
export type {
  Org,
  OrgUpdate,
  Address,
  BillingContact,
  Member,
  MemberRole,
  Invite,
  CreatedInvite,
  InvitePreview,
  GuardrailsPolicy,
  Guardrails,
} from "./contract/org.js";

// ── App spec + validators + template — the one contract every app builder shares ──
export {
  GLYPHH_APP_SPEC, appTemplateFiles, scaffoldAppFiles, appSlugOf, SCAFFOLD_NEXT,
  validateAppBundle, validateAppProject, parseAppManifest, lintRemoteAssets,
  checkCallTargets, checkCronExpressions, checkSqlDialect, extractConnectorCalls,
  KNOWN_CAPABILITIES, RETIRED_CAPABILITIES, MANIFEST_VERSIONS, APP_MANIFEST,
} from "./app-spec/index.js";
export type { AppBundle, AppValidationResult, ParsedAppManifest, AppManifestTool, ScaffoldOptions, ScaffoldTool, ScaffoldConnection } from "./app-spec/index.js";

// The sync rule — last-write-wins per item with tombstones; one pure function
// the member library and chat threads both reconcile by.
export { reconcile, compareLww } from "./sync/lww.js";
export type { LwwRow, Reconciled } from "./sync/lww.js";
