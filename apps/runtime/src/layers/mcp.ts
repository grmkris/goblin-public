import type { CallToolResult } from '@modelcontextprotocol/client'
import * as Clock from 'effect/Clock'
import type * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Option from 'effect/Option'
import { type Entitlements, requirePlan } from '../billing/gates.ts'
import { Channel } from '../channel/service.ts'
import { Forbidden, GrantDenied, attempt, attemptSync } from '../http/errors.ts'
import { type HeldCall, McpApprovalStore, argumentsHash } from '../mcp/approvals.ts'
import { Cipher, CredentialCipher } from '../mcp/cipher.ts'
import { configuredServers } from '../mcp/config.ts'
import { CredentialStore } from '../mcp/credentials.ts'
import { bindEndpoints } from '../mcp/endpoints.ts'
import { makeEvents } from '../mcp/events.ts'
import { type EventConsumerPorts, installEventConsumers } from '../mcp/events/consumers.ts'
import { eventsHookToken, eventsHookUrl } from '../mcp/events/route-token.ts'
import { SqliteEventStore } from '../mcp/events/store.ts'
import { GrantStore } from '../mcp/grants.ts'
import { mcpHost } from '../mcp/host.ts'
import { logEndpointsReset } from '../mcp/log.ts'
import { RegistryStore } from '../mcp/registries.ts'
import { ConnectionEventOffers } from '../mcp/events/offers.ts'
import { ConnectionLabels } from '../mcp/labels.ts'
import { AddedServerStore } from '../mcp/servers.ts'
import {
  Approvals,
  Events,
  McpConnections,
  type McpGrants,
  McpServers,
  type Resident,
  Spending,
  UrlRequests,
  requireResident,
} from '../mcp/service.ts'
import { SpendStore, dayOf } from '../mcp/spend.ts'
import type { McpManagerOptions, UrlPrompt } from '../mcp/types.ts'
import { type HeldUrlRequest, McpUrlRequestStore } from '../mcp/url-requests.ts'
import type { SingleFlight } from '../observability/single-flight.ts'
import { Changes } from '../runtime/changes.ts'
import { Db } from '../runtime/db.ts'
import { AgentInput, type AgentInputs } from '../runtime/input.ts'
import { SqliteSkillState } from '../skills/store.ts'
import { Skills } from '../skills/service.ts'
import { mcpReporter } from '../telemetry/report.ts'

// The MCP layers, both steps of the agent's start in its order (layers/index.ts): the MCP host (step 2) and Events
// with their consumers (12). Every store is made once, here, and every MCP service once over them.

/**
 * The plan the agent keeps, then current resident authority: what Events check before a subscription, a sweep, a
 * dispatch or a delivery, and what ingress checks before it takes a webhook.
 */
const eventsAuthority = Effect.andThen(requirePlan(), requireResident)

