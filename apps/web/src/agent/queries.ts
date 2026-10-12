import { mutationOptions } from '@tanstack/react-query'
import type { ChatId, PayMode, PayRoute } from '@goblin/contracts'
import { owner } from '../lib/api.ts'
import { mcpKeys } from '../mcp/queries.ts'

/**
 * The agent itself, on the owner API: today's usage, its model and how it pays for it, its Telegram channel, resident
 * authority and memory. Keys are `['agent', kind, input]`; each change settles once what it changed is fresh.
 */
const agentKeys = {
  usage: ['agent', 'usage'] as const,
  model: ['agent', 'model'] as const,
  pay: ['agent', 'pay'] as const,
  channel: ['agent', 'channel'] as const,
  resident: ['agent', 'resident'] as const,
  memory: (chat: ChatId | undefined) => ['agent', 'memory', chat ?? null] as const,
}

/** Today's spend and allowance in Credits (ADR 0026). */
export const usageQuery = owner.apiQuery({ queryKey: agentKeys.usage, queryFn: (api) => api.agent.usage() })

/** The owner's model and the ones the deployment offers. */
export const modelQuery = owner.apiQuery({ queryKey: agentKeys.model, queryFn: (api) => api.agent.model() })

/** Picks a model: shown at once, put back if the agent refuses it, then the agent's answer. */
export const chooseModelMutation = mutationOptions({
  ...owner.apiMutation({
    mutationFn: (api, model: string) => api.agent.chooseModel({ payload: { model } }),
  }),
  onMutate: async (model: string, { client }) => {
    await client.cancelQueries({ queryKey: agentKeys.model })
    const previous = client.getQueryData(modelQuery.queryKey)
    if (previous !== undefined) client.setQueryData(modelQuery.queryKey, { ...previous, current: model })
    return { previous }
  },
  onError: (_error, _model, result, { client }) => {
    if (result?.previous !== undefined) client.setQueryData(modelQuery.queryKey, result.previous)
  },
  onSuccess: (choice, _model, _result, { client }) => client.setQueryData(modelQuery.queryKey, choice),
})

/**
 * How goblin pays for its model calls (ADR 0047): the owner's pay mode and route, the routes the stage sells, and
 * whether their Goblin Wallet can pay now.
 */
export const payQuery = owner.apiQuery({ queryKey: agentKeys.pay, queryFn: (api) => api.agent.pay() })

/** Chooses the pay mode and route: shown at once, put back if the agent refuses it, then the agent's answer. */
export const choosePayMutation = mutationOptions({
  ...owner.apiMutation({
    mutationFn: (api, pick: { readonly mode: PayMode; readonly route: PayRoute }) =>
      api.agent.choosePay({ payload: pick }),
  }),
  onMutate: async (pick: { readonly mode: PayMode; readonly route: PayRoute }, { client }) => {
    await client.cancelQueries({ queryKey: agentKeys.pay })
    const previous = client.getQueryData(payQuery.queryKey)
    if (previous !== undefined) client.setQueryData(payQuery.queryKey, { ...previous, ...pick })
    return { previous }
  },
  onError: (_error, _pick, result, { client }) => {
    if (result?.previous !== undefined) client.setQueryData(payQuery.queryKey, result.previous)
  },
  onSuccess: (choice, _pick, _result, { client }) => client.setQueryData(payQuery.queryKey, choice),
})

/** The connection carrying Telegram (ADR 0009), or null when it is off. */
export const channelQuery = owner.apiQuery({ queryKey: agentKeys.channel, queryFn: (api) => api.agent.channel() })

/**
 * Moves Telegram to `connectionId`, or turns it off with null. The channel is read again either way, and the servers,
 * whose grants and Events the channel changes.
 */
export const changeChannelMutation = mutationOptions({
  ...owner.apiMutation({
    mutationFn: (api, connectionId: string | null) =>
      connectionId === null ? api.agent.disableChannel() : api.agent.enableChannel({ payload: { connectionId } }),
  }),
  onSettled: (_channel, _error, _connectionId, _result, { client }) =>
    Promise.all([
      client.invalidateQueries({ queryKey: agentKeys.channel }),
      client.invalidateQueries({ queryKey: mcpKeys.servers }),
    ]),
})

/** Resident authority (ADR 0003), renewed by the read itself. */
export const residentQuery = owner.apiQuery({
  queryKey: agentKeys.resident,
  queryFn: (api) => api.resident.status(),
})

/** Revokes resident authority or enables it again; the answer is the new status. */
export const setResidentMutation = mutationOptions({
  ...owner.apiMutation({ mutationFn: (api, enabled: boolean) => api.resident.set({ payload: { enabled } }) }),
  onSuccess: (status, _enabled, _result, { client }) => client.setQueryData(residentQuery.queryKey, status),
})

/** What the Conversation `chat` sits under remembers; Personal's without a chat (ADR 0032). */
export const memoryQuery = (chat?: ChatId) =>
  owner.apiQuery({
    queryKey: agentKeys.memory(chat),
    queryFn: (api) => api.memory.status({ query: chat === undefined ? {} : { chat } }),
  })
