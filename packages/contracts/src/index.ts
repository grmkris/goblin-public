import * as Schema from 'effect/Schema'
import { HomeLayout } from './home.ts'
export * from './home.ts'

export type JsonObject = { readonly [key: string]: JsonValue }
export type JsonValue = null | boolean | number | string | JsonValue[] | JsonObject

export type McpServerConfig = {
  readonly serverId: string
  readonly endpoint: string
  readonly issuer?: string
  readonly resource?: string
}

/** Every failed API response: the error tag plus optional safe detail fields. */
export const ApiError = Schema.Struct({
  error: Schema.String,
  reason: Schema.optional(Schema.String),
  serverId: Schema.optional(Schema.String),
})
export type ApiError = typeof ApiError.Type

/** Owner-safe Events health. No callback URL, secret, signature or occurrence body crosses this view. */
export const EventHealth = Schema.Struct({
  subscriptionId: Schema.String,
  name: Schema.String,
  granted: Schema.Boolean,
  status: Schema.String,
  refreshBefore: Schema.NullOr(Schema.Number),
  lastReceiptAt: Schema.NullOr(Schema.Number),
})
export type EventHealth = typeof EventHealth.Type

/**
 * An outbound MCP server as the owner sees it. `live`: a connection is open right now. `source`: the deployment
 * configured it, or the owner added it. `title`, `description` and `icon` are the server's own claims.
 */
export const ServerView = Schema.Struct({
  serverId: Schema.String,
  endpoint: Schema.String,
  status: Schema.Literals(['connected', 'needs_auth', 'disconnected']),
  live: Schema.Boolean,
  serverName: Schema.optional(Schema.String),
  source: Schema.Literals(['config', 'added']),
  title: Schema.optional(Schema.String),
  description: Schema.optional(Schema.String),
  icon: Schema.optional(Schema.String),
  /** The live connection declares the MCP Skills extension. */
  skillsOffered: Schema.optional(Schema.Boolean),
  eventsOffered: Schema.optional(Schema.Boolean),
  eventHealth: Schema.optional(Schema.Array(EventHealth)),
  /** The owner uses this server's skills (procedures the agent follows). */
  skillsEnabled: Schema.optional(Schema.Boolean),
})
export type ServerView = typeof ServerView.Type

/** A server we suggest: our own description, whether it needs sign-in, and whether the owner already has it. */
export const ServerSuggestion = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  description: Schema.String,
  endpoint: Schema.String,
  signIn: Schema.Boolean,
  added: Schema.Boolean,
})
export type ServerSuggestion = typeof ServerSuggestion.Type

/**
 * A server found in an MCP registry, as its publisher describes it. `verified`: the registry checks namespace
 * ownership (the official one does). `variables`: placeholders in the endpoint the owner fills in. `needsKey`: the
 * server wants an API key header, which goblin cannot send yet.
 */
export const CatalogEntry = Schema.Struct({
  registry: Schema.String,
  registryTitle: Schema.String,
  verified: Schema.Boolean,
  name: Schema.String,
  title: Schema.optional(Schema.String),
  description: Schema.optional(Schema.String),
  version: Schema.optional(Schema.String),
  endpoint: Schema.String,
  variables: Schema.Array(Schema.String),
  needsKey: Schema.Boolean,
  added: Schema.Boolean,
})
export type CatalogEntry = typeof CatalogEntry.Type

/** An MCP registry searched for servers: built in (always searched) or added by the owner. */
export const RegistryView = Schema.Struct({ url: Schema.String, title: Schema.String, builtIn: Schema.Boolean })
export type RegistryView = typeof RegistryView.Type

/** A discovered remote tool. The hints come from the server and are unverified; only `granted` is ours. */
export const ToolView = Schema.Struct({
  name: Schema.String,
  title: Schema.optional(Schema.String),
  description: Schema.optional(Schema.String),
  readOnlyHint: Schema.optional(Schema.Boolean),
  destructiveHint: Schema.optional(Schema.Boolean),
  modelVisible: Schema.Boolean,
  appResource: Schema.optional(Schema.String),
  granted: Schema.Boolean,
})
export type ToolView = typeof ToolView.Type

