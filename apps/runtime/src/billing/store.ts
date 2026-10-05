/** Adapted from myapps@8a69ec64: D1 customer, subscriptions, checkout quota and leased durable webhook inbox. */
import { and, eq, gt, isNull, lt, or, sql } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/d1'
import * as Effect from 'effect/Effect'
import { Internal } from '../http/errors.ts'
import { authUsers, billingAccounts, billingInbox, checkouts, subscriptions, type Subscription } from './schema.ts'
import type { DodoMode, VerifiedEvent } from './dodo.ts'

const operation = <A>(read: () => PromiseLike<A>) =>
  Effect.tryPromise({
    try: async () => await read(),
    catch: () => new Internal({ reason: 'billing storage unavailable' }),
  })

type Database = ReturnType<typeof drizzle>

const accountStore = (db: Database) => ({
  account: (userId: string) =>
    operation(() => db.select().from(billingAccounts).where(eq(billingAccounts.userId, userId)).get()),
  contact: (userId: string) => operation(() => db.select().from(authUsers).where(eq(authUsers.id, userId)).get()),
  userOfCustomer: (customerId: string) =>
    operation(() =>
      db
        .select({ userId: billingAccounts.userId })
        .from(billingAccounts)
        .where(eq(billingAccounts.customerId, customerId))
        .get(),
    ),
})

const subscriptionStore = (db: Database) => ({
  subscriptions: (userId: string, mode: DodoMode) =>
    operation(() =>
      db
        .select()
        .from(subscriptions)
        .where(and(eq(subscriptions.userId, userId), eq(subscriptions.mode, mode)))
        .limit(50)
        .all(),
    ),
  subscription: (id: string) => operation(() => db.select().from(subscriptions).where(eq(subscriptions.id, id)).get()),
  writeSubscription: (row: Subscription) =>
    operation(async () => {
      // The provider version check and customer update share a short D1 batch; no provider I/O happens here.
      await db.batch([
        db
          .insert(subscriptions)
          .values(row)
          .onConflictDoUpdate({
            target: subscriptions.id,
            set: {
              customerId: row.customerId,
              productId: row.productId,
              status: row.status,
              periodEnd: row.periodEnd,
              pastDueEndsAt: row.pastDueEndsAt,
              cancelAtPeriodEnd: row.cancelAtPeriodEnd,
              providerUpdatedAt: row.providerUpdatedAt,
              updatedAt: row.updatedAt,
            },
            where: sql`${subscriptions.userId} = ${row.userId} AND ${subscriptions.mode} = ${row.mode} AND ${subscriptions.providerUpdatedAt} <= ${row.providerUpdatedAt}`,
          }),
        db
          .insert(billingAccounts)
          .values({ userId: row.userId, createdAt: row.updatedAt, updatedAt: row.updatedAt })
          .onConflictDoNothing(),
        db
          .update(billingAccounts)
          .set({ customerId: row.customerId, updatedAt: row.updatedAt })
          .where(
            and(
              eq(billingAccounts.userId, row.userId),
              sql`EXISTS (SELECT 1 FROM app_billing_subscriptions WHERE id = ${row.id} AND user_id = ${row.userId} AND provider_updated_at = ${row.providerUpdatedAt} AND customer_id = ${row.customerId})`,
            ),
          ),
      ])
    }),
})

const checkoutStore = (db: Database) => ({
  checkoutCount: (userId: string, since: number) =>
    operation(() =>
      db
        .select({ count: sql<number>`count(*)` })
        .from(checkouts)
        .where(and(eq(checkouts.userId, userId), gt(checkouts.createdAt, since)))
        .get(),
    ).pipe(Effect.map((row) => row?.count ?? 0)),
  recordCheckout: (id: string, userId: string, now: number) =>
    operation(() => db.insert(checkouts).values({ id, userId, createdAt: now }).run()),
})

const inboxStore = (db: Database) => ({
  insertEvent: (event: VerifiedEvent, mode: DodoMode, now: number) =>
    operation(() =>
      db
        .insert(billingInbox)
        .values({
          id: event.id,
          mode,
          type: event.type,
          occurredAt: event.timestamp,
          receivedAt: now,
          payload: event.body,
          state: 'pending',
          attempts: 0,
        })
        .onConflictDoNothing()
        .run(),
    ),
  inbox: (id: string) => operation(() => db.select().from(billingInbox).where(eq(billingInbox.id, id)).get()),
  claim: (id: string, now: number, token: string) =>
    operation(() =>
      db
        .update(billingInbox)
        .set({ attempts: sql`${billingInbox.attempts} + 1`, leaseUntil: now + 60_000, leaseToken: token })
        .where(
          and(
            eq(billingInbox.id, id),
            or(eq(billingInbox.state, 'pending'), eq(billingInbox.state, 'failed'), eq(billingInbox.state, 'orphaned')),
            or(isNull(billingInbox.leaseUntil), lt(billingInbox.leaseUntil, now)),
            lt(billingInbox.attempts, 10),
          ),
        )
        .returning()
        .get(),
    ),
})

const inboxProgress = (db: Database) => ({
  finish: (id: string, token: string, state: 'processed' | 'ignored' | 'orphaned' | 'failed') =>
    operation(() =>
      db
        .update(billingInbox)
        .set({ state, leaseUntil: null, leaseToken: null })
        .where(and(eq(billingInbox.id, id), eq(billingInbox.leaseToken, token)))
        .run(),
    ),
  retryable: (mode: DodoMode, now: number) =>
    operation(() =>
      db
        .select()
        .from(billingInbox)
        .where(
          and(
            eq(billingInbox.mode, mode),
            lt(billingInbox.attempts, 10),
            or(eq(billingInbox.state, 'pending'), eq(billingInbox.state, 'failed'), eq(billingInbox.state, 'orphaned')),
            or(isNull(billingInbox.leaseUntil), lt(billingInbox.leaseUntil, now)),
          ),
        )
        .limit(50)
        .all(),
    ),
  dueSubscriptions: (mode: DodoMode, now: number) =>
    operation(() =>
      db
        .select()
        .from(subscriptions)
        .where(and(eq(subscriptions.mode, mode), lt(subscriptions.updatedAt, now - 3_600_000)))
        .orderBy(subscriptions.updatedAt)
        .limit(100)
        .all(),
    ),
  prune: (now: number) =>
    operation(async () => {
      await db.batch([
        db
          .update(billingInbox)
          .set({ payload: null })
          .where(
            and(
              lt(billingInbox.receivedAt, now - 30 * 86_400_000),
              or(eq(billingInbox.state, 'processed'), eq(billingInbox.state, 'ignored')),
            ),
          ),
        db.delete(checkouts).where(lt(checkouts.createdAt, now - 86_400_000)),
      ])
    }),
})

export const makeBillingStore = (database: D1Database) => {
  const db = drizzle(database)
  return {
    ...accountStore(db),
    ...subscriptionStore(db),
    ...checkoutStore(db),
    ...inboxStore(db),
    ...inboxProgress(db),
  }
}
export type BillingStore = ReturnType<typeof makeBillingStore>
