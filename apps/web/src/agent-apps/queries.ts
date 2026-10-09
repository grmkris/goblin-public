// The owner's agent apps (ADR 0021) through the typed client: the Apps page's list and each app's page. Keys are
// [feature, kind, input]; a change answers with the app as it is after it, so its detail is set, not read again.
import { type QueryClient, type QueryKey, mutationOptions, useQueryClient } from '@tanstack/react-query'
import { useEffect, useRef } from 'react'
import type { AgentAppChange } from '@goblin/contracts'
import { owner } from '../lib/api.ts'
import { reportUnexpected } from '../lib/unexpected.ts'

const agentAppKeys = {
  list: ['agentApps', 'list'] as const,
  detail: (name: string) => ['agentApps', 'detail', name] as const,
}

/** The owner's agent apps, newest change first. */
export const agentAppsQuery = owner.apiQuery({ queryKey: agentAppKeys.list, queryFn: (api) => api.agentApps.list() })

/** One agent app in full. */
export const agentAppQuery = (name: string) =>
  owner.apiQuery({
    queryKey: agentAppKeys.detail(name),
    queryFn: (api) => api.agentApps.detail({ params: { name } }),
  })

/** A change to agent app `name`: its answer is the app after it, and the list reads again (its summary moved). */
export const changeAgentAppMutation = (queryClient: QueryClient, name: string) =>
  mutationOptions({
    ...owner.apiMutation({
      mutationFn: (api, change: AgentAppChange) =>
        api.agentApps.change(
          // SAFETY: `change` is one of AgentAppChange's members, and the client takes a request for each member; it does
          // not distribute a union payload over them itself.
          { params: { name }, payload: change } as Parameters<typeof api.agentApps.change>[0],
        ),
    }),
    onSuccess: (detail) => {
      queryClient.setQueryData(agentAppKeys.detail(name), detail)
      return queryClient.invalidateQueries({ queryKey: agentAppKeys.list })
    },
  })

/** Deletes agent app `name` once the owner typed it (`confirm`); the list reads again. */
export const deleteAgentAppMutation = (queryClient: QueryClient, name: string) =>
  mutationOptions({
    ...owner.apiMutation({
      mutationFn: (api, confirm: string) => api.agentApps.delete({ params: { name }, payload: { confirm } }),
    }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: agentAppKeys.list }),
  })

/**
 * Reads `queryKey` again when the workspace feed's `signature` for it moves on: the feed says an app changed, Query
 * reads it. The first render reads through the query itself.
 */
export function useFeedRefresh(queryKey: QueryKey, signature: string): void {
  const queryClient = useQueryClient()
  const seen = useRef(signature)
  useEffect(() => {
    if (seen.current === signature) return
    seen.current = signature
    queryClient.invalidateQueries({ queryKey }).catch(reportUnexpected)
  }, [queryClient, queryKey, signature])
}
