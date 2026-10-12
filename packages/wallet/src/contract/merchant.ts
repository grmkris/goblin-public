import * as Schema from 'effect/Schema'
import { Address, Hex, Instant, OperationId, Text, TokenAmount, UsdAmount } from './ids.ts'

/**
 * Subscriptions a merchant asks the owner to sign once (ADR 0054), and the two APIs around them. The merchant (goblin,
 * the only one) calls the merchant API server to server with its bearer key; the owner's sign page and their console
 * call the owner API with their Privy token. The owner signs an ERC-7710 delegation to the merchant's collector, which
 * the chain holds to every term; the wallet keeps the request, the signed delegation and each period's collection.
 */

/** A subscription's id: `sub_` and 32 hex characters. */
export const SubscriptionId = Schema.String.check(Schema.isPattern(/^sub_[0-9a-f]{32}$/u))
export type SubscriptionId = typeof SubscriptionId.Type

/** What a merchant may sell as a subscription: goblin Pro. */
export const MerchantPlan = Schema.Literal('pro')

/** A period of 1 to 31 days, and 1 to 24 of them. */
const PeriodDays = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 31 }))
const Periods = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 24 }))

/**
 * `POST /api/merchant/subscriptions`: so much USDC every `periodDays` days for `months` periods. `reference` is the
 * merchant's own (goblin's account); `returnUrl`, where the owner goes after signing, must be on one of the merchant's
 * allowed origins.
 */
export const SubscriptionRequest = Schema.Struct({
  plan: MerchantPlan,
  amountUsd: UsdAmount,
  periodDays: PeriodDays,
  months: Periods,
  reference: Text(200),
  returnUrl: Text(2048),
})
export type SubscriptionRequest = typeof SubscriptionRequest.Type

/** The request made: where to send the owner to sign it, until when. */
export const SubscriptionCreated = Schema.Struct({ id: SubscriptionId, signUrl: Text(2048), expiresAt: Instant })
export type SubscriptionCreated = typeof SubscriptionCreated.Type

/**
 * `pending`: not signed yet; `active`: signed, and the collector may take one payment a period; `revoked`: the owner
 * disabled the delegation; `expired`: the request ran out unsigned, or the last period ended.
 */
export const SubscriptionStatus = Schema.Literals(['pending', 'active', 'revoked', 'expired'])
export type SubscriptionStatus = typeof SubscriptionStatus.Type

/** `GET /api/merchant/subscriptions/:id`: the subscription as the merchant may see it. */
export const MerchantSubscription = Schema.Struct({
  id: SubscriptionId,
  reference: Text(200),
  status: SubscriptionStatus,
  owner: Schema.optional(Address),
  chain: Schema.Literal('base'),
  amountUsd: UsdAmount,
  periodDays: PeriodDays,
  startsAt: Schema.optional(Instant),
  expiresAt: Schema.optional(Instant),
  delegationHash: Schema.optional(Hex),
  collector: Address,
  /**
   * For an active subscription, what the owner's account on Base lacks for one payment ("0" when it covers it), so the
   * merchant can say "Add $X" before a renewal; never the balance itself. Absent when it could not be read.
   */
  shortUsd: Schema.optional(UsdAmount),
})
export type MerchantSubscription = typeof MerchantSubscription.Type

/**
 * `POST /api/merchant/subscriptions/:id/collect`: take period `period`'s payment (1-based). Idempotent per period: a
 * period paid answers its payment whatever the operation id; one in flight answers `pending`.
 */
export const CollectRequest = Schema.Struct({
  period: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 24 })),
  operationId: OperationId,
})
export type CollectRequest = typeof CollectRequest.Type

/** Why a collection did not pay; nothing moved for any of them. */
export const CollectReason = Schema.Literals(['insufficient_funds', 'revoked', 'expired', 'not_due', 'chain'])
export type CollectReason = typeof CollectReason.Type

export const Collection = Schema.Struct({
  status: Schema.Literals(['paid', 'pending', 'failed']),
  reason: Schema.optional(CollectReason),
  userOpHash: Schema.optional(Hex),
  txHash: Schema.optional(Hex),
  paidAt: Schema.optional(Instant),
})
export type Collection = typeof Collection.Type

