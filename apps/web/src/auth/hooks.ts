import { useQuery, useQueryClient } from '@tanstack/react-query'
import { sessionQuery } from './queries.ts'

/** `unavailable`: the session could not be checked (offline, a server failure), which says nothing about signing in. */
export type SessionState = 'checking' | 'signed-in' | 'signed-out' | 'unavailable'

/**
 * Whether someone is signed in, from Better Auth's session endpoint through the cache, shared by the nav and every
 * gated page. A failed check is `unavailable`, never `signed-out`, so a signed-in owner offline for a moment is not
 * shown the sign-in form; once known, the state survives a failed re-check. `signedIn` records a sign-in this page
 * made; `recheck` reads the session again after `unavailable`.
 */
export function useSession() {
  const client = useQueryClient()
  const read = useQuery(sessionQuery)
  const state: SessionState = read.data ?? (read.isError && !read.isFetching ? 'unavailable' : 'checking')
  return {
    state,
    error: read.error,
    signedIn: () => client.setQueryData(sessionQuery.queryKey, 'signed-in'),
    recheck: () => void read.refetch(),
  }
}
