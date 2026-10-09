import { CreatePersona, UpdatePersona } from '@goblin/contracts'
import type { AgentRpc } from '../env.ts'
import { readJson } from '../http/body.ts'
import { NotFound } from '../http/errors.ts'
import { unwrap } from '../http/rpc.ts'

/**
 * `/api/personas` (ADR 0033): `GET` lists the owner's Personas (archived ones too), `POST` creates one (the same
 * operation id finds the same Persona; 201 either way), `GET /api/personas/:id` is one with its revisions, and
 * `PATCH` writes a new revision: `expectedRevision` must be the current one (409 otherwise). A name another active
 * Persona has is 409; a model the deployment does not offer is 400.
 */
export async function personaRoute(
  request: Request,
  agent: DurableObjectStub<AgentRpc>,
  path: string,
): Promise<Response> {
  if (path === '/api/personas' && request.method === 'GET') return Response.json(unwrap(await agent.personas()))
  if (path === '/api/personas' && request.method === 'POST')
    return Response.json(unwrap(await agent.createPersona(await readJson(request, CreatePersona))), { status: 201 })
  const [, id = ''] = /^\/api\/personas\/([1-9]\d{0,8})$/u.exec(path) ?? []
  if (id !== '' && request.method === 'GET') return Response.json(unwrap(await agent.personaDetail(Number(id))))
  if (id !== '' && request.method === 'PATCH')
    return Response.json(unwrap(await agent.updatePersona(Number(id), await readJson(request, UpdatePersona))))
  throw new NotFound({ what: 'persona route' })
}
