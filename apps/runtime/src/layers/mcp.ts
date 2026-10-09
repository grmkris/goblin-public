import type { CallToolResult } from '@modelcontextprotocol/client'
import type { CapabilityTarget, HelperExclusion, ServerSource } from '@goblin/contracts'
import * as Clock from 'effect/Clock'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Option from 'effect/Option'
import { Capabilities } from '../capabilities/service.ts'
import { ResidentInactive, toAppError } from '../http/errors.ts'
import { type HeldCall, McpApprovalStore } from '../mcp/approvals.ts'
import { CredentialCipher } from '../mcp/cipher.ts'
import { Events as EventsInstance, type EventWebhook, type SubscribeConsumer } from '../mcp/events.ts'
import type { Receipt } from '../mcp/events/store.ts'
import { RegistryStore } from '../mcp/registries.ts'
import { makeCatalog } from '../mcp/registry.ts'
import { Approvals, Events, McpConnections, McpGrants, McpServers, Resident } from '../mcp/service.ts'
import { type Stage, suggestions } from '../mcp/suggested.ts'
import type { McpCallOptions, McpRequestOptions } from '../mcp/types.ts'
import { enableResident, renewResident, residentStatus, revokeResident } from '../resident.ts'
import { Db } from '../runtime/db.ts'
import { AgentInput } from '../runtime/input.ts'
import { Capabilities as CapabilitiesInstance, Mcp as McpInstance } from '../services.ts'
import type { FoundationServices } from './core.ts'

// Lane M's native layers (wave 3). Resident authority, held calls and the registry catalog are built here over the
// agent's database. The MCP host (its connections, refreshes and credentials), the Events engine and the capability
// switches are stateful objects the legacy start still makes and shares with services outside lane M (skills, the
// channel, agent apps, conversations): until the conductor moves that start into this layer at integration, these
// layers read that one instance by its tag and never make a second one.

/** Wall-clock seconds, the unit resident authority and grants are kept in. */
const nowSeconds = Effect.map(Clock.currentTimeMillis, (millis) => Math.floor(millis / 1000))

/** A call into a stateful instance's async code: a failure is the `AppError` it threw, anything else `Internal`. */
const fromPromise = <A>(run: () => Promise<A>) => Effect.tryPromise({ try: run, catch: toAppError })
/** The same for its synchronous code. */
const fromSync = <A>(run: () => A) => Effect.try({ try: run, catch: toAppError })

/** Resident authority over its row in the agent's database: no state of its own. */
export const ResidentLive = Layer.effect(
  Resident,
  Effect.gen(function* () {
    const db = yield* Db
    const status = Effect.fn('Resident.status')(function* () {
      const now = yield* nowSeconds
      return yield* Effect.sync(() => residentStatus(db, now))
    })
    return Resident.of({
      status,
      renew: Effect.fn('Resident.renew')(function* () {
        const now = yield* nowSeconds
        yield* Effect.sync(() => renewResident(db, now))
      }),
      revoke: Effect.fn('Resident.revoke')(function* () {
        const now = yield* nowSeconds
        return yield* Effect.sync(() => {
          revokeResident(db, now)
          return residentStatus(db, now)
        })
      }),
      enable: Effect.fn('Resident.enable')(function* () {
        const now = yield* nowSeconds
        return yield* Effect.sync(() => {
          enableResident(db, now)
          return residentStatus(db, now)
        })
      }),
      require: Effect.fn('Resident.require')(function* () {
        const { state } = yield* status()
        if (state !== 'active') return yield* new ResidentInactive({ state })
      }),
    })
  }),
)

/**
 * The owner's servers. The registry catalog (its search cache is the catalog's one piece of state) is built here over
 * the owner's registries in the database; the servers themselves are the host's.
 */
