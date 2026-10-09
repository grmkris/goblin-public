/** Adapted from myapps@8a69ec64: durable webhook-id ledger, lease ownership, stale provider guards and refunds. */
import { Clock, Effect, Option, Predicate, Random, Schema } from 'effect'
import { Internal } from '../http/errors.ts'
import { reportAndRecover } from '../observability/report.ts'
import type { DodoApi, VerifiedEvent } from './dodo.ts'
import type { Subscription } from './schema.ts'
import type { BillingStore } from './store.ts'

export interface BillingDeps {
  readonly store: BillingStore
  readonly dodo: DodoApi
  readonly productId: string
}
type Outcome = 'processed' | 'ignored' | 'orphaned'
const str = (value: unknown): string | null => (Predicate.isString(value) && value !== '' ? value : null)
const record = (value: unknown): Record<string, unknown> =>
  Predicate.isObject(value) && !Array.isArray(value) ? Object.fromEntries(Object.entries(value)) : {}
const instant = (value: unknown): number | null => {
  const text = str(value)
  if (text === null) return null
  const ms = Date.parse(text)
  return Number.isFinite(ms) ? ms : null
}
const dateField = (data: Record<string, unknown>, key: string, previous: number | null): number | null =>
  key in data ? instant(data[key]) : previous
const merged = (
  existing: Subscription | undefined,
  data: Record<string, unknown>,
  base: Pick<Subscription, 'id' | 'userId' | 'mode' | 'customerId' | 'productId' | 'providerUpdatedAt' | 'updatedAt'>,
): Subscription => {
  const status = str(data['status']) ?? existing?.status ?? 'pending'
  const grace = status === 'past_due' || status === 'on_hold'
  const cancel = data['cancel_at_next_billing_date']
  return {
    ...base,
    status,
    periodEnd: dateField(data, 'next_billing_date', existing?.periodEnd ?? null),
    pastDueEndsAt: grace ? dateField(data, 'past_due_ends_at', existing?.pastDueEndsAt ?? null) : null,
    cancelAtPeriodEnd: Predicate.isBoolean(cancel) ? Number(cancel) : (existing?.cancelAtPeriodEnd ?? 0),
  }
}
const accountOf = Effect.fn('billing.accountOf')(function* (
  deps: BillingDeps,
  data: Record<string, unknown>,
  existing: Subscription | undefined,
  customerId: string,
) {
  if (existing !== undefined) return existing.userId
  const metadataUser = str(record(data['metadata'])['userId'])
  if (metadataUser !== null && (yield* deps.store.contact(metadataUser)) !== undefined) return metadataUser
  return (yield* deps.store.userOfCustomer(customerId))?.userId ?? null
})

export const upsertSubscription = Effect.fn('billing.upsertSubscription')(function* (
  deps: BillingDeps,
  data: Record<string, unknown>,
  asOf: number,
) {
  const id = str(data['subscription_id'])
  const productId = str(data['product_id'])
  if (id === null || productId === null || productId !== deps.productId) return 'ignored' as const
  const existing = yield* deps.store.subscription(id)
  if (existing !== undefined && existing.mode !== deps.dodo.mode) return 'ignored' as const
  const customerId = str(record(data['customer'])['customer_id']) ?? existing?.customerId ?? null
  if (customerId === null) return yield* new Internal({ reason: 'subscription has no customer' })
  const userId = yield* accountOf(deps, data, existing, customerId)
  if (userId === null) return 'orphaned' as const
  if (existing !== undefined && existing.providerUpdatedAt > asOf) return 'processed' as const
  const row = merged(existing, data, {
    id,
    userId,
    mode: deps.dodo.mode,
    customerId,
    productId,
    providerUpdatedAt: asOf,
    updatedAt: yield* Clock.currentTimeMillis,
  })
  yield* deps.store.writeSubscription(row)
  return 'processed' as const
})
const applyEvent = Effect.fn('billing.applyEvent')(function* (
  deps: BillingDeps,
  event: VerifiedEvent,
): Effect.fn.Return<Outcome, Internal | import('./dodo.ts').DodoError> {
  if (event.type.startsWith('subscription.'))
    return yield* upsertSubscription(deps, Object.fromEntries(Object.entries(event.data)), event.timestamp)
  if (event.type.startsWith('refund.') || event.type.startsWith('dispute.')) {
    const paymentId = str(event.data['payment_id'])
    if (paymentId === null) return 'ignored'
    const id = yield* deps.dodo.paymentSubscriptionId(paymentId)
    if (id === null || (yield* deps.store.subscription(id)) === undefined) return 'ignored'
    const fresh = yield* deps.dodo.getSubscription(id)
    return yield* upsertSubscription(deps, fresh, yield* Clock.currentTimeMillis)
  }
  return 'ignored'
})
const StoredBody = Schema.Struct({ data: Schema.Record(Schema.String, Schema.Unknown) })
const decodeBody = Schema.decodeUnknownOption(Schema.fromJsonString(StoredBody))

/** Work always comes from the persisted first body; a same-id redelivery cannot replace pending data. */
export const processStored = Effect.fn('billing.processStored')(function* (deps: BillingDeps, id: string) {
  const token = [yield* Random.nextInt, yield* Random.nextInt, yield* Random.nextInt, yield* Random.nextInt].join('-')
  const row = yield* deps.store.claim(id, yield* Clock.currentTimeMillis, token)
  if (row === undefined) return 'duplicate' as const
  const decoded = decodeBody(row.payload ?? '')
  if (Option.isNone(decoded) || row.mode !== deps.dodo.mode) {
    yield* deps.store.finish(id, token, 'ignored')
    return 'ignored' as const
  }
  const event = { id, type: row.type, timestamp: row.occurredAt, data: decoded.value.data, body: row.payload ?? '' }
  const outcome = yield* applyEvent(deps, event).pipe(reportAndRecover('billing.processStored', 'failed' as const))
  yield* deps.store.finish(id, token, outcome)
  return outcome
})
