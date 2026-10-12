// Query hooks over the `WalletApi` the app was given. Pages never fetch themselves.
import { QueryClient, QueryClientProvider, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { ApprovalDecision, WalletLimits } from '@goblin/wallet/contract'
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
export const useStatus = () => {
  const api = useApi()
  return useQuery({ queryKey: ['status'], queryFn: api.status })
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

export function useCreateAgent() {
  const api = useApi()
  const client = useQueryClient()
  return useMutation({
    mutationFn: api.createAgent,
    onSuccess: (me) => client.setQueryData(['me'], me),
  })
}
