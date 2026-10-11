import { and, asc, count, eq, gte, isNull, lt, lte, ne, or, sql } from 'drizzle-orm'
import type { DrizzleSqliteDODatabase } from 'drizzle-orm/durable-sqlite'
import { InvalidInput } from '../../http/errors.ts'
import {
  appEventConsumerReceipts as receipts,
  appEventDeliveries as deliveries,
  appMcpEventConsumers as consumers,
  appMcpEventGrants as grants,
  appMcpEventSubscriptions as subscriptions,
} from '../../storage/schema.ts'

export type Subscription = typeof subscriptions.$inferSelect
export type Consumer = typeof consumers.$inferSelect
export type Receipt = typeof receipts.$inferSelect
export type Delivery = typeof deliveries.$inferSelect
export const EVENT_LIMITS = {
  ttlMs: 3_600_000,
  minTtlMs: 300_000,
  maxTtlMs: 86_400_000,
  subscriptions: 64,
  listPages: 32,
  page: 100,
  bodyBytes: 262_144,
  timeoutMs: 15_000,
  pendingRows: 10_000,
  pendingBytes: 33_554_432,
  sweep: 256,
  retentionMs: 8 * 86_400_000,
} as const

const normalize = (input: unknown): unknown => {
  if (input === null || typeof input === 'string' || typeof input === 'boolean') return input
  if (typeof input === 'number' && Number.isFinite(input)) return input
  if (Array.isArray(input)) return input.map(normalize)
  if (typeof input === 'object' && input !== null)
    return Object.fromEntries(
      Object.entries(input)
        .toSorted(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => [k, normalize(v)]),
    )
  throw new InvalidInput({ reason: 'event arguments must be JSON' })
}

/** Canonical JSON selectors: object key order is irrelevant, array order remains meaningful. */
export function canonicalArguments(value: unknown): string {
  const encoded = JSON.stringify(normalize(value))
  if (new TextEncoder().encode(encoded).length > 16_384) throw new InvalidInput({ reason: 'event arguments too large' })
  return encoded
}

export function pendingFits(rows: number, bytes: number, incoming: number): boolean {
  return rows < EVENT_LIMITS.pendingRows && bytes + incoming <= EVENT_LIMITS.pendingBytes
}

/** Database operations are synchronous and short; callers seal bytes before beginning a transaction. */
export class SqliteEventStore {
  readonly db: DrizzleSqliteDODatabase
  constructor(db: DrizzleSqliteDODatabase) {
    this.db = db
  }

