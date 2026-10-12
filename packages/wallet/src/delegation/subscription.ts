/**
 * A subscription the owner signs once (ADR 0054): one ERC-7710 delegation from the owner's 7702-upgraded account to a
 * merchant's collector, with the allowance's caveats and the collector in the agent's place. USDC `transfer` only
 * (AllowedTargets, AllowedMethods, no value), the collector itself as the only recipient (AllowedCalldata at offset 4),
 * at most `amount` per period (ERC20PeriodTransfer) and nothing after `months` periods (Timestamp). The chain enforces
 * every term: the collector can take one payment a period, into its own wallet, and never more.
 *
 * The browser never signs what the server says: `reviewSubscription` rebuilds the delegation from the terms the owner
 * was shown and compares hashes first, as `reviewAllowance` does.
 */
import { type Address, type Hex, getAddress } from 'viem'
import { parseUnits } from '../amounts/index.ts'
import type { Chain } from '../chains/index.ts'
import { canonicalJson } from '../contract/hash.ts'
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
/** The longest period and the most periods a subscription may run: a month, two years. */
export const MAX_PERIOD_DAYS = 31
export const MAX_PERIODS = 24

/** What a merchant asks for: so much USD every `periodDays` days, for `months` periods. */
export interface SubscriptionTerms {
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
  if (!Number.isSafeInteger(terms.periodDays) || terms.periodDays < 1 || terms.periodDays > MAX_PERIOD_DAYS)
    throw new Error(`invalid_subscription: a period is 1 to ${MAX_PERIOD_DAYS} days`)
  if (!Number.isSafeInteger(terms.months) || terms.months < 1 || terms.months > MAX_PERIODS)
    throw new Error(`invalid_subscription: a subscription runs 1 to ${MAX_PERIODS} periods`)
}

/** The period in seconds. */
export const periodSeconds = (terms: Pick<SubscriptionTerms, 'periodDays'>): number => terms.periodDays * DAY_S

/**
 * The delegation of terms prepared at `nowS` with `salt`: the first period starts a minute earlier, and the delegation
 * ends when the last of `months` periods does, so at most `months` payments can ever be taken.
 */
export const buildSubscription = (choice: SubscriptionChoice, nowS: number, salt: bigint): Delegation => {
  checkTerms(choice.terms)
  const period = periodSeconds(choice.terms)
  const start = nowS - START_LEAD_S
  return buildAllowance({
    kind: 'allowance',
    chain: choice.chain,
    owner: choice.owner,
    agent: choice.collector,
    amount: parseUnits(choice.terms.amountUsd, choice.chain.usdc.decimals),
    period,
    start,
    expiresAt: start + choice.terms.months * period,
    salt,
  })
}

/** When a subscription's periods start and when it ends, from the time its delegation was prepared (seconds). */
const windowOf = (terms: SubscriptionTerms, preparedAtS: number) => {
  const start = preparedAtS - START_LEAD_S
  return {
    startsAt: new Date(start * 1000).toISOString(),
    expiresAt: new Date((start + terms.months * periodSeconds(terms)) * 1000).toISOString(),
  }
}

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
  const nowS = Math.floor(nowMs / 1000)
  const delegation = buildSubscription(choice, nowS, salt)
  return {
    chainId: choice.chain.id,
    typedData: delegationTypedData(choice.chain, delegation),
    delegationHash: delegationHash(delegation),
    delegation: toDelegationJson(delegation),
    ...windowOf(choice.terms, nowS),
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
 * Rebuild-and-compare before the owner signs: the wallet's draft must be, byte for byte, the subscription of the terms
 * the owner was shown (chain, owner, collector, amount, period, number of periods), freshly prepared. Throws
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
  const nowS = Math.floor(nowMs / 1000)
  const preparedAt = draftStart(choice.chain, decoded.message.caveats, 'subscription_mismatch') + START_LEAD_S
  if (Math.abs(nowS - preparedAt) > REVIEW_WINDOW_S)
    throw new Error('subscription_mismatch: the draft is stale or from the future; prepare it again')
  const rebuilt = buildSubscription(choice, preparedAt, BigInt(decoded.message.salt))
  const hash = delegationHash(rebuilt)
  // The struct hash covers every signed field; the owner signs the rebuilt typed data, never the wallet's.
  if (hash !== draft.delegationHash.toLowerCase())
    throw new Error('subscription_mismatch: the delegation differs from the subscription you were shown')
  const { startsAt, expiresAt } = windowOf(choice.terms, preparedAt)
  return {
    delegationHash: hash,
    typedData: delegationTypedData(choice.chain, rebuilt),
    description: {
      chainId: choice.chain.id,
      token: choice.chain.usdc.symbol,
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

/**
 * The owner's cancellation as one call of their own account: `DelegationManager.disableDelegation` of the signed
 * subscription. Only the delegator's account can send it; the chain refuses every redemption after it.
 */
export const revokeCall = (chain: Chain, signed: DelegationJson) => ({
  target: chain.delegation.manager,
  value: 0n,
  callData: disableCalldata(fromDelegationJson(signed)),
})