export const McpServersLive = Layer.effect(
  McpServers,
  Effect.gen(function* () {
    const host = yield* McpInstance
    const { mcpFetch } = yield* AgentInput
    const catalog = makeCatalog({ added: new RegistryStore(yield* Db), fetch: mcpFetch })
    const offered = () => new Set(host.manager.servers.map((server) => server.endpoint))
    return McpServers.of({
      list: Effect.fn('McpServers.list')(function* () {
        return yield* Effect.sync(() => host.servers())
      }),
      suggested: Effect.fn('McpServers.suggested')(function* (stage: Stage | undefined) {
        return yield* Effect.sync(() => suggestions(stage, offered()))
      }),
      add: Effect.fn('McpServers.add')(function* (endpoint: string, source?: ServerSource) {
        return yield* fromPromise(() => host.addServer(endpoint, source))
      }),
      remove: Effect.fn('McpServers.remove')(function* (serverId: string) {
        yield* fromPromise(() => host.removeServer(serverId))
      }),
      beginConnect: Effect.fn('McpServers.beginConnect')(function* (serverId: string) {
        return yield* fromPromise(() => host.beginConnect(serverId))
      }),
      finishConnect: Effect.fn('McpServers.finishConnect')(function* (state: string, code: string, issuer?: string) {
        return yield* fromPromise(() => host.finishConnect(state, code, issuer))
      }),
      disconnect: Effect.fn('McpServers.disconnect')(function* (serverId: string) {
        yield* fromPromise(() => host.disconnect(serverId))
      }),
      tools: Effect.fn('McpServers.tools')(function* (serverId: string, refresh: boolean) {
        return yield* fromPromise(() => host.tools(serverId, refresh))
      }),
      catalog: Effect.fn('McpServers.catalog')(function* (query: string) {
        const { entries, partial } = yield* catalog.search(query.trim())
        const endpoints = offered()
        return { entries: entries.map((entry) => ({ ...entry, added: endpoints.has(entry.endpoint) })), partial }
      }),
      registries: Effect.fn('McpServers.registries')(function* () {
        return yield* catalog.registries
      }),
      addRegistry: Effect.fn('McpServers.addRegistry')(function* (url: string) {
        return yield* catalog.add(url)
      }),
      removeRegistry: Effect.fn('McpServers.removeRegistry')(function* (url: string) {
        return yield* catalog.remove(url)
      }),
    })
  }),
)

/** The owner's grants, kept by the host. */
export const McpGrantsLive = Layer.effect(
  McpGrants,
  Effect.gen(function* () {
    const host = yield* McpInstance
    return McpGrants.of({
      list: Effect.fn('McpGrants.list')(function* () {
        return yield* Effect.sync(() => host.grants())
      }),
      policy: Effect.fn('McpGrants.policy')(function* (serverId: string, name: string) {
        return yield* Effect.sync(() => Option.fromNullishOr(host.grantPolicy(serverId, name)))
      }),
      setTool: Effect.fn('McpGrants.setTool')(function* (serverId: string, name: string, allowed: boolean) {
        return yield* fromPromise(() => host.setToolGrant(serverId, name, allowed))
      }),
      setAskFirst: Effect.fn('McpGrants.setAskFirst')(function* (serverId: string, name: string, enabled: boolean) {
        return yield* fromSync(() => {
          host.setAskFirst(serverId, name, enabled)
          return host.grants()
        })
      }),
      setApp: Effect.fn('McpGrants.setApp')(function* (serverId: string, uri: string, allowed: boolean) {
        return yield* fromPromise(() => host.setAppGrant(serverId, uri, allowed))
      }),
    })
  }),
)

