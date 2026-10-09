import { CreateTopic, UpdateTopic } from '@goblin/contracts'
import type { AgentRpc } from '../env.ts'
import { readJson } from '../http/body.ts'
import { NotFound } from '../http/errors.ts'
import { unwrap } from '../http/rpc.ts'

/**
 * `/api/topics` (ADR 0032): `GET` lists the owner's Topics, `POST` creates one (the same operation id finds the same
 * Topic; 201 either way, with the Topic as it is now), `PATCH /api/topics/:id` renames, archives, restores or changes
 * its search opt-out. A name another active Topic has is 409; archiving Personal is 400.
 */
export async function topicRoute(
  request: Request,
  agent: DurableObjectStub<AgentRpc>,
  path: string,
): Promise<Response> {
  if (path === '/api/topics' && request.method === 'GET') return Response.json(unwrap(await agent.topics()))
  if (path === '/api/topics' && request.method === 'POST')
    return Response.json(unwrap(await agent.createTopic(await readJson(request, CreateTopic))), { status: 201 })
  const [, id = ''] = /^\/api\/topics\/([1-9]\d{0,8})$/u.exec(path) ?? []
  if (id === '' || request.method !== 'PATCH') throw new NotFound({ what: 'topic route' })
  return Response.json(unwrap(await agent.updateTopic(Number(id), await readJson(request, UpdateTopic))))
}
