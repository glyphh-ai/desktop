/**
 * client.ts — `createClient` wires the pieces into the object every consumer holds:
 * an HTTP client over injectable `fetch`, a token store, the refresh manager, and
 * the auth surface. The rotor `session()`/`turn()` transport attaches here in a
 * later slice; this slice ships the control-plane (auth) half.
 */

import { HttpClient, type FetchLike } from "./core/http.js";
import { InMemoryTokenStore, type TokenStore } from "./auth/token-store.js";
import { RefreshManager } from "./auth/refresh-manager.js";
import { AuthClient } from "./auth/auth-client.js";
import { sessionTokenProvider, staticTokenProvider, type TokenProvider } from "./auth/credential-provider.js";
import { createLogger, type LoggerOptions } from "./core/logger.js";
import { AuthedHttp } from "./core/authed-http.js";
import { SseTransport } from "./transport/sse-transport.js";
import { HarnessClient, type HarnessRunOptions, type HarnessStartOptions } from "./transport/harness.js";
import type { HarnessSurface } from "./contract/harness.js";
import { Session, type SessionConfig } from "./session/session.js";
import { OrgClient } from "./resources/org.js";
import { MembersClient } from "./resources/members.js";
import { MembershipsClient } from "./resources/memberships.js";
import { InvitesClient } from "./resources/invites.js";
import { WorkspacesClient } from "./resources/workspaces.js";
import { BillingClient } from "./resources/billing.js";
import { ReleasesClient } from "./resources/releases.js";
import { CatalogClient } from "./resources/catalog.js";
import { VoiceClient } from "./resources/voice.js";
import { ProvidersClient } from "./resources/providers.js";
import { AdminClient } from "./resources/admin.js";
import { MarketingClient } from "./resources/marketing.js";
import { TasksClient } from "./resources/tasks.js";
import { ConnectionsClient } from "./resources/connections.js";
import { UsageClient } from "./resources/usage.js";
import { ApiKeysClient } from "./resources/api-keys.js";
import { PlansClient } from "./resources/plans.js";
import { OrgLibraryClient } from "./resources/org-library.js";
import { SessionsClient } from "./resources/sessions.js";
import { FilesClient } from "./resources/files.js";
import { OfficeSlidesClient, OfficeDocsClient, OfficeDriveClient, OfficeSheetsClient } from "./resources/office.js";
import { DesignsClient } from "./resources/design.js";
import { StatorClient } from "./resources/stator.js";
import { MediaClient } from "./resources/media.js";
import { MusicClient } from "./resources/music.js";
import { GitClient } from "./resources/git.js";
import { EnvironmentsClient } from "./resources/environments.js";
import { ArtifactsClient } from "./resources/artifacts.js";
import { MarketplaceClient, LibraryMarketClient } from "./resources/marketplace.js";
import { AppInstancesClient } from "./resources/app-instances.js";
import { LibraryClient } from "./resources/library.js";
import { MemberLibraryClient } from "./resources/member-library.js";
import { RelayClient } from "./resources/relay.js";
import { AttachClient } from "./resources/attach.js";
import { RunStreamClient } from "./resources/run-stream.js";

/**
 * THE ONE PATH. Every surface runs a turn through `client.run()` — never by
 * choosing `harness()` vs `attach.run()` itself. The SDK routes on `target`:
 * `desktop` relays the turn to the caller's attached machine (its real files +
 * tools); `cloud` runs it on a runtime pod through the region-routed proxy. Both
 * return the SAME {@link RunHandle}, so callers consume every turn identically.
 */
