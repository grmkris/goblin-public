import { mutationOptions } from '@tanstack/react-query'
import type { CapabilityChange } from '@goblin/contracts'
import { owner } from '../lib/api.ts'
import { applyChange } from '../lib/capabilities.ts'

/** A conversation's switches (ADR 0033) on the owner API: keys are `['capabilities', chat]`. */
const capabilityKeys = { chat: (chat: string) => ['capabilities', chat] as const }

export const capabilitiesQuery = (chat: string) =>
  owner.apiQuery({
    queryKey: capabilityKeys.chat(chat),
    queryFn: (api) => api.conversations.capabilities({ params: { id: chat } }),
  })

/** One switch (or a reset to the parent's): shown at once, then the agent's answer, or read again if it refused. */
export const setCapabilityMutation = (chat: string) =>
  mutationOptions({
    ...owner.apiMutation({
      mutationFn: (api, change: CapabilityChange) =>
        // The client takes each variant of the change on its own.
        'reset' in change
          ? api.conversations.setCapability({ params: { id: chat }, payload: change })
          : api.conversations.setCapability({ params: { id: chat }, payload: change }),
    }),
    onMutate: async (change: CapabilityChange, { client }) => {
      const { queryKey } = capabilitiesQuery(chat)
      await client.cancelQueries({ queryKey })
      client.setQueryData(queryKey, (view) => (view === undefined ? view : applyChange(view, change)))
    },
    onError: (_error, _change, _result, { client }) =>
      client.invalidateQueries({ queryKey: capabilityKeys.chat(chat) }),
    onSuccess: (view, _change, _result, { client }) => client.setQueryData(capabilitiesQuery(chat).queryKey, view),
  })