/** The connections, the host's manager: one cached client per server. */
export const McpConnectionsLive = Layer.effect(
  McpConnections,
  Effect.gen(function* () {
    const { manager } = yield* McpInstance
    return McpConnections.of({
      servers: Effect.fn('McpConnections.servers')(function* () {
        return yield* Effect.sync(() => manager.servers)
      }),
      server: Effect.fn('McpConnections.server')(function* (serverId: string) {
        return yield* fromSync(() => manager.server(serverId))
      }),
      snapshot: Effect.fn('McpConnections.snapshot')(function* (serverId: string) {
        return yield* Effect.sync(() => Option.fromNullishOr(manager.snapshot(serverId)))
      }),
      connect: Effect.fn('McpConnections.connect')(function* (serverId: string, options?: McpRequestOptions) {
        return yield* fromPromise(() => manager.connect(serverId, options))
      }),
      callTool: Effect.fn('McpConnections.callTool')(function* (
        serverId: string,
        name: string,
        args: Record<string, unknown>,
        options?: McpCallOptions,
      ) {
        return yield* fromPromise(() => manager.callTool(serverId, name, args, options))
      }),
      readResource: Effect.fn('McpConnections.readResource')(function* (
        serverId: string,
        uri: string,
        caller: 'human' | 'app',
      ) {
        return yield* fromPromise(() =>
          caller === 'app' ? manager.readAppResource(serverId, uri) : manager.readResource(serverId, uri),
        )
      }),
      getPrompt: Effect.fn('McpConnections.getPrompt')(function* (
        serverId: string,
        name: string,
        args: Record<string, string>,
      ) {
        return yield* fromPromise(() => manager.getPrompt(serverId, name, args))
      }),
      closeAll: Effect.fn('McpConnections.closeAll')(function* () {
        yield* fromPromise(() => manager.closeAll())
      }),
    })
  }),
)

/** Held calls over their table in the agent's database, sealed with the credential key: no state of their own. */
export const ApprovalsLive = Layer.effect(
  Approvals,
  Effect.gen(function* () {
    const { env } = yield* AgentInput
    const cipher = yield* fromPromise(() => CredentialCipher.fromBase64(env.CREDENTIAL_KEY)).pipe(Effect.orDie)
    const store = new McpApprovalStore(yield* Db, cipher)
    return Approvals.of({
      cipher,
      hold: Effect.fn('Approvals.hold')(function* (call: HeldCall) {
        const now = yield* Clock.currentTimeMillis
        return yield* fromPromise(() => store.hold(call, now))
      }),
      find: Effect.fn('Approvals.find')(function* (id: string) {
        return yield* Effect.sync(() => Option.fromNullishOr(store.find(id)))
      }),
      get: Effect.fn('Approvals.get')(function* (id: string) {
        return yield* fromSync(() => store.get(id))
      }),
      decide: Effect.fn('Approvals.decide')(function* (id: string, allowed: boolean) {
        const now = yield* Clock.currentTimeMillis
        return yield* fromSync(() => store.decide(id, allowed, now))
      }),
      arguments: Effect.fn('Approvals.arguments')(function* (id: string) {
        return yield* fromPromise(() => store.arguments(id))
      }),
      finish: Effect.fn('Approvals.finish')(function* (id: string, result: CallToolResult) {
        const now = yield* Clock.currentTimeMillis
        yield* fromPromise(() => store.finish(id, result, now))
      }),
      fail: Effect.fn('Approvals.fail')(function* (id: string, state: 'failed' | 'uncertain') {
        const now = yield* Clock.currentTimeMillis
        yield* Effect.sync(() => store.fail(id, state, now))
      }),
      result: Effect.fn('Approvals.result')(function* (id: string) {
        return Option.fromNullishOr(yield* fromPromise(() => store.result(id)))
      }),
      view: Effect.fn('Approvals.view')(function* (id: string) {
        const now = yield* Clock.currentTimeMillis
        return yield* fromPromise(() => store.view(id, now))
      }),
    })
  }),
)

