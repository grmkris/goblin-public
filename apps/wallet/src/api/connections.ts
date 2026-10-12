import { disconnect, listConnections, revokeOwnerConnections } from '../oauth/access.ts'
import { json } from '../http.ts'
import type { ApiCall } from './call.ts'
import { readMe } from './me.ts'

export const connections = async (call: ApiCall): Promise<Response> =>
  json(await listConnections(call.auth, call.owner.userId))

export const disconnectOne = async (call: ApiCall): Promise<Response> =>
  json(await disconnect(call.auth, call.owner.userId, call.params['id'] ?? ''))

/**
 * `POST /api/revoke`: the kill switch. The ledger refuses every new spend and closes what has not started, and every
 * MCP connection stops at once. On-chain allowances are revoked by the owner's own signature in the app.
 */
export async function revokeAll(call: ApiCall): Promise<Response> {
  await call.ledger.revoke()
  await revokeOwnerConnections(call.auth, call.owner.userId)
  return json(await readMe(call))
}
