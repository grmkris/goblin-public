import { useQuery } from '@tanstack/react-query'
import type { BillingState } from '@goblin/contracts'
import { useSession } from '../auth/hooks.ts'
import { messageOf } from '../lib/query/app-error.ts'
import { signedInBillingQuery } from './queries.ts'

/**
 * The signed-in account's plan, from the cache: read once someone is signed in, and again when the window comes back
 * into focus after it went stale. Shared by the shell, the gate and the billing pages; `error` is the failed read's
 * copy, with its reference.
 */
export function useBilling(): { readonly state: BillingState | undefined; readonly error: string } {
  const signedIn = useSession().state === 'signed-in'
  const billing = useQuery(signedInBillingQuery(signedIn))
  if (!signedIn) return { state: undefined, error: '' }
  return {
    state: billing.data,
    error: billing.error === null ? '' : messageOf(billing.error, 'check your subscription'),
  }
}
