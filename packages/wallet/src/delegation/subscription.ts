/**
 * A subscription the owner signs once (ADR 0054): one ERC-7710 delegation from the owner's 7702-upgraded account to a
 * merchant's collector, with the allowance's caveats and the collector in the agent's place. USDC `transfer` only
 * (AllowedTargets, AllowedMethods, no value), the collector itself as the only recipient (AllowedCalldata at offset 4),
 * at most `amount` per period (ERC20PeriodTransfer) and nothing after the last whole period within `months` months
 * (Timestamp). The chain enforces every term: the collector can take one payment a period, into its own wallet, and
 * never more.
 *
 * A `day` pass's periods are UTC days: the first starts at the midnight that began the day it was prepared, so the
 * chain's period n is the merchant's UTC day n. A `month` subscription's first period starts a minute before it was
 * prepared, as the allowance's does.
 *
 * The browser never signs what the server says: `reviewSubscription` rebuilds the delegation from the terms the owner
 * was shown and compares hashes first, as `reviewAllowance` does.
 */
import { type Address, type Hex, getAddress, isAddress, isHex } from 'viem'
import { parseUnits } from '../amounts/index.ts'
import type { Chain } from '../chains/index.ts'
import { canonicalJson } from '../contract/hash.ts'
import {
  type MerchantBilling,
  SUBSCRIPTION_MAX_MONTHS,
  SUBSCRIPTION_MAX_PERIOD_DAYS,
  type SignedDelegation,
} from '../contract/merchant.ts'
import type { TypedDataJson } from '../contract/signer.ts'
import * as Option from 'effect/Option'
import {
  REVIEW_WINDOW_S,
  START_LEAD_S,
  buildAllowance,
  decodeDraft,
  draftStart,
  randomSalt,
  signedDelegation,
} from './allowance.ts'
import {
  type Delegation,
  type DelegationJson,
  delegationDomain,
  delegationHash,
  delegationTypedData,
  disableCalldata,
  fromDelegationJson,
  toDelegationJson,
} from './encoding.ts'

const DAY_S = 86_400
/** A month of a subscription: a twelfth of a 365-day year, so 12 months are 365 days. */
const daysIn = (months: number): number => Math.floor((months * 365) / 12)

/** What a merchant asks for: at most so much USD each period of `periodDays` days, billed so, for `months` months. */
export interface SubscriptionTerms {
  readonly billing: MerchantBilling
  /** A decimal string; one USDC base unit per micro-dollar. */
  readonly amountUsd: string
  readonly periodDays: number
  readonly months: number
}

/** The terms, the chain, and the two parties: the owner who signs, and the collector who is paid. */
export interface SubscriptionChoice {
  readonly chain: Chain
  readonly owner: Address
  readonly collector: Address
  readonly terms: SubscriptionTerms
}

const checkTerms = (terms: SubscriptionTerms): void => {
  if (terms.billing !== 'day' && terms.billing !== 'month')
    throw new Error('invalid_subscription: a subscription is billed by the day or the month')
  if (
    !Number.isSafeInteger(terms.periodDays) ||
    terms.periodDays < 1 ||
    terms.periodDays > SUBSCRIPTION_MAX_PERIOD_DAYS
  )
    throw new Error(`invalid_subscription: a period is 1 to ${SUBSCRIPTION_MAX_PERIOD_DAYS} days`)
  if (terms.billing === 'day' && terms.periodDays !== 1)
    throw new Error('invalid_subscription: a day pass has one-day periods')
  if (!Number.isSafeInteger(terms.months) || terms.months < 1 || terms.months > SUBSCRIPTION_MAX_MONTHS)
    throw new Error(`invalid_subscription: a subscription runs 1 to ${SUBSCRIPTION_MAX_MONTHS} months`)
}

/** The period in seconds. */
export const periodSeconds = (terms: Pick<SubscriptionTerms, 'periodDays'>): number => terms.periodDays * DAY_S

/**
 * How many periods a subscription has: the whole ones within its months. A year's day pass has 365, a year of 30-day
 * periods 12.
 */
export const periodCount = (terms: Pick<SubscriptionTerms, 'periodDays' | 'months'>): number =>
  Math.floor(daysIn(terms.months) / terms.periodDays)

