import * as Schema from 'effect/Schema'
import { NonEmptyString } from './ids.ts'

/** A server id as the owner's requests name it: configured ids and the ones added servers get. */
const ConnectionIdField = NonEmptyString(64)

/** What a grant covers on a server: a tool, a resource (an App's `ui://` bundle) or a prompt. */
export const GrantCapability = Schema.Literals(['tool', 'resource', 'prompt'])
export type GrantCapability = typeof GrantCapability.Type

/**
 * One exact grant the owner gave: a tool, resource or prompt on one server, by name. Absence is denial; there are no
 * wildcards. `askFirst`: each call of the tool waits for the owner's decision (ADR 0028).
 */
export const Grant = Schema.Struct({
  connectionId: Schema.String,
  capability: GrantCapability,
  name: Schema.String,
  askFirst: Schema.optionalKey(Schema.Boolean),
})
export type Grant = typeof Grant.Type

/** Where an added server was found: a registry entry (name and version), or nothing for a pasted URL. */
export const ServerSource = Schema.Struct({
  registry: NonEmptyString(2048),
  name: NonEmptyString(256),
  version: Schema.optional(NonEmptyString(64)),
})
export type ServerSource = typeof ServerSource.Type

/** `POST /api/mcp/servers`: add a server by its https endpoint, from a registry entry or pasted. */
/**
 * The owner's name for a connection (e.g. "Sidequest · Hirer", ADR 0041): one line of 1–80 characters, unique on the
 * agent whatever its case.
 */
export const ConnectionLabel = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(80),
  Schema.makeFilter(
    (text) =>
      // oxlint-disable-next-line no-control-regex -- a label is one line of plain text: control characters are refused.
      (text.trim() === text && !/[\u0000-\u001f\u007f\u2028\u2029]/u.test(text)) ||
      'A label is one line with no leading or trailing space.',
  ),
)
/** A connection to add: its endpoint, the owner's label (a free one is chosen when left out) and where it was found. */
export const AddServer = Schema.Struct({
  endpoint: NonEmptyString(2048),
  label: Schema.optional(ConnectionLabel),
  source: Schema.optional(ServerSource),
})
export type AddServer = typeof AddServer.Type

/** `POST /api/mcp/registries` and `…/registries/remove`: a registry by its URL. */
export const RegistryChange = Schema.Struct({ url: NonEmptyString(2048) })
export type RegistryChange = typeof RegistryChange.Type

/** `PUT /api/mcp/grants`: grant or revoke one discovered tool. */
export const GrantChange = Schema.Struct({
  connectionId: ConnectionIdField,
  name: NonEmptyString(256),
  allowed: Schema.Boolean,
})
export type GrantChange = typeof GrantChange.Type

/** `PUT /api/mcp/ask-first`: a granted tool's calls wait for the owner's decision, or no longer do. */
export const AskFirstChange = Schema.Struct({
  connectionId: ConnectionIdField,
  name: NonEmptyString(256),
  enabled: Schema.Boolean,
})
export type AskFirstChange = typeof AskFirstChange.Type

/** `PUT /api/mcp/skills`: the agent uses a server's skills, or stops. */
export const SkillsChange = Schema.Struct({ connectionId: ConnectionIdField, enabled: Schema.Boolean })
export type SkillsChange = typeof SkillsChange.Type

/** What `PUT /api/mcp/skills` answers: the server and its switch as it is now. */
export const SkillsSetting = Schema.Struct({ connectionId: Schema.String, enabled: Schema.Boolean })
export type SkillsSetting = typeof SkillsSetting.Type

