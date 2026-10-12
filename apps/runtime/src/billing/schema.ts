import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'

/** Application tables in auth D1; Better Auth continues to own its own tables. */
export const billingAccounts = sqliteTable('app_billing_accounts', {
  userId: text('user_id').primaryKey().notNull(),
  customerId: text('customer_id'),
  planOverride: text('plan_override', { enum: ['pro'] }),
  overrideStage: text('override_stage'),
  /** Retired by `daily_credits` (migration 0010); kept, unread. */
  dailyTokens: integer('daily_tokens'),
  /** An operator's daily allowance for this account, in estimated Token Plan Credits; unset, the plan's applies. */
  dailyCredits: integer('daily_credits'),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
})
export const subscriptions = sqliteTable('app_billing_subscriptions', {
  id: text('id').primaryKey().notNull(),
  userId: text('user_id').notNull(),
  mode: text('mode').notNull(),
  customerId: text('customer_id').notNull(),
  productId: text('product_id').notNull(),
  status: text('status').notNull(),
  periodEnd: integer('period_end'),
  pastDueEndsAt: integer('past_due_ends_at'),
  cancelAtPeriodEnd: integer('cancel_at_period_end').notNull(),
  providerUpdatedAt: integer('provider_updated_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
})
export const billingInbox = sqliteTable('app_billing_inbox', {
  id: text('id').primaryKey().notNull(),
  mode: text('mode').notNull(),
  type: text('type').notNull(),
  occurredAt: integer('occurred_at').notNull(),
  receivedAt: integer('received_at').notNull(),
  payload: text('payload'),
  state: text('state', { enum: ['pending', 'processed', 'ignored', 'orphaned', 'failed'] }).notNull(),
  attempts: integer('attempts').notNull(),
  leaseUntil: integer('lease_until'),
  leaseToken: text('lease_token'),
})
export const checkouts = sqliteTable('app_billing_checkouts', {
  id: text('id').primaryKey().notNull(),
  userId: text('user_id').notNull(),
  createdAt: integer('created_at').notNull(),
})
/**
 * goblin Pro paid as a signed USDC subscription (ADR 0054): the account's subscription in the Goblin Wallet and its
 * renewals. `period` is the last period paid (0 before the first), `paid_through` its end; a failed collection sets
 * `grace_until` and the cron tries again each day until then. Times are epoch milliseconds.
 */
export const walletSubscriptions = sqliteTable('app_billing_wallet_subscriptions', {
  userId: text('user_id').primaryKey().notNull(),
  subscriptionId: text('subscription_id').notNull(),
  status: text('status', { enum: ['pending', 'active', 'grace', 'cancelled', 'lapsed'] }).notNull(),
  amountUsd: text('amount_usd').notNull(),
  periodDays: integer('period_days').notNull(),
  startsAt: integer('starts_at').notNull(),
  period: integer('period').notNull(),
  paidThrough: integer('paid_through'),
  nextAttemptAt: integer('next_attempt_at'),
  graceUntil: integer('grace_until'),
  remindedPeriod: integer('reminded_period').notNull(),
  lastOperation: text('last_operation'),
  lastTx: text('last_tx'),
  lastFailure: text('last_failure'),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
})
/** Read-only projection of Better Auth's contact fields. */
export const authUsers = sqliteTable('user', {
  id: text('id').primaryKey(),
  email: text('email').notNull(),
  name: text('name').notNull(),
})
export type BillingAccount = typeof billingAccounts.$inferSelect
export type Subscription = typeof subscriptions.$inferSelect
export type WalletSubscription = typeof walletSubscriptions.$inferSelect