export interface RunTurnOptions {
  /** Where the turn executes. Default `cloud`. */
  target?: "desktop" | "cloud";
  runId?: string;
  threadId?: string;
  prompt?: string;
  messages?: Array<{ role: string; text?: string; content?: string }>;
  mode?: "chat" | "work" | "cowork" | "code";
  workdir?: string;
  /** Which attached machine runs a desktop turn (AttachedMachine.id). Absent → the newest. */
  machineId?: string;
  /** A RELATIVE folder inside the CLOUD workspace to run the turn in — the
   *  source chip's cloud folder pick. Ignored on desktop-relay turns. */
  subdir?: string;
  /** The session's GitHub repo (`owner/repo`) — a cloud workspace's source;
   *  the pod pre-clones it. Ignored on desktop-relay turns. */
  repo?: string;
  /** The base branch the pod checks out with `repo` (one of `git.branches`).
   *  Absent → the repo's default. Ignored on desktop-relay turns. */
  branch?: string;
  /** The member's named cloud ENVIRONMENT this turn runs in (one of
   *  `environments.list`; his direction, 2026-10-05: personal environments).
   *  The front door injects its variables and network policy into the worker
   *  server-side. Absent or "default" → the built-in Default: no variables,
   *  full network. Ignored on desktop-relay turns. */
  environmentId?: string;
  /** The model id to run this turn on. Honored on BOTH targets: the cloud pod
   *  runs it directly; a desktop-relay turn overrides the machine's own loop
   *  model with it (so the caller's picker wins). Absent → the executor's default. */
  model?: string;
  /** The agent LOOP this turn runs. Honored on BOTH targets (program-per-turn
   *  P0): a desktop-relay turn forwards it to attach.run, overriding the
   *  machine's own active loop; a cloud turn carries it in the harness run body
   *  so the pod can attribute — and, from P1, EXECUTE — the loop's program
   *  (server/docs/program-per-turn.md). Absent → the executor's active loop. */
  loop?: string;
  permission?: string;
  /** The turn's EFFORT (the composer's dial: low | medium | high | …) — the
   *  same value the desktop's local run carries. Cloud turns forward it in
   *  the harness run body; a desktop-relay turn leaves it to the machine's
   *  own setting. Absent → the executor's default. */
  effort?: string;
  images?: Array<{ mediaType: string; data: string }>;
  /** The loop's memory policy (rides to the runtime as HarnessMemoryPolicy). */
  memory?: unknown;
  /** WHERE THE CALLER IS (HarnessSurface): "web" from app.glyphh.ai, "desktop"
   *  from the desktop's cloud lane, "cli" from a CLI. A cloud turn carries it
   *  in the run body so the pod's window tools act on the right surface (on
   *  the web the page opens things itself; a desktop keeps the relay). A
   *  desktop-relay turn ignores it — the machine IS the surface. */
  surface?: HarnessSurface;
  /** The attached desktops this session may reach over the relay (HarnessRunBody.devices). */
  devices?: string[];
  /** The turn's own folder per machine, beside the grants (HarnessRunBody.folders). */
  folders?: Record<string, string[]>;
  signal?: AbortSignal;
}

/** The single run handle — identical for desktop-relay and cloud-pod turns. */
export interface RunHandle {
  readonly runId?: string;
  on(cb: (frame: { type: string; [k: string]: unknown }) => void): () => void;
  readonly done: Promise<{ runId: string; text?: string; stopped?: boolean; error?: string }>;
  answer(id: string, reply: { allow?: boolean; answers?: string[] }): Promise<void>;
  stop(): Promise<void>;
  /** Change the permission mode of THIS in-flight turn — the executor (desktop or
   *  cloud pod) re-reads it on the next tool decision, so a mode flip lands mid-run
   *  instead of only on the next turn. */
  setPermission(mode: "ask" | "plan" | "acceptEdits" | "auto" | "bypass"): Promise<void>;
}
import { RotorConfigClient } from "./resources/rotor-config.js";
import { GatewayClient } from "./resources/gateway.js";
import { SystemOneClient } from "./resources/systemone.js";
import { GuestClient } from "./resources/guest.js";
import { SkillsClient } from "./resources/skills.js";
import { AgentsClient } from "./resources/agents.js";
import { OrgModelsClient } from "./resources/org-models.js";
import { ModelsClient } from "./resources/models.js";
import { ProfileClient } from "./resources/profile.js";
import { SupportClient } from "./resources/support.js";
import { OAuthClient } from "./resources/oauth.js";
import { RuntimeImagesClient } from "./resources/runtime-images.js";
import type { Identity, StoredSession } from "./contract/auth.js";

