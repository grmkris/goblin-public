import type { CallToolResult } from '@modelcontextprotocol/client'
import type { CapabilityTarget, HelperExclusion, ServerSource } from '@goblin/contracts'
import * as Clock from 'effect/Clock'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Option from 'effect/Option'
import { Capabilities } from '../capabilities/service.ts'
import type { HeldCall } from '../mcp/approvals.ts'
import { Events as LegacyEvents, type EventWebhook, type SubscribeConsumer } from '../mcp/events.ts'
import type { Receipt } from '../mcp/events/store.ts'
import { Approvals, Events, McpConnections, McpGrants, McpServers, Resident } from '../mcp/service.ts'
import { type Stage, suggestions } from '../mcp/suggested.ts'
import type { McpCallOptions, McpRequestOptions } from '../mcp/types.ts'
import {
  Approvals as LegacyApprovals,
  Capabilities as LegacyCapabilities,
  Mcp,
  Resident as LegacyResident,
  attempt,
  attemptSync,
  nowSecondsEffect,
} from '../services.ts'
import type { FoundationServices } from './core.ts'

// Wave 1 adapters: each service over the one legacy instance its `services.ts` tag already provides, never a second
// one. Every call is wrapped as the programs wrap it today: a call that may throw goes through `attempt`/`attemptSync`
// (its failure becomes an `AppError`), a plain read through `Effect.sync` (a throw is a defect, as in a program that
// called it inline). The native layers replace these in wave 3.

export const ResidentAdapter = Layer.effect(
  Resident,
  Effect.gen(function* () {
    const legacy = yield* LegacyResident
    return Resident.of({
      status: Effect.fn('Resident.status')(function* () {
        const now = yield* nowSecondsEffect
        return yield* Effect.sync(() => legacy.status(now))
      }),
      renew: Effect.fn('Resident.renew')(function* () {
        const now = yield* nowSecondsEffect
        yield* Effect.sync(() => legacy.renew(now))
      }),
      revoke: Effect.fn('Resident.revoke')(function* () {
        const now = yield* nowSecondsEffect
        return yield* Effect.sync(() => {
          legacy.revoke(now)
          return legacy.status(now)
        })
      }),
      enable: Effect.fn('Resident.enable')(function* () {
        const now = yield* nowSecondsEffect
        return yield* Effect.sync(() => {
          legacy.enable(now)
          return legacy.status(now)
        })
      }),
      require: Effect.fn('Resident.require')(function* () {
        const now = yield* nowSecondsEffect
        yield* attemptSync(() => legacy.require(now))
      }),
    })
  }),
)

export const McpServersAdapter = Layer.effect(
  McpServers,
  Effect.gen(function* () {
    const host = yield* Mcp
    return McpServers.of({
      list: Effect.fn('McpServers.list')(function* () {
        return yield* Effect.sync(() => host.servers())
      }),
      suggested: Effect.fn('McpServers.suggested')(function* (stage: Stage | undefined) {
        return yield* Effect.sync(() =>
          suggestions(stage, new Set(host.manager.servers.map((server) => server.endpoint))),
        )
      }),
      add: Effect.fn('McpServers.add')(function* (endpoint: string, source?: ServerSource) {
        return yield* attempt(() => host.addServer(endpoint, source))
      }),
      remove: Effect.fn('McpServers.remove')(function* (serverId: string) {
        yield* attempt(() => host.removeServer(serverId))
      }),
      beginConnect: Effect.fn('McpServers.beginConnect')(function* (serverId: string) {
        return yield* attempt(() => host.beginConnect(serverId))
      }),
      finishConnect: Effect.fn('McpServers.finishConnect')(function* (state: string, code: string, issuer?: string) {
        return yield* attempt(() => host.finishConnect(state, code, issuer))
      }),
      disconnect: Effect.fn('McpServers.disconnect')(function* (serverId: string) {
        yield* attempt(() => host.disconnect(serverId))
      }),
      tools: Effect.fn('McpServers.tools')(function* (serverId: string, refresh: boolean) {
        return yield* attempt(() => host.tools(serverId, refresh))
      }),
      catalog: Effect.fn('McpServers.catalog')(function* (query: string) {
        return yield* attempt(() => host.searchCatalog(query))
      }),
      registries: Effect.fn('McpServers.registries')(function* () {
        return yield* Effect.sync(() => host.registries())
      }),
      addRegistry: Effect.fn('McpServers.addRegistry')(function* (url: string) {
        return yield* attempt(() => host.addRegistry(url))
      }),
      removeRegistry: Effect.fn('McpServers.removeRegistry')(function* (url: string) {
        return yield* attemptSync(() => host.removeRegistry(url))
      }),
    })
  }),
)

