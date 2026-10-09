import { type ReactNode, createContext, useCallback, useContext } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { authClient } from './auth-client.ts'
import { sessionQuery } from './auth/queries.ts'

/** `unavailable`: the session could not be checked (offline, a server failure), which says nothing about signing in. */
export type SessionState = 'checking' | 'signed-in' | 'signed-out' | 'unavailable'
/** The state, a way to record signing in, and a way to check again after `unavailable`. */
type Session = readonly [SessionState, (state: 'signed-in' | 'signed-out') => void, () => void]

const SessionContext = createContext<Session>(['checking', () => undefined, () => undefined])

/**
 * Whether someone is signed in, from Better Auth's session endpoint through the Query cache (`auth/queries.ts`);
 * shared by the nav and every gated page. A failed check is `unavailable`, never `signed-out`, so a signed-in owner
 * offline for a moment is not shown the sign-in form; once known, the state survives a failed re-check.
 */
export function SessionProvider({ children }: { readonly children: ReactNode }) {
  const queryClient = useQueryClient()
  const read = useQuery(sessionQuery)
  const state: SessionState = read.data ?? (read.isError && !read.isFetching ? 'unavailable' : 'checking')
  const record = useCallback(
    (next: 'signed-in' | 'signed-out') => queryClient.setQueryData(sessionQuery.queryKey, next),
    [queryClient],
  )
  const { refetch } = read
  const recheck = useCallback(() => void refetch(), [refetch])
  return <SessionContext value={[state, record, recheck]}>{children}</SessionContext>
}

export const useSession = (): Session => useContext(SessionContext)

/** Ends the session and goes to `next`, where a signed-out visitor sees the sign-in form. */
export async function signOut(next = '/'): Promise<void> {
  // expected: `next` loads either way and shows the outcome: still signed in there if the server kept the session
  await authClient.signOut().catch(() => undefined)
  window.location.assign(next)
}
