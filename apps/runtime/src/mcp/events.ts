import type { JsonSchemaType } from '@modelcontextprotocol/client'
import { CfWorkerJsonSchemaValidator } from '@modelcontextprotocol/client/validators/cf-worker'
import * as Clock from 'effect/Clock'
import * as Effect from 'effect/Effect'
import * as Option from 'effect/Option'
import { type AppError, InvalidInput, attempt, attemptSync } from '../http/errors.ts'
import { SingleFlight } from '../observability/single-flight.ts'
import {
  type EventClient,
  catalogEvents,
  envelopeAad,
  listEvents,
  pollEvents,
  prepareEvents,
  subscribeEvents,
  unsubscribeEvents,
} from './events/client.ts'
import { type EventHandler, makeDispatcher } from './events/dispatcher.ts'
import { receive } from './events/ingress.ts'
import type { EventEnvelope, EventsPollResult } from './events/protocol.ts'
import { canonicalArguments, EVENT_LIMITS, type Receipt, type Subscription } from './events/store.ts'
import { challengeResponse, isOccurrence, type WebhookHeaders } from './events/webhook.ts'
import { Events } from './service.ts'

export type SubscribeConsumer = {
  readonly consumerId: string
  readonly revision: number
  readonly connectionId: string
  readonly name: string
  readonly arguments: Record<string, unknown>
  readonly handlerKey: string
}
/** One webhook delivery, as the connection's hook took it. */
export type EventWebhook = WebhookHeaders & {
  readonly connectionId: string
  readonly subscriptionId: string
  readonly body: Uint8Array
}
export type EventWebhookResult = { readonly status: 200 | 204 | 410 | 503; readonly response?: string }

type Binding = { readonly consumerId: string; readonly revision: number }
type ReceiptKey = Pick<Receipt, 'subscriptionId' | 'webhookId' | 'consumerId' | 'revision' | 'operationId'>

export type EventsOptions = EventClient & {
  /** The plan and resident authority: checked before a subscription, a sweep, a dispatch and a delivery. */
  readonly authority: Effect.Effect<void, AppError>
}

/** What the engine's steps share: the client, the dispatcher and the flights that keep one sweep at a time. */
type Engine = EventsOptions & {
  readonly dispatcher: ReturnType<typeof makeDispatcher>
  readonly flights: SingleFlight['Service']
}

/** A subscription stays only while its server is still offered at the same endpoint and its selector is granted. */
const valid = (engine: Engine, row: Subscription): Effect.Effect<boolean, AppError> =>
  engine.connections.server(row.connectionId).pipe(
    Effect.map(
      ({ endpoint }) => row.endpoint === endpoint && engine.store.allows(row.connectionId, row.name, row.argumentsJson),
    ),
    // expected: a server the owner removed is NotFound, and its subscriptions are no longer valid.
    Effect.catchTag('NotFound', () => Effect.succeed(false)),
  )

/** Seals one delivery and stores it; a recovery alarm is armed before commit, and no wait runs in the transaction. */
const persist = (engine: Engine, row: Subscription, id: string, body: Uint8Array, envelope: EventEnvelope) =>
  Effect.gen(function* () {
    const { store } = engine
    const sealed = yield* attempt(() => engine.cipher.encrypt(new TextDecoder().decode(body), envelopeAad(row, id)))
    const response = challengeResponse(envelope)
    const now = yield* Clock.currentTimeMillis
    yield* engine.wake(now + 1000)
    yield* attemptSync(() => {
      store.receive({
        subscriptionId: row.id,
        webhookId: id,
        kind: isOccurrence(envelope) ? 'occurrence' : envelope.type,
        envelope: sealed,
        bytes: sealed.length,
        receivedAt: now,
        nextAttemptAt: now,
        challengeResponse: response ?? null,
        challengeUntil: response === undefined ? null : now + 300_000,
      })
      store.patch(row.id, {
        lastReceiptAt: now,
        updatedAt: now,
        ...(isOccurrence(envelope) && envelope.cursor !== undefined ? { cursor: envelope.cursor } : {}),
      })
    })
  })

