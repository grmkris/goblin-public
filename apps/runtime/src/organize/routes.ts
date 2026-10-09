import type { AgentRpc } from '../env.ts'
import { NotFound } from '../http/errors.ts'
import { unwrap } from '../http/rpc.ts'

/**
 * `/api/organize` (ADR 0033): `GET` lists what organizing changed, newest first; `POST /api/organize/:id/undo` puts
 * the target back as it was. Undo is 409 `touched` once anything changed the target since, and 409 `undone` after.
 */
export async function organizeRoute(
  request: Request,
  agent: DurableObjectStub<AgentRpc>,
  path: string,
): Promise<Response> {
  if (path === '/api/organize' && request.method === 'GET') return Response.json(unwrap(await agent.organizeReceipts()))
  const [, id = ''] = /^\/api\/organize\/(org_[0-9a-f]{32})\/undo$/u.exec(path) ?? []
  if (id !== '' && request.method === 'POST') return Response.json(unwrap(await agent.undoOrganize(id)))
  throw new NotFound({ what: 'organize route' })
}
