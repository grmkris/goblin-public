import { mutationOptions, queryOptions, skipToken } from '@tanstack/react-query'
import type { BillingId, OnboardingChange, OnboardingConnect, OnboardingState, OnboardingView } from '@goblin/contracts'
import * as Effect from 'effect/Effect'
import { account, owner } from '../lib/api.ts'

/** First-run Start (ADR 0048) on the owner API. Keys are `['onboarding', kind]`. */
export const onboardingKeys = {
  state: ['onboarding', 'state'] as const,
  view: ['onboarding', 'view'] as const,
}

/** Whether Start still stands before the chats, and its first open step: cheap once kept, read by the shell. */
export const onboardingStateQuery = owner.apiQuery({
  queryKey: onboardingKeys.state,
  queryFn: (api) => api.onboarding.state(),
})
/**
 * Start's state, read only once someone is signed in (beside the plan, not after it); before then the key holds
 * nothing. A refusal never sends anyone to sign in: the page's own gate decides that.
 */
export const signedInStartQuery = (signedIn: boolean) =>
  queryOptions({
    queryKey: onboardingKeys.state,
    queryFn: signedIn ? onboardingStateQuery.queryFn : skipToken,
    meta: { auth: 'optional' },
  })

/** Every step's state, read live from the wallet and Mercator. */
export const onboardingQuery = owner.apiQuery({
  queryKey: onboardingKeys.view,
  queryFn: (api) => api.onboarding.view(),
})

/** The gate's answer from Start's whole view: its status and, while it is open, the first step still to do. */
export const stateOf = (view: OnboardingView): OnboardingState => {
  const step = view.status === 'open' ? view.steps.find((each) => !each.done)?.id : undefined
  return step === undefined ? { status: view.status } : { status: view.status, step }
}

/** The owner finishes or skips Start, goes through a step, or records the kickoff; the view and the gate follow. */
export const changeOnboardingMutation = mutationOptions({
  ...owner.apiMutation({
    mutationFn: (api, change: OnboardingChange) => api.onboarding.change({ payload: change }),
  }),
  onSuccess: (view, _change, _result, { client }) => {
    client.setQueryData(onboardingQuery.queryKey, view)
    client.setQueryData(onboardingStateQuery.queryKey, stateOf(view))
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

/** Adds a suggested server from Start's services step and signs in to it, back to that step; nothing allowed yet. */
export const startAddMutation = mutationOptions({
  ...owner.apiMutation({
    mutationFn: (api, endpoint: string) =>
      Effect.flatMap(api.mcp.addServer({ payload: { endpoint } }), (added) =>
        api.onboarding.connect({ payload: { connectionId: added.connectionId, step: 'services', recommend: false } }),
      ),
  }),
  onSuccess: (started, _endpoint, _result, { client }) =>
    started.authorizationUrl === undefined ? client.invalidateQueries({ queryKey: ['mcp', 'servers'] }) : undefined,
})

/**
 * Pays for goblin Pro from the Goblin Wallet the way the owner chose (ADR 0054): the page goes to sign it once, and the
 * wallet's return (`/subscribe/success`, which confirms it) brings them back to Start's wallet step.
 */
export const startPlanMutation = account.apiMutation({
  mutationFn: (api, plan: BillingId) => api.billing.walletStart({ payload: { plan, return: '/start/wallet' } }),
})
