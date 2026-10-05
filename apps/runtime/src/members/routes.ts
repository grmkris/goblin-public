import { Schema } from 'effect'
import { AppContext, CreateConversation, UpdateConversation } from '@purrable/contracts'
import type { AgentRpc, MemberPrincipal, MemberRequest, RuntimeEnv } from '../env.ts'
import { readJson } from '../http/body.ts'
import { InvalidInput, NotFound } from '../http/errors.ts'
import { unwrap } from '../http/rpc.ts'
import { requireWorkspaceWrite } from '../workspaces/routes.ts'

const Bounded = (max: number) => Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(max))
const Submit = Schema.Struct({
  input: Bounded(20_000),
  operationId: Bounded(200),
  appContext: Schema.optional(Schema.Array(AppContext).check(Schema.isMaxLength(2))),
})
const Answer = Schema.Struct({ input: Bounded(20_000), operationId: Bounded(200), requestHash: Bounded(128) })
const response = async (
  agent: DurableObjectStub<AgentRpc>,
  principal: MemberPrincipal,
  input: MemberRequest,
  status = 200,
) =>
  new Response(unwrap(await agent.memberRequest(principal, input)), {
    status,
    headers: { 'content-type': 'application/json' },
  })

/** Principal is derived by the Worker from the authenticated session and live membership. */
export async function memberRoute(
  request: Request,
  env: RuntimeEnv,
  path: string,
  principal: MemberPrincipal,
  agent: DurableObjectStub<AgentRpc>,
): Promise<Response> {
  if (request.method !== 'GET') requireWorkspaceWrite(request, env.APP_URL)
  if (path === '/api/workspace/events' && request.method === 'GET')
    return agent.fetch(
      new Request('https://agent/members/workspace/events', {
        headers: { 'x-purrable-principal': JSON.stringify(principal) },
      }),
    )
  if (path === '/api/agent/usage' && request.method === 'GET') return response(agent, principal, { action: 'usage' })
  if (path === '/api/interactions' && request.method === 'GET')
    return response(agent, principal, { action: 'interactions' })
  if (path === '/api/access-requests' && request.method === 'POST') {
    const body = await readJson(request, Schema.Struct({ operationId: Bounded(200), message: Bounded(2000) }))
    return response(agent, principal, { action: 'request-access', ...body }, 202)
  }
  const interaction = /^\/api\/interactions\/([^/]{1,200})\/answer$/u.exec(path)?.[1]
  if (interaction !== undefined && request.method === 'POST') {
    const body = await readJson(request, Answer)
    return response(agent, principal, { action: 'answer', id: decodeURIComponent(interaction), ...body })
  }
  if (path === '/api/conversations') return conversationCollection(request, agent, principal)
  const [, id = '', action = ''] = /^\/api\/conversations\/(\d{1,12})(?:\/([a-z]+))?$/u.exec(path) ?? []
  if (id === '') throw new NotFound({ what: path })
  return conversationRoute(request, agent, principal, id, action)
}

async function conversationCollection(
  request: Request,
  agent: DurableObjectStub<AgentRpc>,
  principal: MemberPrincipal,
): Promise<Response> {
  if (request.method === 'GET') return response(agent, principal, { action: 'list' })
  if (request.method === 'POST') {
    const body = await readJson(request, CreateConversation)
    return response(
      agent,
      principal,
      { action: 'create', ...(body.from === undefined ? {} : { from: body.from }) },
      201,
    )
  }
  throw new NotFound({ what: 'conversation collection' })
}

async function conversationRoute(
  request: Request,
  agent: DurableObjectStub<AgentRpc>,
  principal: MemberPrincipal,
  session: string,
  action: string,
): Promise<Response> {
  const route = `${request.method} ${action}`
  if (route === 'POST messages') {
    const body = await readJson(request, Submit)
    return response(
      agent,
      principal,
      {
        action: 'submit',
        session,
        input: body.input,
        operationId: body.operationId,
        appContext: body.appContext ?? [],
      },
      202,
    )
  }
  if (route === 'GET events')
    return agent.fetch(
      new Request(`https://agent/members/${session}/events`, {
        headers: { 'x-purrable-principal': JSON.stringify(principal) },
      }),
    )
  if (route === 'GET snapshot') return response(agent, principal, { action: 'snapshot', session })
  if (route === 'GET history') {
    const before = Number(new URL(request.url).searchParams.get('before'))
    if (!Number.isSafeInteger(before) || before < 1) throw new InvalidInput({ reason: 'history_before' })
    return response(agent, principal, { action: 'history', session, before })
  }
  if (route === 'PATCH access') {
    const body = await readJson(
      request,
      Schema.Struct({ readers: Schema.Array(Bounded(200)).check(Schema.isMaxLength(16)) }),
    )
    return response(agent, principal, { action: 'readers', session, readers: body.readers })
  }
  if (route === 'POST stop') return response(agent, principal, { action: 'stop', session })
  if (route === 'GET capabilities') return response(agent, principal, { action: 'capabilities', session })
  if (route === 'PATCH ')
    return response(agent, principal, {
      action: 'update',
      session,
      change: await readJson(request, UpdateConversation),
    })
  throw new NotFound({ what: 'member conversation route' })
}