export const ResidentStatus = Schema.Struct({
  state: Schema.Literals(['active', 'expired', 'revoked', 'never']),
  renewedAt: Schema.optional(Schema.Number),
  expiresAt: Schema.optional(Schema.Number),
  revokedAt: Schema.optional(Schema.Number),
})
export type ResidentStatus = typeof ResidentStatus.Type

/** Model tokens the user's agent spent today (UTC) against its daily limit, and when the day resets (epoch seconds). */
export const UsageToday = Schema.Struct({ used: Schema.Number, limit: Schema.Number, resetsAt: Schema.Number })
export type UsageToday = typeof UsageToday.Type

/** Main's memory: the messages it remembers, and how many of them its newest view summarizes. */
export const MemoryStatus = Schema.Struct({ messages: Schema.Number, summarized: Schema.Number })
export type MemoryStatus = typeof MemoryStatus.Type

/** The Telegram channel: the connection that carries it, or null when it is off. */
export const ChannelStatus = Schema.NullOr(
  Schema.Struct({
    serverId: Schema.String,
    enabledAt: Schema.Number,
    transport: Schema.optional(Schema.Literals(['events', 'doorbell'])),
  }),
)
export type ChannelStatus = typeof ChannelStatus.Type

/**
 * One question the agent asks the owner with `ask_user`. A choice question (`single`, `multi`) offers 2 to 8 options;
 * `allowOther` adds a free answer. The tool result's details are `{ kind: 'question', questions }`.
 */
export const QuestionOption = Schema.Struct({
  id: Schema.String,
  label: Schema.String,
  description: Schema.optional(Schema.String),
})
export const QuestionSpec = Schema.Struct({
  id: Schema.String,
  prompt: Schema.String,
  kind: Schema.Literals(['single', 'multi', 'text']),
  options: Schema.optional(Schema.Array(QuestionOption)),
  allowOther: Schema.optional(Schema.Boolean),
})
export type QuestionSpec = typeof QuestionSpec.Type

/**
 * What an open App shared for the agent (`ui/update-model-context`), sent with the owner's next message by its App id.
 * The runtime finds where the App comes from (its server, or the agent app it is) and passes the text to the model as
 * a separate block labelled untrusted, never as the owner's words.
 */
export const AppContext = Schema.Struct({
  app: Schema.String.check(Schema.isPattern(/^\d{1,12}$/u)),
  text: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(8192)),
})
export type AppContext = typeof AppContext.Type

/** A model the deployment offers. `route` groups models by provider route, because quotas are per route. */
export const ModelOption = Schema.Struct({
  id: Schema.String,
  label: Schema.String,
  route: Schema.String,
  note: Schema.String,
  images: Schema.Boolean,
  /** The context the agent may fill, in tokens; Pi compacts the conversation before it is full. */
  contextWindow: Schema.Number,
})
export type ModelOption = typeof ModelOption.Type

/** The model the user's agent answers with, the deployment default, and every model on offer (default first). */
export const ModelChoice = Schema.Struct({
  current: Schema.String,
  default: Schema.String,
  options: Schema.Array(ModelOption),
})
export type ModelChoice = typeof ModelChoice.Type

/** An MCP client the owner has authorized to use goblin's /mcp server. */
export const InboundClient = Schema.Struct({
  clientId: Schema.String,
  name: Schema.optional(Schema.String),
  uri: Schema.optional(Schema.String),
  consentedAt: Schema.optional(Schema.String),
})
export type InboundClient = typeof InboundClient.Type

/** Pi's root conversation: the agent's one main conversation, where every channel and client talks. */
export const MAIN_THREAD = '1'

/** The kinds of conversation: Pi's root `main`, a side `thread` the owner branched or started, a `subagent`. */
export const ConversationKind = Schema.Literals(['main', 'thread', 'subagent'])
export type ConversationKind = typeof ConversationKind.Type

