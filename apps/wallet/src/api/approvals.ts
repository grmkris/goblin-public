import { ApprovalDecision } from '@goblin/wallet/contract'
import { apiError, json } from '../http.ts'
import { type ApiCall, readBody } from './call.ts'

const missing = (id: string): Response => apiError('unknown_approval', `No approval for ${id}.`, 404)

/** `GET /api/approvals/:operationId`: what the Approve page shows; the page rebuilds the terms hash itself. */
export async function approval(call: ApiCall): Promise<Response> {
  const id = call.params['operationId'] ?? ''
  const view = await call.ledger.approval(id)
  return view === undefined ? missing(id) : json(view)
}

/** `POST /api/approvals/:operationId`: the owner's decision, bound to the terms hash they saw. */
export async function decide(call: ApiCall): Promise<Response> {
  const id = call.params['operationId'] ?? ''
  const body = await readBody(call.request, ApprovalDecision)
  if (!body.ok) return body.response
  const result = await call.ledger.decide(id, body.value)
  if (result.ok) return json(result.approval)
  if (result.code === 'unknown_approval') return missing(id)
  if (result.code === 'terms_changed')
    return apiError(
      'terms_changed',
      'The terms are not the ones you saw. Reload and review them again.',
      409,
      'Nothing was approved.',
    )
  return apiError('approval_closed', `This approval is already ${result.approval?.status ?? 'closed'}.`, 409)
}