/** Events, the one engine the legacy start made: its methods are Effects already. */
export const EventsLive = Layer.effect(
  Events,
  Effect.gen(function* () {
    const legacy = yield* EventsInstance
    return Events.of({
      health: Effect.fn('Events.health')(function* (serverId: string) {
        return yield* Effect.sync(() => legacy.health(serverId))
      }),
      grant: Effect.fn('Events.grant')(function* (
        serverId: string,
        name: string,
        args: Record<string, unknown>,
        allowed: boolean,
      ) {
        yield* Effect.sync(() => legacy.grant(serverId, name, args, allowed))
      }),
      subscribe: Effect.fn('Events.subscribe')(function* (input: SubscribeConsumer) {
        return yield* legacy.subscribe(input)
      }),
      unsubscribe: Effect.fn('Events.unsubscribe')(function* (input: {
        readonly consumerId: string
        readonly revision: number
      }) {
        return yield* legacy.unsubscribe(input)
      }),
      activeConsumer: Effect.fn('Events.activeConsumer')(function* (consumerId: string) {
        return yield* Effect.sync(() => Option.fromNullishOr(legacy.store.activeConsumer(consumerId)))
      }),
      subscription: Effect.fn('Events.subscription')(function* (id: string) {
        return yield* Effect.sync(() => Option.fromNullishOr(legacy.store.get(id)))
      }),
      ack: Effect.fn('Events.ack')(function* (
        input: Pick<Receipt, 'subscriptionId' | 'webhookId' | 'consumerId' | 'revision' | 'operationId'>,
      ) {
        yield* legacy.ack(input)
      }),
      disableServer: Effect.fn('Events.disableServer')(function* (serverId?: string) {
        yield* legacy.disableServer(serverId)
      }),
      receive: Effect.fn('Events.receive')(function* (input: EventWebhook) {
        return yield* legacy.receive(input)
      }),
      maintain: Effect.fn('Events.maintain')(function* () {
        yield* legacy.maintain()
      }),
    })
  }),
)

/** Each conversation's switches, the one profile store the legacy start made and the conversations share. */
export const CapabilitiesLive = Layer.effect(
  Capabilities,
  Effect.gen(function* () {
    const legacy = yield* CapabilitiesInstance
    return Capabilities.of({
      scope: Effect.fn('Capabilities.scope')(function* (session: string) {
        return yield* Effect.sync(() => legacy.scope(session))
      }),
      app: Effect.fn('Capabilities.app')(function* (session: string, app: string) {
        return yield* Effect.sync(() => legacy.app(session, app))
      }),
      own: Effect.fn('Capabilities.own')(function* (session: string) {
        return yield* Effect.sync(() => legacy.own(session))
      }),
      inherited: Effect.fn('Capabilities.inherited')(function* (thread: string) {
        return yield* Effect.sync(() => legacy.inherited(thread))
      }),
      set: Effect.fn('Capabilities.set')(function* (session: string, target: CapabilityTarget, on: boolean) {
        const now = yield* nowSeconds
        yield* Effect.sync(() => legacy.set(session, target, on, now))
      }),
      narrow: Effect.fn('Capabilities.narrow')(function* (session: string, exclusions: readonly HelperExclusion[]) {
        const now = yield* nowSeconds
        yield* Effect.sync(() => legacy.narrow(session, exclusions, now))
      }),
      copy: Effect.fn('Capabilities.copy')(function* (from: string, to: string) {
        const now = yield* nowSeconds
        yield* Effect.sync(() => legacy.copy(from, to, now))
      }),
      reset: Effect.fn('Capabilities.reset')(function* (thread: string) {
        const now = yield* nowSeconds
        yield* fromPromise(() => legacy.reset(thread, now))
      }),
      configureHelper: Effect.fn('Capabilities.configureHelper')(function* (
        parent: string,
        session: string,
        exclusions: readonly HelperExclusion[],
      ) {
        const now = yield* nowSeconds
        yield* fromPromise(() => legacy.configureHelper(parent, session, exclusions, now))
      }),
      piTools: Effect.fn('Capabilities.piTools')(function* (session: string) {
        return yield* Effect.sync(() => legacy.piTools(session))
      }),
      syncPi: Effect.fn('Capabilities.syncPi')(function* (session: string) {
        yield* fromPromise(() => legacy.syncPi(session))
      }),
    })
  }),
)

/**
 * Lane M's services: resident authority, the MCP servers, grants, connections, held calls and Events, and each
 * conversation's capabilities.
 */
export const McpLive: Layer.Layer<
  Resident | McpServers | McpGrants | McpConnections | Approvals | Events | Capabilities,
  never,
  FoundationServices
> = Layer.mergeAll(
  ResidentLive,
  McpServersLive,
  McpGrantsLive,
  McpConnectionsLive,
  ApprovalsLive,
  EventsLive,
  CapabilitiesLive,
)
