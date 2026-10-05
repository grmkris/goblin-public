import { InvalidInput } from '../../http/errors.ts'
import type { CredentialCipher } from '../cipher.ts'
import { secretAad } from './client.ts'
import { challengeResponse, decodeEnvelope, isOccurrence, verifyWebhook } from './webhook.ts'
import type { EventEnvelope } from './protocol.ts'
import type { SqliteEventStore, Subscription } from './store.ts'
import type { EventWebhook, EventWebhookResult } from '../events.ts'

export type IngressOptions = {
  readonly store: SqliteEventStore
  readonly cipher: CredentialCipher
  readonly now: () => number
  readonly wake: (at: number) => Promise<void>
  readonly valid: (row: Subscription) => boolean
  readonly authorized: () => void | Promise<void>
  readonly persist: (row: Subscription, id: string, body: Uint8Array, envelope: EventEnvelope) => Promise<void>
}

/** Verification is bounded to this owner's endpoint-bound pending intents and matching current/previous secrets. */
export class EventIngress {
  readonly options: IngressOptions
  constructor(options: IngressOptions) {
    this.options = options
  }
  async #matches(row: Subscription, input: EventWebhook): Promise<boolean> {
    const { cipher, now } = this.options
    const secrets = [row.secret]
    if (row.previousSecret !== null && (row.graceUntil ?? 0) >= now()) secrets.push(row.previousSecret)
    for (const secret of secrets) {
      try {
        await verifyWebhook(await cipher.decrypt(secret, secretAad(row)), input, input.body, now())
        return true
      } catch {
        /* Try only bounded candidate secrets. */
      }
    }
    return false
  }
  async #select(input: EventWebhook): Promise<Subscription | undefined> {
    const { store, now, valid } = this.options
    const known = store.list().filter((r) => r.remoteId === input.subscriptionId)
    const candidates =
      known.length > 0
        ? known
        : store.list().filter((r) => r.status === 'pending' && r.updatedAt >= now() - 300_000 && valid(r))
    if (candidates.length === 0) return undefined
    const matches: Subscription[] = []
    for (const row of candidates) if (await this.#matches(row, input)) matches.push(row)
    if (matches.length !== 1) throw new InvalidInput({ reason: 'event signature or timestamp' })
    return matches[0]
  }
  #accept(row: Subscription, input: EventWebhook, envelope: EventEnvelope): boolean {
    if (isOccurrence(envelope))
      return row.name === envelope.name && row.status !== 'terminated' && row.remoteId !== null
    if (!input.id.startsWith(`msg_${envelope.type}_`)) throw new InvalidInput({ reason: 'event control id' })
    if (row.remoteId === null) {
      if (envelope.type !== 'verification') return false
      this.options.store.patch(row.id, { remoteId: input.subscriptionId })
    }
    return true
  }
  async receive(input: EventWebhook): Promise<EventWebhookResult> {
    const { store, now, valid, authorized, wake, persist } = this.options
    try {
      await authorized()
    } catch {
      return { status: 410 }
    }
    const tombstone = store
      .list()
      .some((r) => r.remoteId === input.subscriptionId && (r.status === 'tombstone' || !valid(r)))
    if (tombstone) return { status: 410 }
    const row = await this.#select(input)
    if (row === undefined) return { status: 503 }
    const envelope = decodeEnvelope(input.body, input.id)
    if (!this.#accept(row, input, envelope)) return { status: 503 }
    const prior = store.delivery(row.id, input.id)
    if (prior !== undefined) {
      await wake(now() + 1000)
      if (prior.challengeResponse !== null && (prior.challengeUntil ?? 0) >= now())
        return { status: 200, response: prior.challengeResponse }
      return { status: 204 }
    }
    try {
      await persist(row, input.id, input.body, envelope)
    } catch (error) {
      if (error instanceof InvalidInput && error.reason === 'events backlog full') return { status: 503 }
      throw error
    }
    const response = challengeResponse(envelope)
    return response === undefined ? { status: 204 } : { status: 200, response }
  }
}
