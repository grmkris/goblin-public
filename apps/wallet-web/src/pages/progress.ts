import type { Me, WalletStatusResult } from '@goblin/wallet/contract'
import { UPGRADE_FEE_CEILINGS } from '@goblin/wallet/userop'
import { ownerOnBase } from './deposit-model.ts'

export type StepId = 'agent' | 'fund' | 'upgrade' | 'allowance'

interface SetupState {
  /** The owner holds enough USDC on Base for the upgrade's gas; undefined until Base is read. */
  readonly funded: boolean | undefined
}

const baseOf = (me: Me) => me.chains.find((chain) => chain.chain === 'base')

/**
 * The wallet works once the agent has a wallet and the account is upgraded and allowed on Base. Connecting an agent is
 * not part of it: an agent can connect at any time, before or after, and tells the owner what is still missing.
 */
export function isSetUp(me: Me): boolean {
  const base = baseOf(me)
  return me.agent !== undefined && base?.upgraded === true && base.allowance !== undefined
}

/**
 * Server state decides the step, so a refresh or a second device resumes where the owner stopped. Funding comes before
 * the upgrade and only there: an account already upgraded has passed it, so being done never waits on a balance read.
 */
export function setupProgress(me: Me, state: SetupState): StepId | 'done' {
  if (me.agent === undefined) return 'agent'
  const base = baseOf(me)
  if (base?.upgraded !== true) return state.funded === true ? 'upgrade' : 'fund'
  return base.allowance === undefined ? 'allowance' : 'done'
}

/** The most USDC the upgrade's gas may take on Base: what the owner needs there before upgrading. */
export const UPGRADE_FEE_BOUND = UPGRADE_FEE_CEILINGS.base

/**
 * Enough USDC in the owner's account on Base to pay the upgrade's gas (in USDC, not ETH), at its most. Undefined until
 * Base is read.
 */
export function fundedOnBase(status: WalletStatusResult | undefined): boolean | undefined {
  const units = ownerOnBase(status, 'USDC')
  return units === undefined ? undefined : units >= UPGRADE_FEE_BOUND
}