  grant(connectionId: string, name: string, argumentsJson: string, allowed: boolean, now: number): void {
    this.db
      .insert(grants)
      .values({ connectionId, name, argumentsJson, grantedAt: now, revokedAt: allowed ? null : now })
      .onConflictDoUpdate({
        target: [grants.connectionId, grants.name, grants.argumentsJson],
        set: { grantedAt: now, revokedAt: allowed ? null : now },
      })
      .run()
  }
  allows(connectionId: string, name: string, argumentsJson: string): boolean {
    return (
      this.db
        .select()
        .from(grants)
        .where(
          and(
            eq(grants.connectionId, connectionId),
            eq(grants.name, name),
            eq(grants.argumentsJson, argumentsJson),
            isNull(grants.revokedAt),
          ),
        )
        .get() !== undefined
    )
  }
  /** Every subscription not tombstoned, however many: what maintenance reconciles and what the cap counts. */
  live(): Subscription[] {
    return this.db.select().from(subscriptions).where(ne(subscriptions.status, 'tombstone')).all()
  }
  /** How many subscriptions are live, for the cap. */
  count(): number {
    return (
      this.db.select({ rows: count() }).from(subscriptions).where(ne(subscriptions.status, 'tombstone')).get()?.rows ??
      0
    )
  }
  /** The rows a producer's subscription id names, tombstones included: a delivery to a gone one is answered 410. */
  byRemote(remoteId: string): Subscription[] {
    return this.db.select().from(subscriptions).where(eq(subscriptions.remoteId, remoteId)).all()
  }
  /** Intents still waiting for their verification, touched since `since`. */
  pendingSince(since: number): Subscription[] {
    return this.db
      .select()
      .from(subscriptions)
      .where(and(eq(subscriptions.status, 'pending'), gte(subscriptions.updatedAt, since)))
      .all()
  }
  get(id: string): Subscription | undefined {
    return this.db.select().from(subscriptions).where(eq(subscriptions.id, id)).get()
  }
  selector(connectionId: string, name: string, argumentsJson: string): Subscription | undefined {
    return this.db
      .select()
      .from(subscriptions)
      .where(
        and(
          eq(subscriptions.connectionId, connectionId),
          eq(subscriptions.name, name),
          eq(subscriptions.argumentsJson, argumentsJson),
        ),
      )
      .get()
  }
  save(row: Subscription): void {
    this.db.insert(subscriptions).values(row).onConflictDoUpdate({ target: subscriptions.id, set: row }).run()
  }
  patch(id: string, patch: Partial<Subscription>): void {
    this.db.update(subscriptions).set(patch).where(eq(subscriptions.id, id)).run()
  }
  bindings(subscriptionId: string): Consumer[] {
    return this.db
      .select()
      .from(consumers)
      .where(and(eq(consumers.subscriptionId, subscriptionId), eq(consumers.state, 'active')))
      .all()
  }
  activeConsumer(consumerId: string): Consumer | undefined {
    return this.db
      .select()
      .from(consumers)
      .where(and(eq(consumers.consumerId, consumerId), eq(consumers.state, 'active')))
      .get()
  }
  consumer(consumerId: string, revision: number): Consumer | undefined {
    return this.db
      .select()
      .from(consumers)
      .where(and(eq(consumers.consumerId, consumerId), eq(consumers.revision, revision)))
      .get()
  }
  bind(row: Consumer): void {
    this.db.transaction((tx) => {
      tx.update(consumers)
        .set({ state: 'retiring', retiredAt: row.createdAt })
        .where(and(eq(consumers.consumerId, row.consumerId), eq(consumers.state, 'active')))
        .run()
      tx.insert(consumers)
        .values(row)
        .onConflictDoUpdate({ target: [consumers.consumerId, consumers.revision], set: row })
        .run()
    })
  }
  retire(consumerId: string, revision: number, now: number): void {
    this.db.transaction((tx) => {
      tx.update(consumers)
        .set({ state: 'retiring', retiredAt: now })
        .where(and(eq(consumers.consumerId, consumerId), eq(consumers.revision, revision)))
        .run()
      tx.update(receipts)
        .set({ state: 'retired', acceptedAt: now })
        .where(and(eq(receipts.consumerId, consumerId), eq(receipts.revision, revision), eq(receipts.state, 'pending')))
        .run()
    })
  }
  delivery(subscriptionId: string, webhookId: string): Delivery | undefined {
    return this.db
      .select()
      .from(deliveries)
      .where(and(eq(deliveries.subscriptionId, subscriptionId), eq(deliveries.webhookId, webhookId)))
      .get()
  }
  /** Receipt plus frozen consumer snapshot commit atomically; replay never regenerates that snapshot. */
  receive(row: typeof deliveries.$inferInsert): boolean {
    return this.db.transaction((tx) => {
      if (
        tx
          .select()
          .from(deliveries)
          .where(and(eq(deliveries.subscriptionId, row.subscriptionId), eq(deliveries.webhookId, row.webhookId)))
          .get() !== undefined
      )
        return false
      const pending = tx
        .select({ rows: count(), bytes: sql<number>`coalesce(sum(${deliveries.bytes}), 0)` })
        .from(deliveries)
        .where(isNull(deliveries.processedAt))
        .get()
      if (!pendingFits(pending?.rows ?? 0, pending?.bytes ?? 0, row.bytes))
        throw new InvalidInput({ reason: 'events backlog full' })
      tx.insert(deliveries).values(row).run()
      if (row.kind !== 'verification') {
        for (const binding of tx
          .select()
          .from(consumers)
          .where(and(eq(consumers.subscriptionId, row.subscriptionId), eq(consumers.state, 'active')))
          .all())
          tx.insert(receipts)
            .values({
              subscriptionId: row.subscriptionId,
              webhookId: row.webhookId,
              consumerId: binding.consumerId,
              revision: binding.revision,
              operationId: canonicalArguments([
                row.subscriptionId,
                row.webhookId,
                binding.consumerId,
                binding.revision,
              ]),
              state: 'pending',
            })
            .run()
      }
      return true
    })
  }
  work(now: number): Delivery[] {
    return this.db
      .select()
      .from(deliveries)
      .where(and(isNull(deliveries.processedAt), lte(deliveries.nextAttemptAt, now)))
      .orderBy(asc(deliveries.receivedAt))
      .limit(EVENT_LIMITS.sweep)
      .all()
  }
  snapshots(subscriptionId: string, webhookId: string): Receipt[] {
    return this.db
      .select()
      .from(receipts)
      .where(and(eq(receipts.subscriptionId, subscriptionId), eq(receipts.webhookId, webhookId)))
      .all()
  }
  ack(
    input: Pick<Receipt, 'subscriptionId' | 'webhookId' | 'consumerId' | 'revision' | 'operationId'>,
    now: number,
  ): void {
    this.db
      .update(receipts)
      .set({ state: 'accepted', acceptedAt: now })
      .where(
        and(
          eq(receipts.subscriptionId, input.subscriptionId),
          eq(receipts.webhookId, input.webhookId),
          eq(receipts.consumerId, input.consumerId),
          eq(receipts.revision, input.revision),
          eq(receipts.operationId, input.operationId),
          eq(receipts.state, 'pending'),
        ),
      )
      .run()
  }
  finish(subscriptionId: string, webhookId: string, now: number): boolean {
    if (this.snapshots(subscriptionId, webhookId).some((r) => r.state === 'pending')) return false
    this.db
      .update(deliveries)
      .set({ processedAt: now })
      .where(and(eq(deliveries.subscriptionId, subscriptionId), eq(deliveries.webhookId, webhookId)))
      .run()
    return true
  }
  retry(row: Delivery, now: number): void {
    this.db
      .update(deliveries)
      .set({
        attempts: row.attempts + 1,
        nextAttemptAt: now + Math.min(300_000, 1000 * 2 ** Math.min(9, row.attempts)),
      })
      .where(and(eq(deliveries.subscriptionId, row.subscriptionId), eq(deliveries.webhookId, row.webhookId)))
      .run()
  }
  /**
   * Drops processed deliveries past retention, then tombstoned subscriptions that nothing refers to any more: no
   * delivery left and no active binding, with remote cleanup done or the producer's lease lapsed (until then a
   * delivery to it is answered 410).
   */
  prune(now: number): void {
    this.db.transaction((tx) => {
      const expired = tx
        .select()
        .from(deliveries)
        .where(lte(deliveries.processedAt, now - EVENT_LIMITS.retentionMs))
        .limit(EVENT_LIMITS.sweep)
        .all()
      for (const row of expired) {
        tx.delete(receipts)
          .where(and(eq(receipts.subscriptionId, row.subscriptionId), eq(receipts.webhookId, row.webhookId)))
          .run()
        tx.delete(deliveries)
          .where(and(eq(deliveries.subscriptionId, row.subscriptionId), eq(deliveries.webhookId, row.webhookId)))
          .run()
      }
      const retired = tx
        .select({ id: subscriptions.id })
        .from(subscriptions)
        .where(
          and(
            eq(subscriptions.status, 'tombstone'),
            or(
              isNull(subscriptions.lastError),
              isNull(subscriptions.refreshBefore),
              lt(subscriptions.refreshBefore, now),
            ),
          ),
        )
        .limit(EVENT_LIMITS.sweep)
        .all()
      for (const { id } of retired) {
        const delivery = tx.select().from(deliveries).where(eq(deliveries.subscriptionId, id)).limit(1).get()
        const bound = tx
          .select()
          .from(consumers)
          .where(and(eq(consumers.subscriptionId, id), eq(consumers.state, 'active')))
          .limit(1)
          .get()
        if (delivery !== undefined || bound !== undefined) continue
        tx.delete(consumers).where(eq(consumers.subscriptionId, id)).run()
        tx.delete(subscriptions).where(eq(subscriptions.id, id)).run()
      }
    })
  }
}