/**
 * A conversation of the agent the owner can open. `parent` is the conversation it came from: the one a thread branched
 * from (or main for one started empty) and the spawner of a subagent; only main has none. `forkEntry` is the entry of
 * the parent a thread branched at. `replies` are the messages written in it (the owner's and the agent's, not the
 * history it inherited) and `lastReplyAt` when the newest was. A closed conversation (`closedAt`, by the owner or
 * `done` after a subagent's last report) stays readable and reopens; `keepOpen` stops a subagent closing itself.
 * Times are in seconds. Whether it is working right now is not here: the workspace feed carries that.
 */
export const ConversationView = Schema.Struct({
  id: Schema.String,
  kind: ConversationKind,
  title: Schema.optional(Schema.String),
  parent: Schema.optional(Schema.String),
  forkEntry: Schema.optional(Schema.Number),
  createdAt: Schema.Number,
  closedAt: Schema.optional(Schema.Number),
  closedBy: Schema.optional(Schema.Literals(['owner', 'done'])),
  keepOpen: Schema.Boolean,
  replies: Schema.Number,
  lastReplyAt: Schema.optional(Schema.Number),
  /** When the owner last saw the newest reply (seconds): a later `lastReplyAt` is unread. */
  readAt: Schema.optional(Schema.Number),
})
export type ConversationView = typeof ConversationView.Type

/** A thread from an entry of any open conversation, or (without `from`) an empty one under main. */
export const CreateConversation = Schema.Struct({
  from: Schema.optional(
    Schema.Struct({
      conversation: Schema.String.check(Schema.isPattern(/^\d{1,12}$/u)),
      entry: Schema.Int.check(Schema.isGreaterThan(0)),
    }),
  ),
})
export type CreateConversation = typeof CreateConversation.Type

/** Rename, close or reopen (with everything under it), or pin a subagent open. */
export const UpdateConversation = Schema.Struct({
  title: Schema.optional(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(120))),
  closed: Schema.optional(Schema.Boolean),
  keepOpen: Schema.optional(Schema.Boolean),
})
export type UpdateConversation = typeof UpdateConversation.Type

/**
 * What a conversation's agent is doing: `working` on a run, `waiting` with only its subagents at work, or `idle`.
 * `since` (milliseconds) is when that began.
 */
export const ConversationActivity = Schema.Struct({
  id: Schema.String,
  state: Schema.Literals(['idle', 'working', 'waiting']),
  since: Schema.Number,
})
export type ConversationActivity = typeof ConversationActivity.Type

/** Where a kept MCP App comes from: the tool call it shows, on its server, rendering a `ui://` resource. */
export const McpAppSource = Schema.Struct({
  kind: Schema.Literal('mcp'),
  callId: Schema.String,
  serverId: Schema.String,
  tool: Schema.String,
  uri: Schema.String,
})

/** An agent app (ADR 0021): its name, the release it runs and the revision its state is at. */
/**
 * One schedule of an agent app (ADR 0021): the action it runs, how often (a daily one at `at`, UTC), when next, how
 * the last run went, its failures in a row, and whether it is paused (by the owner, or by failures until a new
 * release).
 */
export const AgentAppJob = Schema.Struct({
  action: Schema.String,
  every: Schema.Literals(['15m', '30m', '1h', '3h', '6h', '12h', '1d']),
  at: Schema.NullOr(Schema.String),
  nextAt: Schema.Number,
  lastAt: Schema.NullOr(Schema.Number),
  status: Schema.NullOr(Schema.Literals(['ok', 'failed', 'waiting', 'skipped'])),
  /** Why the last run failed or waited. */
  error: Schema.NullOr(Schema.String),
  failures: Schema.Number,
  paused: Schema.NullOr(Schema.Literals(['owner', 'failures'])),
})
export type AgentAppJob = typeof AgentAppJob.Type

export const AgentAppSource = Schema.Struct({
  kind: Schema.Literal('agent'),
  name: Schema.String,
  release: Schema.String,
  version: Schema.Number,
  revision: Schema.Number,
  jobs: Schema.Array(AgentAppJob),
})

