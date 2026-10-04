import * as Schema from 'effect/Schema'
import type { AgentRpc, RuntimeEnv } from './env.ts'
import {
  handleAuth,
  listInboundClients,
  protectedResourceMetadata,
  requireUserSession,
  revokeInboundClient,
} from './auth/index.ts'
import { signupMode } from './auth/options.ts'
import { readJson } from './http/body.ts'
import { Forbidden, InvalidInput, NotFound } from './http/errors.ts'
import { failureResponse, requestIdOf, secured } from './http/respond.ts'
import { unwrap } from './http/rpc.ts'
import { handleInboundMcp } from './inbound/route.ts'

export { PersonalAgent } from './agent.ts'

const Bounded = (max: number) => Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(max))
const Submit = Schema.Struct({ input: Bounded(20_000), operationId: Bounded(200) })
const Stop = Schema.Struct({ operationId: Schema.optional(Bounded(200)) })
const ToolCall = Schema.Struct({
  name: Bounded(256),
  arguments: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
})
const ResourceRead = Schema.Struct({ uri: Bounded(2048) })
const PromptGet = Schema.Struct({
  name: Bounded(256),
  arguments: Schema.optional(Schema.Record(Schema.String, Schema.String.check(Schema.isMaxLength(16_384)))),
})
const GrantChange = Schema.Struct({ serverId: Bounded(64), name: Bounded(256), allowed: Schema.Boolean })
const ResidentChange = Schema.Struct({ enabled: Schema.Boolean })

const json = (value: unknown, status = 200): Response => Response.json(value, { status })
/** Every user has their own agent object, named by their user ID. */
const agentOf = (env: RuntimeEnv, userId: string): DurableObjectStub<AgentRpc> => env.AGENTS.getByName(userId)

type Route = (request: Request, agent: DurableObjectStub<AgentRpc>) => Promise<Response>

const waitRoute: Route = async (request, agent) => {
  const operationId = new URL(request.url).searchParams.get('operationId') ?? ''
  if (operationId.length === 0 || operationId.length > 200) throw new InvalidInput({ reason: 'operationId' })
  return json(unwrap(await agent.wait(operationId)))
}

/** The conversation and resident-authority routes, keyed `METHOD path`. */
const agentRoutes: Readonly<Record<string, Route>> = {
  'POST /api/agent': async (request, agent) => {
    const body = await readJson(request, Submit)
    return json(unwrap(await agent.submit(body.input, body.operationId)), 202)
  },
  'POST /api/agent/stop': async (request, agent) =>
    json({ stopped: unwrap(await agent.stop((await readJson(request, Stop)).operationId)) }),
  'GET /api/agent/wait': waitRoute,
  'GET /api/agent/events': (_request, agent) => agent.fetch('https://agent/events'),
  'GET /api/agent/snapshot': (_request, agent) => agent.fetch('https://agent/snapshot'),
  'GET /api/agent/resident': async (_request, agent) => json(unwrap(await agent.residentStatus())),
  'GET /api/agent/usage': async (_request, agent) => json(unwrap(await agent.usageToday())),
  'POST /api/agent/resident': async (request, agent) =>
    json(unwrap(await agent.residentSet((await readJson(request, ResidentChange)).enabled))),
}

async function agentRoute(request: Request, agent: DurableObjectStub<AgentRpc>, path: string): Promise<Response> {
  const route = agentRoutes[`${request.method} ${path}`]
  if (route === undefined) throw new NotFound({ what: path })
  return route(request, agent)
}

/** Completes an outbound OAuth authorization, then sends the owner back to the Connections page. */
async function oauthCallback(request: Request, agent: DurableObjectStub<AgentRpc>, env: RuntimeEnv) {
  const params = new URL(request.url).searchParams
  const target = new URL('/connections', env.APP_URL)
  const state = params.get('state')
  const code = params.get('code')
  if (params.get('error') !== null || state === null || code === null) {
    target.searchParams.set('error', params.get('error') ?? 'authorization_failed')
    return Response.redirect(target.href, 302)
  }
  const issuer = params.get('iss') ?? undefined
  const result = await agent.mcpFinishConnect(state, code, issuer)
  if (result.ok) target.searchParams.set('connected', result.value)
  else target.searchParams.set('error', result.error._tag)
  return Response.redirect(target.href, 302)
}

