import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react'
import { Schema } from 'effect'
import { BillingState } from '@purrable/contracts'
import { failureText, request } from './boundary.ts'
import { useSession } from './session.tsx'

const decode = Schema.decodeUnknownSync(BillingState)
interface Billing {
  readonly state: BillingState | undefined
  readonly error: string
  readonly refresh: () => Promise<void>
}
const BillingContext = createContext<Billing>({ state: undefined, error: '', refresh: async () => undefined })
export function BillingProvider({ children }: { readonly children: ReactNode }) {
  const [session] = useSession()
  const [state, setState] = useState<BillingState>()
  const [error, setError] = useState('')
  const refresh = useCallback(async () => {
    try {
      setState(decode(await request('/api/billing/state')))
      setError('')
    } catch (cause) {
      setError(failureText(cause))
    }
  }, [])
  useEffect(() => {
    if (session !== 'signed-in') {
      setState(undefined)
      setError('')
      return
    }
    void refresh()
    const onFocus = () => void refresh()
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [session, refresh])
  return <BillingContext value={{ state, error, refresh }}>{children}</BillingContext>
}
export const useBilling = (): Billing => useContext(BillingContext)
