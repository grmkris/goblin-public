import { type ReactNode, createContext, useContext, useEffect, useState } from 'react'
import { record, request } from './boundary.ts'

export type SessionState = 'checking' | 'signed-in' | 'signed-out'
type Session = readonly [SessionState, (state: SessionState) => void]

const SessionContext = createContext<Session>(['checking', () => undefined])

/** Whether someone is signed in, from Better Auth's session endpoint; shared by the nav and every gated page. */
export function SessionProvider({ children }: { readonly children: ReactNode }) {
  const [state, setState] = useState<SessionState>('checking')
  useEffect(() => {
    const controller = new AbortController()
    void request('/api/auth/get-session', { signal: controller.signal })
      .then((data) => {
        if (!controller.signal.aborted) setState(record(record(data)?.user) ? 'signed-in' : 'signed-out')
      })
      .catch(() => {
        if (!controller.signal.aborted) setState('signed-out')
      })
    return () => controller.abort()
  }, [])
  return <SessionContext value={[state, setState]}>{children}</SessionContext>
}

export const useSession = (): Session => useContext(SessionContext)
