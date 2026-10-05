import { Schema } from 'effect'

/** The account's current allowance; checkout return URLs never prove payment. */
export const BillingState = Schema.Struct({
  active: Schema.Boolean,
  source: Schema.Literals(['override', 'subscription', 'none']),
  until: Schema.NullOr(Schema.Number),
  dailyTokens: Schema.Number,
  status: Schema.String,
  hasCustomer: Schema.Boolean,
  cancelAtPeriodEnd: Schema.Boolean,
  mode: Schema.NullOr(Schema.Literals(['test_mode', 'live_mode'])),
  plan: Schema.NullOr(Schema.Literal('pro')),
  priceCents: Schema.Number,
})
export type BillingState = typeof BillingState.Type
