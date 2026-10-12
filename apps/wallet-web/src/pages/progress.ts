import type { Me, WalletStatusResult } from '@goblin/wallet/contract'
import { ownerOnBase } from './deposit-model.ts'

export type StepId = 'agent' | 'fund' | 'upgrade' | 'allowance' | 'connect'

export interface SetupState {
  /** An MCP client is connected. */
  readonly connected: boolean
  /** The owner chose to connect later. */
  readonly skipped: boolean
  /** The owner holds ETH on Base; undefined until Base is read. */
  readonly funded: boolean | undefined
}

/**
 * Server state decides the step, so a refresh or a second device resumes where the owner stopped. Funding comes before
 * the upgrade and only there: an account already upgraded has passed it, so being done never waits on a balance read.
 */
export function setupProgress(me: Me, state: SetupState): StepId | 'done' {
  if (me.agent === undefined) return 'agent'
  const base = me.chains.find((chain) => chain.chain === 'base')
  if (base?.upgraded !== true) return state.funded === true ? 'upgrade' : 'fund'
  if (base.allowance === undefined) return 'allowance'
  return state.connected || state.skipped ? 'done' : 'connect'
}

/** Any ETH in the owner's account on Base: what the upgrade and the fees after it need. Undefined until Base is read. */
export function fundedOnBase(status: WalletStatusResult | undefined): boolean | undefined {
  const eth = ownerOnBase(status, 'ETH')
  return eth === undefined ? undefined : eth > 0n
}
