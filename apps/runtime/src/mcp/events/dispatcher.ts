import * as Cause from 'effect/Cause'
import * as Effect from 'effect/Effect'
import * as Schema from 'effect/Schema'
import type { AppError } from '../../http/errors.ts'
import type { CredentialCipher } from '../cipher.ts'
import { envelopeAad } from './client.ts'
import { EventEnvelope, type EventEnvelope as Envelope } from './protocol.ts'
import type { Consumer, Delivery, Receipt, SqliteEventStore, Subscription } from './store.ts'

export type EventContext = {
  readonly subscription: Subscription
  readonly consumer: Consumer
  readonly receipt: Receipt
  /** Untrusted metadata. Handlers pull authoritative content through the originating connection. */
  readonly envelope: Envelope
}
/** A consumer's handler, an Effect bound to its own services; when it completes it has durably taken the delivery. */
export type EventHandler = (context: EventContext) => Effect.Effect<void, AppError>

const decodeEnvelope = Schema.decodeUnknownSync(EventEnvelope)

/**
 * The static handler registry and one pass over the deliveries due. A completed handler has durably accepted its
 * intent before its independent ack; a delivery whose handling failed stays queued and is retried with backoff.
 */
export const makeDispatcher = (store: SqliteEventStore, cipher: CredentialCipher) => {
  const handlers = new Map<string, EventHandler>()

  const handle = (subscription: Subscription, envelope: Envelope, receipt: Receipt, now: number) =>
    Effect.gen(function* () {
      if (receipt.state !== 'pending') return
      const consumer = store.consumer(receipt.consumerId, receipt.revision)
      if (consumer === undefined || consumer.state === 'retiring')
        return yield* Effect.sync(() => store.retire(receipt.consumerId, receipt.revision, now))
      const handler = handlers.get(consumer.handlerKey)
      if (handler === undefined) return
      yield* handler({ subscription, consumer, receipt, envelope })
      yield* Effect.sync(() => store.ack(receipt, now))
    })

  /** One delivery to every consumer bound to its subscription; a gap or a termination is recorded first. */
  const deliver = (subscription: Subscription, row: Delivery, now: number) =>
    Effect.gen(function* () {
      const plain = yield* Effect.tryPromise(() =>
        cipher.decrypt(row.envelope, envelopeAad(subscription, row.webhookId)),
      )
      const envelope = yield* Effect.try(() => decodeEnvelope(JSON.parse(plain)))
      if ('type' in envelope && envelope.type === 'gap')
        store.patch(subscription.id, { status: 'catching_up', cursor: envelope.cursor, nextPollAt: now })
      if ('type' in envelope && envelope.type === 'terminated')
        store.patch(subscription.id, {
          status: 'terminated',
          nextRefreshAt: Number.MAX_SAFE_INTEGER,
          lastError: `terminated:${envelope.error?.code ?? 'unknown'}`,
        })
      for (const receipt of store.snapshots(row.subscriptionId, row.webhookId))
        yield* handle(subscription, envelope, receipt, now)
      yield* Effect.sync(() => store.finish(row.subscriptionId, row.webhookId, now))
    }).pipe(
      // expected: whatever stopped it (a handler's failure or defect included), the delivery stays queued and is retried
      // with backoff; the row counts its attempts. Interruption still interrupts.
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause) ? Effect.interrupt : Effect.sync(() => store.retry(row, now)),
      ),
    )

  return {
    register: (key: string, handler: EventHandler): void => {
      handlers.set(key, handler)
    },
    /** Every delivery due at `now`, in order. */
    dispatch: (now: number): Effect.Effect<void> =>
      Effect.suspend(() =>
        Effect.forEach(
          store.work(now),
          (row) =>
            Effect.suspend(() => {
              const subscription = store.get(row.subscriptionId)
              return subscription === undefined ? Effect.void : deliver(subscription, row, now)
            }),
          { discard: true },
        ),
      ),
  }
}