/** `PUT /api/mcp/app-grants`: grant or revoke an MCP App as a whole, by its `ui://` resource. */
export const AppGrantChange = Schema.Struct({
  connectionId: ConnectionIdField,
  uri: NonEmptyString(2048).check(Schema.isPattern(/^ui:\/\//u)),
  allowed: Schema.Boolean,
})
export type AppGrantChange = typeof AppGrantChange.Type

/** `POST /api/mcp/approvals/:id`: the owner's decision on a held call. */
/** A dollar amount as a plain decimal: digits, then at most two after a point (ADR 0044). */
export const Dollars = Schema.String.check(Schema.isPattern(/^\d{1,6}(?:\.\d{1,2})?$/u))
export type Dollars = typeof Dollars.Type

/**
 * The owner's decision on a held call. `runUpTo`: approve it, and from now on run this paid tool's jobs up to that much
 * without asking (ADR 0044); its daily total stays as it was, or starts at four times the amount.
 */
export const ApprovalDecision = Schema.Struct({ allowed: Schema.Boolean, runUpTo: Schema.optional(Dollars) })
export type ApprovalDecision = typeof ApprovalDecision.Type

/**
 * A first-class server's paid tool and the owner's rule for it (ADR 0044), with what it spent today (UTC): amounts in
 * dollars. No `perJob`: every job asks first.
 */
export const SpendingView = Schema.Struct({
  tool: Schema.String,
  perJob: Schema.optional(Schema.String),
  daily: Schema.optional(Schema.String),
  spentToday: Schema.String,
})
export type SpendingView = typeof SpendingView.Type

/** The owner's rule for a paid tool: run jobs up to `perJob` without asking, `daily` a day at most; null for none. */
export const SpendingChange = Schema.Struct({ perJob: Schema.NullOr(Dollars), daily: Schema.NullOr(Dollars) })
export type SpendingChange = typeof SpendingChange.Type

/**
 * How goblin tops up a prepaid server's own balance from the Goblin Wallet (ADR 0049): up to `perTopUp` a top-up and
 * `daily` a day without asking, what it moved today (UTC), all in dollars, and the chain and token it moves.
 */
export const TopUpView = Schema.Struct({
  chain: Schema.String,
  token: Schema.String,
  perTopUp: Schema.String,
  daily: Schema.String,
  movedToday: Schema.String,
})
export type TopUpView = typeof TopUpView.Type

/** The owner's top-up rule: up to `perTopUp` a top-up and `daily` a day without asking; above it, goblin asks. */
export const TopUpChange = Schema.Struct({ perTopUp: Dollars, daily: Dollars })
export type TopUpChange = typeof TopUpChange.Type

/** What `POST /api/mcp/:id/connect` answers: where to send the owner's browser, when sign-in is needed. */
export const ConnectStart = Schema.Struct({ authorizationUrl: Schema.optional(Schema.String) })
export type ConnectStart = typeof ConnectStart.Type

/** One OAuth scope token (RFC 6749 §3.3): printable ASCII but space, `"` and `\`. */
const ScopeToken = Schema.String.check(Schema.isPattern(/^[\x21\x23-\x5B\x5D-\x7E]{1,128}$/u))

/**
 * `POST /api/mcp/:id/connect`: sign in. `scope`, when the owner chose access, is the scopes to ask for, each one the
 * server offers (`GET /api/mcp/:id/access`); without it goblin asks for everything offered.
 */
export const ConnectRequest = Schema.Struct({
  scope: Schema.optional(Schema.Array(ScopeToken).check(Schema.isMinLength(1), Schema.isMaxLength(64))),
})
export type ConnectRequest = typeof ConnectRequest.Type

/** `GET /api/mcp/:id/access`: the scopes a sign-in can ask for, and those the connection holds now (null: not known). */
export const ServerAccess = Schema.Struct({
  offered: Schema.Array(Schema.String),
  held: Schema.NullOr(Schema.Array(Schema.String)),
})
export type ServerAccess = typeof ServerAccess.Type

/** `POST /api/mcp/:id/step-up`: sign a connection in again with this much more access, as scope tokens (ADR 0042). */
export const StepUp = Schema.Struct({ scope: Schema.String.check(Schema.isMaxLength(512)) })
export type StepUp = typeof StepUp.Type

/** `POST /api/mcp/:id/tools/call`: the owner (or an App they opened) calls one granted tool. */
export const ToolCall = Schema.Struct({
  name: NonEmptyString(256),
  arguments: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
})
export type ToolCall = typeof ToolCall.Type

/** `POST /api/mcp/:id/resources/read`: one granted resource by its URI. */
export const ResourceRead = Schema.Struct({ uri: NonEmptyString(2048) })
export type ResourceRead = typeof ResourceRead.Type

/** `POST /api/agent/resident`: revoke resident authority, or enable it again. */
export const ResidentChange = Schema.Struct({ enabled: Schema.Boolean })
export type ResidentChange = typeof ResidentChange.Type

/**
 * Remote data inside an MCP result: the server's own, untrusted. Only its shape as a JSON object is checked here; the
 * official SDK validated the result when it arrived.
 */
const RemoteObject = Schema.Record(Schema.String, Schema.Unknown)

/**
 * A remote MCP result is answered whole, as the SDK validated it, so the schemas below are typed passthroughs: they
 * name the fields owners and Apps read and keep every other field the server sent (`StructWithRest`). Stricter schemas
 * would drop or refuse the fields of MCP revisions this contract does not know yet.
 */
const passthrough = <Fields extends Schema.Struct.Fields>(fields: Fields) =>
  Schema.StructWithRest(Schema.Struct(fields), [RemoteObject])

/**
 * A `tools/call` result: content blocks, structured content (an object by the specification, which the SDK leaves
 * unchecked) and whether the tool reports an error.
 */
export const McpToolResult = passthrough({
  content: Schema.optional(Schema.Array(RemoteObject)),
  structuredContent: Schema.optional(Schema.Unknown),
  isError: Schema.optional(Schema.Boolean),
})
export type McpToolResult = typeof McpToolResult.Type

/** A `resources/read` result: the resource's contents (an App's HTML bundle among them). */
export const McpResourceResult = passthrough({ contents: Schema.Array(RemoteObject) })
export type McpResourceResult = typeof McpResourceResult.Type

export type McpServerConfig = {
  readonly connectionId: string
  readonly endpoint: string
  /** The configured connection's first label; the owner may rename it. */
  readonly label?: string
  readonly issuer?: string
  readonly resource?: string
}

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

/** A new label for a connection. */
export const RenameConnection = Schema.Struct({ label: ConnectionLabel })
export type RenameConnection = typeof RenameConnection.Type

/**
 * One stream of events a connection's server offers (`events/list`), as the owner sees it before subscribing: its name,
 * the server's own description (a claim, for the owner's eyes), the arguments it takes, and whether goblin can
 * subscribe to it (it delivers by poll and webhook).
 */
export const EventStream = Schema.Struct({
  name: Schema.String,
  description: Schema.optional(Schema.String),
  inputSchema: Schema.Record(Schema.String, Schema.Unknown),
  subscribable: Schema.Boolean,
})
export type EventStream = typeof EventStream.Type

/**
 * An outbound MCP server as the owner sees it. `live`: a connection is open right now. `source`: the deployment
 * configured it, or the owner added it. `title`, `description` and `icon` are the server's own claims.
 */
/**
 * goblin's own profile of a server it supports first-class (ADR 0043), matched by endpoint, never by what the server
 * says about itself: our title and words, the grants "Allow recommended" applies, a paid tool and the argument that
 * holds its amount (ADR 0044), the tool that opens the server's own App, whether it has a status line, and where its
 * wallet is topped up.
 */
export const ServerProfile = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  description: Schema.String,
  /** Why to connect it, as the end of a sentence ("so goblin can …"), for onboarding's offers. */
  offer: Schema.String,
  /** The tools that run when needed, and those that ask first, once the owner allows the recommended set. */
  recommended: Schema.Struct({ run: Schema.Array(Schema.String), ask: Schema.Array(Schema.String) }),
  spend: Schema.optional(
    Schema.Struct({ tool: Schema.String, argument: Schema.String, currency: Schema.Literal('USD') }),
  ),
  app: Schema.optional(Schema.Struct({ tool: Schema.String })),
  /** It has a status line (`GET /api/mcp/:id/status`). */
  status: Schema.Boolean,
  /** Where the owner adds funds when its status says the wallet needs them: goblin's own https link. */
  topUp: Schema.optional(Schema.Struct({ url: Schema.String })),
  /**
   * It keeps its own prepaid balance, which goblin tops up from the Goblin Wallet (ADR 0049): the chain and token the
   * balance is in (its status reports it, and where to send it), and the default rule, in dollars: up to `perTopUp` a
   * top-up and `daily` a day without asking.
   */
  prepaid: Schema.optional(
    Schema.Struct({ chain: Schema.String, token: Schema.String, perTopUp: Schema.String, daily: Schema.String }),
  ),
})
export type ServerProfile = typeof ServerProfile.Type