/**
 * When the first period of terms prepared at `nowS` starts (seconds): the midnight UTC that began that day for a day
 * pass, a minute earlier for the rest, so a redemption right after signing never meets an earlier block.
 */
export const subscriptionStart = (terms: Pick<SubscriptionTerms, 'billing'>, nowS: number): number =>
  terms.billing === 'day' ? nowS - (nowS % DAY_S) : nowS - START_LEAD_S

/**
 * The delegation of terms whose first period starts at `start` (seconds), with `salt`. It ends when the last period
 * does, so at most `periodCount` payments can ever be taken.
 */
export const buildSubscription = (choice: SubscriptionChoice, start: number, salt: bigint): Delegation => {
  checkTerms(choice.terms)
  const period = periodSeconds(choice.terms)
  return buildAllowance({
    kind: 'allowance',
    chain: choice.chain,
    owner: choice.owner,
    agent: choice.collector,
    amount: parseUnits(choice.terms.amountUsd, choice.chain.usdc.decimals),
    period,
    start,
    expiresAt: start + periodCount(choice.terms) * period,
    salt,
  })
}

/** When a subscription's periods start and when it ends, from its first period's start (seconds). */
const windowOf = (terms: SubscriptionTerms, start: number) => ({
  startsAt: new Date(start * 1000).toISOString(),
  expiresAt: new Date((start + periodCount(terms) * periodSeconds(terms)) * 1000).toISOString(),
})

/** A subscription prepared for the owner to sign, kept by the wallet until it comes back signed. */
export interface PreparedSubscription {
  readonly chainId: number
  readonly typedData: TypedDataJson
  readonly delegationHash: Hex
  readonly delegation: DelegationJson
  readonly startsAt: string
  readonly expiresAt: string
}

/** The exact delegation for the owner to sign, and its hash. */
export const prepareSubscription = (
  choice: SubscriptionChoice,
  nowMs: number,
  salt: bigint = randomSalt(),
): PreparedSubscription => {
  const start = subscriptionStart(choice.terms, Math.floor(nowMs / 1000))
  const delegation = buildSubscription(choice, start, salt)
  return {
    chainId: choice.chain.id,
    typedData: delegationTypedData(choice.chain, delegation),
    delegationHash: delegationHash(delegation),
    delegation: toDelegationJson(delegation),
    ...windowOf(choice.terms, start),
  }
}

/** A signed subscription: what the collector redeems from, one period at a time. */
export interface SignedSubscription {
  readonly delegation: DelegationJson
  readonly delegationHash: Hex
  readonly startsAt: string
  readonly expiresAt: string
}

/** Checks the owner's signature over the prepared subscription (as `confirmAllowance` does) and attaches it. */
export const confirmSubscription = async (
  chain: Chain,
  prepared: PreparedSubscription,
  owner: Address,
  signature: Hex,
): Promise<SignedSubscription> => ({
  delegation: await signedDelegation(chain, prepared, owner, signature, 'subscription_mismatch'),
  delegationHash: prepared.delegationHash,
  startsAt: prepared.startsAt,
  expiresAt: prepared.expiresAt,
})

export interface ReviewedSubscription {
  readonly delegationHash: Hex
  /** Exactly what to sign: the rebuilt delegation, not the server's. */
  readonly typedData: TypedDataJson
  readonly description: {
    readonly chainId: number
    readonly token: string
    readonly billing: MerchantBilling
    readonly amountUsd: string
    readonly periodDays: number
    readonly months: number
    readonly startsAt: string
    /** When the first period ends: the earliest the second payment can be taken. */
    readonly secondPaymentAt: string
    readonly expiresAt: string
    readonly collector: Address
  }
}

/**
 * Whether a draft whose first period starts at `start` was prepared lately: within the review window for a month, and
 * for a day pass today (UTC), or yesterday when today is younger than the window.
 */
const freshStart = (terms: SubscriptionTerms, start: number, nowS: number): boolean =>
  terms.billing === 'day'
    ? start === subscriptionStart(terms, nowS) || start === subscriptionStart(terms, nowS - REVIEW_WINDOW_S)
    : Math.abs(nowS - (start + START_LEAD_S)) <= REVIEW_WINDOW_S

