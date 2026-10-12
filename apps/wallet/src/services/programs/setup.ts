import { parseUnits } from '@goblin/wallet/amounts'
import type { ChainBalance, ChainSetup, PayFrom } from '@goblin/wallet/contract'

/** What the owner still has to do on the wallet's site before the agent can pay; empty when setup is finished. */
export function setupGaps(input: {
  readonly hasAgent: boolean
  readonly chains: readonly ChainSetup[]
  readonly balances: readonly ChainBalance[]
}): string[] {
  const base = input.chains.find((chain) => chain.chain === 'base')
  const funded = input.balances.some(
    (row) => row.chain === 'base' && row.holder === 'owner' && /[1-9]/u.test(row.balance),
  )
  const gaps: string[] = []
  if (!input.hasAgent) gaps.push('create the agent wallet')
  if (base?.upgraded !== true && !funded) gaps.push('add funds to the account (USDC or ETH, on any EVM chain)')
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

/**
 * One sentence when the address paid inference and MPP services pay from is (nearly) empty: where to send USDC.e, and
 * that the wallet App adds funds from any chain. Nothing when Tempo was not read: unknown is not empty.
 */
export const fundingSentence = (payFrom: PayFrom | undefined): string | undefined => {
  if (payFrom?.held === undefined || parseUnits(payFrom.held, 6) >= LOW_TEMPO) return undefined
  return `The agent wallet ${payFrom.address} holds ${payFrom.held} USDC.e on Tempo, which pays paid inference and MPP services: send USDC.e on Tempo to that address, or use add_funds (or the wallet App's Add funds) from Base, Arbitrum or Ethereum.`
}
