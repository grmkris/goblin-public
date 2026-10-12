import type { Me } from '@goblin/wallet/contract'

export type StepId = 'agent' | 'upgrade' | 'allowance' | 'connect'

/** Server state decides the step, so a refresh or a second device resumes where the owner stopped. */
export function setupProgress(me: Me, connected: boolean, skipped: boolean): StepId | 'done' {
  if (me.agent === undefined) return 'agent'
  const base = me.chains.find((chain) => chain.chain === 'base')
  if (base?.upgraded !== true) return 'upgrade'
  if (base.allowance === undefined) return 'allowance'
  return connected || skipped ? 'done' : 'connect'
}
