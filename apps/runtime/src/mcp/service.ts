import type { CallToolResult, ReadResourceResult, Tool } from '@modelcontextprotocol/client'
import type {
  ApprovalView,
  CatalogEntry,
  ConnectStart,
  EventHealth,
  Grant,
  JsonObject,
  RegistryView,
  ResidentStatus,
  ServerSource,
  ServerSuggestion,
  ServerView,
  ToolView,
} from '@goblin/contracts'
import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import type * as Option from 'effect/Option'
import type * as Schema from 'effect/Schema'
import type { AppError } from '../http/errors.ts'
import type { ApprovalRow, HeldCall } from './approvals.ts'
import type { CredentialCipher } from './cipher.ts'
import type { ConnectionStatus } from './credentials.ts'
import type { EventWebhook, EventWebhookResult, SubscribeConsumer } from './events.ts'
import type { EventContext } from './events/dispatcher.ts'
import type { SettledOffer } from './events/offers.ts'
import type { EventDescriptor } from './events/protocol.ts'
import type { Consumer, Receipt, Subscription } from './events/store.ts'
import type { Stage } from './suggested.ts'
import type { HeldUrlRequest, UrlRequestRow } from './url-requests.ts'

declare module '../runtime/changes.ts' {
  interface ChangeTopics {
    /** A connection's tools changed (ADR 0042): `digest` names the new list, so a reader can tell it from the last. */
    'mcp.tools': { readonly connectionId: string; readonly digest: string }
  }
}
import type {
  McpCallOptions,
  McpConnectionSnapshot,
  McpModelCallOptions,
  McpModelCallResult,
  McpRequestOptions,
  McpServerConfig,
  McpToolResult,
  SkillRequestOptions,
  UrlPrompt,
} from './types.ts'
import type { SkillEntry } from '../skills/protocol.ts'

// The MCP area's services (ADRs 0003, 0006, 0011, 0028). Each method is one Effect with the area's typed failures;
// the clocks (seconds for authority and grants, milliseconds for approvals and Events) are read inside, so no caller
// passes a time.

/**
 * Resident authority (ADR 0003): what lets tools run without a live browser session. Every owner request renews it; a
 * revocation is sticky until the owner enables it again.
 */
export class Resident extends Context.Service<
  Resident,
  {
    readonly status: () => Effect.Effect<ResidentStatus>
    /** Owner activity: extends the window, unless the owner revoked authority. */
    readonly renew: () => Effect.Effect<void>
    /** Revokes it (renewing the row first, so the times are current) and answers the status after. */
    readonly revoke: () => Effect.Effect<ResidentStatus>
    /** Clears a revocation and renews; answers the status after. */
    readonly enable: () => Effect.Effect<ResidentStatus>
    /** Fails with `ResidentInactive` unless authority is current. */
    readonly require: () => Effect.Effect<void, AppError>
  }
>()('goblin/mcp/Resident') {}

/** Fails with `ResidentInactive` unless the owner's resident authority is current: the gate before any agent action. */
export const requireResident: Effect.Effect<void, AppError, Resident> = Resident.use((resident) => resident.require())

/**
 * The owner's servers (ADR 0006): the ones offered, adding and removing them, signing in, their tools, and the
 * registries searched for more.
 */
