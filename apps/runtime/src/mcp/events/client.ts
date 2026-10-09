import * as Schema from 'effect/Schema'
import { nowMillis } from '../../clock.ts'
import { GrantDenied, InvalidInput, UpstreamMcp } from '../../http/errors.ts'
import type { CredentialCipher } from '../cipher.ts'
import type { McpConnectionManager } from '../connection.ts'
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
export const secretAad = (row: Pick<Subscription, 'id' | 'serverId'>): string =>
  `events:${row.serverId}:${row.id}:secret`
export const envelopeAad = (row: Pick<Subscription, 'id' | 'serverId'>, webhookId: string): string =>
  `events:${row.serverId}:${row.id}:delivery:${webhookId}`
const makeSecret = (): string => `whsec_${btoa(String.fromCodePoint(...crypto.getRandomValues(new Uint8Array(32))))}`
export type EventClientOptions = {
  readonly manager: McpConnectionManager
  readonly store: SqliteEventStore
  readonly cipher: CredentialCipher
  readonly principal: string
  readonly callback: string
  readonly now?: () => number
  readonly wake: (at: number) => Promise<void>
}

/** Finite leases through the existing MCP connection. Persist intent before subscribe and any verification POST. */
export class EventsClient {
  readonly options: EventClientOptions
  readonly now: () => number
  constructor(options: EventClientOptions) {
    this.options = options
    this.now = options.now ?? nowMillis
  }

  async list(serverId: string, name: string, args: Record<string, unknown>): Promise<readonly EventDescriptor[]> {
    const selector = { name, argumentsJson: canonicalArguments(args) }
    const events: EventDescriptor[] = []
    let cursor: string | undefined
    for (let page = 0; page < EVENT_LIMITS.subscriptions; page++) {
      const result = await this.options.manager.eventRequest(
        serverId,
        selector,
        'events/list',
        cursor === undefined ? {} : { cursor },
        EventsListResult,
      )
      events.push(...result.events)
      if (result.nextCursor === undefined || result.nextCursor === cursor) return events
      cursor = result.nextCursor
    }
    throw new UpstreamMcp({ serverId, reason: 'content-limit' })
  }

  async prepare(
    serverId: string,
    name: string,
    args: Record<string, unknown>,
    ttlMs = EVENT_LIMITS.ttlMs,
  ): Promise<Subscription> {
    const { store, manager, principal, callback, cipher } = this.options
    const argumentsJson = canonicalArguments(args)
    if (!store.allows(serverId, name, argumentsJson)) throw new GrantDenied({ serverId, name })
    const current = store.selector(serverId, name, argumentsJson)
    if (
      current !== undefined &&
      current.endpoint === manager.server(serverId).endpoint &&
      current.principal === principal &&
      current.callbackUrl === callback &&
      current.status !== 'tombstone'
    )
      return current
    if (store.list().length >= EVENT_LIMITS.subscriptions && current === undefined)
      throw new InvalidInput({ reason: 'too many event subscriptions' })
    const now = this.now()
    const id = current?.id ?? crypto.randomUUID()
    const binding = { id, serverId }
    const secret = await cipher.encrypt(makeSecret(), secretAad(binding))
    const row: Subscription = {
      ...binding,
      name,
      argumentsJson,
      endpoint: manager.server(serverId).endpoint,
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
    await this.options.wake(now + Math.min(ttlMs, 60_000))
    store.save(row)
    return row
  }

  async subscribe(row: Subscription, ttlMs: number = EVENT_LIMITS.ttlMs): Promise<Subscription> {
    const { manager, store, cipher } = this.options
    const now = this.now()
    if (row.remoteId === null) store.patch(row.id, { status: 'pending', updatedAt: now })
    const secret = await cipher.decrypt(row.secret, secretAad(row))
    const result = await manager.eventRequest(
      row.serverId,
      row,
      'events/subscribe',
      {
        name: row.name,
        arguments: decodeArguments(row.argumentsJson),
        delivery: { mode: 'webhook', url: row.callbackUrl, secret },
        cursor: row.cursor,
        ttlMs: Math.min(EVENT_LIMITS.maxTtlMs, Math.max(EVENT_LIMITS.minTtlMs, ttlMs)),
        maxAgeMs: 7 * 86_400_000,
      },
      EventsSubscribeResult,
    )
    const refreshBefore = Date.parse(result.refreshBefore)
    if (!Number.isFinite(refreshBefore) || refreshBefore <= now || refreshBefore > now + EVENT_LIMITS.maxTtlMs)
      throw new UpstreamMcp({ serverId: row.serverId, reason: 'remote-rpc' })
    const provisional = store.get(row.id)?.remoteId
    if (provisional !== null && provisional !== undefined && provisional !== result.id)
      throw new UpstreamMcp({ serverId: row.serverId, reason: 'remote-rpc' })
    // Refresh 10% early, with bounded jitter; short leases always rearm before expiration.
    const margin = Math.min(300_000, Math.max(1000, (refreshBefore - now) / 10))
    const jitter = crypto.getRandomValues(new Uint16Array(1))[0] ?? 0
    const nextRefreshAt = Math.max(now + 1000, refreshBefore - margin - (jitter % 1000))
    const status = result.truncated === true || result.deliveryStatus?.active === false ? 'catching_up' : 'active'
    await this.options.wake(Math.min(nextRefreshAt, now + 300_000))
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
    if (saved === undefined) throw new InvalidInput({ reason: 'event intent missing' })
    return saved
  }

  async poll(row: Subscription): Promise<EventsPollResult> {
    return this.options.manager.eventRequest(
      row.serverId,
      row,
      'events/poll',
      {
        name: row.name,
        arguments: decodeArguments(row.argumentsJson),
        cursor: row.cursor,
        maxEvents: EVENT_LIMITS.page,
        maxAgeMs: 7 * 86_400_000,
      },
      EventsPollResult,
    )
  }

  async unsubscribe(row: Subscription): Promise<void> {
    try {
      await this.options.manager.eventRequest(
        row.serverId,
        row,
        'events/unsubscribe',
        {
          name: row.name,
          arguments: decodeArguments(row.argumentsJson),
          delivery: { mode: 'webhook', url: row.callbackUrl },
        },
        EventsUnsubscribeResult,
      )
    } catch (error) {
      if (!(error instanceof UpstreamMcp && error.code === -32011)) throw error
    }
  }
}
