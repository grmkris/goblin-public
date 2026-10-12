import { PolicyChangeDecision } from '@goblin/wallet/contract'
import { apiError, json } from '../http.ts'
import { type ApiCall, readBody } from './call.ts'

/** `GET /api/policy-changes`: what the agent asked to change, newest first. */
export const policyChanges = async (call: ApiCall): Promise<Response> => json(await call.ledger.policyChanges())

/** `POST /api/policy-changes/:id`: the owner marks a pending request done or dismisses it. */
export async function decidePolicyChange(call: ApiCall): Promise<Response> {
  const id = call.params['id'] ?? ''
  const body = await readBody(call.request, PolicyChangeDecision)
  if (!body.ok) return body.response
  const result = await call.ledger.decidePolicyChange(id, body.value.decision)
  if (result.ok) return json(result.change)
  if (result.code === 'unknown_policy_change') return apiError('unknown_policy_change', `No request for ${id}.`, 404)
  return apiError('policy_change_closed', 'You already answered this request.', 409)
}
