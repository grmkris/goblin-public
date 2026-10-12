import type { ChainBalance, ChainSetup } from '@goblin/wallet/contract'

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
