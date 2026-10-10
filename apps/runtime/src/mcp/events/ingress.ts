import * as Clock from 'effect/Clock'
import * as Effect from 'effect/Effect'
import { type AppError, InvalidInput, attemptSync } from '../../http/errors.ts'
import { reportAndRecover } from '../../observability/report.ts'
import type { CredentialCipher } from '../cipher.ts'
import { secretAad } from './client.ts'
import { challengeResponse, decodeEnvelope, isOccurrence, verifyWebhook } from './webhook.ts'
import type { EventEnvelope } from './protocol.ts'
import type { SqliteEventStore, Subscription } from './store.ts'
import type { EventWebhook, EventWebhookResult } from '../events.ts'

export type Ingress = {
  readonly store: SqliteEventStore
  readonly cipher: CredentialCipher
  readonly wake: (at: number) => Effect.Effect<void, AppError>
  /** Whether a subscription is still current: its server offered at the same endpoint, its selector granted. */
  readonly valid: (row: Subscription) => Effect.Effect<boolean, AppError>
  /** The plan and resident authority: whether the owner's agent may take events now. */
  readonly authorized: Effect.Effect<void, AppError>
  readonly persist: (
    row: Subscription,
    id: string,
    body: Uint8Array,
    envelope: EventEnvelope,
  ) => Effect.Effect<void, AppError>
}

const GONE: EventWebhookResult = { status: 410 }
const LATER: EventWebhookResult = { status: 503 }

/**
 * Whether the agent may take events now. The owner's own refusal ends the subscription (410); any other failure of the
 * check is ours and transient, so the sender retries later (503), and it is reported.
 */
const refused = (ingress: Ingress): Effect.Effect<EventWebhookResult | undefined> =>
  ingress.authorized.pipe(
    Effect.as(undefined),
    Effect.catchTags({
      SubscriptionRequired: () => Effect.succeed(GONE),
      ResidentInactive: () => Effect.succeed(GONE),
      Forbidden: () => Effect.succeed(GONE),
    }),
    reportAndRecover('mcp.events.ingress', LATER),
  )

/** Whether `input` is signed with `row`'s current secret, or its previous one within the rotation grace. */
const matches = (ingress: Ingress, row: Subscription, input: EventWebhook) =>
  Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis
    const secrets = [row.secret]
    if (row.previousSecret !== null && (row.graceUntil ?? 0) >= now) secrets.push(row.previousSecret)
    for (const secret of secrets) {
      const verified = yield* Effect.tryPromise(async () => {
        await verifyWebhook(await ingress.cipher.decrypt(secret, secretAad(row)), input, input.body, now)
      }).pipe(
        Effect.as(true),
        // expected: a secret that does not verify falls through to the next of the bounded candidates.
        Effect.catch(() => Effect.succeed(false)),
      )
      if (verified) return true
    }
    return false
  })

/** The one subscription `input` is for: a known remote id, else a recent pending intent; two matches is a refusal. */
const select = (ingress: Ingress, input: EventWebhook) =>
  Effect.gen(function* () {
    const { store } = ingress
    const now = yield* Clock.currentTimeMillis
    const known = store.list().filter((row) => row.remoteId === input.subscriptionId)
    const candidates = known.length > 0 ? known : []
    if (known.length === 0)
      for (const row of store.list())
        if (row.status === 'pending' && row.updatedAt >= now - 300_000 && (yield* ingress.valid(row)))
          candidates.push(row)
    if (candidates.length === 0) return undefined
    const matched: Subscription[] = []
    for (const row of candidates) if (yield* matches(ingress, row, input)) matched.push(row)
    if (matched.length !== 1) return yield* new InvalidInput({ reason: 'event signature or timestamp' })
    return matched[0]
  })

/** Whether the envelope is one the row takes now; a verification binds a pending intent to its remote id. */
const accepts = (ingress: Ingress, row: Subscription, input: EventWebhook, envelope: EventEnvelope) =>
  attemptSync(() => {
    if (isOccurrence(envelope))
      return row.name === envelope.name && row.status !== 'terminated' && row.remoteId !== null
    if (!input.id.startsWith(`msg_${envelope.type}_`)) throw new InvalidInput({ reason: 'event control id' })
    if (row.remoteId === null) {
      if (envelope.type !== 'verification') return false
      ingress.store.patch(row.id, { remoteId: input.subscriptionId })
    }
    return true
  })

/** Whether `input` is for a subscription that is gone: tombstoned, or no longer current. */
const ended = (ingress: Ingress, input: EventWebhook) =>
  Effect.gen(function* () {
    for (const row of ingress.store.list())
      if (row.remoteId === input.subscriptionId && (row.status === 'tombstone' || !(yield* ingress.valid(row))))
        return true
    return false
  })

/**
 * One signed webhook delivery, verified against this owner's endpoint-bound pending intents and current or previous
 * secrets, stored durably before it is answered.
 */
export const receive = (ingress: Ingress, input: EventWebhook): Effect.Effect<EventWebhookResult, AppError> =>
  Effect.gen(function* () {
    const { store } = ingress
    const refusal = yield* refused(ingress)
    if (refusal !== undefined) return refusal
    if (yield* ended(ingress, input)) return GONE
    const row = yield* select(ingress, input)
    if (row === undefined) return LATER
    const envelope = yield* attemptSync(() => decodeEnvelope(input.body, input.id))
    if (!(yield* accepts(ingress, row, input, envelope))) return LATER
    const prior = store.delivery(row.id, input.id)
    if (prior !== undefined) {
      const now = yield* Clock.currentTimeMillis
      yield* ingress.wake(now + 1000)
      if (prior.challengeResponse !== null && (prior.challengeUntil ?? 0) >= now)
        return { status: 200, response: prior.challengeResponse }
      return { status: 204 }
    }
    const full = yield* ingress.persist(row, input.id, input.body, envelope).pipe(
      Effect.as(false),
      Effect.catchTag('InvalidInput', (error) =>
        error.reason === 'events backlog full' ? Effect.succeed(true) : Effect.fail(error),
      ),
    )
    if (full) return LATER
    const response = challengeResponse(envelope)
    return response === undefined ? { status: 204 } : { status: 200, response }
  })