/**
 * An App the workspace shows (ADRs 0020, 0021): an MCP App kept from a tool call in a conversation, or an agent app
 * with its home conversation. It holds no grant: an App's calls are checked live, every time.
 */
export const AppView = Schema.Struct({
  id: Schema.String,
  conversation: Schema.String,
  title: Schema.String,
  createdAt: Schema.Number,
  closedAt: Schema.optional(Schema.Number),
  source: Schema.Union([McpAppSource, AgentAppSource]),
})
export type AppView = typeof AppView.Type

/** Keep the App of a tool call made in `conversation` (one from before Apps were kept, or one the owner closed). */
export const CreateApp = Schema.Struct({
  conversation: Schema.String.check(Schema.isPattern(/^\d{1,12}$/u)),
  callId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200)),
})
export type CreateApp = typeof CreateApp.Type

/** Close an App (its iframe goes everywhere) or reopen it. */
export const UpdateApp = Schema.Struct({ closed: Schema.Boolean })
export type UpdateApp = typeof UpdateApp.Type

/** What the browser needs to load an App. An MCP App: its server and resource, and the call it shows with its result. */
export const McpAppLaunch = Schema.Struct({
  kind: Schema.Literal('mcp'),
  serverId: Schema.String,
  uri: Schema.String,
  arguments: Schema.Record(Schema.String, Schema.Unknown),
  result: Schema.Unknown,
})

/** The frame runtime bundles an agent app's view loads besides `core`. */
export const AgentAppLib = Schema.Literals(['charts', 'maps', 'diagrams', 'icons'])
export type AgentAppLib = typeof AgentAppLib.Type

/** An agent app: its view's built module and CSS, the libraries it uses, and its state now. */
export const AgentAppLaunch = Schema.Struct({
  kind: Schema.Literal('agent'),
  name: Schema.String,
  release: Schema.String,
  revision: Schema.Number,
  state: Schema.Unknown,
  ui: Schema.Struct({ module: Schema.String, css: Schema.String, libs: Schema.Array(AgentAppLib) }),
})
export type AgentAppLaunch = typeof AgentAppLaunch.Type

export const AppLaunch = Schema.Union([McpAppLaunch, AgentAppLaunch])
export type AppLaunch = typeof AppLaunch.Type

/** An agent app's state now: its revision, the release that runs it, and the state itself. */
export const AppSnapshot = Schema.Struct({ revision: Schema.Number, release: Schema.String, state: Schema.Unknown })
export type AppSnapshot = typeof AppSnapshot.Type

/** An action an agent app's view calls, with the frame's operation id (a replay with it runs nothing again). */
export const AppCall = Schema.Struct({
  name: Schema.String.check(Schema.isPattern(/^[a-z][A-Za-z0-9]{0,31}$/u)),
  arguments: Schema.Record(Schema.String, Schema.Unknown),
  op: Schema.String.check(Schema.isPattern(/^[0-9a-f-]{36}$/u)),
})
export type AppCall = typeof AppCall.Type

/** What a view's action call returns: the state after it, or the app's own error. */
export const AppCallResult = Schema.Union([
  Schema.Struct({ ok: Schema.Literal(true), ...AppSnapshot.fields }),
  Schema.Struct({ ok: Schema.Literal(false), error: Schema.String }),
])
export type AppCallResult = typeof AppCallResult.Type

/** A power an agent app asks for (ADR 0021): a host to fetch from, an MCP tool, another app, model calls, Telegram. */
export const AppPowerKind = Schema.Literals(['egress', 'tool', 'app', 'llm', 'notify'])
export const AppPower = Schema.Struct({
  kind: AppPowerKind,
  target: Schema.String.check(Schema.isMaxLength(260)),
  status: Schema.Literals(['pending', 'approved', 'revoked']),
})
export type AppPower = typeof AppPower.Type