export class McpServers extends Context.Service<
  McpServers,
  {
    /** Every server offered, configured first, with its connection status. */
    readonly list: () => Effect.Effect<readonly ServerView[]>
    /** The owner's label for every connection, by connection id. */
    readonly labels: () => Effect.Effect<ReadonlyMap<string, string>>
    /** One server's connection status: signed in, needing sign-in, or never connected. */
    readonly status: (connectionId: string) => Effect.Effect<ConnectionStatus>
    /** goblin's suggested servers for `stage`, each marked added when the owner already has its endpoint. */
    readonly suggested: (stage: Stage | undefined) => Effect.Effect<readonly ServerSuggestion[]>
    /**
     * Adds a connection to a public https endpoint (one the owner may already have a connection to), named `label`
     * or the first free name from its server card; it starts disconnected.
     */
    readonly add: (endpoint: string, label?: string, source?: ServerSource) => Effect.Effect<ServerView, AppError>
    /** Names a connection `label`; refused (409) when another connection holds it. */
    readonly rename: (connectionId: string, label: string) => Effect.Effect<ServerView, AppError>
    /** Removes an added server with its credentials, grants and pending sign-ins. Configured ones stay. */
    readonly remove: (connectionId: string) => Effect.Effect<void, AppError>
    /** Starts (or silently renews) sign-in: the URL to send the owner's browser to, when one is needed. */
    readonly beginConnect: (connectionId: string) => Effect.Effect<ConnectStart, AppError>
    /**
     * Starts signing in again with more access (ADR 0042): a fresh authorization for `scope` and what the connection
     * already holds; its tokens stay until the new ones arrive.
     */
    readonly beginStepUp: (connectionId: string, scope: string) => Effect.Effect<ConnectStart, AppError>
    /** Completes the sign-in the browser came back from; answers the server's id. The `state` is single-use. */
    readonly finishConnect: (state: string, code: string, issuer?: string) => Effect.Effect<string, AppError>
    /** Forgets the server's credentials and closes its connection; grants stay. */
    readonly disconnect: (connectionId: string) => Effect.Effect<void, AppError>
    /** Records what the owner did with a connection's offer of events (ADR 0041): dismissed, or a routine set up. */
    readonly settleEvents: (connectionId: string, state: SettledOffer) => Effect.Effect<void, AppError>
    /** The server's tools as the owner sees them, from the live connection or a fresh one. */
    readonly tools: (connectionId: string, refresh: boolean) => Effect.Effect<readonly ToolView[], AppError>
    /**
     * Registry entries matching `query`, marking the ones already offered; `partial` when a registry could not be
     * searched (it is logged, and the answer is not cached).
     */
    readonly catalog: (
      query: string,
    ) => Effect.Effect<{ readonly entries: readonly CatalogEntry[]; readonly partial: boolean }, AppError>
    /** The registries searched: the built-in ones first, then the owner's. */
    readonly registries: () => Effect.Effect<readonly RegistryView[]>
    readonly addRegistry: (url: string) => Effect.Effect<readonly RegistryView[], AppError>
    readonly removeRegistry: (url: string) => Effect.Effect<readonly RegistryView[], AppError>
  }
>()('goblin/mcp/McpServers') {}

/** The owner's exact grants: absence is denial, there are no wildcards, and remote metadata never grants anything. */
export class McpGrants extends Context.Service<
  McpGrants,
  {
    readonly list: () => Effect.Effect<readonly Grant[]>
    /** A granted tool's ask-first switch and version, which a held call is checked against. */
    readonly policy: (
      connectionId: string,
      name: string,
    ) => Effect.Effect<Option.Option<{ readonly askFirst: boolean; readonly version: string }>>
    /** Grants or revokes one discovered tool; its App resource follows the tools that use it. */
    readonly setTool: (
      connectionId: string,
      name: string,
      allowed: boolean,
    ) => Effect.Effect<readonly Grant[], AppError>
    /** A granted tool's calls wait for the owner's decision, or no longer do. */
    readonly setAskFirst: (
      connectionId: string,
      name: string,
      enabled: boolean,
    ) => Effect.Effect<readonly Grant[], AppError>
    /** Grants or revokes an App as a whole: exactly the tools declaring `uri` and the resource itself. */
    readonly setApp: (connectionId: string, uri: string, allowed: boolean) => Effect.Effect<readonly Grant[], AppError>
  }
>()('goblin/mcp/McpGrants') {}

/**
 * The connections to remote servers: one cached client per server, every call behind the owner's exact grant, every
 * result size-bounded. Remote data is untrusted; it never grants anything.
 */
