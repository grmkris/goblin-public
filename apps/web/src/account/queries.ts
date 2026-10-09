import { type QueryClient, mutationOptions, queryOptions, skipToken } from '@tanstack/react-query'
import { account } from '../lib/api.ts'

/**
 * The account's plan and its inbound clients, answered by the Worker (`AccountApi`): keys are `[feature, kind,
 * input]`, and each change refreshes what it changed before it settles.
 */
const billingStateKey = ['billing', 'state'] as const
const clientsKey = ['clients', 'list'] as const

/** The plan as it stands. */
export const billingStateQuery = account.apiQuery({
  queryKey: billingStateKey,
  queryFn: (api) => api.billing.state(),
})
/** The plan, read only once someone is signed in; before then the key holds nothing. */
export const signedInBillingQuery = (signedIn: boolean) =>
  queryOptions({ queryKey: billingStateKey, queryFn: signedIn ? billingStateQuery.queryFn : skipToken })

/** Opens a Pro checkout; the page goes there, so nothing here needs refreshing. */
export const checkoutMutation = account.apiMutation({ mutationFn: (api, _: void) => api.billing.checkout() })
/** The payment provider's portal for an account that has paid before. */
export const portalMutation = account.apiMutation({ mutationFn: (api, _: void) => api.billing.portal() })

/** The MCP clients the owner let use their agent. */
export const clientsQuery = account.apiQuery({ queryKey: clientsKey, queryFn: (api) => api.clients.list() })

/** Ends one client's access at once. */
export const revokeClientMutation = (queryClient: QueryClient) =>
  mutationOptions({
    ...account.apiMutation({
      mutationFn: (api, clientId: string) => api.clients.revoke({ params: { clientId } }),
    }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: clientsKey }),
  })