export const McpGrantsAdapter = Layer.effect(
  McpGrants,
  Effect.gen(function* () {
    const host = yield* Mcp
    return McpGrants.of({
      list: Effect.fn('McpGrants.list')(function* () {
        return yield* Effect.sync(() => host.grants())
      }),
      policy: Effect.fn('McpGrants.policy')(function* (serverId: string, name: string) {
        return yield* Effect.sync(() => Option.fromNullishOr(host.grantPolicy(serverId, name)))
      }),
      setTool: Effect.fn('McpGrants.setTool')(function* (serverId: string, name: string, allowed: boolean) {
        return yield* attempt(() => host.setToolGrant(serverId, name, allowed))
      }),
      setAskFirst: Effect.fn('McpGrants.setAskFirst')(function* (serverId: string, name: string, enabled: boolean) {
        return yield* attemptSync(() => {
          host.setAskFirst(serverId, name, enabled)
          return host.grants()
        })
      }),
      setApp: Effect.fn('McpGrants.setApp')(function* (serverId: string, uri: string, allowed: boolean) {
        return yield* attempt(() => host.setAppGrant(serverId, uri, allowed))
      }),
    })
  }),
)

export const McpConnectionsAdapter = Layer.effect(
  McpConnections,
  Effect.gen(function* () {
    const { manager } = yield* Mcp
    return McpConnections.of({
      servers: Effect.fn('McpConnections.servers')(function* () {
        return yield* Effect.sync(() => manager.servers)
      }),
      snapshot: Effect.fn('McpConnections.snapshot')(function* (serverId: string) {
        return yield* Effect.sync(() => Option.fromNullishOr(manager.snapshot(serverId)))
      }),
      connect: Effect.fn('McpConnections.connect')(function* (serverId: string, options?: McpRequestOptions) {
        return yield* attempt(() => manager.connect(serverId, options))
      }),
      callTool: Effect.fn('McpConnections.callTool')(function* (
        serverId: string,
        name: string,
        args: Record<string, unknown>,
        options?: McpCallOptions,
      ) {
        return yield* attempt(() => manager.callTool(serverId, name, args, options))
      }),
      readResource: Effect.fn('McpConnections.readResource')(function* (
        serverId: string,
        uri: string,
        caller: 'human' | 'app',
      ) {
        return yield* attempt(() =>
          caller === 'app' ? manager.readAppResource(serverId, uri) : manager.readResource(serverId, uri),
        )
      }),
      getPrompt: Effect.fn('McpConnections.getPrompt')(function* (
        serverId: string,
        name: string,
        args: Record<string, string>,
      ) {
        return yield* attempt(() => manager.getPrompt(serverId, name, args))
      }),
      closeAll: Effect.fn('McpConnections.closeAll')(function* () {
        yield* attempt(() => manager.closeAll())
      }),
    })
  }),
)

