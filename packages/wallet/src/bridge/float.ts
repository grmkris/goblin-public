/**
 * The agent's Tempo float: the USDC.e on Tempo that paid inference and MPP services are paid from. The owner funds Base
 * and signs an allowance there, so the wallet keeps the float itself: when it falls below `FLOAT_LOW` it bridges Base
 * USDC to the agent's own Tempo address, enough to bring it back to `FLOAT_TARGET`, drawn the same way every agent send
 * is (the agent's Base USDC first, then the owner's allowance, in one UserOperation). This module only decides how
 * much; the Worker reads the chains and moves it.
 */
import { PAYMENT_CAP_UNITS } from '../policy/index.ts'

/** Below this (USDC.e base units, 6 decimals) the float is refilled: $1.00. */
export const FLOAT_LOW = 1_000_000n
/** A refill brings the float back to this, before Relay's fee: $3.00. */
export const FLOAT_TARGET = 3_000_000n
/** A smaller refill is not worth its gas and Relay's fee, so none is sent: $0.50. */
export const FLOAT_MIN_BRIDGE = 500_000n
/** The most one refill bridges: the Privy policy's cap on a USDC approval to Relay's depository ($5). */
export const FLOAT_MAX_BRIDGE = PAYMENT_CAP_UNITS

const CENT = 10_000n

export interface FloatInput {
  /** The agent's USDC.e on Tempo. */
  readonly held: bigint
  /** A payment that must fit (an MPP charge refused for want of funds); the float then refills to cover it. */
  readonly need?: bigint
  /** What the owner's allowance on Base still releases this period (the enforcer's `getAvailableAmount`). */
  readonly allowance: bigint
  /** The owner's USDC on Base: the allowance moves real money, so it cannot release more than this. */
  readonly owner: bigint
  /** The agent's own USDC on Base, which a send spends before it redeems anything. */
  readonly agent: bigint
  /** Kept back for the UserOperation's gas, which the same source pays (the chain's gas ceiling). */
  readonly feeMargin: bigint
  /** The most one bridge may move: the Privy policy's cap on a route approval. */
  readonly maxBridge: bigint
  readonly low?: bigint
  readonly target?: bigint
  readonly minimum?: bigint
}

/** Why no refill is sent: the float is high enough, or the source cannot release a bridge worth sending. */
export type FloatSkip = 'full' | 'source_short'

export type FloatDecision =
  | { readonly kind: 'refill'; readonly amount: bigint }
  | { readonly kind: 'skip'; readonly reason: FloatSkip; readonly available: bigint }

const max = (a: bigint, b: bigint): bigint => (a > b ? a : b)
const min = (a: bigint, b: bigint): bigint => (a < b ? a : b)
const ceilCents = (units: bigint): bigint => ((units + CENT - 1n) / CENT) * CENT
const floorCents = (units: bigint): bigint => (units / CENT) * CENT

/**
 * What the source can put into one bridge: the allowance up to the owner's balance, plus the agent's own Base USDC,
 * less the gas margin and never above the policy's cap; whole cents.
 */
export const floatSource = (input: FloatInput): bigint => {
  const pull = min(input.allowance, input.owner) + input.agent
  return pull <= input.feeMargin ? 0n : floorCents(min(pull - input.feeMargin, input.maxBridge))
}

/**
 * How much to bridge to the float, or why nothing is. Below `low` (or below a payment that must fit), the refill brings
 * it to `target` (or to that payment), in whole cents and at least `minimum`, capped by the source; a capped refill
 * under `minimum` is skipped rather than sent.
 */
export const planRefill = (input: FloatInput): FloatDecision => {
  const need = input.need ?? 0n
  const minimum = input.minimum ?? FLOAT_MIN_BRIDGE
  const available = floatSource(input)
  if (input.held >= max(input.low ?? FLOAT_LOW, need)) return { kind: 'skip', reason: 'full', available }
  const goal = max(input.target ?? FLOAT_TARGET, need)
  const amount = min(max(ceilCents(goal - input.held), minimum), available)
  return amount < minimum ? { kind: 'skip', reason: 'source_short', available } : { kind: 'refill', amount }
}