export class McpConnections extends Context.Service<
  McpConnections,
  {
    /** Every server the manager offers (configured and added), by id and endpoint. */
    readonly servers: () => Effect.Effect<readonly McpServerConfig[]>
    /** One offered server, or `NotFound`. */
    readonly server: (connectionId: string) => Effect.Effect<McpServerConfig, AppError>
    /** The live connection's discovered snapshot; none without a connection. */
    readonly snapshot: (connectionId: string) => Effect.Effect<Option.Option<McpConnectionSnapshot>>
    /** Connects (or reuses the live connection) and answers what it discovered. */
    readonly connect: (
      connectionId: string,
      options?: McpRequestOptions,
    ) => Effect.Effect<McpConnectionSnapshot, AppError>
    /**
     * Connects (or reuses the live connection) and lists its tools again, keeping them (ADR 0042): a tool the server
     * added since it was discovered is then known.
     */
    readonly refreshTools: (
      connectionId: string,
      options?: McpRequestOptions,
    ) => Effect.Effect<McpConnectionSnapshot, AppError>
    /** Drops the live connection and discovers again over a fresh handshake. */
    readonly reconnect: (connectionId: string) => Effect.Effect<McpConnectionSnapshot, AppError>
    /** Closes the server's connection, if it has one. */
    readonly close: (connectionId: string) => Effect.Effect<void>
    readonly callTool: (
      connectionId: string,
      name: string,
      args: Record<string, unknown>,
      options?: McpCallOptions,
    ) => Effect.Effect<McpToolResult, AppError>
    /**
     * A model's own call of a granted tool (ADR 0042): on a 2026 connection it declares URL elicitation for this
     * request, so the server may answer with a URL request instead of a result; `answer` retries it with the owner's.
     */
    readonly callModelTool: (
      connectionId: string,
      name: string,
      args: Record<string, unknown>,
      options?: McpModelCallOptions,
    ) => Effect.Effect<McpModelCallResult, AppError>
    /** A granted resource; `app` reads an App's `ui://` HTML bundle, under its larger bound. */
    readonly readResource: (
      connectionId: string,
      uri: string,
      caller: 'human' | 'app',
    ) => Effect.Effect<ReadResourceResult, AppError>
    /**
     * One draft Events request over the server's connection, `authorize` (the Events authority for its selector)
     * checked before it connects and again before it is sent; the result decoded with `schema`.
     */
    readonly events: <S extends Schema.ConstraintDecoder<unknown>>(
      connectionId: string,
      method: EventMethod,
      params: Record<string, unknown>,
      schema: S,
      authorize: Effect.Effect<void, AppError>,
    ) => Effect.Effect<S['Type'], AppError>
    /**
     * Every skill a server lists, when the owner uses skills from it and it declares the Skills extension, with the
     * shortest `ttlMs` seen for the caller's cache.
     */
    readonly skills: (
      connectionId: string,
      options?: SkillRequestOptions,
    ) => Effect.Effect<{ readonly skills: readonly SkillEntry[]; readonly ttlMs: number | undefined }, AppError>
    /** One skill file through `resources/read`, bounded; the caller verifies its bytes against the manifest. */
    readonly skillFile: (
      connectionId: string,
      uri: string,
      options?: SkillRequestOptions,
    ) => Effect.Effect<ReadResourceResult, AppError>
  }
>()('goblin/mcp/McpConnections') {}

/** The draft Events methods a server may answer (ADR 0011). */
export type EventMethod = 'events/list' | 'events/poll' | 'events/subscribe' | 'events/unsubscribe'

/**
 * Held calls (ADR 0028): the exact arguments of an ask-first call, frozen and encrypted until the owner decides, and
 * dispatched at most once.
 */
export class Approvals extends Context.Service<
  Approvals,
  {
    /** The cipher held calls are sealed with; a routine run's question about a held call is sealed with it too. */
    readonly cipher: CredentialCipher
    /** Holds `call` (or finds the same call held before); a different call under the same id is a conflict. */
    readonly hold: (call: HeldCall) => Effect.Effect<ApprovalRow, AppError>
    readonly find: (id: string) => Effect.Effect<Option.Option<ApprovalRow>>
    /** The held call, or `NotFound`. */
    readonly get: (id: string) => Effect.Effect<ApprovalRow, AppError>
    /** Claims the owner's decision once, before any I/O; `changed` is false when it was already decided. */
    readonly decide: (
      id: string,
      allowed: boolean,
    ) => Effect.Effect<{ readonly row: ApprovalRow; readonly changed: boolean }, AppError>
    /** The frozen arguments, decrypted. */
    readonly arguments: (id: string) => Effect.Effect<JsonObject, AppError>
    /** Records a dispatched call's result. */
    readonly finish: (id: string, result: CallToolResult) => Effect.Effect<void, AppError>
    /** An approved or dispatching call that did not complete: `uncertain` once it may have taken effect. */
    readonly fail: (id: string, state: 'failed' | 'uncertain') => Effect.Effect<void>
    /** A completed call's result, decrypted. */
    readonly result: (id: string) => Effect.Effect<Option.Option<CallToolResult>, AppError>
    /** The owner's view of the held call, its secret-looking fields redacted. */
    readonly view: (id: string) => Effect.Effect<ApprovalView, AppError>
  }
>()('goblin/mcp/Approvals') {}

/**
 * URL requests (ADR 0042): a model's call the server answered "input required: open this URL", kept sealed until the
 * owner finishes or cancels it.
 */