export const ApprovalsAdapter = Layer.effect(
  Approvals,
  Effect.gen(function* () {
    const store = yield* LegacyApprovals
    return Approvals.of({
      hold: Effect.fn('Approvals.hold')(function* (call: HeldCall) {
        const now = yield* Clock.currentTimeMillis
        return yield* attempt(() => store.hold(call, now))
      }),
      find: Effect.fn('Approvals.find')(function* (id: string) {
        return yield* Effect.sync(() => Option.fromNullishOr(store.find(id)))
      }),
      get: Effect.fn('Approvals.get')(function* (id: string) {
        return yield* attemptSync(() => store.get(id))
      }),
      decide: Effect.fn('Approvals.decide')(function* (id: string, allowed: boolean) {
        const now = yield* Clock.currentTimeMillis
        return yield* attemptSync(() => store.decide(id, allowed, now))
      }),
      arguments: Effect.fn('Approvals.arguments')(function* (id: string) {
        return yield* attempt(() => store.arguments(id))
      }),
      finish: Effect.fn('Approvals.finish')(function* (id: string, result: CallToolResult) {
        const now = yield* Clock.currentTimeMillis
        yield* attempt(() => store.finish(id, result, now))
      }),
      fail: Effect.fn('Approvals.fail')(function* (id: string, state: 'failed' | 'uncertain') {
        const now = yield* Clock.currentTimeMillis
        yield* Effect.sync(() => store.fail(id, state, now))
      }),
      result: Effect.fn('Approvals.result')(function* (id: string) {
        return Option.fromNullishOr(yield* attempt(() => store.result(id)))
      }),
      view: Effect.fn('Approvals.view')(function* (id: string) {
        const now = yield* Clock.currentTimeMillis
        return yield* attempt(() => store.view(id, now))
      }),
    })
  }),
)

export const EventsAdapter = Layer.effect(
  Events,
  Effect.gen(function* () {
    const legacy = yield* LegacyEvents
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

export const CapabilitiesAdapter = Layer.effect(
  Capabilities,
  Effect.gen(function* () {
    const legacy = yield* LegacyCapabilities
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
        const now = yield* nowSecondsEffect
        yield* Effect.sync(() => legacy.set(session, target, on, now))
      }),
      narrow: Effect.fn('Capabilities.narrow')(function* (session: string, exclusions: readonly HelperExclusion[]) {
        const now = yield* nowSecondsEffect
        yield* Effect.sync(() => legacy.narrow(session, exclusions, now))
      }),
      copy: Effect.fn('Capabilities.copy')(function* (from: string, to: string) {
        const now = yield* nowSecondsEffect
        yield* Effect.sync(() => legacy.copy(from, to, now))
      }),
      reset: Effect.fn('Capabilities.reset')(function* (thread: string) {
        const now = yield* nowSecondsEffect
        yield* attempt(() => legacy.reset(thread, now))
      }),
      configureHelper: Effect.fn('Capabilities.configureHelper')(function* (
        parent: string,
        session: string,
        exclusions: readonly HelperExclusion[],
      ) {
        const now = yield* nowSecondsEffect
        yield* attempt(() => legacy.configureHelper(parent, session, exclusions, now))
      }),
      piTools: Effect.fn('Capabilities.piTools')(function* (session: string) {
        return yield* Effect.sync(() => legacy.piTools(session))
      }),
      syncPi: Effect.fn('Capabilities.syncPi')(function* (session: string) {
        yield* attempt(() => legacy.syncPi(session))
      }),
    })
  }),
)

/**
 * Lane M's services: resident authority, the MCP servers, grants, connections, held calls and Events, and each
 * conversation's capabilities. Wave 1 builds them over the legacy instances (see above).
 */
export const McpLive: Layer.Layer<
  Resident | McpServers | McpGrants | McpConnections | Approvals | Events | Capabilities,
  never,
  FoundationServices
> = Layer.mergeAll(
  ResidentAdapter,
  McpServersAdapter,
  McpGrantsAdapter,
  McpConnectionsAdapter,
  ApprovalsAdapter,
  EventsAdapter,
  CapabilitiesAdapter,
)
