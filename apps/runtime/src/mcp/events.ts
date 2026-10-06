import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import type { EventHealth } from '@goblin/contracts'
import { type AppError, InvalidInput, toAppError } from '../http/errors.ts'
import type { CredentialCipher } from './cipher.ts'
import type { McpConnectionManager } from './connection.ts'
import { EventsClient, envelopeAad, type EventClientOptions } from './events/client.ts'
import { EventIngress } from './events/ingress.ts'
import { EventDispatcher, type EventHandler } from './events/dispatcher.ts'
import { type EventEnvelope } from './events/protocol.ts'
import {
  canonicalArguments,
  EVENT_LIMITS,
  type Receipt,
  type SqliteEventStore,
  type Subscription,
} from './events/store.ts'
import { challengeResponse, isOccurrence, type WebhookHeaders } from './events/webhook.ts'
import { CfWorkerJsonSchemaValidator } from '@modelcontextprotocol/client/validators/cf-worker'
import type { JsonSchemaType } from '@modelcontextprotocol/client'

const attempt = <A>(run: () => Promise<A>): Effect.Effect<A, AppError> =>
  Effect.tryPromise({ try: run, catch: toAppError })
export type SubscribeConsumer = {
  readonly consumerId: string
  readonly revision: number
  readonly serverId: string
  readonly name: string
  readonly arguments: Record<string, unknown>
  readonly handlerKey: string
}
export type EventWebhook = WebhookHeaders & { readonly subscriptionId: string; readonly body: Uint8Array }
export type EventWebhookResult = { readonly status: 200 | 204 | 410 | 503; readonly response?: string }