const Readiness = Schema.Literals(['ready', 'blocked', 'not_verified'])
const Short = Schema.String.check(Schema.isMaxLength(64))

/**
 * A first-class server's wallet as goblin reads it from the server's status tool (ADR 0043): whether paid work can run
 * now and whether it is funded, each token's balance, what its signed limit has left and can spend now, when the
 * limit's period ends, when the wallet's key expires and, where the server sums them, its stablecoin dollars. All of it is the server's claim, decoded by goblin and bounded.
 */
export const WalletStatus = Schema.Struct({
  kind: Schema.Literal('wallet'),
  paid: Readiness,
  funding: Readiness,
  tokens: Schema.Array(
    Schema.Struct({
      symbol: Short,
      balance: Schema.optional(Short),
      remaining: Schema.optional(Short),
      spendable: Schema.optional(Short),
    }),
  ).check(Schema.isMaxLength(8)),
  periodEndsAt: Schema.optional(Short),
  expiresAt: Schema.optional(Short),
  /** The dollar stablecoins held on every chain the server read, a decimal string, when it adds them up itself. */
  stablecoinUsd: Schema.optional(Short),
  /** Set when a chain could not be read, so `stablecoinUsd` may be short of what is held. */
  stablecoinUsdPartial: Schema.optional(Schema.Literal(true)),
  /**
   * Where the server's own payments come from, when it says so: the address to fund, its chain and token, and what it
   * holds there (a decimal string; absent when that chain could not be read).
   */
  payFrom: Schema.optional(Schema.Struct({ address: Short, chain: Short, token: Short, held: Schema.optional(Short) })),
  /**
   * Where the server's own prepaid balance is funded (ADR 0049), when its status says so: the address, and the chain
   * and token it takes. The balance itself is the token's in `tokens`.
   */
  depositTo: Schema.optional(Schema.Struct({ address: Short, chain: Short, token: Short })),
})
export type WalletStatus = typeof WalletStatus.Type

