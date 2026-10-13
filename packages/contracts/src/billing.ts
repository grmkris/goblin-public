import { Schema } from 'effect'

/**
 * How goblin Pro is paid from the Goblin Wallet (ADR 0054): `day`, a day pass taken on each UTC day the owner uses
 * goblin, or `month`, every 30 days. Both are the same plan; the deployment sets their prices (`GOBLIN_PLAN_CATALOG`).
 */
export const BillingId = Schema.Literals(['day', 'month'])
export type BillingId = typeof BillingId.Type

/** A way to pay for Pro as this deployment sells it: so much USDC every `periodDays` days, with Pro's daily Credits. */
export const PlanOffer = Schema.Struct({
  id: BillingId,
  /** A decimal string of US dollars, as the owner signs it: `"1.00"`. */
  amountUsd: Schema.String,
  periodDays: Schema.Number,
  /** The daily model allowance in estimated Token Plan Credits (ADR 0026). */
  dailyCredits: Schema.Number,
})
export type PlanOffer = typeof PlanOffer.Type

/** A way to pay for Pro as `/health` tells anyone, signed in or not: the prices a landing page shows. */
export const PublicPlan = Schema.Struct({ id: BillingId, amountUsd: Schema.String, periodDays: Schema.Number })
export type PublicPlan = typeof PublicPlan.Type

/** A price as the setting takes it: 0.01 to 999.99 US dollars, with two decimals. */
const SettingUsd = Schema.String.check(Schema.isPattern(/^(?:[1-9]\d{0,2}\.\d{2}|0\.(?:0[1-9]|[1-9]\d))$/u))

/** 0 to 10,000 Credits a day. */
const SettingCredits = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 10_000 }))

/**
 * `GOBLIN_PLAN_CATALOG`, the deployment's prices (ADR 0054): JSON with `day` and `month`, each optional, each giving any
 * of `amountUsd`, `periodDays` and `dailyCredits`; what it leaves out keeps the default in code. The day pass's period
 * is one day; monthly's is 1 to 30 days. Deploying with a setting that does not decode fails.
 */
export const PlanCatalogSetting = Schema.Struct({
  day: Schema.optionalKey(
    Schema.Struct({
      amountUsd: Schema.optionalKey(SettingUsd),
      periodDays: Schema.optionalKey(Schema.Literal(1)),
      dailyCredits: Schema.optionalKey(SettingCredits),
    }),
  ),
  month: Schema.optionalKey(
    Schema.Struct({
      amountUsd: Schema.optionalKey(SettingUsd),
      periodDays: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 30 }))),
      dailyCredits: Schema.optionalKey(SettingCredits),
    }),
  ),
})
export type PlanCatalogSetting = typeof PlanCatalogSetting.Type

/**
 * goblin Pro paid as a signed USDC subscription in the Goblin Wallet (ADR 0054), as Settings shows it. `pending`: signed,
 * the first payment not taken yet; `grace`: a monthly renewal failed and is retried each day until `graceUntil`;
 * `cancelled`: the owner revoked it, Pro runs to `paidThrough`; `lapsed`: a monthly grace ran out, or a day pass could
 * not take a day's payment (the owner adds funds, then confirms it again). Times are epoch milliseconds.
 *
 * For a day pass, `paidThrough` is the end of the last UTC day paid (null before the first use) and `nextPaymentAt` is
 * null: the first message of each day pays for it.
 */
export const WalletPlan = Schema.Struct({
  /** The subscription's id in the wallet (`sub_…`): what `walletConfirm` takes. */
  subscription: Schema.String,
  billing: BillingId,
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
  /** True only with a plan: an operator's override, a card subscription or one paid from the Goblin Wallet. */
  active: Schema.Boolean,
  /** `wallet`: Pro paid from the Goblin Wallet; `none`: no plan, so goblin does not answer. */
  source: Schema.Literals(['override', 'subscription', 'wallet', 'none']),
  until: Schema.NullOr(Schema.Number),
  /** The daily model allowance in estimated Token Plan Credits (ADR 0026). */
  dailyCredits: Schema.Number,
  status: Schema.String,
  hasCustomer: Schema.Boolean,
  cancelAtPeriodEnd: Schema.Boolean,
  mode: Schema.NullOr(Schema.Literals(['test_mode', 'live_mode'])),
  /** The plan: goblin Pro, however it is paid; null without one. */
  plan: Schema.NullOr(Schema.Literal('pro')),
  /** The ways to pay for Pro on this deployment, with their prices: the day pass first. */
  catalog: Schema.Array(PlanOffer),
  /** Whether Pro can be paid in USDC from the Goblin Wallet on this deployment (ADR 0054). */
  walletPay: Schema.optionalKey(Schema.Boolean),
  /** Whether the card checkout is on (ADR 0015); off unless the deployment turns it on. */
  cardCheckout: Schema.optionalKey(Schema.Boolean),
  /** The account's wallet subscription, when it has had one: the one its plan comes from, else its latest. */
  wallet: Schema.optionalKey(WalletPlan),
})

/**
 * What confirming a signed subscription did (ADR 0054). `paid`: the plan is on. For a monthly one with the first
 * period's receipt (its transaction on Base); for a day pass nothing is taken yet (`paidFrom` and `paidThrough` null),
 * the first message of each UTC day pays for that day, and after a day it could not pay, confirming takes that day's
 * payment. `pending`: the payment is still landing. Times are epoch milliseconds.
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
