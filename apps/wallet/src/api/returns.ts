import type { ReturnCheck } from '@goblin/wallet/contract'
import { json } from '../http.ts'
import { returnUrl } from '../oauth/validation.ts'
import type { ApiCall } from './call.ts'

/**
 * `GET /api/return-check?url=`: whether `/setup?return=` may send the owner back to `url`. Only to the origin of a
 * redirect URI of a client the owner connected or has a pending request with; anything else answers empty, and the
 * page ignores the return rather than become an open redirect.
 */
export async function returnCheck(call: ApiCall): Promise<Response> {
  const target = returnUrl(new URL(call.request.url).searchParams.get('url') ?? '')
  if (target === undefined) return json({} satisfies ReturnCheck)
  const origins = await call.auth.returnOrigins(call.owner.userId, Math.floor(Date.now() / 1000))
  const answer: ReturnCheck = origins.includes(target.origin) ? { url: target.href, host: target.host } : {}
  return json(answer)
}