/**
 * Rebuild-and-compare before the owner signs: the wallet's draft must be, byte for byte, the subscription of the terms
 * the owner was shown (chain, owner, collector, billing, amount, period, months), freshly prepared. Throws
 * `subscription_mismatch` otherwise.
 */
export const reviewSubscription = (
  draft: { readonly typedData: unknown; readonly delegationHash: string },
  choice: SubscriptionChoice,
  nowMs: number,
): ReviewedSubscription => {
  const decoded = Option.getOrUndefined(decodeDraft(draft.typedData))
  if (decoded === undefined || canonicalJson(decoded.domain) !== canonicalJson(delegationDomain(choice.chain)))
    throw new Error('subscription_mismatch: the draft is not a delegation on this chain')
  const start = draftStart(choice.chain, decoded.message.caveats, 'subscription_mismatch')
  if (!freshStart(choice.terms, start, Math.floor(nowMs / 1000)))
    throw new Error('subscription_mismatch: the draft is stale or from the future; prepare it again')
  const rebuilt = buildSubscription(choice, start, BigInt(decoded.message.salt))
  const hash = delegationHash(rebuilt)
  // The struct hash covers every signed field; the owner signs the rebuilt typed data, never the wallet's.
  if (hash !== draft.delegationHash.toLowerCase())
    throw new Error('subscription_mismatch: the delegation differs from the subscription you were shown')
  const { startsAt, expiresAt } = windowOf(choice.terms, start)
  return {
    delegationHash: hash,
    typedData: delegationTypedData(choice.chain, rebuilt),
    description: {
      chainId: choice.chain.id,
      token: choice.chain.usdc.symbol,
      billing: choice.terms.billing,
      amountUsd: choice.terms.amountUsd,
      periodDays: choice.terms.periodDays,
      months: choice.terms.months,
      startsAt,
      secondPaymentAt: new Date(Date.parse(startsAt) + periodSeconds(choice.terms) * 1000).toISOString(),
      expiresAt,
      collector: getAddress(choice.collector),
    },
  }
}

/**
 * The period (1-based) a time falls in, for a subscription whose periods start at `startsAt`; 0 before the first, and
 * past the last once it has ended.
 */
export const periodAt = (startsAt: string, terms: Pick<SubscriptionTerms, 'periodDays'>, atMs: number): number => {
  const elapsed = atMs - Date.parse(startsAt)
  return elapsed < 0 ? 0 : Math.floor(elapsed / (periodSeconds(terms) * 1000)) + 1
}

/** When period `n` (1-based) starts; it ends when period `n + 1` starts. */
export const periodStart = (startsAt: string, terms: Pick<SubscriptionTerms, 'periodDays'>, n: number): string =>
  new Date(Date.parse(startsAt) + (n - 1) * periodSeconds(terms) * 1000).toISOString()

const hexOf = (value: string): Hex => {
  if (!isHex(value, { strict: true })) throw new Error('invalid_delegation: a field is not hex')
  return value
}
const addressOf = (value: string): Address => {
  if (!isAddress(value, { strict: false })) throw new Error('invalid_delegation: a field is not an address')
  return value
}

/** A signed delegation as the contract carries it (plain strings), checked back into the encoders' types. */
const delegationJsonOf = (signed: typeof SignedDelegation.Type): DelegationJson => ({
  delegate: addressOf(signed.delegate),
  delegator: addressOf(signed.delegator),
  authority: hexOf(signed.authority),
  caveats: signed.caveats.map((item) => ({
    enforcer: addressOf(item.enforcer),
    terms: hexOf(item.terms),
    args: hexOf(item.args),
  })),
  salt: signed.salt,
  signature: hexOf(signed.signature),
})

/**
 * The owner's cancellation as one call of their own account: `DelegationManager.disableDelegation` of the signed
 * subscription. Only the delegator's account can send it; the chain refuses every redemption after it.
 */
export const revokeCall = (chain: Chain, signed: typeof SignedDelegation.Type) => ({
  target: chain.delegation.manager,
  value: 0n,
  callData: disableCalldata(fromDelegationJson(delegationJsonOf(signed))),
})
