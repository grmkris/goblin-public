import { mutationOptions } from '@tanstack/react-query'
import type { OnboardingChange, OnboardingConnect } from '@goblin/contracts'
import * as Effect from 'effect/Effect'
import { owner } from '../lib/api.ts'

/** First-run Start (ADR 0048) on the owner API. Keys are `['onboarding', kind]`. */
export const onboardingKeys = {
  state: ['onboarding', 'state'] as const,
  view: ['onboarding', 'view'] as const,
}

/** Whether Start still stands before the chats: cheap, read by the gate on every channel. */
export const onboardingStateQuery = owner.apiQuery({
  queryKey: onboardingKeys.state,
  queryFn: (api) => api.onboarding.state(),
})

/** Every step's state, read live from the wallet and Mercator. */
export const onboardingQuery = owner.apiQuery({
  queryKey: onboardingKeys.view,
  queryFn: (api) => api.onboarding.view(),
})

/** The owner finishes, skips or reopens Start, or goes through a step; the view and the gate's state follow. */
export const changeOnboardingMutation = mutationOptions({
  ...owner.apiMutation({
    mutationFn: (api, change: OnboardingChange) => api.onboarding.change({ payload: change }),
  }),
  onSuccess: (view, _change, _result, { client }) => {
    client.setQueryData(onboardingQuery.queryKey, view)
    client.setQueryData(onboardingStateQuery.queryKey, { status: view.status })
  },
})

/**
 * Signs the owner in to a server from Start, to come back to its step (allowing its recommended tools on the way when
 * asked): an authorization URL to send them to, or none when it connected at once, and Start reads its state again.
 */
export const startConnectMutation = mutationOptions({
  ...owner.apiMutation({
    mutationFn: (api, request: OnboardingConnect) => api.onboarding.connect({ payload: request }),
  }),
  onSuccess: (started, _request, _result, { client }) =>
    started.authorizationUrl === undefined
      ? Promise.all([
          client.invalidateQueries({ queryKey: onboardingKeys.view }),
          client.invalidateQueries({ queryKey: ['mcp', 'servers'] }),
        ])
      : undefined,
})

/** Adds a suggested server from Start's More services and signs in to it, back to that step; nothing allowed yet. */
export const startAddMutation = mutationOptions({
  ...owner.apiMutation({
    mutationFn: (api, endpoint: string) =>
      Effect.flatMap(api.mcp.addServer({ payload: { endpoint } }), (added) =>
        api.onboarding.connect({ payload: { connectionId: added.connectionId, step: 'more', recommend: false } }),
      ),
  }),
  onSuccess: (started, _endpoint, _result, { client }) =>
    started.authorizationUrl === undefined ? client.invalidateQueries({ queryKey: ['mcp', 'servers'] }) : undefined,
})
