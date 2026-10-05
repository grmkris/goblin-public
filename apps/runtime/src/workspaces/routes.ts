import { Schema } from 'effect'
import type { RuntimeEnv } from '../env.ts'
import type { UserSession } from '../auth/service.ts'
import { readJson } from '../http/body.ts'
import { Forbidden, NotFound } from '../http/errors.ts'
import { selectWorkspace, workspaceState } from './resolution.ts'

export function requireWorkspaceWrite(request: Request, appUrl: string): void {
  if (request.headers.get('origin') !== new URL(appUrl).origin || request.headers.get('x-purrable-csrf') !== '1')
    throw new Forbidden({ reason: 'workspace write origin' })
}
const Selection = Schema.Struct({
  workspaceId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200)),
  context: Schema.NullOr(Schema.String),
})
export async function workspaceApi(request: Request, env: RuntimeEnv, session: UserSession): Promise<Response> {
  const path = new URL(request.url).pathname
  if (path === '/api/workspaces' && request.method === 'GET') return Response.json(await workspaceState(env, session))
  if (path === '/api/workspaces/active' && request.method === 'POST') {
    requireWorkspaceWrite(request, env.APP_URL)
    const body = await readJson(request, Selection)
    return Response.json(await selectWorkspace(env, session, body.workspaceId, body.context))
  }
  throw new NotFound({ what: 'workspace route' })
}
