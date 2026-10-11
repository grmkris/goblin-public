import * as Clock from 'effect/Clock'
import * as Effect from 'effect/Effect'
import * as Schema from 'effect/Schema'
import { type AppError, GrantDenied, InvalidInput, UpstreamMcp, attempt, attemptSync } from '../../http/errors.ts'
import type { CredentialCipher } from '../cipher.ts'
import type { McpConnections } from '../service.ts'
import { canonicalArguments, EVENT_LIMITS, type SqliteEventStore, type Subscription } from './store.ts'
import {
  EventsListResult,
  EventsPollResult,
  EventsSubscribeResult,
  EventsUnsubscribeResult,
  type EventDescriptor,
} from './protocol.ts'

const Arguments = Schema.Record(Schema.String, Schema.Unknown)
export const decodeArguments = (value: string): Record<string, unknown> =>
  Schema.decodeUnknownSync(Arguments)(JSON.parse(value))
/** A row's stored selector arguments, decoded. */
const argumentsOf = (row: Pick<Subscription, 'argumentsJson'>) => attemptSync(() => decodeArguments(row.argumentsJson))
export const secretAad = (row: Pick<Subscription, 'id' | 'connectionId'>): string =>
  `events:${row.connectionId}:${row.id}:secret`
export const envelopeAad = (row: Pick<Subscription, 'id' | 'connectionId'>, webhookId: string): string =>
  `events:${row.connectionId}:${row.id}:delivery:${webhookId}`
const makeSecret = (): string => `whsec_${btoa(String.fromCodePoint(...crypto.getRandomValues(new Uint8Array(32))))}`
const makeSubscriptionId = (): string => crypto.randomUUID()

/** What the Events requests go through: the connections, the durable intents and the agent's own identity. */
export type EventClient = {
  readonly connections: Pick<McpConnections['Service'], 'events' | 'server'>
  readonly store: SqliteEventStore
  readonly cipher: CredentialCipher
  readonly principal: string
  /** The webhook URL of `connectionId`'s Events (one per connection, ADR 0041). */
  readonly callback: (connectionId: string) => Effect.Effect<string>
  /** Arms the Events alarm no later than `at`. */
  readonly wake: (at: number) => Effect.Effect<void, AppError>
  /** The Events authority for one selector: checked before each request connects and again before it is sent. */
  readonly authorize: (connectionId: string, name: string, argumentsJson: string) => Effect.Effect<void, AppError>
}

/** One Events request for `row`'s selector, through its server's connection. */
const request = <S extends Schema.ConstraintDecoder<unknown>>(
  client: EventClient,
  row: Pick<Subscription, 'connectionId' | 'name' | 'argumentsJson'>,
  method: 'events/list' | 'events/poll' | 'events/subscribe' | 'events/unsubscribe',
  params: Record<string, unknown>,
  schema: S,
) =>
  client.connections.events(
    row.connectionId,
    method,
    params,
    schema,
    client.authorize(row.connectionId, row.name, row.argumentsJson),
  )

/** The server's event descriptors for one selector, every page up to the subscription bound. */
export const listEvents = (client: EventClient, connectionId: string, name: string, args: Record<string, unknown>) =>
  Effect.gen(function* () {
    const selector = { connectionId, name, argumentsJson: yield* attemptSync(() => canonicalArguments(args)) }
    const events: EventDescriptor[] = []
    let cursor: string | undefined
    for (let page = 0; page < EVENT_LIMITS.listPages; page++) {
      const result = yield* request(
        client,
        selector,
        'events/list',
        cursor === undefined ? {} : { cursor },
        EventsListResult,
      )
      events.push(...result.events)
      if (result.nextCursor === undefined || result.nextCursor === cursor) return events
      cursor = result.nextCursor
    }
    return yield* new UpstreamMcp({ connectionId, reason: 'content-limit' })
  })

