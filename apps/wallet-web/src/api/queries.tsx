// Query hooks over the `WalletApi` the app was given. Pages never fetch themselves.
import { QueryClient, QueryClientProvider, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { ApprovalDecision, DepositRequest, WalletLimits } from '@goblin/wallet/contract'
import { createContext, type ReactNode, use, useState } from 'react'
import type { WalletApi } from './types.ts'

const ApiContext = createContext<WalletApi | undefined>(undefined)

export function ApiProvider({ api, children }: { readonly api: WalletApi; readonly children: ReactNode }) {
  const [client] = useState(
    () => new QueryClient({ defaultOptions: { queries: { staleTime: 10_000, retry: 1, refetchOnWindowFocus: true } } }),
  )
  return (
    <ApiContext value={api}>
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    </ApiContext>
  )
}

export function useApi(): WalletApi {
  const api = use(ApiContext)
  if (api === undefined) throw new Error('api_provider_missing')
  return api
}

export const useMe = (enabled = true) => {
  const api = useApi()
  return useQuery({ queryKey: ['me'], queryFn: api.me, enabled })
}
/** `refetchInterval` while something is expected to change the balances (a deposit on its way). */
export const useStatus = (refetchInterval: number | false = false) => {
  const api = useApi()
  return useQuery({ queryKey: ['status'], queryFn: api.status, refetchInterval })
}
export const useLimits = () => {
  const api = useApi()
  return useQuery({ queryKey: ['limits'], queryFn: api.limits })
}
export const useActivity = () => {
  const api = useApi()
  return useQuery({ queryKey: ['activity'], queryFn: api.activity, refetchInterval: 15_000 })
}
export const useApproval = (operationId: string) => {
  const api = useApi()
  return useQuery({ queryKey: ['approval', operationId], queryFn: () => api.approval(operationId) })
}
export const useServices = () => {
  const api = useApi()
  return useQuery({ queryKey: ['services'], queryFn: api.services })
}
export const useAddressBook = () => {
  const api = useApi()
  return useQuery({ queryKey: ['address-book'], queryFn: api.addressBook })
}
export const useConnections = () => {
  const api = useApi()
  return useQuery({ queryKey: ['connections'], queryFn: api.connections })
}
export const usePolicyChanges = () => {
  const api = useApi()
  return useQuery({ queryKey: ['policy-changes'], queryFn: api.policyChanges })
}
export const useOAuthRequest = (id: string) => {
  const api = useApi()
  return useQuery({ queryKey: ['oauth-request', id], queryFn: () => api.oauthRequest(id), retry: false })
}

export function useSetLimits() {
  const api = useApi()
  const client = useQueryClient()
  return useMutation({
    mutationFn: (limits: WalletLimits) => api.setLimits(limits),
    onSuccess: async () => {
      await client.invalidateQueries()
    },
  })
}
export function useDecide(operationId: string) {
  const api = useApi()
  const client = useQueryClient()
  return useMutation({
    mutationFn: (decision: ApprovalDecision) => api.decide(operationId, decision),
    onSuccess: async (view) => {
      client.setQueryData(['approval', operationId], view)
      await client.invalidateQueries({ queryKey: ['activity'] })
    },
  })
}
/** Checks an uncertain operation against the chain; activity and status follow whatever it settled or released. */
export function useCheckOperation() {
  const api = useApi()
  const client = useQueryClient()
  return useMutation({
    mutationFn: (operationId: string) => api.checkOperation(operationId),
    onSuccess: async () => {
      await Promise.all([
        client.invalidateQueries({ queryKey: ['activity'] }),
        client.invalidateQueries({ queryKey: ['status'] }),
        client.invalidateQueries({ queryKey: ['limits'] }),
      ])
    },
  })
}
export function useDecidePolicyChange(id: string) {
  const api = useApi()
  const client = useQueryClient()
  return useMutation({
    mutationFn: (decision: 'applied' | 'dismissed') => api.decidePolicyChange(id, decision),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: ['policy-changes'] })
    },
  })
}
export function useOAuthDecide(id: string) {
  const api = useApi()
  return useMutation({ mutationFn: (decision: 'approve' | 'deny') => api.oauthDecide(id, decision) })
}
/** Keeps a consent request pending while its page is open; each answer replaces the page's view of it. */
export function useOAuthKeepAlive(id: string) {
  const api = useApi()
  const client = useQueryClient()
  return useMutation({
    mutationFn: () => api.oauthKeepAlive(id),
    onSuccess: (view) => client.setQueryData(['oauth-request', id], view),
  })
}
/** Whether setup may send the owner back to `url`; nothing is asked when there is no `url`. */
export const useReturnCheck = (url: string | undefined) => {
  const api = useApi()
  return useQuery({
    queryKey: ['return-check', url],
    queryFn: () => api.returnCheck(url ?? ''),
    enabled: url !== undefined,
    staleTime: Number.POSITIVE_INFINITY,
    retry: false,
  })
}
export function useDisconnect() {
  const api = useApi()
  const client = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => api.disconnect(id),
    onSuccess: (connections) => client.setQueryData(['connections'], connections),
  })
}
export function useRevokeAll() {
  const api = useApi()
  const client = useQueryClient()
  return useMutation({
    mutationFn: api.revokeAll,
    onSuccess: async () => {
      await client.invalidateQueries()
    },
  })
}

export function useDeposit() {
  const api = useApi()
  return useMutation({ mutationFn: (request: DepositRequest) => api.deposit(request) })
}

/** Relay's answers after which a deposit address has nothing more to report. */
const DEPOSIT_DONE: ReadonlySet<string> = new Set(['success', 'refunded', 'failed'])

/**
 * Relay's progress for one deposit address, every five seconds while `follow` holds and Relay has not answered with an
 * outcome. Each answer also refreshes the balances: Relay's status is best effort, and the owner's balance on Base
 * rising is arrival too.
 */
export function useDepositStatus(depositAddress: string | undefined, follow: boolean) {
  const api = useApi()
  const client = useQueryClient()
  return useQuery({
    queryKey: ['deposit', depositAddress],
    queryFn: async () => {
      if (depositAddress === undefined) throw new Error('No deposit to follow.')
      const status = await api.depositStatus(depositAddress)
      await client.invalidateQueries({ queryKey: ['status'] })
      return status
    },
    enabled: depositAddress !== undefined,
    refetchInterval: (query) => (follow && !DEPOSIT_DONE.has(query.state.data?.status ?? 'waiting') ? 5_000 : false),
  })
}