async function mcpServerRoute(request: Request, agent: DurableObjectStub<AgentRpc>, path: string) {
  const [, serverId = '', action = ''] = /^\/api\/mcp\/([\w-]{1,64})\/([a-z/]+)$/u.exec(path) ?? []
  const caller = request.headers.get('x-mcp-caller') === 'app' ? 'app' : 'human'
  if (action === 'tools' && request.method === 'GET')
    return json(unwrap(await agent.mcpTools(serverId, new URL(request.url).searchParams.has('refresh'))))
  if (request.method !== 'POST') throw new NotFound({ what: path })
  if (action === 'connect') return json(unwrap(await agent.mcpConnect(serverId)))
  if (action === 'disconnect') return json(unwrap(await agent.mcpDisconnect(serverId)))
  if (action === 'tools/call') {
    const body = await readJson(request, ToolCall)
    return json(unwrap(await agent.mcpCallTool(serverId, body.name, body.arguments ?? {}, caller)))
  }
  if (action === 'resources/read')
    return json(unwrap(await agent.mcpReadResource(serverId, (await readJson(request, ResourceRead)).uri, caller)))
  if (action === 'prompts/get') {
    const body = await readJson(request, PromptGet)
    return json(unwrap(await agent.mcpGetPrompt(serverId, body.name, body.arguments ?? {})))
  }
  throw new NotFound({ what: path })
}

async function mcpRoute(request: Request, agent: DurableObjectStub<AgentRpc>, path: string, env: RuntimeEnv) {
  if (path === '/api/mcp/oauth/callback' && request.method === 'GET') return oauthCallback(request, agent, env)
  if (path === '/api/mcp/servers' && request.method === 'GET') return json(unwrap(await agent.mcpServers()))
  if (path === '/api/mcp/grants' && request.method === 'GET') return json(unwrap(await agent.mcpGrants()))
  if (path === '/api/mcp/grants' && request.method === 'PUT') {
    const body = await readJson(request, GrantChange)
    return json(unwrap(await agent.mcpSetToolGrant(body.serverId, body.name, body.allowed)))
  }
  return mcpServerRoute(request, agent, path)
}

/** Every /api route below belongs to the signed-in user and their agent: a cookie session, same-origin for writes. */
async function apiRequest(request: Request, env: RuntimeEnv): Promise<Response> {
  if (request.method !== 'GET') {
    const origin = request.headers.get('origin')
    if (origin !== null && origin !== new URL(env.APP_URL).origin) throw new Forbidden({ reason: 'origin' })
  }
  const { userId } = await requireUserSession(request, env)
  const path = new URL(request.url).pathname
  const agent = agentOf(env, userId)
  if (path.startsWith('/api/agent')) return agentRoute(request, agent, path)
  if (path.startsWith('/api/mcp/')) return mcpRoute(request, agent, path, env)
  if (path === '/api/clients' && request.method === 'GET') return json(await listInboundClients(env, userId))
  const revoke = /^\/api\/clients\/([\w.-]{1,200})$/u.exec(path)?.[1]
  if (revoke !== undefined && request.method === 'DELETE') {
    await revokeInboundClient(env, userId, revoke)
    return json({ revoked: true })
  }
  throw new NotFound({ what: path })
}

export default {
  async fetch(request: Request, env: RuntimeEnv): Promise<Response> {
    const url = new URL(request.url)
    if (url.pathname === '/health')
      return Response.json({ ok: true, service: 'purrable', stage: env.STAGE, signup: signupMode(env.SIGNUP_MODE) })
    if (url.pathname.startsWith('/.well-known/oauth-protected-resource'))
      return secured(Response.json(protectedResourceMetadata(env)))
    if (url.pathname.startsWith('/.well-known/') || url.pathname.startsWith('/api/auth/'))
      return handleAuth(request, env)
    if (url.pathname === '/mcp') return handleInboundMcp(request, env)
    if (!url.pathname.startsWith('/api/')) return Response.json({ error: 'NotFound' }, { status: 404 })
    try {
      return secured(await apiRequest(request, env))
    } catch (cause) {
      return failureResponse(cause, url.pathname, requestIdOf(request))
    }
  },
}
