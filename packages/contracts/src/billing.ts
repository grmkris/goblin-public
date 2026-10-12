import { Schema } from 'effect'

/**
 * goblin Pro paid as a signed USDC subscription in the Goblin Wallet (ADR 0054), as Settings shows it. `pending`: signed,
 * the first payment not taken yet; `grace`: a renewal failed and is retried each day until `graceUntil`; `cancelled`:
 * the owner revoked it, Pro runs to `paidThrough`; `lapsed`: the grace ran out. Times are epoch milliseconds.
 */
export const WalletPlan = Schema.Struct({
  status: Schema.Literals(['pending', 'active', 'grace', 'cancelled', 'lapsed']),
  amountUsd: Schema.String,
  periodDays: Schema.Number,
  paidThrough: Schema.NullOr(Schema.Number),
  nextPaymentAt: Schema.NullOr(Schema.Number),
  graceUntil: Schema.NullOr(Schema.Number),
  /** Where the owner manages or cancels it: the wallet's Limits page. */
  manageUrl: Schema.String,
})
export type WalletPlan = typeof WalletPlan.Type

/** The account's current allowance; checkout return URLs never prove payment. */
export const BillingState = Schema.Struct({
  active: Schema.Boolean,
  /**
   * `free`: no Pro, on the deployment's free plan (its Credits, and routines that tell you; hand-overs to goblin or a
   * Persona and subagents are Pro). `wallet`: Pro paid from the Goblin Wallet.
   */
  source: Schema.Literals(['override', 'subscription', 'wallet', 'free', 'none']),
  until: Schema.NullOr(Schema.Number),
  /** The daily model allowance in estimated Token Plan Credits (ADR 0026). */
  dailyCredits: Schema.Number,
  status: Schema.String,
  hasCustomer: Schema.Boolean,
  cancelAtPeriodEnd: Schema.Boolean,
  mode: Schema.NullOr(Schema.Literals(['test_mode', 'live_mode'])),
  plan: Schema.NullOr(Schema.Literals(['pro', 'free'])),
  priceCents: Schema.Number,
  /** Whether Pro can be paid in USDC from the Goblin Wallet on this deployment (ADR 0054). */
  walletPay: Schema.optionalKey(Schema.Boolean),
  /** Whether the card checkout is on (ADR 0015); off unless the deployment turns it on. */
  cardCheckout: Schema.optionalKey(Schema.Boolean),
  /** The account's wallet subscription, when it has had one. */
  wallet: Schema.optionalKey(WalletPlan),
})

/**
 * What confirming a signed subscription did (ADR 0054): `paid` with the first period's receipt (its transaction on
 * Base), or `pending` while the payment is still landing. Times are epoch milliseconds.
 */
export const WalletReceipt = Schema.Struct({
  status: Schema.Literals(['paid', 'pending']),
  amountUsd: Schema.String,
  periodDays: Schema.Number,
  paidFrom: Schema.NullOr(Schema.Number),
  paidThrough: Schema.NullOr(Schema.Number),
  explorerUrl: Schema.optionalKey(Schema.String),
})
export type WalletReceipt = typeof WalletReceipt.Type
export type BillingState = typeof BillingState.Type
