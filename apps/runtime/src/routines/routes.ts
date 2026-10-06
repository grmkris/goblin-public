import { RoutineEdit, RoutineProposal, RoutineRevision, RoutineSettings, RoutineManualRun } from '@goblin/contracts'
import { NotFound } from '../http/errors.ts'
import { readJson } from '../http/body.ts'
import { unwrap } from '../http/rpc.ts'
import type { AgentRpc } from '../env.ts'

const rootRoutes: Readonly<
  Record<string, (request: Request, agent: DurableObjectStub<AgentRpc>) => Promise<Response>>
> = {
  'GET /api/routines': async (_request, agent) => Response.json(unwrap(await agent.routines())),
  'POST /api/routines': async (request, agent) =>
    Response.json(unwrap(await agent.routinePropose(await readJson(request, RoutineProposal))), { status: 201 }),
  'GET /api/routines/settings': async (_request, agent) => Response.json(unwrap(await agent.routineSettings())),
  'PUT /api/routines/settings': async (request, agent) =>
    Response.json(unwrap(await agent.routineSettingsSet(await readJson(request, RoutineSettings)))),
}
const itemRoutes: Readonly<
  Record<string, (request: Request, agent: DurableObjectStub<AgentRpc>, id: string) => Promise<Response>>
> = {
  'PATCH ': async (request, agent, id) =>
    Response.json(unwrap(await agent.routineEdit(id, await readJson(request, RoutineEdit)))),
  'DELETE ': async (request, agent, id) =>
    Response.json(unwrap(await agent.routineChange(id, await readJson(request, RoutineRevision), 'archive'))),
  'POST confirm': async (request, agent, id) =>
    Response.json(unwrap(await agent.routineChange(id, await readJson(request, RoutineRevision), 'confirm'))),
  'POST pause': async (request, agent, id) =>
    Response.json(unwrap(await agent.routineChange(id, await readJson(request, RoutineRevision), 'pause'))),
  'POST run': async (request, agent, id) =>
    Response.json(unwrap(await agent.routineRun(id, await readJson(request, RoutineManualRun))), { status: 202 }),
  'GET runs': async (_request, agent, id) => Response.json(unwrap(await agent.routineRuns(id))),
}
export async function routineRoute(
  request: Request,
  agent: DurableObjectStub<AgentRpc>,
  path: string,
): Promise<Response> {
  const root = rootRoutes[`${request.method} ${path}`]
  if (root !== undefined) return root(request, agent)
  const [, id = '', action = ''] =
    /^\/api\/routines\/(rt_[\w-]{1,100})(?:\/(confirm|pause|run|runs))?$/u.exec(path) ?? []
  const route = itemRoutes[`${request.method} ${action}`]
  if (id === '' || route === undefined) throw new NotFound({ what: 'routine route' })
  return route(request, agent, id)
}
