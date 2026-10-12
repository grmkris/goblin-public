import { WalletLimits } from '@goblin/wallet/contract'
import { apiError, json } from '../http.ts'
import { readLimits } from '../services/programs/status.ts'
import { answerWith, type ApiCall, readBody } from './call.ts'

/** `GET /api/limits`: every limit with the layer that enforces it. */
export const limits = (call: ApiCall) => answerWith(call, readLimits)

/** `PUT /api/limits`: the owner's ledger limits. The version in the body is ignored; each write makes the next. */
export async function setLimits(call: ApiCall): Promise<Response> {
  const body = await readBody(call.request, WalletLimits)
  if (!body.ok) return body.response
  const { perCall, perHour, perWeek, expiresAt } = body.value
  const written = await call.ledger.setLimits({ perCall, perHour, perWeek, expiresAt })
  if (written === undefined)
    return apiError(
      'invalid_limits',
      'The limits must grow from per call to per hour to per week, and expiry must be a date.',
      400,
    )
  return json(written)
}
