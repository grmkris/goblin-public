import { Schema } from 'effect'

/** The account's current allowance; checkout return URLs never prove payment. */
export const BillingState = Schema.Struct({
  active: Schema.Boolean,
  /** `free`: no Pro, on the deployment's free plan (its Credits, no routines). */
  source: Schema.Literals(['override', 'subscription', 'free', 'none']),
  until: Schema.NullOr(Schema.Number),
  /** The daily model allowance in estimated Token Plan Credits (ADR 0026). */
  dailyCredits: Schema.Number,
  status: Schema.String,
  hasCustomer: Schema.Boolean,
  cancelAtPeriodEnd: Schema.Boolean,
  mode: Schema.NullOr(Schema.Literals(['test_mode', 'live_mode'])),
  plan: Schema.NullOr(Schema.Literals(['pro', 'free'])),
  priceCents: Schema.Number,
})
export type BillingState = typeof BillingState.Type
