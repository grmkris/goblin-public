import type { SubscriptionStatus } from '@goblin/wallet/contract'
import type { Sql } from '../ledger/sql.ts'

/**
 * Subscriptions a merchant asked an owner to sign (ADR 0054), in the `WalletAuth` singleton beside OAuth: a request is
 * made before anyone signs it, so it cannot live in an owner's ledger, and the merchant finds it by id alone. The first
 * signed-in owner to open a request is bound to it, as a consent request is. Each period's collection is one row,
 * keyed by the subscription and the period, so a period is paid at most once whatever operation ids the merchant sends;
 * the chain enforces the same cap by itself. Times are epoch seconds; every method is one short transaction.
 */

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS merchant_subscriptions (
    id TEXT PRIMARY KEY, merchant TEXT NOT NULL, reference TEXT NOT NULL, plan TEXT NOT NULL,
    amount_usd TEXT NOT NULL, period_days INTEGER NOT NULL, months INTEGER NOT NULL, return_url TEXT NOT NULL,
    collector TEXT NOT NULL, chain TEXT NOT NULL, status TEXT NOT NULL, owner TEXT, owner_address TEXT,
    prepared_json TEXT, signed_json TEXT, delegation_hash TEXT, starts_at INTEGER, expires_at INTEGER,
    request_expires_at INTEGER NOT NULL, created_at INTEGER NOT NULL, signed_at INTEGER, revoked_at INTEGER,
    revoke_json TEXT)`,
  `CREATE INDEX IF NOT EXISTS merchant_subscriptions_owner ON merchant_subscriptions (owner)`,
  `CREATE TABLE IF NOT EXISTS merchant_collections (
    subscription_id TEXT NOT NULL, period INTEGER NOT NULL, operation_id TEXT NOT NULL, status TEXT NOT NULL,
    reason TEXT, user_op_hash TEXT, tx_hash TEXT, attempts INTEGER NOT NULL, lease_until INTEGER,
    paid_at INTEGER, updated_at INTEGER NOT NULL, PRIMARY KEY (subscription_id, period))`,
]

/** How long a request can be signed before the merchant asks again. */
export const REQUEST_TTL_S = 3600
/** How long one collection attempt holds its period: the send and its receipt wait. */
const COLLECT_LEASE_S = 180
/** A submitted collection whose receipt never came is tried again after this; the chain refuses a second payment. */
const PENDING_STALE_S = 900

/** A subscription as the store keeps it. `status` is as written; `statusAt` says whether it has run out. */
export interface SubscriptionRow {
  readonly id: string
  readonly merchant: string
  readonly reference: string
  readonly plan: 'pro'
  readonly amountUsd: string
  readonly periodDays: number
  readonly months: number
  readonly returnUrl: string
  readonly collector: string
  readonly chain: 'base'
  readonly status: 'pending' | 'active' | 'revoked'
  readonly owner: string | null
  readonly ownerAddress: string | null
  readonly preparedJson: string | null
  readonly signedJson: string | null
  readonly delegationHash: string | null
  readonly startsAt: number | null
  readonly expiresAt: number | null
  readonly requestExpiresAt: number
  readonly createdAt: number
  readonly revokeJson: string | null
  /** The last period paid, and when; 0 and null before the first. */
  readonly paidPeriods: number
  readonly lastPaidAt: number | null
}

interface Row {
  id: string
  merchant: string
  reference: string
  plan: string
  amount_usd: string
  period_days: number
  months: number
  return_url: string
  collector: string
  chain: string
  status: string
  owner: string | null
  owner_address: string | null
  prepared_json: string | null
  signed_json: string | null
  delegation_hash: string | null
  starts_at: number | null
  expires_at: number | null
  request_expires_at: number
  created_at: number
  revoke_json: string | null
  paid_periods: number | null
  last_paid_at: number | null
}

const SELECT = `SELECT s.*,
  (SELECT MAX(period) FROM merchant_collections c WHERE c.subscription_id=s.id AND c.status='paid') paid_periods,
  (SELECT MAX(paid_at) FROM merchant_collections c WHERE c.subscription_id=s.id AND c.status='paid') last_paid_at
  FROM merchant_subscriptions s`

const rowOf = (row: Row): SubscriptionRow => ({
  id: row.id,
  merchant: row.merchant,
  reference: row.reference,
  plan: 'pro',
  amountUsd: row.amount_usd,
  periodDays: row.period_days,
  months: row.months,
  returnUrl: row.return_url,
  collector: row.collector,
  chain: 'base',
  status: row.status === 'active' || row.status === 'revoked' ? row.status : 'pending',
  owner: row.owner,
  ownerAddress: row.owner_address,
  preparedJson: row.prepared_json,
  signedJson: row.signed_json,
  delegationHash: row.delegation_hash,
  startsAt: row.starts_at,
  expiresAt: row.expires_at,
  requestExpiresAt: row.request_expires_at,
  createdAt: row.created_at,
  revokeJson: row.revoke_json,
  paidPeriods: row.paid_periods ?? 0,
  lastPaidAt: row.last_paid_at,
})

/** The status a merchant and the owner see at `now`: a request or a subscription that ran out is `expired`. */
export const statusAt = (row: SubscriptionRow, now: number): SubscriptionStatus => {
  if (row.status === 'pending') return row.requestExpiresAt <= now ? 'expired' : 'pending'
  if (row.status === 'active' && row.expiresAt !== null && row.expiresAt <= now) return 'expired'
  return row.status
}

/** The request is bound to another owner: the first one who opened it signed in. */
export const OTHER_OWNER = 'other_owner'

export interface NewSubscription {
  readonly id: string
  readonly merchant: string
  readonly reference: string
  readonly amountUsd: string
  readonly periodDays: number
  readonly months: number
  readonly returnUrl: string
  readonly collector: string
  readonly now: number
}

export interface Activation {
  readonly id: string
  readonly owner: string
  readonly ownerAddress: string
  readonly signedJson: string
  readonly delegationHash: string
  readonly startsAt: number
  readonly expiresAt: number
  readonly now: number
}

/** What a collection attempt may do for its period. */
export type CollectionStart =
  | { readonly kind: 'paid'; readonly txHash: string | null; readonly userOpHash: string | null; readonly at: number }
  /** Another attempt holds the period right now. */
  | { readonly kind: 'busy' }
  /** An earlier attempt was submitted and its outcome is not known yet: ask the bundler about `userOpHash`. */
  | { readonly kind: 'check'; readonly userOpHash: string }
  /** Go ahead: this attempt holds the period for a while; `attempt` numbers its signer key. */
  | { readonly kind: 'go'; readonly attempt: number }

export interface CollectionOutcome {
  readonly subscriptionId: string
  readonly period: number
  readonly status: 'pending' | 'paid' | 'failed'
  readonly reason?: string | undefined
  readonly userOpHash?: string | undefined
  readonly txHash?: string | undefined
  readonly now: number
}

export class SubscriptionStore {
  readonly #sql: Sql

  constructor(sql: Sql) {
    this.#sql = sql
    for (const statement of SCHEMA) sql.run(statement)
  }

  createSubscription(input: NewSubscription): void {
    this.#sql.run(
      `INSERT INTO merchant_subscriptions (id,merchant,reference,plan,amount_usd,period_days,months,return_url,
        collector,chain,status,request_expires_at,created_at) VALUES (?,?,?,'pro',?,?,?,?,?,'base','pending',?,?)`,
      input.id,
      input.merchant,
      input.reference,
      input.amountUsd,
      input.periodDays,
      input.months,
      input.returnUrl,
      input.collector,
      input.now + REQUEST_TTL_S,
      input.now,
    )
  }

  #row(id: string): SubscriptionRow | undefined {
    const row = this.#sql.all<Row>(`${SELECT} WHERE s.id=?`, id)[0]
    return row === undefined ? undefined : rowOf(row)
  }

  /** The merchant's own subscription; another merchant's is not found. */
  merchantSubscription(id: string, merchant: string): SubscriptionRow | undefined {
    const row = this.#row(id)
    return row?.merchant === merchant ? row : undefined
  }

  /** Any subscription by id, for the collector, which the merchant route has already matched. */
  subscription(id: string): SubscriptionRow | undefined {
    return this.#row(id)
  }

  /**
   * A subscription as its owner's page reads it. The first signed-in owner to read a pending request while it is open
   * is bound to it, and any other owner is refused from then on.
   */
  viewSubscription(id: string, owner: string, now: number): SubscriptionRow | typeof OTHER_OWNER | undefined {
    return this.#sql.atomic(() => {
      const row = this.#row(id)
      if (row === undefined) return undefined
      if (row.owner !== null && row.owner !== owner) return OTHER_OWNER
      if (row.owner === null && row.status === 'pending' && row.requestExpiresAt > now) {
        this.#sql.run('UPDATE merchant_subscriptions SET owner=? WHERE id=? AND owner IS NULL', owner, id)
        return { ...row, owner }
      }
      return row.owner === owner ? row : undefined
    })
  }

  /** Keeps the delegation prepared for the owner of a pending request; false when it is not theirs or not open. */
  putPrepared(id: string, owner: string, preparedJson: string, now: number): boolean {
    return (
      this.#sql.all<{ id: string }>(
        `UPDATE merchant_subscriptions SET prepared_json=? WHERE id=? AND owner=? AND status='pending'
          AND request_expires_at>? RETURNING id`,
        preparedJson,
        id,
        owner,
        now,
      ).length > 0
    )
  }

  /** The signed delegation: the subscription is active from its first period. False unless it was pending and open. */
  activate(input: Activation): boolean {
    return (
      this.#sql.all<{ id: string }>(
        `UPDATE merchant_subscriptions SET status='active', owner_address=?, signed_json=?, delegation_hash=?,
          starts_at=?, expires_at=?, signed_at=?, prepared_json=NULL
          WHERE id=? AND owner=? AND status='pending' AND request_expires_at>? RETURNING id`,
        input.ownerAddress,
        input.signedJson,
        input.delegationHash,
        input.startsAt,
        input.expiresAt,
        input.now,
        input.id,
        input.owner,
        input.now,
      ).length > 0
    )
  }

  /** The owner's signed subscriptions, newest first; requests never signed are left out. */
  ownerSubscriptions(owner: string): SubscriptionRow[] {
    return this.#sql
      .all<Row>(`${SELECT} WHERE s.owner=? AND s.status IN ('active','revoked') ORDER BY s.created_at DESC`, owner)
      .map(rowOf)
  }

  /** Keeps the owner's prepared cancellation (a UserOperation to sign) on their active subscription. */
  putRevoke(id: string, owner: string, revokeJson: string): boolean {
    return (
      this.#sql.all<{ id: string }>(
        `UPDATE merchant_subscriptions SET revoke_json=? WHERE id=? AND owner=? AND status='active' RETURNING id`,
        revokeJson,
        id,
        owner,
      ).length > 0
    )
  }

  /** The chain shows the delegation disabled: nothing is collected from it again. */
  markRevoked(id: string, now: number): void {
    this.#sql.run(
      `UPDATE merchant_subscriptions SET status='revoked', revoked_at=COALESCE(revoked_at,?), revoke_json=NULL
        WHERE id=? AND status='active'`,
      now,
      id,
    )
  }

  /**
   * Claims period `period` for one collection attempt. A paid period answers its payment; one another attempt holds is
   * busy; one submitted recently is checked against the bundler; anything else (new, failed, or submitted long ago
   * without a receipt) is this attempt's for `COLLECT_LEASE_S`.
   */
  beginCollection(input: {
    subscriptionId: string
    period: number
    operationId: string
    now: number
  }): CollectionStart {
    return this.#sql.atomic(() => {
      const row = this.#sql.all<{
        status: string
        attempts: number
        lease_until: number | null
        user_op_hash: string | null
        tx_hash: string | null
        paid_at: number | null
        updated_at: number
      }>(
        `SELECT status,attempts,lease_until,user_op_hash,tx_hash,paid_at,updated_at FROM merchant_collections
          WHERE subscription_id=? AND period=?`,
        input.subscriptionId,
        input.period,
      )[0]
      if (row?.status === 'paid')
        return { kind: 'paid', txHash: row.tx_hash, userOpHash: row.user_op_hash, at: row.paid_at ?? row.updated_at }
      if (row?.status === 'sending' && (row.lease_until ?? 0) > input.now) return { kind: 'busy' }
      if (row?.status === 'pending' && row.user_op_hash !== null && input.now - row.updated_at < PENDING_STALE_S)
        return { kind: 'check', userOpHash: row.user_op_hash }
      const attempt = (row?.attempts ?? 0) + 1
      this.#sql.run(
        `INSERT INTO merchant_collections (subscription_id,period,operation_id,status,attempts,lease_until,updated_at)
          VALUES (?,?,?,'sending',?,?,?) ON CONFLICT (subscription_id,period) DO UPDATE SET
          operation_id=excluded.operation_id, status='sending', reason=NULL, attempts=excluded.attempts,
          lease_until=excluded.lease_until, updated_at=excluded.updated_at`,
        input.subscriptionId,
        input.period,
        input.operationId,
        attempt,
        input.now + COLLECT_LEASE_S,
        input.now,
      )
      return { kind: 'go', attempt }
    })
  }

  /** Records how an attempt ended: submitted (its hash), paid (its transaction), or failed with nothing moved. */
  finishCollection(outcome: CollectionOutcome): void {
    this.#sql.run(
      `UPDATE merchant_collections SET status=?, reason=?, user_op_hash=COALESCE(?,user_op_hash),
        tx_hash=COALESCE(?,tx_hash), paid_at=?, lease_until=NULL, updated_at=?
        WHERE subscription_id=? AND period=? AND status<>'paid'`,
      outcome.status,
      outcome.reason ?? null,
      outcome.userOpHash ?? null,
      outcome.txHash ?? null,
      outcome.status === 'paid' ? outcome.now : null,
      outcome.now,
      outcome.subscriptionId,
      outcome.period,
    )
  }
}
