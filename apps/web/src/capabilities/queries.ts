import { type QueryClient, mutationOptions } from '@tanstack/react-query'
import type { CapabilityChange } from '@goblin/contracts'
import { owner } from '../lib/api.ts'
import { applyChange } from '../lib/capabilities.ts'

/**
 * A conversation's switches (ADR 0033) on the owner API. The key sits under `conversations`, so whatever refreshes a
 * conversation refreshes its switches too.
 */
export const capabilitiesQuery = (chat: string) =>
  owner.apiQuery({
    queryKey: ['conversations', 'capabilities', chat],
    queryFn: (api) => api.conversations.capabilities({ params: { id: chat } }),
  })

/** One switch (or a reset to the parent's): shown at once, then the agent's answer, or read again if it refused. */
export const setCapabilityMutation = (queryClient: QueryClient, chat: string) =>
  mutationOptions({
    ...owner.apiMutation({
      mutationFn: (api, change: CapabilityChange) =>
        // The client takes each variant of the change on its own.
        'reset' in change
          ? api.conversations.setCapability({ params: { id: chat }, payload: change })
          : api.conversations.setCapability({ params: { id: chat }, payload: change }),
    }),
    onMutate: async (change: CapabilityChange) => {
      const { queryKey } = capabilitiesQuery(chat)
      await queryClient.cancelQueries({ queryKey })
      queryClient.setQueryData(queryKey, (view) => (view === undefined ? view : applyChange(view, change)))
    },
    onError: () => queryClient.invalidateQueries({ queryKey: capabilitiesQuery(chat).queryKey }),
    onSuccess: (view) => queryClient.setQueryData(capabilitiesQuery(chat).queryKey, view),
  })