export interface ClientOptions {
  /** Control-plane base URL, e.g. https://api.glyphh.ai (or http://127.0.0.1:3001). */
  url: string;
  /** Injectable fetch — pass the platform's fetch in RN/tests. Defaults to global. */
  fetch?: FetchLike;
  /** Where the session lives. Defaults to in-memory; pass a platform adapter to persist. */
  tokenStore?: TokenStore;
  /** Refresh this many ms before access-token expiry (default 60s). */
  refreshMarginMs?: number;
  /** Fired once when the session becomes unrecoverable — flip the UI to signed-out. */
  onSignedOut?: () => void;
  /** A `gy_ak_` API key for headless use — bypasses the interactive session entirely. */
  apiKey?: string;
  /** Request timeout in ms (default 30s). */
  timeoutMs?: number;
  /** Optional observability. No telemetry by default — silent unless you pass a sink. */
  log?: LoggerOptions;
}

/** Options for opening a rotor session (the data plane). */
export interface OpenSessionOptions extends SessionConfig {
  /** Runtime base URL (a provisioned `*.fly.dev`, or the client url for loopback). */
  url?: string;
  /** Runtime bearer. Defaults to the client's session token. */
  token?: TokenProvider;
  /** Injectable fetch for the runtime stream (defaults to the client's). */
  fetch?: FetchLike;
}

/** Options for opening a HARNESS pod (the `glyphh.harness/v1` data plane). */
export interface OpenHarnessOptions {
  /** The pod's base URL (the provisioned session's `runtimeUrl`). */
  url: string;
  /** Runtime bearer — the session's `gy_rk_` runtime token (NOT the
   *  control-plane session token). Loopback/auth-off pods need none. */
  token?: TokenProvider;
  /** Injectable fetch for the pod (defaults to the client's). */
  fetch?: FetchLike;
  /** Reconnect/poll/WS knobs for this pod's runs. */
  run?: HarnessRunOptions;
}