export const ServerView = Schema.Struct({
  connectionId: Schema.String,
  /** The owner's name for this connection (ADR 0041). */
  label: Schema.String,
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
  /**
   * The live connection sends events (ADR 0041), and what the owner did with the offer: `open` until they set up a
   * routine on it (`done`) or dismiss it (`dismissed`). None when it sends no events.
   */
  events: Schema.optional(Schema.Literals(['open', 'dismissed', 'done'])),
  eventHealth: Schema.optional(Schema.Array(EventHealth)),
  /** The owner uses this server's skills (procedures the agent follows). */
  skillsEnabled: Schema.optional(Schema.Boolean),
  /** goblin's own profile, for a server it supports first-class (ADR 0043). */
  profile: Schema.optional(ServerProfile),
  /**
   * The tool that opens this connection's global entrypoint (its App, from any chat): the one a profile names, or the one
   * the server declares in `_meta["openai/ui"].entrypoints`. Absent when it has none.
   */
  entrypoint: Schema.optional(Schema.String),
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

/** A catalog search: the entries that match, and `partial` when a registry could not be searched (some may be missing). */
export const CatalogResults = Schema.Struct({ entries: Schema.Array(CatalogEntry), partial: Schema.Boolean })
export type CatalogResults = typeof CatalogResults.Type

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
  askFirst: Schema.optional(Schema.Boolean),
})
export type ToolView = typeof ToolView.Type

/** An exact held call, shown only to its signed-in owner. */
export const ApprovalView = Schema.Struct({
  id: Schema.String,
  connectionId: Schema.String,
  name: Schema.String,
  arguments: Schema.Record(Schema.String, Schema.Json),
  conversation: Schema.optional(Schema.String),
  state: Schema.Literals([
    'pending',
    'approved',
    'dispatching',
    'completed',
    'refused',
    'failed',
    'uncertain',
    'expired',
  ]),
  expiresAt: Schema.Number,
  /**
   * The URL request its approved dispatch met (ADR 0042): the server asked the owner to finish a step on its site
   * first, so the call goes on as that request.
   */
  urlRequest: Schema.optional(Schema.String),
})
export type ApprovalView = typeof ApprovalView.Type

/**
 * A URL request (ADR 0042), shown only to its signed-in owner: the server's message and the link it asks them to open,
 * with the link's host and whether that host is the connection's own server (or a subdomain of it, or it of the
 * link's), so a link elsewhere can be flagged.
 */
export const UrlRequestView = Schema.Struct({
  id: Schema.String,
  connectionId: Schema.String,
  name: Schema.String,
  message: Schema.String,
  url: Schema.String,
  host: Schema.String,
  ownHost: Schema.Boolean,
  conversation: Schema.String,
  state: Schema.Literals(['pending', 'retrying', 'completed', 'declined', 'expired', 'failed', 'uncertain']),
  expiresAt: Schema.Number,
})
export type UrlRequestView = typeof UrlRequestView.Type

/**
 * How a call held for the owner ended, as goblin sends it back to the conversation that held it (ADR 0028, ADR 0042):
 * an ask-first approval or a URL request, the call and its state, and the server's result as untrusted data. The web
 * shows it as one quiet row, never as the owner's message.
 */
export const McpOutcome = Schema.Struct({
  continuation: Schema.Struct({
    kind: Schema.Literals(['approval', 'url']),
    connectionId: Schema.String,
    name: Schema.String,
    state: Schema.Literals(['completed', 'declined', 'refused', 'expired', 'failed', 'uncertain']),
  }),
  origin: Schema.Struct({ connectionId: Schema.String, trust: Schema.Literal('untrusted') }),
  result: Schema.optional(Schema.Unknown),
})
export type McpOutcome = typeof McpOutcome.Type

/** The owner's answer to a URL request: Done (`accept`, the server's step is finished) or Cancel (`decline`). */
export const UrlRequestAnswer = Schema.Struct({ action: Schema.Literals(['accept', 'decline']) })
export type UrlRequestAnswer = typeof UrlRequestAnswer.Type