/** Consumer API returns Effect values. Alarm-driven processing, shared leases and independent durable ack. */
export class McpEvents {
  readonly store: SqliteEventStore
  readonly #cipher: CredentialCipher
  readonly #manager: McpConnectionManager
  readonly #client: EventsClient
  readonly #dispatcher: EventDispatcher
  readonly #authorize: () => void | Promise<void>
  readonly #wake: (at: number) => Promise<void>
  readonly #now: () => number
  #dispatching: Promise<void> | undefined
  #maintaining: Promise<void> | undefined
  constructor(options: EventClientOptions & { readonly authorize: () => void | Promise<void> }) {
    this.store = options.store
    this.#cipher = options.cipher
    this.#manager = options.manager
    this.#client = new EventsClient(options)
    this.#dispatcher = new EventDispatcher(options.store, options.cipher)
    this.#authorize = options.authorize
    this.#wake = options.wake
    this.#now = this.#client.now
  }
  register(key: string, handler: EventHandler): void {
    this.#dispatcher.register(key, handler)
  }
  grant(serverId: string, name: string, args: Record<string, unknown>, allowed: boolean): void {
    this.store.grant(serverId, name, canonicalArguments(args), allowed, this.#now())
  }
  health(serverId: string): readonly EventHealth[] {
    return this.store
      .list()
      .filter((r) => r.serverId === serverId && r.status !== 'tombstone')
      .map(({ id, name, argumentsJson, status, refreshBefore, lastReceiptAt }) => ({
        subscriptionId: id,
        name,
        granted: this.store.allows(serverId, name, argumentsJson),
        status,
        refreshBefore,
        lastReceiptAt,
      }))
  }
  list(serverId: string, name: string, args: Record<string, unknown>) {
    return attempt(() => this.#client.list(serverId, name, args))
  }
  subscribe(
    input: SubscribeConsumer,
  ): Effect.Effect<{ readonly subscriptionId: string; readonly status: string }, AppError> {
    return attempt(async () => {
      await this.#authorize()
      const existing = this.store.consumer(input.consumerId, input.revision)
      const args = canonicalArguments(input.arguments)
      if (existing !== undefined) {
        const old = this.store.get(existing.subscriptionId)
        if (
          existing.state !== 'active' ||
          old?.serverId !== input.serverId ||
          old.name !== input.name ||
          old.argumentsJson !== args ||
          existing.handlerKey !== input.handlerKey
        )
          throw new InvalidInput({ reason: 'event consumer revision cannot be rebound' })
      }
      const descriptors = await this.#client.list(input.serverId, input.name, input.arguments)
      const descriptor = descriptors.find(
        (d) => d.name === input.name && d.delivery.includes('webhook') && d.delivery.includes('poll'),
      )
      if (descriptor === undefined) throw new InvalidInput({ reason: 'event not available with poll and webhook' })
      // SAFETY: the bounded descriptor is decoded as an object; the SDK validator treats its JSON schema as data.
      const schema = descriptor.inputSchema as JsonSchemaType
      if (!new CfWorkerJsonSchemaValidator().getValidator(schema)(input.arguments).valid)
        throw new InvalidInput({ reason: 'event arguments do not match its descriptor' })
      const row = await this.#client.prepare(input.serverId, input.name, input.arguments)
      this.store.bind({
        consumerId: input.consumerId,
        revision: input.revision,
        subscriptionId: row.id,
        handlerKey: input.handlerKey,
        state: 'active',
        createdAt: this.#now(),
        retiredAt: null,
      })
      const active = row.status === 'active' ? row : await this.#client.subscribe(row)
      return { subscriptionId: active.id, status: active.status }
    })
  }
  ack(
    input: Pick<Receipt, 'subscriptionId' | 'webhookId' | 'consumerId' | 'revision' | 'operationId'>,
  ): Effect.Effect<void, AppError> {
    return Effect.try({ try: () => this.store.ack(input, this.#now()), catch: toAppError })
  }
  unsubscribe(input: {
    readonly consumerId: string
    readonly revision: number
  }): Effect.Effect<{ retired: boolean; remoteCleanup: boolean }, AppError> {
    return attempt(async () => {
      const binding = this.store.consumer(input.consumerId, input.revision)
      if (binding === undefined) return { retired: true, remoteCleanup: true }
      const row = this.store.get(binding.subscriptionId)
      this.store.retire(input.consumerId, input.revision, this.#now())
      if (row === undefined || this.store.bindings(binding.subscriptionId).length > 0)
        return { retired: true, remoteCleanup: true }
      let remoteCleanup = false
      try {
        await this.#authorize()
        await this.#client.unsubscribe(row)
        remoteCleanup = true
      } catch {
        /* Finite remote TTL handles unavailable authority; never renew for cleanup. */
      }
      this.store.patch(row.id, {
        status: 'tombstone',
        nextRefreshAt: Number.MAX_SAFE_INTEGER,
        updatedAt: this.#now(),
        lastError: remoteCleanup ? null : 'cleanup_pending',
      })
      await this.#wake(this.#now() + 1000)
      return { retired: true, remoteCleanup }
    })
  }
  /** Disconnect/revoke cleanup runs while the originating authorization is still available. */
  disableServer(serverId?: string): Effect.Effect<void, AppError> {
    return attempt(async () => {
      for (const row of this.store.list().filter((r) => serverId === undefined || r.serverId === serverId))
        for (const binding of this.store.bindings(row.id)) await Effect.runPromise(this.unsubscribe(binding))
    })
  }
  #valid(row: Subscription): boolean {
    try {
      return (
        row.endpoint === this.#manager.server(row.serverId).endpoint &&
        this.store.allows(row.serverId, row.name, row.argumentsJson)
      )
    } catch {
      return false
    }
  }
  async #persist(row: Subscription, id: string, body: Uint8Array, envelope: EventEnvelope): Promise<void> {
    const encoded = new TextDecoder().decode(body)
    const sealed = await this.#cipher.encrypt(encoded, envelopeAad(row, id))
    const response = challengeResponse(envelope)
    // A recovery alarm is armed before commit; no model or network call occurs in the transaction.
    await this.#wake(this.#now() + 1000)
    this.store.receive({
      subscriptionId: row.id,
      webhookId: id,
      kind: isOccurrence(envelope) ? 'occurrence' : envelope.type,
      envelope: sealed,
      bytes: sealed.length,
      receivedAt: this.#now(),
      nextAttemptAt: this.#now(),
      challengeResponse: response ?? null,
      challengeUntil: response === undefined ? null : this.#now() + 300_000,
    })
    this.store.patch(row.id, {
      lastReceiptAt: this.#now(),
      updatedAt: this.#now(),
      ...(isOccurrence(envelope) && envelope.cursor !== undefined ? { cursor: envelope.cursor } : {}),
    })
  }
  receive(input: EventWebhook): Effect.Effect<EventWebhookResult, AppError> {
    const ingress = new EventIngress({
      store: this.store,
      cipher: this.#cipher,
      now: this.#now,
      wake: this.#wake,
      valid: (row) => this.#valid(row),
      authorized: this.#authorize,
      persist: (row, id, body, envelope) => this.#persist(row, id, body, envelope),
    })
    return attempt(() => ingress.receive(input))
  }
  /** One sweep per isolate; unfinished rows retain their independent receipts across reconstruction. */
  dispatch(): Effect.Effect<void, AppError> {
    return attempt(async () => {
      await this.#authorize()
      this.#dispatching ??= this.#dispatcher.dispatch(this.#now()).finally(() => {
        this.#dispatching = undefined
      })
      await this.#dispatching
    })
  }
  maintain(): Effect.Effect<void, AppError> {
    return attempt(async () => {
      this.#maintaining ??= this.#maintenance().finally(() => {
        this.#maintaining = undefined
      })
      await this.#maintaining
    })
  }
  async #reconcile(initial: Subscription, now: number): Promise<void> {
    if (initial.status === 'tombstone' || initial.status === 'terminated') return
    if (!this.#valid(initial)) {
      this.store.patch(initial.id, { status: 'tombstone', lastError: 'grant_or_endpoint_changed' })
      return
    }
    try {
      await this.#authorize()
      const row = initial.nextRefreshAt <= now ? await this.#client.subscribe(initial) : initial
      if (row.nextPollAt > now && row.status !== 'catching_up') return
      const result = await this.#client.poll(row)
      await this.#acceptPoll(row, result, now)
    } catch {
      this.store.patch(initial.id, {
        status: 'catching_up',
        lastError: 'reconnect_or_poll_required',
        nextRefreshAt: now + 60_000,
        nextPollAt: now + 60_000,
      })
    }
  }
  async #acceptPoll(
    row: Subscription,
    result: import('./events/protocol.ts').EventsPollResult,
    now: number,
  ): Promise<void> {
    if (result.events.length > EVENT_LIMITS.page) throw new InvalidInput({ reason: 'event poll page too large' })
    for (const event of result.events) {
      if (event.name !== row.name) throw new InvalidInput({ reason: 'event poll selector mismatch' })
      await this.#persist(row, event.eventId, new TextEncoder().encode(JSON.stringify(event)), event)
    }
    if (result.truncated) {
      const gap = { type: 'gap' as const, cursor: result.cursor }
      await this.#persist(row, `msg_gap_poll_${now}`, new TextEncoder().encode(JSON.stringify(gap)), gap)
    }
    this.store.patch(row.id, {
      cursor: result.cursor,
      status: 'active',
      nextPollAt: now + (result.hasMore ? 1000 : Math.max(1000, Math.min(300_000, result.nextPollMs ?? 300_000))),
      lastError: null,
    })
  }
  async #maintenance(): Promise<void> {
    const now = this.#now()
    await Effect.runPromise(this.dispatch())
    for (const row of this.store.list()) await this.#reconcile(row, now)
    this.store.prune(now)
    await Effect.runPromise(this.dispatch())
    await this.#wake(now + 60_000)
  }
}

export class Events extends Context.Service<Events, McpEvents>()('goblin/Events') {}