export interface Client {
  /**
   * Escape hatch: authenticated raw HTTP against the control plane (bearer +
   * refresh handled). For endpoints a typed resource client doesn't cover yet —
   * prefer the typed clients; migrate callers off this as coverage lands.
   */
  http: AuthedHttp;
  /** The sign-in surface (magic link, Google, Apple, org SSO, sign out). */
  auth: AuthClient;
  /** The caller's own editable profile (name + timezone). */
  profile: ProfileClient;
  /** Submit support tickets (relayed to the configured sink). */
  support: SupportClient;
  /** Glyphh as an OAuth authorization server: consent + authorized connections. */
  oauth: OAuthClient;
  /** The caller's organization (read + org_admin update). */
  org: OrgClient;
  /** Org membership + seats (list, invite, remove, set role). */
  members: MembersClient;
  /** The caller's own memberships + the session's active-org scope (the org-switcher). */
  memberships: MembershipsClient;
  /** Accept an org invite. */
  invites: InvitesClient;
  /** Workspaces — governance (models/connections/apps/limits) + member assignment. */
  workspaces: WorkspacesClient;
  /** Billing — plans, subscription, the budget, Stripe checkout/portal. */
  billing: BillingClient;
  /** Desktop builds — the release list and signed download URLs. */
  releases: ReleasesClient;
  /** Runtime image SKUs (§7b) — the org's picker, current image, and change requests. */
  runtimeImages: RuntimeImagesClient;
  /** The provider/model catalog (read). */
  catalog: CatalogClient;
  /** Voice runtime — transcribe (STT) + synthesize (TTS). */
  voice: VoiceClient;
  /** Org provider enablement + BYOK (org_admin). */
  providers: ProvidersClient;
  /** Glyphh platform administration (super_admin). */
  admin: AdminClient;
  /** Marketing link tracking + click analytics (super_admin). */
  marketing: MarketingClient;
  /** The org's TASK library (members read; org_admin builds). Formerly
   *  `loops` — renamed 2026-09-12 so "loop" means one thing. Routes return
   *  with the Build section. */
  tasks: TasksClient;
  /** Connectors — Pipedream accounts + custom MCP servers (org_admin manages). */
  connections: ConnectionsClient;
  /** Usage rollups — dollars spent by user, workspace, org. */
  usage: UsageClient;
  /** User-scoped `gy_ak_` API keys for headless SDK/CLI use + the desktop relay. */
  apiKeys: ApiKeysClient;
  /** THE licensing read — what this org's plan allows. Every surface gates
   *  here and nowhere else (see resources/plans.ts). */
  plans: PlansClient;
  /** The ORG's loop support list — which CLIs this organization runs. */
  /** The ORG LIBRARY — promoted tasks/agents/skills: publish, review, role
   *  access, installs. One library, keyed by kind. */
  orgLibrary: OrgLibraryClient;
  /** Control-plane runtime sessions — provision/list/get/deprovision (data plane is `session()`). */
  sessions: SessionsClient;
  /** Saved FILE ARTIFACTS — the explicit deliverables an agent saves for the user (list/get/create/delete). */
  files: FilesClient;
  /** Glyphh Office · Slides — the org's shared, agent-authored slide decks (list/get/put/delete). */
  officeSlides: OfficeSlidesClient;
  /** Glyphh Office · Docs — markdown documents + the review-and-approve suggestion flow + templates. */
  officeDocs: OfficeDocsClient;
  /** Glyphh Office · Sheets — JSON workbooks with materialized formula values. */
  officeSheets: OfficeSheetsClient;
  /** Glyphh Drive — folders and the pointer view over every Office file. */
  officeDrive: OfficeDriveClient;
  /** Glyphh Design — org design systems: the brand kit Apps and Slides consume (list/get/put/css/assets). */
  designs: DesignsClient;
  /** The org MEMORY PLANE — recall/write for runtimes; browse/graph/forget/amend for curation (the Memory panel). */
  stator: StatorClient;
  /** Glyphh Image/Video/Sounds — the media library + enforced, credit-debited generation jobs. */
  media: MediaClient;
  /** The Music Studio documents — artists (look + voice + style) and songs (lyrics + prompt + band + lineage). */
  music: MusicClient;
  /** GitHub connection — link, list repos; sessions with a repo get a scoped clone token. */
  git: GitClient;
  /** The member's named cloud environments — variables + network policy a cloud turn runs under. */
  environments: EnvironmentsClient;
  /** Artifacts — pages and files the loop published for the member: list, share, comment. */
  artifacts: ArtifactsClient;
  /** Installed apps — instances on the app server: install, build from source, releases, pin, invoke. */
  appInstances: AppInstancesClient;
  /** Marketplace developer profiles + developer reviews. */
  marketplace: MarketplaceClient;
  /** Skills + loops marketplace — free installs, org share queue, review desk. */
  libraryMarket: LibraryMarketClient;
  /** Rotor-loop library (personal + org). */
  rotors: LibraryClient;
  /** Skill library — manifest + prompt + optional program (org_admin builds). */
  skills: SkillsClient;
  /** Standing workers: an agent runs a loop and fires scheduled tasks. */
  agents: AgentsClient;
  /** Workbench layout library (personal + org). */
  layouts: LibraryClient;
  /** Drip (scheduled prompt) library (personal + org). */
  drips: LibraryClient;
  /** Saved message-session library (personal + org). */
  messageSessions: LibraryClient;
  /** THE MEMBER LIBRARY v2 — workspaces, tabs, skills, agents, tasks: database
   *  as truth, files in R2, synced per item by `reconcile` (LWW + tombstones). */
  memberLibrary: MemberLibraryClient;
  /** Drive-my-desktop relay — org policy + per-device opt-in (same-user, revocable). */
  relay: RelayClient;
  /** Attached-desktop control — status + dispatch a method to the caller's own live machine. */
  attach: AttachClient;
  /** Attach to a thread's live run and stream its frames (the run-stream broker) —
   *  "open a thread anywhere, see the live turn". */
  runStream: RunStreamClient;
  /** Rotor catalog + role→model bindings + the resolved runtime registry. */
  rotorConfig: RotorConfigClient;
  /** The org's SUPPORTED model set + model-governance audit (org_admin). */
  orgModels: OrgModelsClient;
  /** The caller's EFFECTIVE model set — what they may actually use right now. */
  models: ModelsClient;
  /** The metered model call — the one egress for model traffic. */
  gateway: GatewayClient;
  /** Jev (TypeSafe's System One decision model) through GlyphhRouter's
   *  /v1/systemone: a state + typed questions → numeric answers. */
  decide: SystemOneClient["decide"];
  /** Route a state to one of `branches` with one Jev `choice` question —
   *  deterministic: highest probability, ties to the first branch listed,
   *  `fallback` under `minConfidence`. */
  route: SystemOneClient["route"];
  /** The anonymous (no-account) chat surface — mint a guest token + chat via the gateway. */
  guest: GuestClient;
  /** App-icon resolution — the server's cached icon for a domain, as a URL an
   *  <img>/texture loads directly (public endpoint, no bearer). */
  icons: { urlFor(domain: string): string };
  /** The bearer supplier for authenticated calls / the rotor transport. */
  token: TokenProvider;
  /** Force a session refresh (rotation). Resolves false if signed out. */
  refresh(): Promise<boolean>;
  /** The current stored session, or null if signed out. */
  getSession(): Promise<StoredSession | null>;
  /** The authenticated principal (who am I). Requires a session. */
  me(): Promise<Identity>;
  /** Open a rotor session on the runtime (streaming turns, durable reconnect). */
  session(opts: OpenSessionOptions): Session;
  /** Open a HARNESS pod (`glyphh.harness/v1`) — interactive chat/cowork/code
   *  turns streamed as agent frames, durable across reconnects. */
  harness(opts: OpenHarnessOptions): HarnessClient;
  /** THE SINGLE FRONT DOOR for interactive turns: a HarnessClient bound to the
   *  control-plane turn proxy (`/api/harness`), which region-routes to the org's
   *  regional rrotor + stator. No pod URL, no provisioning — the caller's session
   *  token authenticates and the server picks the region. Every surface should run
   *  turns through this (docs/turn-proxy.md). */
  harnessViaApi(): HarnessClient;

