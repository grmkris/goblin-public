// What the dashboard App says when the wallet is not ready for its agent yet: what is missing, in the owner's words, and
// whose agent it is for. `wallet_status` carries the gaps as `setup` (the agent's own sentences); a result without them
// (an older server, `wallet_open`) has them read from the status itself.
import type { WalletStatusResult } from '@goblin/wallet/contract'
import { unitsOf } from './money.ts'

const NO_ADDRESS = '0x0000000000000000000000000000000000000000'

/**
 * The most USDC the upgrade's gas may take on Base (`UPGRADE_FEE_CEILINGS.base`, held equal by a test): importing
 * `@goblin/wallet/userop` would bring the operation builder into the single-file App.
 */
export const UPGRADE_FEE_BOUND_BASE = 100_000n

/** The gaps as `wallet_status` words them, from the status alone. */
function gapsFromStatus(status: WalletStatusResult): string[] {
  const gaps: string[] = []
  if (status.agent.address === NO_ADDRESS) gaps.push('create the agent wallet')
  const allowed = status.limits.some((limit) => limit.layer === 'onchain' && limit.chain === 'base')
  if (allowed) return gaps
  const usdc = status.balances.find((row) => row.chain === 'base' && row.holder === 'owner' && row.symbol === 'USDC')
  const funded = usdc !== undefined && unitsOf(usdc.balance, usdc.decimals) >= UPGRADE_FEE_BOUND_BASE
  if (!status.owner.upgraded && !funded) gaps.push('add USDC to the account on Base')
  if (!status.owner.upgraded) gaps.push('upgrade the account on Base')
  gaps.push('sign the spending allowance')
  return gaps
}

/** What setup still needs: the server's list when it sent one, otherwise what the status shows. */
export const setupGapsOf = (status: WalletStatusResult, setup: readonly string[] | undefined): readonly string[] =>
  setup ?? gapsFromStatus(status)

const OWNER_WORDS: readonly (readonly [RegExp, string])[] = [
  [/agent wallet/iu, 'Create your agent wallet'],
  [/USDC|fund/iu, 'Add USDC on Base'],
  [/upgrade|allowance|spending/iu, 'Turn on spending'],
]

const capitalize = (text: string): string => `${text.charAt(0).toUpperCase()}${text.slice(1)}`

/** The gaps as the owner's checklist, the steps of the wallet's own setup, each once. */
export function setupChecklist(gaps: readonly string[]): readonly string[] {
  const items = gaps.map((gap) => OWNER_WORDS.find(([pattern]) => pattern.test(gap))?.[1] ?? capitalize(gap))
  return [...new Set(items)]
}

/** The host's name as the card says it ("goblin"), when it is a plain short name; otherwise none. */
export const clientNameOf = (name: string | undefined): string | undefined =>
  name !== undefined && /^[\p{L}\p{N}][\p{L}\p{N} ._-]{0,39}$/u.test(name) ? name : undefined

/** "Your wallet isn't ready for goblin yet", or for "your agent" when the host gave no name. */
export const notReadyTitle = (client: string | undefined): string =>
  `Your wallet isn't ready for ${client ?? 'your agent'} yet`