/** The owner approves (`allowed`) or revokes one power an agent app asks for. */
export const AppPowerChange = Schema.Struct({
  kind: AppPowerKind,
  target: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(260)),
  allowed: Schema.Boolean,
})
export type AppPowerChange = typeof AppPowerChange.Type

/** An agent app as the owner's Apps page lists it (ADR 0021): what it is, where it lives and whether it needs them. */
export const AgentAppSummary = Schema.Struct({
  name: Schema.String,
  title: Schema.String,
  description: Schema.String,
  /** Its home conversation, where its builds and notes go. */
  home: Schema.String,
  /** Its App id once it has a view (what opens it), otherwise null. */
  app: Schema.NullOr(Schema.String),
  version: Schema.Number,
  revision: Schema.Number,
  jobs: Schema.Array(AgentAppJob),
  /** How many powers it asks for that the owner has not allowed. */
  waiting: Schema.Number,
  /** Its newest event when that is a failure, otherwise null. */
  failure: Schema.NullOr(Schema.String),
  updatedAt: Schema.Number,
})
export type AgentAppSummary = typeof AgentAppSummary.Type

/** One agent app in full on its page: its versions, powers, today's usage, its files and what happened lately. */
export const AgentAppDetail = Schema.Struct({
  ...AgentAppSummary.fields,
  releases: Schema.Array(
    Schema.Struct({
      release: Schema.String,
      version: Schema.Number,
      status: Schema.Literals(['active', 'retired', 'failed']),
      note: Schema.NullOr(Schema.String),
      at: Schema.Number,
    }),
  ),
  powers: Schema.Array(AppPower),
  usage: Schema.Struct({ egress: Schema.Number, tokens: Schema.Number, notify: Schema.Number, job: Schema.Number }),
  files: Schema.Struct({ count: Schema.Number, bytes: Schema.Number }),
  events: Schema.Array(Schema.Struct({ kind: Schema.String, detail: Schema.String, at: Schema.Number })),
})
export type AgentAppDetail = typeof AgentAppDetail.Type

const AppAction = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(64))

/**
 * What the owner changes about an agent app: go back to an earlier version, pause or resume a schedule, run one now,
 * move its home to another conversation, or allow or revoke a power it asks for.
 */
export const AgentAppChange = Schema.Union([
  Schema.Struct({ kind: Schema.Literal('rollback'), release: Schema.String.check(Schema.isMaxLength(40)) }),
  Schema.Struct({ kind: Schema.Literal('pause'), action: AppAction, paused: Schema.Boolean }),
  Schema.Struct({ kind: Schema.Literal('run'), action: AppAction }),
  Schema.Struct({ kind: Schema.Literal('home'), conversation: Schema.String.check(Schema.isPattern(/^\d{1,12}$/u)) }),
  Schema.Struct({
    kind: Schema.Literal('power'),
    power: AppPowerKind,
    target: AppPowerChange.fields.target,
    allowed: Schema.Boolean,
  }),
])
export type AgentAppChange = typeof AgentAppChange.Type

/** Deleting an agent app erases it; the owner confirms by typing its name. */
export const DeleteAgentApp = Schema.Struct({ confirm: Schema.String.check(Schema.isMaxLength(40)) })
export type DeleteAgentApp = typeof DeleteAgentApp.Type

/** A failure an agent app's view reported (an uncaught error, a render that threw). */
export const AppDiagnostic = Schema.Struct({ message: Schema.String.check(Schema.isMaxLength(4000)) })
export type AppDiagnostic = typeof AppDiagnostic.Type

/** The workspace feed's first event: every conversation and App, and the conversations not idle. */
export const WorkspaceSnapshot = Schema.Struct({
  conversations: Schema.Array(ConversationView),
  activity: Schema.Array(ConversationActivity),
  apps: Schema.Array(AppView),
  home: Schema.optional(HomeLayout),
})
export type WorkspaceSnapshot = typeof WorkspaceSnapshot.Type