/** Binds a consumer revision to a (shared) subscription, subscribing remotely when none is active. */
const subscribe = (engine: Engine, input: SubscribeConsumer) =>
  Effect.gen(function* () {
    const { store } = engine
    yield* engine.authority
    const existing = store.consumer(input.consumerId, input.revision)
    const args = yield* attemptSync(() => canonicalArguments(input.arguments))
    if (existing !== undefined) {
      const old = store.get(existing.subscriptionId)
      if (
        existing.state !== 'active' ||
        old?.connectionId !== input.connectionId ||
        old.name !== input.name ||
        old.argumentsJson !== args ||
        existing.handlerKey !== input.handlerKey
      )
        return yield* new InvalidInput({ reason: 'event consumer revision cannot be rebound' })
    }
    const descriptors = yield* listEvents(engine, input.connectionId, input.name, input.arguments)
    const descriptor = descriptors.find(
      (d) => d.name === input.name && d.delivery.includes('webhook') && d.delivery.includes('poll'),
    )
    if (descriptor === undefined)
      return yield* new InvalidInput({ reason: 'event not available with poll and webhook' })
    // SAFETY: the bounded descriptor is decoded as an object; the SDK validator treats its JSON schema as data.
    const schema = descriptor.inputSchema as JsonSchemaType
    if (!new CfWorkerJsonSchemaValidator().getValidator(schema)(input.arguments).valid)
      return yield* new InvalidInput({ reason: 'event arguments do not match its descriptor' })
    const row = yield* prepareEvents(engine, input.connectionId, input.name, input.arguments)
    const now = yield* Clock.currentTimeMillis
    yield* Effect.sync(() =>
      store.bind({
        consumerId: input.consumerId,
        revision: input.revision,
        subscriptionId: row.id,
        handlerKey: input.handlerKey,
        state: 'active',
        createdAt: now,
        retiredAt: null,
      }),
    )
    const active = row.status === 'active' ? row : yield* subscribeEvents(engine, row)
    return { subscriptionId: active.id, status: active.status }
  })

/** Retires a consumer revision; the last one tombstones the subscription and cleans up remotely when it still can. */
const retire = (engine: Engine, input: Binding) =>
  Effect.gen(function* () {
    const { store } = engine
    const binding = store.consumer(input.consumerId, input.revision)
    if (binding === undefined) return { retired: true, remoteCleanup: true }
    const row = store.get(binding.subscriptionId)
    const now = yield* Clock.currentTimeMillis
    store.retire(input.consumerId, input.revision, now)
    if (row === undefined || store.bindings(binding.subscriptionId).length > 0)
      return { retired: true, remoteCleanup: true }
    const remoteCleanup = yield* Effect.andThen(engine.authority, unsubscribeEvents(engine, row)).pipe(
      Effect.as(true),
      // expected: without authority the remote subscription lapses at its finite TTL; cleanup never renews it.
      Effect.catch(() => Effect.succeed(false)),
    )
    const later = yield* Clock.currentTimeMillis
    store.patch(row.id, {
      status: 'tombstone',
      nextRefreshAt: Number.MAX_SAFE_INTEGER,
      updatedAt: later,
      lastError: remoteCleanup ? null : 'cleanup_pending',
    })
    yield* engine.wake(later + 1000)
    return { retired: true, remoteCleanup }
  })

/** One dispatch at a time: a caller while one runs joins it. */
const dispatch = (engine: Engine) =>
  Effect.andThen(
    engine.authority,
    engine.flights.run('mcp.events.dispatch', Effect.flatMap(Clock.currentTimeMillis, engine.dispatcher.dispatch)),
  )

const acceptPoll = (engine: Engine, row: Subscription, result: EventsPollResult, now: number) =>
  Effect.gen(function* () {
    if (result.events.length > EVENT_LIMITS.page)
      return yield* new InvalidInput({ reason: 'event poll page too large' })
    for (const event of result.events) {
      if (event.name !== row.name) return yield* new InvalidInput({ reason: 'event poll selector mismatch' })
      yield* persist(engine, row, event.eventId, new TextEncoder().encode(JSON.stringify(event)), event)
    }
    if (result.truncated) {
      const gap = { type: 'gap' as const, cursor: result.cursor }
      yield* persist(engine, row, `msg_gap_poll_${now}`, new TextEncoder().encode(JSON.stringify(gap)), gap)
    }
    engine.store.patch(row.id, {
      cursor: result.cursor,
      status: 'active',
      nextPollAt: now + (result.hasMore ? 1000 : Math.max(1000, Math.min(300_000, result.nextPollMs ?? 300_000))),
      lastError: null,
    })
  })

/** Refreshes a subscription's lease when due and polls it when due or catching up. */
const reconcile = (engine: Engine, initial: Subscription, now: number) =>
  Effect.gen(function* () {
    if (initial.status === 'tombstone' || initial.status === 'terminated') return
    if (!(yield* valid(engine, initial))) {
      engine.store.patch(initial.id, { status: 'tombstone', lastError: 'grant_or_endpoint_changed' })
      return
    }
    yield* Effect.gen(function* () {
      yield* engine.authority
      const row = initial.nextRefreshAt <= now ? yield* subscribeEvents(engine, initial) : initial
      if (row.nextPollAt > now && row.status !== 'catching_up') return
      yield* acceptPoll(engine, row, yield* pollEvents(engine, row), now)
    }).pipe(
      // expected: the row records the failure as catching_up and the next sweep, a minute on, tries again.
      Effect.catch(() =>
        Effect.sync(() =>
          engine.store.patch(initial.id, {
            status: 'catching_up',
            lastError: 'reconnect_or_poll_required',
            nextRefreshAt: now + 60_000,
            nextPollAt: now + 60_000,
          }),
        ),
      ),
    )
  })