  /** THE ONE PATH. Run a turn — `target: 'desktop'` relays to the caller's
   *  attached machine, `target: 'cloud'` (default) runs on a runtime pod — and
   *  get back the same {@link RunHandle} either way. Surfaces call this, never
   *  `harness()`/`attach.run` directly. */
  run(opts: RunTurnOptions): RunHandle;
}

export function createClient(opts: ClientOptions): Client {
  const logger = createLogger(opts.log ?? {});
  const http = new HttpClient({
    baseUrl: opts.url,
    logger,
    ...(opts.fetch ? { fetchImpl: opts.fetch } : {}),
    ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
  });
  const store = opts.tokenStore ?? new InMemoryTokenStore();
  const refresh = new RefreshManager(http, store, {
    logger,
    ...(opts.refreshMarginMs !== undefined ? { refreshMarginMs: opts.refreshMarginMs } : {}),
    ...(opts.onSignedOut ? { onSignedOut: opts.onSignedOut } : {}),
  });
  // A static credential (an API key) has no session to refresh; anything else rides
  // the interactive session.
  const staticCred = opts.apiKey;
  const token: TokenProvider = staticCred ? staticTokenProvider(staticCred) : sessionTokenProvider(refresh);
  // Session clients recover a mid-call 401 with one forced refresh (a dead
  // refresh signs out); a static credential has nothing to refresh.
  const authed = new AuthedHttp(http, token, staticCred ? undefined : () => refresh.onUnauthorized());
  const gateway = new GatewayClient(authed);
  const systemOne = new SystemOneClient(gateway, opts.fetch);
  // `authed` is built first: the device grant's APPROVE leg is performed BY the
  // signed-in user, so AuthClient needs an authenticated transport for it.
  const auth = new AuthClient(http, refresh, authed);
  return {
    http: authed,
    auth,
    profile: new ProfileClient(authed),
    support: new SupportClient(authed),
    oauth: new OAuthClient(authed),
    org: new OrgClient(authed),
    members: new MembersClient(authed),
    memberships: new MembershipsClient(authed),
    invites: new InvitesClient(http, authed),
    workspaces: new WorkspacesClient(authed),
    billing: new BillingClient(authed),
    releases: new ReleasesClient(authed),
    runtimeImages: new RuntimeImagesClient(authed),
    catalog: new CatalogClient(authed),
    voice: new VoiceClient(authed),
    providers: new ProvidersClient(authed),
    admin: new AdminClient(authed),
    marketing: new MarketingClient(authed),
    tasks: new TasksClient(authed),
    connections: new ConnectionsClient(authed),
    usage: new UsageClient(authed),
    apiKeys: new ApiKeysClient(authed),
    plans: new PlansClient(authed),
    orgLibrary: new OrgLibraryClient(authed),
    sessions: new SessionsClient(authed),
    files: new FilesClient(authed),
    officeSlides: new OfficeSlidesClient(authed),
    officeDocs: new OfficeDocsClient(authed),
    officeSheets: new OfficeSheetsClient(authed),
    officeDrive: new OfficeDriveClient(authed),
    designs: new DesignsClient(authed),
    stator: new StatorClient(authed),
    media: new MediaClient(authed),
    music: new MusicClient(authed),
    git: new GitClient(authed),
    environments: new EnvironmentsClient(authed),
    artifacts: new ArtifactsClient(authed),
    appInstances: new AppInstancesClient(authed),
    marketplace: new MarketplaceClient(authed),
    libraryMarket: new LibraryMarketClient(authed),
    rotors: new LibraryClient(authed, "rotor"),
    skills: new SkillsClient(authed),
    agents: new AgentsClient(authed),
    layouts: new LibraryClient(authed, "layout"),
    drips: new LibraryClient(authed, "drip"),
    messageSessions: new LibraryClient(authed, "message_session"),
    memberLibrary: new MemberLibraryClient(authed),
    relay: new RelayClient(authed),
    attach: new AttachClient(authed),
    runStream: new RunStreamClient(authed),
    rotorConfig: new RotorConfigClient(authed),
    orgModels: new OrgModelsClient(authed),
    models: new ModelsClient(authed),
    gateway,
    decide: systemOne.decide,
    route: systemOne.route,
    // The guest surface rides the UNAUTHENTICATED transport — a guest token is not a
    // session bearer, it is carried per-call.
    guest: new GuestClient(http),
    icons: {
      // v=2: cache-shape bump — clients that pinned the (formerly cacheable)
      // 404s bypass those entries instead of replaying them for an hour.
      urlFor: (domain: string): string =>
        `${opts.url.replace(/\/$/, "")}/api/icons?domain=${encodeURIComponent(domain.trim().toLowerCase())}&v=2`,
    },
    token,
    refresh: async () => (await refresh.refresh()) !== null,
    getSession: () => store.load(),
    me: async () => http.get<Identity>("/api/auth/me", { bearer: await token() }),
    session: (sopts: OpenSessionOptions): Session => {
      // The runtime bearer is a SEPARATE credential (the provisioned runtimeToken),
      // not the control-plane session token — and loopback needs none. Only attach
      // one if the caller supplies it.
      const transport = new SseTransport({
        baseUrl: sopts.url ?? opts.url,
        ...(sopts.token ? { token: sopts.token } : {}),
        ...(sopts.fetch ?? opts.fetch ? { fetchImpl: sopts.fetch ?? opts.fetch } : {}),
      });
      return new Session(transport, { ...sopts, run: { logger, ...(sopts.run ?? {}) } });
    },
    harness: (hopts: OpenHarnessOptions): HarnessClient =>
      // Like `session()`: the pod bearer is the provisioned runtimeToken, a
      // SEPARATE credential — only attach one if the caller supplies it.
      new HarnessClient({
        baseUrl: hopts.url,
        ...(hopts.token ? { token: hopts.token } : {}),
        ...(hopts.fetch ?? opts.fetch ? { fetchImpl: hopts.fetch ?? opts.fetch } : {}),
        run: { logger, ...(hopts.run ?? {}) },
      }),
    harnessViaApi: (): HarnessClient =>
      // The single front door: bind to the control-plane proxy, authenticated by
      // the user's OWN session token (not a pod runtimeToken). The server
      // region-routes and forwards the bearer; the rrotor introspects + owner-scopes.
      new HarnessClient({
        baseUrl: `${opts.url.replace(/\/+$/, "")}/api/harness`,
        token,
        ...(opts.fetch ? { fetchImpl: opts.fetch } : {}),
        run: { logger },
      }),

    // THE ONE PATH every surface uses. Routes to the right executor and returns
    // the common RunHandle. `harness()`/`attach.run` remain as the transports it
    // delegates to — nothing else should call them directly.
    run: (ropts: RunTurnOptions): RunHandle => {
      const { target = "cloud", signal, mode } = ropts;
      if (target === "desktop") {
        // The thread's TYPE rides through: a Work turn has no folder, and sent as
        // "code" the machine refuses it for want of one.
        const attachMode: "work" | "code" = mode === "work" || mode === "chat" || mode === "cowork" ? "work" : "code";
        return new AttachClient(authed).run(
          {
            ...(ropts.runId ? { runId: ropts.runId } : {}),
            ...(ropts.threadId ? { threadId: ropts.threadId } : {}),
            ...(ropts.prompt ? { prompt: ropts.prompt } : {}),
            ...(ropts.messages ? { messages: ropts.messages } : {}),
            mode: attachMode,
            ...(ropts.workdir ? { workdir: ropts.workdir } : {}),
            ...(ropts.model ? { model: ropts.model } : {}),
            ...(ropts.loop ? { loop: ropts.loop } : {}),
            ...(ropts.permission ? { permission: ropts.permission as "ask" | "plan" | "acceptEdits" | "auto" | "bypass" } : {}),
            ...(ropts.images?.length ? { images: ropts.images } : {}),
            ...(ropts.machineId ? { machineId: ropts.machineId } : {}),
          },
          signal ? { signal } : {},
        ) as unknown as RunHandle;
      }
      const hc = new HarnessClient({
        baseUrl: `${opts.url.replace(/\/+$/, "")}/api/harness`,
        token,
        ...(opts.fetch ? { fetchImpl: opts.fetch } : {}),
        run: { logger },
      });
      const body = {
        ...(ropts.runId ? { runId: ropts.runId } : {}),
        ...(ropts.threadId ? { threadId: ropts.threadId } : {}),
        ...(ropts.prompt ? { prompt: ropts.prompt } : {}),
        ...(ropts.messages ? { messages: ropts.messages } : {}),
        ...(ropts.mode ? { mode: ropts.mode } : {}),
        ...(ropts.workdir ? { workdir: ropts.workdir } : {}),
        ...(ropts.subdir ? { subdir: ropts.subdir } : {}),
        ...(ropts.repo ? { repo: ropts.repo } : {}),
        ...(ropts.repo && ropts.branch ? { branch: ropts.branch } : {}),
        ...(ropts.environmentId ? { environmentId: ropts.environmentId } : {}),
        ...(ropts.model ? { model: ropts.model } : {}),
        ...(ropts.loop ? { loop: ropts.loop } : {}),
        ...(ropts.permission ? { permission: ropts.permission } : {}),
        ...(ropts.effort ? { effort: ropts.effort } : {}),
        ...(ropts.images && ropts.images.length ? { images: ropts.images } : {}),
        ...(ropts.memory ? { memory: ropts.memory } : {}),
        ...(ropts.surface ? { surface: ropts.surface } : {}),
        ...(ropts.devices && ropts.devices.length ? { devices: ropts.devices } : {}),
        ...(ropts.folders && Object.keys(ropts.folders).length ? { folders: ropts.folders } : {}),
        ...(signal ? { signal } : {}),
      } as HarnessStartOptions;
      return hc.start(body) as unknown as RunHandle;
    },
  };
}
