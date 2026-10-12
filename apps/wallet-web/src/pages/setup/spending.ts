// Turning on spending: the account upgrade on Base (two confirmations: the authorization, then the operation that
// carries it) and then the allowance (one), in one run. What is done is the server's to say; this hook only knows
// which confirmation is being asked for now, and what stopped it.
import type { Me } from '@goblin/wallet/contract'
import { useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { useAuth } from '../../app/auth.tsx'
import { errorText } from '../../ui/async.tsx'
import type { SpendingChoice, SpendingPhase } from './model.ts'

export interface TurnOnSpending {
  readonly phase: SpendingPhase
  readonly running: boolean
  readonly error: string | undefined
  /** The upgrade was sent but has not confirmed yet: nothing more can be signed until it has. */
  readonly confirming: boolean
  readonly start: (choice: SpendingChoice) => Promise<void>
}

export function useTurnOnSpending(me: Me): TurnOnSpending {
  const auth = useAuth()
  const client = useQueryClient()
  const [phase, setPhase] = useState<SpendingPhase>('idle')
  const [running, setRunning] = useState(false)
  const [error, setError] = useState<string>()
  const [confirming, setConfirming] = useState(false)
  const base = me.chains.find((chain) => chain.chain === 'base')
  const refresh = () =>
    Promise.all([client.invalidateQueries({ queryKey: ['me'] }), client.invalidateQueries({ queryKey: ['status'] })])

  const start = async (choice: SpendingChoice): Promise<void> => {
    setRunning(true)
    setError(undefined)
    setConfirming(false)
    try {
      if (base?.upgraded !== true) {
        setPhase('authorize')
        const outcome = await auth.upgrade('base', setPhase)
        if (outcome === 'submitted') {
          setConfirming(true)
          setPhase('idle')
          await refresh()
          return
        }
      }
      setPhase('allowance')
      await auth.signAllowance({ chain: 'base', perHour: choice.perHour, days: choice.days })
      setPhase('idle')
    } catch (caught) {
      // expected: a closed Privy screen or a refusal stops the run where it was; the list marks that step
      setError(errorText(caught))
    } finally {
      setRunning(false)
      await refresh()
    }
  }
  return { phase, running, error, confirming, start }
}
