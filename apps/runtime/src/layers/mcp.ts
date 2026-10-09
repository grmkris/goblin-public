import type { CallToolResult } from '@modelcontextprotocol/client'
import type { CapabilityTarget, HelperExclusion, ServerSource } from '@goblin/contracts'
import type { PiHarness } from 'agents/harness/pi'
import type { DrizzleSqliteDODatabase } from 'drizzle-orm/durable-sqlite'
import * as Clock from 'effect/Clock'
import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Option from 'effect/Option'
import { CapabilityProfiles, type PiTools, ProfilesInstance } from '../capabilities/profiles.ts'
import { Capabilities } from '../capabilities/service.ts'
import { Channel } from '../channel/service.ts'
import { ChatsInstance } from '../chats/directory.ts'
import { nowMillis } from '../clock.ts'
import { Forbidden, GrantDenied, ResidentInactive, toAppError } from '../http/errors.ts'
import { type HeldCall, McpApprovalStore } from '../mcp/approvals.ts'
import { Cipher, CredentialCipher } from '../mcp/cipher.ts'
import { configuredServers } from '../mcp/config.ts'
import { CredentialStore } from '../mcp/credentials.ts'
import { bindEndpoints } from '../mcp/endpoints.ts'
import { type EventWebhook, McpEvents, type SubscribeConsumer } from '../mcp/events.ts'
import { type EventConsumerPorts, installEventConsumers } from '../mcp/events/consumers.ts'
import { eventsHookToken, eventsHookUrl } from '../mcp/events/route-token.ts'
import { type Receipt, SqliteEventStore } from '../mcp/events/store.ts'
import { GrantStore } from '../mcp/grants.ts'
import { McpHost, McpHostInstance } from '../mcp/host.ts'
import { logEndpointsReset } from '../mcp/log.ts'
import { RegistryStore } from '../mcp/registries.ts'
import { makeCatalog } from '../mcp/registry.ts'
import { AddedServerStore } from '../mcp/servers.ts'
import { Approvals, Events, McpConnections, McpGrants, McpServers, Resident, requireResident } from '../mcp/service.ts'
import { type Stage, suggestions } from '../mcp/suggested.ts'
import type { McpCallOptions, McpRequestOptions } from '../mcp/types.ts'
import { BACKGROUND, conversationId } from '../pi/context.ts'
import { enableResident, renewResident, residentStatus, revokeResident } from '../resident.ts'
import { Db } from '../runtime/db.ts'
import { AgentInput, type AgentInputs } from '../runtime/input.ts'
import { SqliteSkillState } from '../skills/store.ts'
import { Skills } from '../skills/service.ts'
import { mcpReporter } from '../telemetry/report.ts'

// Lane M's layers. Four are steps of the agent's start, in its order (layers/index.ts): the MCP host (step 2), the
// capability profiles (6), their one retool (8) and Events with their consumers (17). Each makes its stateful object
// once and shares it by its instance tag (`McpHostInstance`, `Cipher`, `ProfilesInstance`) with the steps and layers
// that wire it; `Events` is the service itself. The services after the start (`McpLive`) read those instances, and
// resident authority, held calls and the registry catalog are built over the agent's database.

/** Wall-clock seconds, the unit resident authority and grants are kept in. */
const nowSeconds = Effect.map(Clock.currentTimeMillis, (millis) => Math.floor(millis / 1000))

/** A call into a stateful instance's async code: a failure is the `AppError` it threw, anything else `Internal`. */
const fromPromise = <A>(run: () => Promise<A>) => Effect.tryPromise({ try: run, catch: toAppError })
/** The same for its synchronous code. */
const fromSync = <A>(run: () => A) => Effect.try({ try: run, catch: toAppError })

/**
 * The plan, then current resident authority: what the MCP host and Events check before an Events call goes out. It
 * runs through the bridge's `local` (no second plan check) on the agent's own plan policy, read fresh each time.
 */
const eventsAuthority = (input: AgentInputs): Promise<void> =>
  input.local(Effect.andThen(input.entitlements.require(), requireResident))