/** Held calls over their one store, sealed with the credential key. */
export const approvalsOver = (store: McpApprovalStore) =>
  Approvals.of({
    cipher: store.cipher,
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

/** URL requests over their one store (ADR 0042). */
/** The spending rules and paid calls over their store (ADR 0044). */
export const spendingOver = (store: SpendStore) =>
  Spending.of({
    rule: (connectionId, tool) => Effect.sync(() => store.rule(connectionId, tool)),
    setRule: (connectionId, tool, rule) =>
      Effect.flatMap(Clock.currentTimeMillis, (now) => Effect.sync(() => store.setRule(connectionId, tool, rule, now))),
    spentToday: (connectionId, tool) =>
      Effect.flatMap(Clock.currentTimeMillis, (now) =>
        Effect.sync(() => store.spentOn(connectionId, tool, dayOf(now))),
      ),
    standing: (approvalId) => Effect.sync(() => store.standing(approvalId)),
    record: (call, rule) =>
      Effect.flatMap(Clock.currentTimeMillis, (now) => Effect.sync(() => store.record(call, now, rule))),
  })

export const urlRequestsOver = (store: McpUrlRequestStore) =>
  UrlRequests.of({
    hold: Effect.fn('UrlRequests.hold')(function* (request: HeldUrlRequest) {
      const now = yield* Clock.currentTimeMillis
      return yield* attempt(() => store.hold(request, now))
    }),
    get: Effect.fn('UrlRequests.get')(function* (id: string) {
      return yield* attemptSync(() => store.get(id))
    }),
    claim: Effect.fn('UrlRequests.claim')(function* (id: string) {
      const now = yield* Clock.currentTimeMillis
      return yield* attemptSync(() => store.claim(id, now))
    }),
    again: Effect.fn('UrlRequests.again')(function* (id: string, prompt: UrlPrompt) {
      const now = yield* Clock.currentTimeMillis
      yield* attempt(() => store.again(id, prompt, now))
    }),
    finish: Effect.fn('UrlRequests.finish')(function* (
      id: string,
      state: 'completed' | 'declined',
      result: CallToolResult,
    ) {
      const now = yield* Clock.currentTimeMillis
      yield* attempt(() => store.finish(id, state, result, now))
    }),
    fail: Effect.fn('UrlRequests.fail')(function* (id: string, state: 'failed' | 'uncertain') {
      const now = yield* Clock.currentTimeMillis
      yield* Effect.sync(() => store.fail(id, state, now))
    }),
    decline: Effect.fn('UrlRequests.decline')(function* (id: string) {
      const now = yield* Clock.currentTimeMillis
      yield* Effect.sync(() => store.decline(id, now))
    }),
    arguments: Effect.fn('UrlRequests.arguments')(function* (id: string) {
      return yield* attempt(() => store.arguments(id))
    }),
    tool: Effect.fn('UrlRequests.tool')(function* (id: string) {
      return yield* attemptSync(() => store.tool(id))
    }),
    prompt: Effect.fn('UrlRequests.prompt')(function* (id: string) {
      return yield* attempt(() => store.prompt(id))
    }),
    result: Effect.fn('UrlRequests.result')(function* (id: string) {
      return Option.fromNullishOr(yield* attempt(() => store.result(id)))
    }),
  })

/**
 * The owner's decision on a call by the model or an App: an ask-first tool's call goes out only as the held call the
 * owner approved, with exactly its reviewed arguments, conversation and grant version; `authorize`, the caller's own
 * check, runs after the arguments are hashed and before the held call is read.
 */
const heldCalls =
  (approvals: McpApprovalStore, grants: GrantStore): NonNullable<McpManagerOptions['authorizeTool']> =>
  (call, approvalId, dispatch, authorize) =>
    Effect.gen(function* () {
      if (call.caller === 'human') return
      const grant = { connectionId: call.connectionId, capability: 'tool' as const, name: call.name }
      const policy = grants.policy(grant)
      if (approvalId === undefined) {
        if (policy?.askFirst === true)
          return yield* new Forbidden({ reason: 'Owner approval required for this exact call' })
        return
      }
      if (policy === undefined) return yield* new GrantDenied({ connectionId: call.connectionId, name: call.name })
      const hash = yield* attempt(() => argumentsHash(call.arguments))
      if (authorize !== undefined) yield* authorize
      const now = yield* Clock.currentTimeMillis
      const version = grants.policy(grant)?.version
      yield* attemptSync(() => approvals.check({ id: approvalId, call, hash, version, now, dispatch }))
    })

/**
 * Start step 2: every server's endpoint binding is checked (a re-pointed server loses what it had), the credential
 * cipher is made, held calls a restart cut off are recovered, and the one MCP host is made over its stores: the
 * connections, the owner's servers and grants, and held calls.
 */
export const McpHostLive: Layer.Layer<
  McpConnections | McpServers | McpGrants | Approvals | UrlRequests | Spending | Cipher,
  never,
  AgentInput | Db | SingleFlight | Changes
> = Layer.unwrap(
  Effect.gen(function* () {
    const input = yield* AgentInput
    const db = yield* Db
    const changes = yield* Changes
    const { env } = input
    const servers = configuredServers(env.MCP_SERVERS)
    const added = new AddedServerStore(db)
    const now = yield* Clock.currentTimeMillis
    const reset = bindEndpoints(db, [...servers, ...added.list()], Math.floor(now / 1000))
    if (reset.length > 0) logEndpointsReset(reset)
    const cipher = yield* Effect.promise(() => CredentialCipher.fromBase64(env.CREDENTIAL_KEY))
    const grants = new GrantStore(db)
    const approvals = new McpApprovalStore(db, cipher)
    yield* Effect.sync(() => approvals.recover(now))
    const urlRequests = new McpUrlRequestStore(db, cipher)
    yield* Effect.sync(() => urlRequests.recover(now))
    const skillState = new SqliteSkillState(db)
    const host = mcpHost({
      servers,
      added,
      labels: new ConnectionLabels(db),
      credentials: new CredentialStore(db, cipher),
      grants,
      registries: new RegistryStore(db),
      skillsEnabled: (connectionId) => skillState.enabled(connectionId),
      offers: new ConnectionEventOffers(db),
      authorizeTool: heldCalls(approvals, grants),
      appUrl: env.APP_URL,
      fetch: input.mcpFetch,
      report: mcpReporter(input.telemetry),
      toolsChanged: (connectionId, digest) => changes.publish('mcp.tools', { connectionId, digest }),
    })
    return Layer.mergeAll(
      host,
      Layer.succeed(Approvals, approvalsOver(approvals)),
      Layer.succeed(UrlRequests, urlRequestsOver(urlRequests)),
      Layer.succeed(Spending, spendingOver(new SpendStore(db))),
      Layer.succeed(Cipher, cipher),
    )
  }),
)

/**
 * What the Telegram and skills consumers reach, read when an event arrives: the channel and skills services of the
 * start (steps 10 and 11, before Events), and the agent's Telegram pull, scheduled as a doorbell schedules it.
 */
const consumerPorts = (
  { schedulePull }: AgentInputs,
  context: Context.Context<Channel | Skills>,
): EventConsumerPorts => ({
  channel: Channel.use((channel) => channel.status).pipe(Effect.provideContext(context)),
  pull: Effect.asVoid(attempt(schedulePull)),
  skills: {
    enabled: (connectionId) =>
      Skills.use((skills) => skills.enabled(connectionId)).pipe(Effect.provideContext(context)),
    invalidate: (connectionId, unavailable) =>
      Skills.use((skills) => skills.invalidate(connectionId, unavailable)).pipe(Effect.provideContext(context)),
  },
})

/**
 * Start step 12: the one Events engine over the host's connections and its event store, with the Telegram and skills
 * consumers registered before any delivery can reach it (the routine trigger is registered by `RoutinesLive`, before
 * the agent runs anything).
 */
export const McpEventsLive: Layer.Layer<
  Events,
  never,
  AgentInput | Db | Entitlements | Resident | SingleFlight | McpConnections | McpServers | Cipher | Channel | Skills
> = Layer.effect(
  Events,
  Effect.gen(function* () {
    const input = yield* AgentInput
    const context = yield* Effect.context<AgentInput | Entitlements | Resident | Channel | Skills>()
    const { env, userId } = input
    const servers = yield* McpServers
    const store = new SqliteEventStore(yield* Db)
    const hooks = new Map<string, string>()
    const callback = (connectionId: string) =>
      Effect.promise(async () => {
        const known = hooks.get(connectionId)
        if (known !== undefined) return known
        const token = await eventsHookToken(env.CREDENTIAL_KEY, userId, connectionId)
        const url = eventsHookUrl(env.APP_URL, userId, connectionId, token)
        hooks.set(connectionId, url)
        return url
      })
    const authority = Effect.provideContext(eventsAuthority, context)
    const connected = (connectionId: string) =>
      Effect.gen(function* () {
        yield* authority
        if ((yield* servers.status(connectionId)) !== 'connected')
          return yield* new Forbidden({ reason: 'event connection requires authorization' })
      })
    const events = yield* makeEvents({
      connections: yield* McpConnections,
      store,
      cipher: yield* Cipher,
      principal: userId,
      callback,
      wake: (at) => attempt(() => input.scheduleEvents(at)),
      authority,
      connected,
      authorize: (connectionId, name, argumentsJson) =>
        Effect.gen(function* () {
          yield* connected(connectionId)
          if (!store.allows(connectionId, name, argumentsJson)) return yield* new GrantDenied({ connectionId, name })
        }),
    })
    yield* installEventConsumers(events, consumerPorts(input, context))
    return events
  }),
)
