import { type QueryClient, mutationOptions } from '@tanstack/react-query'
import type { ChatId } from '@goblin/contracts'
import { owner } from '../api.ts'
import { serversQuery } from '../mcp/queries.ts'

/**
 * The agent itself, on the owner API: today's usage, its model, its Telegram channel, resident authority and memory.
 * Keys are `[feature, kind, input]` after the API's groups; each change settles once what it changed is fresh.
 */

/** Today's spend and allowance in Credits (ADR 0026). */
export const usageQuery = owner.apiQuery({ queryKey: ['agent', 'usage'], queryFn: (api) => api.agent.usage() })

/** The owner's model and the ones the deployment offers. */
export const modelQuery = owner.apiQuery({ queryKey: ['agent', 'model'], queryFn: (api) => api.agent.model() })

/** Picks a model: shown at once, put back if the agent refuses it, then the agent's answer. */
export const chooseModelMutation = (queryClient: QueryClient) =>
  mutationOptions({
    ...owner.apiMutation({
      mutationFn: (api, model: string) => api.agent.chooseModel({ payload: { model } }),
    }),
    onMutate: async (model: string) => {
      await queryClient.cancelQueries({ queryKey: modelQuery.queryKey })
      const previous = queryClient.getQueryData(modelQuery.queryKey)
      if (previous !== undefined) queryClient.setQueryData(modelQuery.queryKey, { ...previous, current: model })
      return { previous }
    },
    onError: (_error, _model, context) => {
      if (context?.previous !== undefined) queryClient.setQueryData(modelQuery.queryKey, context.previous)
    },
    onSuccess: (choice) => queryClient.setQueryData(modelQuery.queryKey, choice),
  })

/** The connection carrying Telegram (ADR 0009), or null when it is off. */
export const channelQuery = owner.apiQuery({ queryKey: ['agent', 'channel'], queryFn: (api) => api.agent.channel() })

/**
 * Moves Telegram to `serverId`, or turns it off with null. The channel is read again either way, and the servers,
 * whose grants and Events the channel changes.
 */
export const changeChannelMutation = (queryClient: QueryClient) =>
  mutationOptions({
    ...owner.apiMutation({
      mutationFn: (api, serverId: string | null) =>
        serverId === null ? api.agent.disableChannel() : api.agent.enableChannel({ payload: { serverId } }),
    }),
    onSettled: () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: channelQuery.queryKey }),
        queryClient.invalidateQueries({ queryKey: serversQuery.queryKey }),
      ]),
  })

/** Resident authority (ADR 0003), renewed by the read itself. */
export const residentQuery = owner.apiQuery({
  queryKey: ['resident', 'status'],
  queryFn: (api) => api.resident.status(),
})

/** Revokes resident authority or enables it again; the answer is the new status. */
export const setResidentMutation = (queryClient: QueryClient) =>
  mutationOptions({
    ...owner.apiMutation({ mutationFn: (api, enabled: boolean) => api.resident.set({ payload: { enabled } }) }),
    onSuccess: (status) => queryClient.setQueryData(residentQuery.queryKey, status),
  })

/** What the Conversation `chat` sits under remembers; Personal's without a chat (ADR 0032). */
export const memoryQuery = (chat?: ChatId) =>
  owner.apiQuery({
    queryKey: ['memory', 'status', chat ?? null],
    queryFn: (api) => api.memory.status({ query: chat === undefined ? {} : { chat } }),
  })