/** The MCP host over the agent's database, with the stores it checks and the held calls a restart cut off recovered. */
async function makeHost(input: AgentInputs, db: DrizzleSqliteDODatabase) {
  const env = input.env
  const servers = configuredServers(env.MCP_SERVERS)
  const added = new AddedServerStore(db)
  const reset = bindEndpoints(db, [...servers, ...added.list()], Math.floor(nowMillis() / 1000))
  if (reset.length > 0) logEndpointsReset(reset)
  const skillState = new SqliteSkillState(db)
  const grants = new GrantStore(db)
  const cipher = await CredentialCipher.fromBase64(env.CREDENTIAL_KEY)
  const approvals = new McpApprovalStore(db, cipher)
  approvals.recover(nowMillis())
  const eventStore = new SqliteEventStore(db)
  const credentials = new CredentialStore(db, cipher)
  const host = new McpHost({
    servers,
    added,
    credentials,
    authorizeEvents: async (serverId, name, argumentsJson) => {
      await eventsAuthority(input)
      if (credentials.status(serverId) !== 'connected')
        throw new Forbidden({ reason: 'event connection requires authorization' })
      if (!eventStore.allows(serverId, name, argumentsJson)) throw new GrantDenied({ serverId, name })
    },
    grants,
    authorizeTool: async (call, approvalId, dispatch, authorize) => {
      if (call.caller === 'human') return
      const policy = grants.policy({ serverId: call.serverId, capability: 'tool', name: call.name })
      if (approvalId !== undefined) {
        if (policy === undefined) throw new GrantDenied({ serverId: call.serverId, name: call.name })
        await approvals.assert({
          id: approvalId,
          call,
          version: () => grants.policy({ serverId: call.serverId, capability: 'tool', name: call.name })?.version,
          now: nowMillis(),
          dispatch,
          ...(authorize === undefined ? {} : { authorize }),
        })
      } else if (policy?.askFirst === true) {
        throw new Forbidden({ reason: 'Owner approval required for this exact call' })
      }
    },
    skillsEnabled: (serverId) => skillState.enabled(serverId),
    appUrl: env.APP_URL,
    fetch: input.mcpFetch,
    report: mcpReporter(input.telemetry),
  })
  return { host, cipher }
}

/**
 * Start step 2: every server's endpoint binding is checked (a re-pointed server loses what it had), the credential
 * cipher is made, held calls a restart cut off are recovered, and the one MCP host is made.
 */
export const McpHostLive: Layer.Layer<McpHostInstance | Cipher, never, AgentInput | Db> = Layer.effectContext(
  Effect.gen(function* () {
    const input = yield* AgentInput
    const db = yield* Db
    const { host, cipher } = yield* Effect.promise(() => makeHost(input, db))
    return Context.mergeAll(McpHostInstance.context(host), Cipher.context(cipher))
  }),
)

/** Sets a conversation's Pi tool filter (where subagents are switched off), leaving its extensions as they are. */
const retool = (harness: PiHarness) => async (session: string, tools: PiTools) => {
  const conversation = await (await harness.pi()).conversation(conversationId(session), BACKGROUND)
  await conversation?.configure({ tools }, BACKGROUND)
}

/** Start step 6: each conversation's switches, the one profile store, over the chat directory. */
export const ProfilesLive: Layer.Layer<ProfilesInstance, never, AgentInput | Db | ChatsInstance> = Layer.effect(
  ProfilesInstance,
  Effect.gen(function* () {
    const input = yield* AgentInput
    return new CapabilityProfiles(yield* Db, input.subagentTools, retool(input.harness), yield* ChatsInstance)
  }),
)

/** Start step 8: the current complete delegation tool set is applied to the retained Pi filters, once. */
export const RetoolLive: Layer.Layer<never, never, ProfilesInstance> = Layer.effectDiscard(
  Effect.gen(function* () {
    const profiles = yield* ProfilesInstance
    const now = yield* nowSeconds
    yield* Effect.promise(() => profiles.retoolOnce('retool:subagent-config', now))
  }),
)

/** `Events` over the agent's one engine: its methods are Effects already. */
const eventsOver = (engine: McpEvents) =>
  Events.of({
    health: Effect.fn('Events.health')(function* (serverId: string) {
      return yield* Effect.sync(() => engine.health(serverId))
    }),
    grant: Effect.fn('Events.grant')(function* (
      serverId: string,
      name: string,
      args: Record<string, unknown>,
      allowed: boolean,
    ) {
      yield* Effect.sync(() => engine.grant(serverId, name, args, allowed))
    }),
    subscribe: Effect.fn('Events.subscribe')(function* (input: SubscribeConsumer) {
      return yield* engine.subscribe(input)
    }),
    unsubscribe: Effect.fn('Events.unsubscribe')(function* (input: {
      readonly consumerId: string
      readonly revision: number
    }) {
      return yield* engine.unsubscribe(input)
    }),
    activeConsumer: Effect.fn('Events.activeConsumer')(function* (consumerId: string) {
      return yield* Effect.sync(() => Option.fromNullishOr(engine.store.activeConsumer(consumerId)))
    }),
    subscription: Effect.fn('Events.subscription')(function* (id: string) {
      return yield* Effect.sync(() => Option.fromNullishOr(engine.store.get(id)))
    }),
    ack: Effect.fn('Events.ack')(function* (
      input: Pick<Receipt, 'subscriptionId' | 'webhookId' | 'consumerId' | 'revision' | 'operationId'>,
    ) {
      yield* engine.ack(input)
    }),
    ackWith: Effect.fn('Events.ackWith')(function* (
      input: Pick<Receipt, 'subscriptionId' | 'webhookId' | 'consumerId' | 'revision' | 'operationId'>,
      write: () => void,
    ) {
      yield* engine.ackWith(input, write)
    }),
    disableServer: Effect.fn('Events.disableServer')(function* (serverId?: string) {
      yield* engine.disableServer(serverId)
    }),
    receive: Effect.fn('Events.receive')(function* (input: EventWebhook) {
      return yield* engine.receive(input)
    }),
    maintain: Effect.fn('Events.maintain')(function* () {
      yield* engine.maintain()
    }),
  })