/** One maintenance sweep at a time: dispatch, refresh or poll each subscription, prune, dispatch again. */
const maintain = (engine: Engine) =>
  engine.flights.run(
    'mcp.events.maintain',
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis
      yield* dispatch(engine)
      for (const row of engine.store.live()) yield* reconcile(engine, row, now)
      yield* Effect.sync(() => engine.store.prune(now))
      yield* dispatch(engine)
      // The next sweep only when something is due: an alarm every minute keeps the agent awake for nothing.
      const due = engine.store.nextDue()
      if (due !== undefined) yield* engine.wake(Math.max(due, now + 1000))
    }),
  )

/** `Events` and, for the tests that drive it, one dispatch of the deliveries due. */
export type EventsEngine = Events['Service'] & { readonly dispatch: () => Effect.Effect<void, AppError> }

/** `write`, a synchronous write to the same database, and the acknowledgement, in one short transaction. */
const ackWith = (engine: Engine, input: ReceiptKey, write: () => void) =>
  Effect.flatMap(Clock.currentTimeMillis, (now) =>
    attemptSync(() =>
      engine.store.db.transaction(() => {
        write()
        engine.store.ack(input, now)
      }),
    ),
  )

/** What the owner and the consumers read and grant. */
const reads = (engine: Engine) => ({
  catalog: Effect.fn('Events.catalog')(function* (connectionId: string) {
    return yield* catalogEvents(engine, connectionId)
  }),
  health: Effect.fn('Events.health')(function* (connectionId: string) {
    const { store } = engine
    return yield* Effect.sync(() =>
      store
        .live()
        .filter((row) => row.connectionId === connectionId)
        .map(({ id, name, argumentsJson, status, refreshBefore, lastReceiptAt }) => ({
          subscriptionId: id,
          name,
          granted: store.allows(connectionId, name, argumentsJson),
          status,
          refreshBefore,
          lastReceiptAt,
        })),
    )
  }),
  grant: Effect.fn('Events.grant')(function* (
    connectionId: string,
    name: string,
    args: Record<string, unknown>,
    allowed: boolean,
  ) {
    const now = yield* Clock.currentTimeMillis
    yield* Effect.orDie(
      attemptSync(() => engine.store.grant(connectionId, name, canonicalArguments(args), allowed, now)),
    )
  }),
  activeConsumer: Effect.fn('Events.activeConsumer')(function* (consumerId: string) {
    return yield* Effect.sync(() => Option.fromNullishOr(engine.store.activeConsumer(consumerId)))
  }),
  subscription: Effect.fn('Events.subscription')(function* (id: string) {
    return yield* Effect.sync(() => Option.fromNullishOr(engine.store.get(id)))
  }),
  register: Effect.fn('Events.register')(function* (key: string, handler: EventHandler) {
    yield* Effect.sync(() => engine.dispatcher.register(key, handler))
  }),
})

/** Subscriptions, acknowledgements, deliveries and sweeps. */
const changes = (engine: Engine) => ({
  subscribe: Effect.fn('Events.subscribe')(function* (input: SubscribeConsumer) {
    return yield* subscribe(engine, input)
  }),
  unsubscribe: Effect.fn('Events.unsubscribe')(function* (input: Binding) {
    return yield* retire(engine, input)
  }),
  ack: Effect.fn('Events.ack')(function* (input: ReceiptKey) {
    yield* ackWith(engine, input, () => undefined)
  }),
  ackWith: Effect.fn('Events.ackWith')(function* (input: ReceiptKey, write: () => void) {
    yield* ackWith(engine, input, write)
  }),
  /** Disconnect or revoke cleanup, while the authorization that made the subscriptions is still available. */
  disableServer: Effect.fn('Events.disableServer')(function* (connectionId?: string) {
    const { store } = engine
    for (const row of store.live().filter((item) => connectionId === undefined || item.connectionId === connectionId))
      for (const binding of store.bindings(row.id)) yield* retire(engine, binding)
  }),
  receive: Effect.fn('Events.receive')(function* (input: EventWebhook) {
    return yield* receive(
      {
        store: engine.store,
        cipher: engine.cipher,
        wake: engine.wake,
        valid: (row) => valid(engine, row),
        authorized: engine.authority,
        persist: (row, id, body, envelope) => persist(engine, row, id, body, envelope),
      },
      input,
    )
  }),
  maintain: Effect.fn('Events.maintain')(function* () {
    yield* maintain(engine)
  }),
  nextDue: () => Effect.sync(() => engine.store.nextDue()),
})

/**
 * MCP Events over the agent's connections and its event store: finite leases, alarm-driven sweeps, and deliveries
 * acknowledged durably and independently by each consumer.
 */
export const makeEvents = Effect.fnUntraced(function* (options: EventsOptions) {
  const engine: Engine = {
    ...options,
    dispatcher: makeDispatcher(options.store, options.cipher),
    flights: yield* SingleFlight,
  }
  const events: EventsEngine = {
    ...Events.of({ ...reads(engine), ...changes(engine) }),
    dispatch: () => dispatch(engine),
  }
  return events
})
