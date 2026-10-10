// The owner's agent apps (ADR 0021) through the typed client: the Apps page's list and each app's page. Keys are
// [feature, kind, input]; a change answers with the app as it is after it, so its detail is set, not read again.
import { mutationOptions } from '@tanstack/react-query'
import type { AgentAppChange } from '@goblin/contracts'
import { owner } from '../lib/api.ts'

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
export const changeAgentAppMutation = (name: string) =>
  mutationOptions({
    ...owner.apiMutation({
      mutationFn: (api, change: AgentAppChange) =>
        api.agentApps.change(
          // SAFETY: `change` is one of AgentAppChange's members, and the client takes a request for each member; it does
          // not distribute a union payload over them itself.
          { params: { name }, payload: change } as Parameters<typeof api.agentApps.change>[0],
        ),
    }),
    onSuccess: (detail, _change, _result, { client }) => {
      client.setQueryData(agentAppKeys.detail(name), detail)
      return client.invalidateQueries({ queryKey: agentAppKeys.list })
    },
  })

/** Deletes agent app `name` once the owner typed it (`confirm`); the list reads again. */
export const deleteAgentAppMutation = (name: string) =>
  mutationOptions({
    ...owner.apiMutation({
      mutationFn: (api, confirm: string) => api.agentApps.delete({ params: { name }, payload: { confirm } }),
    }),
    onSuccess: (_deleted, _confirm, _result, { client }) => client.invalidateQueries({ queryKey: agentAppKeys.list }),
  })
