import type { ApprovalDecision, ApprovalView, UrlRequestView } from '@goblin/contracts'
import { mutationOptions, queryOptions } from '@tanstack/react-query'
import { owner } from '../lib/api.ts'

/** Every read of what is held for the owner: keys are `['approvals', kind, input]`. */
const approvalKeys = {
  detail: (id: string) => ['approvals', 'detail', id] as const,
  url: (id: string) => ['approvals', 'url', id] as const,
}

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

/**
 * The owner's decision on held call `id`; its answer is the call as it now stands. `runUpTo` also sets the paid tool's
 * spending rule (ADR 0044), so the connection's spending is read again.
 */
export const decideApprovalMutation = (id: string) =>
  mutationOptions({
    ...owner.apiMutation({
      mutationFn: (api, decision: ApprovalDecision) => api.mcp.decideApproval({ params: { id }, payload: decision }),
    }),
    onSuccess: (view, decision, _result, { client }) => {
      client.setQueryData(approvalKeys.detail(id), view)
      if (decision.runUpTo !== undefined)
        return client.invalidateQueries({ queryKey: ['mcp', 'spending', view.connectionId] })
      return undefined
    },
  })

/** Whether a URL request still waits: on the owner, or on its retry. */
const awaitingUrl = (view: UrlRequestView | undefined): boolean =>
  view === undefined || view.state === 'pending' || view.state === 'retrying'

/** A URL request (ADR 0042) and where it stands; read every five seconds while it still waits. */
export const urlRequestQuery = (id: string) =>
  queryOptions({
    ...owner.apiQuery({
      queryKey: approvalKeys.url(id),
      queryFn: (api) => api.mcp.urlRequest({ params: { id } }),
    }),
    refetchInterval: (query) => (awaitingUrl(query.state.data) ? 5000 : false),
  })

/** The owner finished the server's step (`accept`) or cancels it (`decline`); the answer is the request as it stands. */
export const answerUrlRequestMutation = (id: string) =>
  mutationOptions({
    ...owner.apiMutation({
      mutationFn: (api, action: 'accept' | 'decline') =>
        api.mcp.answerUrlRequest({ params: { id }, payload: { action } }),
    }),
    onSuccess: (view, _action, _result, { client }) => client.setQueryData(approvalKeys.url(id), view),
  })