/** The durable intent for a selector, made (or found current) before anything is sent: a finite lease to come. */
export const prepareEvents = (
  client: EventClient,
  connectionId: string,
  name: string,
  args: Record<string, unknown>,
  ttlMs: number = EVENT_LIMITS.ttlMs,
) =>
  Effect.gen(function* () {
    const { store, principal, cipher } = client
    const argumentsJson = yield* attemptSync(() => canonicalArguments(args))
    if (!store.allows(connectionId, name, argumentsJson)) return yield* new GrantDenied({ connectionId, name })
    const { endpoint } = yield* client.connections.server(connectionId)
    const callback = yield* client.callback(connectionId)
    const current = store.selector(connectionId, name, argumentsJson)
    if (
      current !== undefined &&
      current.endpoint === endpoint &&
      current.principal === principal &&
      current.callbackUrl === callback &&
      current.status !== 'tombstone'
    )
      return current
    if (store.count() >= EVENT_LIMITS.subscriptions && (current === undefined || current.status === 'tombstone'))
      return yield* new InvalidInput({ reason: 'too many event subscriptions' })
    const now = yield* Clock.currentTimeMillis
    const binding = { id: current?.id ?? (yield* Effect.sync(makeSubscriptionId)), connectionId }
    const secret = yield* attempt(() => cipher.encrypt(makeSecret(), secretAad(binding)))
    const row: Subscription = {
      ...binding,
      name,
      argumentsJson,
      endpoint,
      principal,
      callbackUrl: callback,
      remoteId: null,
      secret,
      previousSecret: null,
      graceUntil: null,
      cursor: null,
      refreshBefore: null,
      nextRefreshAt: now,
      nextPollAt: now + 300_000,
      status: 'pending',
      lastError: null,
      lastReceiptAt: null,
      createdAt: now,
      updatedAt: now,
    }
    // Arm a recovery wake before the durable intent. A crash after commit is repaired by this alarm or startup.
    yield* client.wake(now + Math.min(ttlMs, 60_000))
    yield* Effect.sync(() => store.save(row))
    return row
  })

/** Subscribes (or renews) `row` remotely and records the lease, refreshed 10% early with bounded jitter. */
export const subscribeEvents = (client: EventClient, row: Subscription, ttlMs: number = EVENT_LIMITS.ttlMs) =>
  Effect.gen(function* () {
    const { store, cipher } = client
    const now = yield* Clock.currentTimeMillis
    if (row.remoteId === null) store.patch(row.id, { status: 'pending', updatedAt: now })
    const secret = yield* attempt(() => cipher.decrypt(row.secret, secretAad(row)))
    const args = yield* argumentsOf(row)
    const result = yield* request(
      client,
      row,
      'events/subscribe',
      {
        name: row.name,
        arguments: args,
        delivery: { mode: 'webhook', url: row.callbackUrl, secret },
        cursor: row.cursor,
        ttlMs: Math.min(EVENT_LIMITS.maxTtlMs, Math.max(EVENT_LIMITS.minTtlMs, ttlMs)),
        maxAgeMs: 7 * 86_400_000,
      },
      EventsSubscribeResult,
    )
    const refreshBefore = Date.parse(result.refreshBefore)
    if (!Number.isFinite(refreshBefore) || refreshBefore <= now || refreshBefore > now + EVENT_LIMITS.maxTtlMs)
      return yield* new UpstreamMcp({ connectionId: row.connectionId, reason: 'remote-rpc' })
    const provisional = store.get(row.id)?.remoteId
    if (provisional !== null && provisional !== undefined && provisional !== result.id)
      return yield* new UpstreamMcp({ connectionId: row.connectionId, reason: 'remote-rpc' })
    const margin = Math.min(300_000, Math.max(1000, (refreshBefore - now) / 10))
    const jitter = crypto.getRandomValues(new Uint16Array(1))[0] ?? 0
    const nextRefreshAt = Math.max(now + 1000, refreshBefore - margin - (jitter % 1000))
    const status = result.truncated === true || result.deliveryStatus?.active === false ? 'catching_up' : 'active'
    yield* client.wake(Math.min(nextRefreshAt, now + 300_000))
    store.patch(row.id, {
      remoteId: result.id,
      refreshBefore,
      nextRefreshAt,
      cursor: result.cursor ?? row.cursor,
      status,
      lastError: null,
      updatedAt: now,
    })
    const saved = store.get(row.id)
    if (saved === undefined) return yield* new InvalidInput({ reason: 'event intent missing' })
    return saved
  })

/** The occurrences after `row`'s cursor, one page. */
export const pollEvents = (client: EventClient, row: Subscription) =>
  Effect.flatMap(argumentsOf(row), (args) =>
    request(
      client,
      row,
      'events/poll',
      { name: row.name, arguments: args, cursor: row.cursor, maxEvents: EVENT_LIMITS.page, maxAgeMs: 7 * 86_400_000 },
      EventsPollResult,
    ),
  )

/** Ends `row`'s remote subscription; one the server no longer knows (-32011) is already gone. */
export const unsubscribeEvents = (client: EventClient, row: Subscription): Effect.Effect<void, AppError> =>
  Effect.flatMap(argumentsOf(row), (args) =>
    request(
      client,
      row,
      'events/unsubscribe',
      { name: row.name, arguments: args, delivery: { mode: 'webhook', url: row.callbackUrl } },
      EventsUnsubscribeResult,
    ),
  ).pipe(
    Effect.asVoid,
    Effect.catchTag('UpstreamMcp', (error) => (error.code === -32011 ? Effect.void : Effect.fail(error))),
  )
