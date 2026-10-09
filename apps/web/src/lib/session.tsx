import { type ReactNode, createContext, useCallback, useContext, useEffect, useState } from 'react'
import { record, request } from './boundary.ts'

/** `unavailable`: the session could not be checked (offline, a server failure), which says nothing about signing in. */
export type SessionState = 'checking' | 'signed-in' | 'signed-out' | 'unavailable'
/** The state, a way to set it after signing in, and a way to check again after `unavailable`. */
type Session = readonly [SessionState, (state: SessionState) => void, () => void]

const SessionContext = createContext<Session>(['checking', () => undefined, () => undefined])

/**
 * Whether someone is signed in, from Better Auth's session endpoint; shared by the nav and every gated page. Better
 * Auth answers a visitor without a session with `null`, so a failed check is `unavailable`, never `signed-out`: a
 * signed-in owner offline for a moment is not shown the sign-in form.
 */
export function SessionProvider({ children }: { readonly children: ReactNode }) {
  const [state, setState] = useState<SessionState>('checking')
  const [checks, setChecks] = useState(0)
  useEffect(() => {
    const controller = new AbortController()
    void request('/api/auth/get-session', { signal: controller.signal })
      .then((data) => {
        if (!controller.signal.aborted) setState(record(record(data)?.user) ? 'signed-in' : 'signed-out')
      })
      .catch(() => {
        // expected: the gate shows `unavailable` as an alert with a way to check again (owner-gate.tsx)
        if (!controller.signal.aborted) setState('unavailable')
      })
    return () => controller.abort()
  }, [checks])
  const recheck = useCallback(() => {
    setState('checking')
    setChecks((count) => count + 1)
  }, [])
  return <SessionContext value={[state, setState, recheck]}>{children}</SessionContext>
}

export const useSession = (): Session => useContext(SessionContext)

/** Ends the session and goes to `next`, where a signed-out visitor sees the sign-in form. */
export async function signOut(next = '/'): Promise<void> {
  // expected: `next` loads either way and shows the outcome: still signed in there if the server kept the session
  await request('/api/auth/sign-out', { body: {} }).catch(() => undefined)
  window.location.assign(next)
}
