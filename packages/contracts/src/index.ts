import * as Schema from 'effect/Schema'

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
 * server wants an API key header, which Purrable cannot send yet.
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
 * What an open MCP App shared for the agent (`ui/update-model-context`), sent with the owner's next message. The
 * runtime passes it to the model as a separate block labelled untrusted, never as the owner's words.
 */
export const AppContext = Schema.Struct({
  serverId: Schema.String.check(Schema.isPattern(/^[\w-]{1,64}$/u)),
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

/** An MCP client the owner has authorized to use Purrable's /mcp server. */
export const InboundClient = Schema.Struct({
  clientId: Schema.String,
  name: Schema.optional(Schema.String),
  uri: Schema.optional(Schema.String),
  consentedAt: Schema.optional(Schema.String),
})
export type InboundClient = typeof InboundClient.Type

/** Pi's root conversation: the agent's one main conversation, where every channel and client talks. */
export const MAIN_THREAD = '1'

/**
 * A conversation of the agent the owner can open: `main` (Pi's root), a side `thread` (branched from main or new),
 * or a `subagent` the agent started. `parent` is main for a thread and the spawner for a subagent. A live thread also
 * carries its activity: `forkEntry`, the entry of main it branched at (none when it started empty); `replies`, the
 * messages written in the thread itself (the owner's and the agent's, not the main history it inherited); and
 * `lastReplyAt`, when the newest was written. Times are in seconds.
 */
export const ThreadView = Schema.Struct({
  id: Schema.String,
  kind: Schema.Literals(['main', 'thread', 'subagent']),
  title: Schema.optional(Schema.String),
  parent: Schema.optional(Schema.String),
  busy: Schema.Boolean,
  archived: Schema.Boolean,
  createdAt: Schema.Number,
  forkEntry: Schema.optional(Schema.Number),
  replies: Schema.optional(Schema.Number),
  lastReplyAt: Schema.optional(Schema.Number),
})
export type ThreadView = typeof ThreadView.Type

/** A bounded, owner-scoped preview used under a message in the main transcript. */
export const ThreadPreviewMessage = Schema.Struct({
  role: Schema.Literals(['user', 'assistant']),
  text: Schema.String.check(Schema.isMaxLength(800)),
  author: Schema.optional(Schema.String),
  quiet: Schema.optional(Schema.Array(Schema.String).check(Schema.isMaxLength(8))),
})
export type ThreadPreviewMessage = typeof ThreadPreviewMessage.Type

export const ThreadPreview = Schema.Struct({
  threadId: Schema.String,
  messages: Schema.Array(ThreadPreviewMessage).check(Schema.isMaxLength(5)),
  more: Schema.Number,
  busy: Schema.Boolean,
})
export type ThreadPreview = typeof ThreadPreview.Type

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

/** Switch one thing on or off in a conversation, or give a thread main's switches again. */
export const CapabilityChange = Schema.Union([
  Schema.Struct({ target: CapabilityTarget, on: Schema.Boolean }),
  Schema.Struct({ reset: Schema.Literal('main') }),
])
export type CapabilityChange = typeof CapabilityChange.Type

/**
 * What a conversation lets its agent use: each server with at least one granted tool (`on` is the server's switch,
 * each tool its own), each skills library the owner turned on, and whether it may start subagents. `sameAsMain`, on a
 * thread, says whether its switches are main's.
 */
export const ConversationCapabilities = Schema.Struct({
  thread: Schema.String,
  kind: Schema.Literals(['main', 'thread', 'subagent']),
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
  sameAsMain: Schema.optional(Schema.Boolean),
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

export { BillingState } from './billing.ts'