/** One change the workspace feed sends after its snapshot: a conversation or App as it is now, or what one is doing. */
export const WorkspaceChange = Schema.Union([
  Schema.Struct({ type: Schema.Literal('home'), home: HomeLayout }),
  Schema.Struct({ type: Schema.Literal('conversation'), conversation: ConversationView }),
  Schema.Struct({ type: Schema.Literal('activity'), activity: ConversationActivity }),
  Schema.Struct({ type: Schema.Literal('app'), app: AppView }),
  /** An App that is gone: the owner deleted the agent app it showed. */
  Schema.Struct({ type: Schema.Literal('app-removed'), id: Schema.String }),
])
export type WorkspaceChange = typeof WorkspaceChange.Type

/** A server id as configuration and the owner's added servers spell it. */
const ServerId = Schema.String.check(Schema.isPattern(/^[\w-]{1,64}$/u))
const ToolName = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256))

/**
 * One thing a conversation can switch off for its agent: a connected server, one of that server's granted tools, the
 * server's skills library, or starting subagents. Switching off only narrows the owner's grants (ADR 0010).
 */
export const CapabilityTarget = Schema.Union([
  Schema.Struct({ kind: Schema.Literal('server'), serverId: ServerId }),
  Schema.Struct({ kind: Schema.Literal('tool'), serverId: ServerId, name: ToolName }),
  Schema.Struct({ kind: Schema.Literal('skills'), serverId: ServerId }),
  Schema.Struct({ kind: Schema.Literal('subagents') }),
])
export type CapabilityTarget = typeof CapabilityTarget.Type

/** Switch one thing on or off in a conversation, or give a thread its parent's switches again. */
export const CapabilityChange = Schema.Union([
  Schema.Struct({ target: CapabilityTarget, on: Schema.Boolean }),
  Schema.Struct({ reset: Schema.Literal('parent') }),
])
export type CapabilityChange = typeof CapabilityChange.Type

/**
 * What a conversation lets its agent use: each server with at least one granted tool (`on` is the server's switch,
 * each tool its own), each skills library the owner turned on, and whether it may start subagents. `sameAsParent`, on a
 * thread, says whether its switches are those of the conversation it came from.
 */
export const ConversationCapabilities = Schema.Struct({
  thread: Schema.String,
  kind: ConversationKind,
  servers: Schema.Array(
    Schema.Struct({
      serverId: Schema.String,
      label: Schema.String,
      status: Schema.Literals(['connected', 'needs_auth', 'disconnected']),
      on: Schema.Boolean,
      tools: Schema.Array(
        Schema.Struct({ name: Schema.String, title: Schema.optional(Schema.String), on: Schema.Boolean }),
      ),
    }),
  ),
  skills: Schema.Array(Schema.Struct({ serverId: Schema.String, label: Schema.String, on: Schema.Boolean })),
  subagents: Schema.Boolean,
  sameAsParent: Schema.optional(Schema.Boolean),
})
export type ConversationCapabilities = typeof ConversationCapabilities.Type

const AUTHOR_TAG = /^\[from ([^\]\n]{1,80})\]$/u

/**
 * Who wrote a message into a conversation when it was not the owner's own browser (Telegram, an MCP client, a
 * subagent): its content starts with a text block holding only this tag. The model reads it as written.
 */
export const authorTag = (author: string): string => `[from ${author.replaceAll(/[\]\n]/gu, ' ').slice(0, 80)}]`

/** The author named by a leading tag block, if that is what the block is. */
export const authorOf = (block: string): string | undefined => AUTHOR_TAG.exec(block)?.[1]

/** The author of a message the owner sent from Telegram: their own words, from their phone. */
export const TELEGRAM_AUTHOR = 'Telegram'

export { BillingState } from './billing.ts'
export { Attachment, FILE_LIMITS, FILE_PATH, FileDirectory, FileEntry, FileListing, FilePath } from './files.ts'
export {
  RoutineTrigger,
  RoutineDefinition,
  RoutineView,
  RoutinePage,
  RoutineProposal,
  RoutineRevision,
  RoutineEdit,
  RoutineManualRun,
  RoutineRunView,
  RoutineRunPage,
  RoutineSettings,
} from './routines.ts'
