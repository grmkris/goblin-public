import type { ApprovalView } from '@goblin/contracts'
import { type QueryClient, mutationOptions, queryOptions } from '@tanstack/react-query'
import { owner } from '../lib/api.ts'

/** Every approval read: keys are `['approvals', kind, input]`. */
export const approvalKeys = { detail: (id: string) => ['approvals', 'detail', id] as const }

/** Whether a held call still waits on its way: not yet decided, or decided and not yet run. */
const awaitingApproval = (view: ApprovalView | undefined): boolean =>
  view === undefined || view.state === 'pending' || view.state === 'approved' || view.state === 'dispatching'

/** A held MCP call and where it stands; read every five seconds while it still waits. */
export const approvalQuery = (id: string) =>
  queryOptions({
    ...owner.apiQuery({
      queryKey: approvalKeys.detail(id),
      queryFn: (api) => api.mcp.approval({ params: { id } }),
    }),
    refetchInterval: (query) => (awaitingApproval(query.state.data) ? 5000 : false),
  })

/** The owner's decision on held call `id`; its answer is the call as it now stands. */
export const decideApprovalMutation = (queryClient: QueryClient, id: string) =>
  mutationOptions({
    ...owner.apiMutation({
      mutationFn: (api, allowed: boolean) => api.mcp.decideApproval({ params: { id }, payload: { allowed } }),
    }),
    onSuccess: (view) => queryClient.setQueryData(approvalKeys.detail(id), view),
  })