/** The merchant API: bearer merchant key, server to server. */
export const MerchantRoutes = {
  create: {
    method: 'POST',
    path: '/api/merchant/subscriptions',
    request: SubscriptionRequest,
    response: SubscriptionCreated,
  },
  get: { method: 'GET', path: '/api/merchant/subscriptions/:id', response: MerchantSubscription },
  collect: {
    method: 'POST',
    path: '/api/merchant/subscriptions/:id/collect',
    request: CollectRequest,
    response: Collection,
  },
} as const

/** A signed ERC-7710 delegation as JSON (salt as a decimal string), for the owner's own cancellation. */
export const SignedDelegation = Schema.Struct({
  delegate: Address,
  delegator: Address,
  authority: Hex,
  caveats: Schema.Array(Schema.Struct({ enforcer: Address, terms: Hex, args: Hex })),
  salt: Schema.String.check(Schema.isPattern(/^\d{1,78}$/u)),
  signature: Hex,
})

/**
 * A subscription as its owner sees it. `merchant` and `merchantHost` say who asked (the host of the return address the
 * wallet vouched for); `returnUrl` is where the sign page goes once signed. `paidThrough` is the end of the last period
 * paid; `delegation` is the signed one, which the console rebuilds the cancellation from.
 */
export const SubscriptionView = Schema.Struct({
  id: SubscriptionId,
  merchant: Text(120),
  merchantHost: Text(253),
  plan: MerchantPlan,
  amountUsd: UsdAmount,
  periodDays: PeriodDays,
  months: Periods,
  chain: Schema.Literal('base'),
  collector: Address,
  status: SubscriptionStatus,
  returnUrl: Text(2048),
  requestExpiresAt: Instant,
  startsAt: Schema.optional(Instant),
  expiresAt: Schema.optional(Instant),
  paidThrough: Schema.optional(Instant),
  lastPaidAt: Schema.optional(Instant),
  delegation: Schema.optional(SignedDelegation),
})
export type SubscriptionView = typeof SubscriptionView.Type

/** The exact delegation to sign; the page rebuilds and compares it before the owner signs. */
export const SubscriptionDraft = Schema.Struct({ typedData: Schema.Unknown, delegationHash: Hex })
export const SubscriptionConfirm = Schema.Struct({ delegationHash: Hex, signature: Hex })

/**
 * The owner's cancellation as their own UserOperation: `disableDelegation` from their account, its gas paid in their
 * USDC. The page rebuilds the call from the signed delegation and checks the operation before the owner signs it.
 */
export const RevokeDraft = Schema.Struct({
  revokeId: Text(128),
  typedData: Schema.Unknown,
  maxFeeUsdc: TokenAmount,
  expiresAt: Instant,
})
export type RevokeDraft = typeof RevokeDraft.Type
export const RevokeConfirm = Schema.Struct({ revokeId: Text(128), signature: Hex })

/** `revoked` once the chain shows the delegation disabled; `submitted` while the operation is still in flight. */
export const RevokeResult = Schema.Struct({
  status: Schema.Literals(['revoked', 'submitted']),
  subscription: SubscriptionView,
  explorerUrl: Schema.optional(Text(2048)),
})
export type RevokeResult = typeof RevokeResult.Type

/** The owner API of subscriptions: the sign page, and the console's list with Cancel. */
export const SubscriptionRoutes = {
  view: { method: 'GET', path: '/api/subscriptions/:id', response: SubscriptionView },
  prepare: { method: 'POST', path: '/api/subscriptions/:id/prepare', response: SubscriptionDraft },
  confirm: {
    method: 'POST',
    path: '/api/subscriptions/:id/confirm',
    request: SubscriptionConfirm,
    response: SubscriptionView,
  },
  list: { method: 'GET', path: '/api/subscriptions', response: Schema.Array(SubscriptionView) },
  revokePrepare: { method: 'POST', path: '/api/subscriptions/:id/revoke/prepare', response: RevokeDraft },
  revoke: { method: 'POST', path: '/api/subscriptions/:id/revoke', request: RevokeConfirm, response: RevokeResult },
} as const
