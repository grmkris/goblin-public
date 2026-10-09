import { createContext, useContext, type ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import type { BillingState } from '@goblin/contracts'
import { signedInBillingQuery } from './account/queries.ts'
import { messageOf } from './query/app-error.ts'
import { useSession } from './session.tsx'

interface Billing {
  readonly state: BillingState | undefined
  readonly error: string
}
const BillingContext = createContext<Billing>({ state: undefined, error: '' })

/**
 * The signed-in account's plan, from the Query cache (`account/queries.ts`): read once someone is signed in, and again
 * when the window comes back into focus after it went stale. Shared by the shell, the gate and the billing pages.
 */
export function BillingProvider({ children }: { readonly children: ReactNode }) {
  const [session] = useSession()
  const signedIn = session === 'signed-in'
  const billing = useQuery(signedInBillingQuery(signedIn))
  const value: Billing = signedIn
    ? {
        state: billing.data,
        error: billing.error === null ? '' : messageOf(billing.error, 'check your subscription'),
      }
    : { state: undefined, error: '' }
  return <BillingContext value={value}>{children}</BillingContext>
}
export const useBilling = (): Billing => useContext(BillingContext)
