import * as Schema from 'effect/Schema'
import type { CredentialCipher } from '../cipher.ts'
import { envelopeAad } from './client.ts'
import { EventEnvelope, type EventEnvelope as Envelope } from './protocol.ts'
import { type Consumer, type Receipt, type SqliteEventStore, type Subscription } from './store.ts'

export type EventContext = {
  readonly subscription: Subscription
  readonly consumer: Consumer
  readonly receipt: Receipt
  /** Untrusted metadata. Handlers pull authoritative content through the originating connection. */
  readonly envelope: Envelope
}
export type EventHandler = (context: EventContext) => Promise<void>

/** Static handler registry. A completed handler has durably accepted its intent before its independent ack. */
export class EventDispatcher {
  readonly #handlers = new Map<string, EventHandler>()
  constructor(
    readonly store: SqliteEventStore,
    readonly cipher: CredentialCipher,
  ) {}
  register(key: string, handler: EventHandler): void {
    this.#handlers.set(key, handler)
  }
  async #handle(subscription: Subscription, envelope: Envelope, receipt: Receipt, now: number): Promise<void> {
    if (receipt.state !== 'pending') return
    const consumer = this.store.consumer(receipt.consumerId, receipt.revision)
    if (consumer === undefined || consumer.state === 'retiring') {
      this.store.retire(receipt.consumerId, receipt.revision, now)
      return
    }
    const handler = this.#handlers.get(consumer.handlerKey)
    if (handler === undefined) return
    await handler({ subscription, consumer, receipt, envelope })
    this.store.ack(receipt, now)
  }
  async dispatch(now: number): Promise<void> {
    for (const row of this.store.work(now)) {
      const subscription = this.store.get(row.subscriptionId)
      if (subscription === undefined) continue
      try {
        const plain = await this.cipher.decrypt(row.envelope, envelopeAad(subscription, row.webhookId))
        const envelope = Schema.decodeUnknownSync(EventEnvelope)(JSON.parse(plain))
        if ('type' in envelope && envelope.type === 'gap')
          this.store.patch(subscription.id, { status: 'catching_up', cursor: envelope.cursor, nextPollAt: now })
        if ('type' in envelope && envelope.type === 'terminated')
          this.store.patch(subscription.id, {
            status: 'terminated',
            nextRefreshAt: Number.MAX_SAFE_INTEGER,
            lastError: `terminated:${envelope.error?.code ?? 'unknown'}`,
          })
        for (const receipt of this.store.snapshots(row.subscriptionId, row.webhookId))
          await this.#handle(subscription, envelope, receipt, now)
        this.store.finish(row.subscriptionId, row.webhookId, now)
      } catch {
        this.store.retry(row, now)
      }
    }
  }
}
