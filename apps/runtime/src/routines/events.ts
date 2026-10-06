import { RoutineDefinition } from '@goblin/contracts'
import * as Schema from 'effect/Schema'
import * as Effect from 'effect/Effect'
import { drizzle } from 'drizzle-orm/durable-sqlite'
import { Conflict, NotFound } from '../http/errors.ts'
import { CredentialCipher } from '../mcp/cipher.ts'
import type { McpEvents } from '../mcp/events.ts'
import type { EventContext } from '../mcp/events/dispatcher.ts'
import { canonicalArguments } from '../mcp/events/store.ts'
import { RoutineStore } from './store.ts'
import type { RoutineRunner, RoutineWake } from './runner.ts'
import type { Firing } from './runs.ts'
import { routineSummary } from './summary.ts'

const decode = (json: string) => Schema.decodeUnknownSync(RoutineDefinition)(JSON.parse(json))
const consumerId = (id: string) => `routine:${id}`
const busy = (error: unknown) =>
  error instanceof Conflict &&
  ['routine already running', 'running routine limit', 'event run spacing limit'].includes(error.reason)

/** The shared dispatcher owns delivery; these are only confirmed routine admission and sealed pending metadata. */
export class RoutineEventBindings {
  readonly #store: RoutineStore
  readonly #events: McpEvents
  readonly #runner: RoutineRunner
  readonly #cipher: Promise<CredentialCipher>
  readonly #wake: RoutineWake
  constructor(input: {
    storage: DurableObjectStorage
    owner: string
    events: McpEvents
    runner: RoutineRunner
    key: string
    wake: RoutineWake
  }) {
    this.#store = new RoutineStore(drizzle(input.storage), input.owner)
    this.#events = input.events
    this.#runner = input.runner
    this.#cipher = CredentialCipher.fromBase64(input.key)
    this.#wake = input.wake
  }