export class UrlRequests extends Context.Service<
  UrlRequests,
  {
    /** Keeps the call as a URL request (or finds it kept, a pending one taking the newer prompt). */
    readonly hold: (request: HeldUrlRequest) => Effect.Effect<UrlRequestRow, AppError>
    /** The request, or `NotFound`. */
    readonly get: (id: string) => Effect.Effect<UrlRequestRow, AppError>
    /** Claims the one retry of a pending request, before any I/O; `changed` is false otherwise. */
    readonly claim: (id: string) => Effect.Effect<{ readonly row: UrlRequestRow; readonly changed: boolean }, AppError>
    /** The server is still waiting: pending again, with its newer prompt. */
    readonly again: (id: string, prompt: UrlPrompt) => Effect.Effect<void, AppError>
    /** The server's answer to the retry. */
    readonly finish: (
      id: string,
      state: 'completed' | 'declined',
      result: McpToolResult,
    ) => Effect.Effect<void, AppError>
    /** A retry that did not complete: `uncertain` once it may have reached the server. */
    readonly fail: (id: string, state: 'failed' | 'uncertain') => Effect.Effect<void>
    /** The owner cancelled it. */
    readonly decline: (id: string) => Effect.Effect<void>
    /** The call's frozen arguments. */
    readonly arguments: (id: string) => Effect.Effect<JsonObject, AppError>
    /** The tool the answer goes to when the server no longer lists it, as it was listed when the server asked. */
    readonly tool: (id: string) => Effect.Effect<Tool, AppError>
    /** What the server asked, unsealed. */
    readonly prompt: (id: string) => Effect.Effect<UrlPrompt, AppError>
    /** The retry's result, once the server answered it. */
    readonly result: (id: string) => Effect.Effect<Option.Option<McpToolResult>, AppError>
  }
>()('goblin/mcp/UrlRequests') {}

/**
 * MCP Events (ADR 0011): exact owner grants per event selector, durable subscriptions shared by their consumers, the
 * signed webhook ingress and the alarm-driven sweep that polls and dispatches.
 */
export class Events extends Context.Service<
  Events,
  {
    /** The server's subscriptions as the owner sees them; no callback URL, secret or event body. */
    readonly health: (connectionId: string) => Effect.Effect<readonly EventHealth[]>
    /** The event streams a connection's server offers, read for the owner with no grant (none is made). */
    readonly catalog: (connectionId: string) => Effect.Effect<readonly EventDescriptor[], AppError>
    /** Grants or revokes one exact selector (server, event name and canonical arguments). */
    readonly grant: (
      connectionId: string,
      name: string,
      args: Record<string, unknown>,
      allowed: boolean,
    ) => Effect.Effect<void>
    /** Binds a consumer revision to a (shared) subscription, subscribing remotely when none is active. */
    readonly subscribe: (
      input: SubscribeConsumer,
    ) => Effect.Effect<{ readonly subscriptionId: string; readonly status: string }, AppError>
    /** Retires a consumer revision; the last one tombstones the subscription and cleans up remotely when it can. */
    readonly unsubscribe: (input: {
      readonly consumerId: string
      readonly revision: number
    }) => Effect.Effect<{ readonly retired: boolean; readonly remoteCleanup: boolean }, AppError>
    /** The consumer's active binding, if any. */
    readonly activeConsumer: (consumerId: string) => Effect.Effect<Option.Option<Consumer>>
    readonly subscription: (id: string) => Effect.Effect<Option.Option<Subscription>>
    /** A consumer's durable acknowledgement of one delivery. */
    readonly ack: (
      input: Pick<Receipt, 'subscriptionId' | 'webhookId' | 'consumerId' | 'revision' | 'operationId'>,
    ) => Effect.Effect<void, AppError>
    /**
     * The acknowledgement and `write`, a synchronous write to the agent's database (a routine's pending handoff), in
     * one transaction: a crash keeps both or neither.
     */
    readonly ackWith: (
      input: Pick<Receipt, 'subscriptionId' | 'webhookId' | 'consumerId' | 'revision' | 'operationId'>,
      write: () => void,
    ) => Effect.Effect<void, AppError>
    /** Unsubscribes every consumer of one server (or of all), while the authorization that made them still holds. */
    readonly disableServer: (connectionId?: string) => Effect.Effect<void, AppError>
    /** One signed webhook delivery, verified and stored before it is answered. */
    readonly receive: (input: EventWebhook) => Effect.Effect<EventWebhookResult, AppError>
    /**
     * Handles deliveries to consumers registered under `key` with `handler`, an Effect bound to its services; a
     * completed handler has durably taken the delivery before its own ack.
     */
    readonly register: (
      key: string,
      handler: (context: EventContext) => Effect.Effect<void, AppError>,
    ) => Effect.Effect<void>
    /** One maintenance sweep: dispatch, refresh or poll each subscription, prune, dispatch again. */
    readonly maintain: () => Effect.Effect<void, AppError>
    /** When a sweep next has work, in Clock milliseconds; none when nothing waits. */
    readonly nextDue: () => Effect.Effect<number | undefined>
  }
>()('goblin/mcp/Events') {}
