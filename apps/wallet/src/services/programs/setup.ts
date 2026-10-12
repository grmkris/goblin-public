import { parseUnits } from '@goblin/wallet/amounts'
import { AGENT_GAS_CEILINGS } from '@goblin/wallet/balances'
import { FLOAT_MIN_BRIDGE } from '@goblin/wallet/bridge'
import type { ChainBalance, ChainSetup, LimitView, PayFrom } from '@goblin/wallet/contract'

/** What the owner still has to do on the wallet's site before the agent can pay; empty when setup is finished. */
export function setupGaps(input: {
  readonly hasAgent: boolean
  readonly chains: readonly ChainSetup[]
  readonly balances: readonly ChainBalance[]
}): string[] {
  const base = input.chains.find((chain) => chain.chain === 'base')
  // The upgrade's gas is paid in USDC from the owner's account on Base, so only USDC there counts.
  const funded = input.balances.some(
    (row) => row.chain === 'base' && row.holder === 'owner' && row.symbol === 'USDC' && /[1-9]/u.test(row.balance),
  )
  const gaps: string[] = []
  if (!input.hasAgent) gaps.push('create the agent wallet')
  if (base?.upgraded !== true && !funded)
    gaps.push("add USDC to the account on Base (the upgrade's gas is paid in USDC)")
  if (base?.upgraded !== true) gaps.push('upgrade the account on Base')
  if (base?.allowance === undefined) gaps.push('sign the spending allowance')
  return gaps
}

/** One sentence for the agent to pass on: what is missing and where the owner finishes it. */
export const setupSentence = (gaps: readonly string[], origin: string): string | undefined =>
  gaps.length === 0
    ? undefined
    : `Setup isn't finished; ask the owner to ${gaps.join(', then ')} at ${origin}/. Paid tools stay blocked until then.`

/** Below this the agent cannot pay for about two paid model calls on Tempo (0.05 USDC.e). */
const LOW_TEMPO = 50_000n

/** Whether the owner's Base allowance can refill the Tempo float (ADR 0051), or why it cannot. */
export type FloatSource = 'allowance' | 'no_allowance' | 'expired' | 'exhausted' | 'unfunded' | 'testnet'

const usdcOn = (balances: readonly ChainBalance[], holder: ChainBalance['holder']): bigint | undefined => {
  const row = balances.find((entry) => entry.chain === 'base' && entry.holder === holder && entry.symbol === 'USDC')
  return row === undefined ? undefined : parseUnits(row.balance, row.decimals)
}

/**
 * Can a refill draw on Base: an allowance signed and unexpired, with at least the smallest refill plus its gas left
 * this period on chain, and that much USDC on Base. A chain that was not read is not counted against it.
 */
export function floatSource(input: {
  readonly live: boolean
  readonly chains: readonly ChainSetup[]
  readonly limits: readonly LimitView[]
  readonly balances: readonly ChainBalance[]
  readonly now: number
}): FloatSource {
  if (!input.live) return 'testnet'
  const allowance = input.chains.find((chain) => chain.chain === 'base')?.allowance
  if (allowance === undefined) return 'no_allowance'
  if (Date.parse(allowance.expiresAt) <= input.now) return 'expired'
  const least = FLOAT_MIN_BRIDGE + AGENT_GAS_CEILINGS.base
  const onchain = input.limits.find((limit) => limit.layer === 'onchain' && limit.chain === 'base')
  if (onchain?.remaining !== undefined && parseUnits(onchain.remaining, 6) < least) return 'exhausted'
  const owner = usdcOn(input.balances, 'owner')
  if (owner !== undefined && owner + (usdcOn(input.balances, 'agent') ?? 0n) < least) return 'unfunded'
  return 'allowance'
}

/** Why the owner funds Tempo by hand, when the allowance cannot. */
const BY_HAND: Readonly<Record<Exclude<FloatSource, 'allowance' | 'unfunded'>, string>> = {
  testnet: '',
  no_allowance: ' No Base allowance is signed, so the wallet cannot refill it.',
  expired: ' The Base allowance has expired, so the wallet cannot refill it until the owner signs a new one.',
  exhausted: ' The Base allowance is used up for this period; the wallet refills it once the period renews.',
}

/**
 * One sentence when the address paid inference and MPP services pay from is (nearly) empty. When the owner's Base
 * allowance keeps it topped up (ADR 0051), it says so, or that a refill is on its way; only when the allowance cannot
 * refill it does it ask for USDC.e by hand, and why. Nothing when Tempo was not read: unknown is not empty.
 */
export const fundingSentence = (
  payFrom: PayFrom | undefined,
  float?: { readonly source: FloatSource; readonly refilling: boolean },
): string | undefined => {
  if (payFrom?.held === undefined || parseUnits(payFrom.held, 6) >= LOW_TEMPO) return undefined
  const holds = `The agent wallet ${payFrom.address} holds ${payFrom.held} USDC.e on Tempo, which pays paid inference and MPP services`
  if (float?.refilling === true) return `${holds}; a refill from the owner's Base allowance is on its way.`
  if (float?.source === 'allowance')
    return `${holds}; the wallet keeps it topped up from the owner's Base allowance (back to $3 whenever it falls under $1), so nothing needs sending by hand.`
  if (float?.source === 'unfunded')
    return `${holds}; the wallet refills it from the owner's Base allowance, but the owner holds too little USDC on Base: add USDC on Base, or use add_funds.`
  const why = float === undefined ? '' : BY_HAND[float.source]
  return `${holds}: send USDC.e on Tempo to that address, or use add_funds (or the wallet App's Add funds) from Base, Arbitrum or Ethereum.${why}`
}