/**
 * What the Telegram and skills consumers reach, read when an event arrives: the channel and skills services through
 * the bridge's `local` (no plan check), and the agent's scheduled Telegram pull.
 */
const consumerPorts = ({ local, pullTelegram }: AgentInputs): EventConsumerPorts => ({
  channel: () => local(Channel.use((channel) => channel.status)),
  pull: pullTelegram,
  skills: {
    enabled: (serverId) => local(Skills.use((skills) => skills.enabled(serverId))),
    invalidate: (serverId, unavailable) => local(Skills.use((skills) => skills.invalidate(serverId, unavailable))),
  },
})

/**
 * Start step 17: the one Events engine over the host's connections, with the routine trigger and then the Telegram
 * and skills consumers registered before any delivery can reach it.
 */
export const McpEventsLive: Layer.Layer<Events, never, AgentInput | Db | McpHostInstance | Cipher> = Layer.effect(
  Events,
  Effect.gen(function* () {
    const input = yield* AgentInput
    const { env, userId } = input
    const host = yield* McpHostInstance
    const cipher = yield* Cipher
    const store = new SqliteEventStore(yield* Db)
    const token = yield* Effect.promise(() => eventsHookToken(env.CREDENTIAL_KEY, userId))
    const engine = new McpEvents({
      manager: host.manager,
      store,
      cipher,
      principal: userId,
      callback: eventsHookUrl(env.APP_URL, userId, token),
      wake: input.scheduleEvents,
      authorize: () => eventsAuthority(input),
    })
    engine.register('routine-trigger', input.routineEvent)
    installEventConsumers(engine, consumerPorts(input))
    return eventsOver(engine)
  }),
)

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
    const host = yield* McpHostInstance
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
    const host = yield* McpHostInstance
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
    const { manager } = yield* McpHostInstance
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
    const cipher = yield* Cipher
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

/** Each conversation's switches, over the one profile store the conversations, Topics and the mover share. */
export const CapabilitiesLive = Layer.effect(
  Capabilities,
  Effect.gen(function* () {
    const profiles = yield* ProfilesInstance
    return Capabilities.of({
      scope: Effect.fn('Capabilities.scope')(function* (session: string) {
        return yield* Effect.sync(() => profiles.scope(session))
      }),
      app: Effect.fn('Capabilities.app')(function* (session: string, app: string) {
        return yield* Effect.sync(() => profiles.app(session, app))
      }),
      own: Effect.fn('Capabilities.own')(function* (session: string) {
        return yield* Effect.sync(() => profiles.own(session))
      }),
      inherited: Effect.fn('Capabilities.inherited')(function* (thread: string) {
        return yield* Effect.sync(() => profiles.inherited(thread))
      }),
      set: Effect.fn('Capabilities.set')(function* (session: string, target: CapabilityTarget, on: boolean) {
        const now = yield* nowSeconds
        yield* Effect.sync(() => profiles.set(session, target, on, now))
      }),
      narrow: Effect.fn('Capabilities.narrow')(function* (session: string, exclusions: readonly HelperExclusion[]) {
        const now = yield* nowSeconds
        yield* Effect.sync(() => profiles.narrow(session, exclusions, now))
      }),
      copy: Effect.fn('Capabilities.copy')(function* (from: string, to: string) {
        const now = yield* nowSeconds
        yield* Effect.sync(() => profiles.copy(from, to, now))
      }),
      reset: Effect.fn('Capabilities.reset')(function* (thread: string) {
        const now = yield* nowSeconds
        yield* fromPromise(() => profiles.reset(thread, now))
      }),
      configureHelper: Effect.fn('Capabilities.configureHelper')(function* (
        parent: string,
        session: string,
        exclusions: readonly HelperExclusion[],
      ) {
        const now = yield* nowSeconds
        yield* fromPromise(() => profiles.configureHelper(parent, session, exclusions, now))
      }),
      piTools: Effect.fn('Capabilities.piTools')(function* (session: string) {
        return yield* Effect.sync(() => profiles.piTools(session))
      }),
      syncPi: Effect.fn('Capabilities.syncPi')(function* (session: string) {
        yield* fromPromise(() => profiles.syncPi(session))
      }),
    })
  }),
)

/**
 * Lane M's services after the start: resident authority, the MCP servers, grants, connections and held calls, and each
 * conversation's capabilities (`Events` is start step 17's).
 */
export const McpLive: Layer.Layer<
  Resident | McpServers | McpGrants | McpConnections | Approvals | Capabilities,
  never,
  AgentInput | Db | McpHostInstance | Cipher | ProfilesInstance
> = Layer.mergeAll(ResidentLive, McpServersLive, McpGrantsLive, McpConnectionsLive, ApprovalsLive, CapabilitiesLive)