  /** Called solely by the authenticated exact-revision Confirm API, never by reconciliation or the model. */
  async confirm(id: string, revision: number): Promise<void> {
    const row = this.#store.get(id)
    if (row.revision !== revision || row.state !== 'activating' || row.confirmedAt === null) return
    const trigger = decode(row.definitionJson).trigger
    if (trigger.kind !== 'event') return
    this.#events.grant(trigger.serverId, trigger.name, trigger.arguments, true)
    await Effect.runPromise(
      this.#events.subscribe({
        consumerId: consumerId(id),
        revision,
        serverId: trigger.serverId,
        name: trigger.name,
        arguments: trigger.arguments,
        handlerKey: 'routine-trigger',
      }),
    )
    this.#store.markActive(id, revision, null, Date.now())
  }

  async reconcile(): Promise<void> {
    for (const row of this.#store.scheduling()) await this.#repair(row)
  }
  async #repair(row: ReturnType<RoutineStore['get']>): Promise<void> {
    const binding = this.#events.store.activeConsumer(consumerId(row.id))
    const definition = decode(row.definitionJson)
    if (binding !== undefined && (binding.revision !== row.revision || !['active', 'activating'].includes(row.state)))
      await Effect.runPromise(this.#events.unsubscribe(binding))
    if (
      definition.trigger.kind !== 'event' ||
      !['active', 'activating'].includes(row.state) ||
      row.confirmedAt === null
    )
      return
    if (binding?.revision === row.revision) {
      const lease = this.#events.store.get(binding.subscriptionId)
      if (lease?.status === 'terminated' || lease?.status === 'tombstone') {
        this.#store.pause(row.id, row.revision, `event-ended:${row.id}:${row.revision}`, Date.now())
        this.#store.eventHealth(
          row.id,
          row.revision + 1,
          'Event subscription ended; review and confirm to reconnect.',
          Date.now(),
        )
        await Effect.runPromise(this.#events.unsubscribe(binding))
      } else if (lease?.status === 'active') this.#store.markActive(row.id, row.revision, null, Date.now())
      return
    }
    const trigger = definition.trigger
    try {
      await Effect.runPromise(
        this.#events.subscribe({
          consumerId: consumerId(row.id),
          revision: row.revision,
          serverId: trigger.serverId,
          name: trigger.name,
          arguments: trigger.arguments,
          handlerKey: 'routine-trigger',
        }),
      )
      const current = this.#store.get(row.id)
      if (current.revision !== row.revision || !['active', 'activating'].includes(current.state)) {
        await Effect.runPromise(this.#events.unsubscribe({ consumerId: consumerId(row.id), revision: row.revision }))
        return
      }
      this.#store.markActive(row.id, row.revision, null, Date.now())
    } catch {
      this.#store.eventHealth(
        row.id,
        row.revision,
        'Event activation needs the connected server and exact event selector.',
        Date.now(),
      )
    }
  }

  async consume(context: EventContext): Promise<void> {
    const id = context.consumer.consumerId.slice('routine:'.length)
    let row: ReturnType<RoutineStore['get']>
    try {
      row = this.#store.get(id)
    } catch (error) {
      if (error instanceof NotFound) return
      throw error
    }
    const trigger = decode(row.definitionJson).trigger
    if (
      row.state !== 'active' ||
      row.revision !== context.consumer.revision ||
      trigger.kind !== 'event' ||
      trigger.serverId !== context.subscription.serverId ||
      trigger.name !== context.subscription.name ||
      canonicalArguments(trigger.arguments) !== context.subscription.argumentsJson
    )
      return
    if ('type' in context.envelope) {
      if (context.envelope.type === 'terminated') {
        this.#store.pause(id, row.revision, `event-terminated:${context.receipt.operationId}`, Date.now())
        this.#store.eventHealth(
          id,
          row.revision + 1,
          'Event subscription terminated; review and confirm to reconnect.',
          Date.now(),
        )
      } else if (context.envelope.type === 'gap') {
        this.#store.eventHealth(id, row.revision, 'Catching up through the originating event selector.', Date.now())
      }
      await this.#wake(Date.now() + 1000)
      return
    }
    await this.#occurrence(row, context)
  }

  async #occurrence(row: ReturnType<RoutineStore['get']>, context: EventContext): Promise<void> {
    const envelope = context.envelope
    if ('type' in envelope || envelope.name !== context.subscription.name) return
    const operationId = `routine:${row.id}:${encodeURIComponent(envelope.eventId)}`
    const at = Date.now()
    const occurredAt = Date.parse(envelope.timestamp)
    const data = JSON.stringify(
      { name: envelope.name, timestamp: envelope.timestamp, data: envelope.data },
      (key, value: unknown) => (/token|secret|password|authorization|api.?key/iu.test(key) ? '[redacted]' : value),
    )
    const selected = routineSummary(data).slice(0, 8000)
    const dataSealed = await (await this.#cipher).encrypt(selected, `routine-event:${operationId}:${row.revision}`)
    const firing: Firing = {
      routineId: row.id,
      revision: row.revision,
      operationId,
      source: 'event',
      firedAt: at,
      event: {
        eventId: envelope.eventId,
        subscriptionId: context.subscription.id,
        webhookId: context.receipt.webhookId,
        dataSealed,
      },
    }
    try {
      await this.#runner.admit(
        firing,
        !Number.isFinite(occurredAt) || occurredAt < at - 86_400_000
          ? 'Event is invalid or older than the 24-hour catch-up window'
          : undefined,
      )
    } catch (error) {
      if (!busy(error)) {
        if (error instanceof Conflict && error.reason === 'routine is not active at this revision') return
        throw error
      }
      const pending = await (
        await this.#cipher
      ).encrypt(JSON.stringify(firing), `routine-pending:${row.id}:${row.revision}`)
      await this.#wake(Date.now() + 60_000)
      // The pending handoff and this consumer's acknowledgement share one short app transaction.
      this.#events.store.db.transaction(() => {
        this.#store.pending(row.id, row.revision, pending, Date.now())
        this.#events.store.ack(context.receipt, Date.now())
      })
    }
  }
}
