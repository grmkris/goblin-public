import * as Schema from 'effect/Schema'
import type { RuntimeEnv } from './env.ts'
import {
  handleAuth,
  handleGrantRequest,
  authPrincipal,
  requireOwnerSession,
  protectedResourceMetadata,
} from './auth/index.ts'
import { readJson } from './http/body.ts'
import { Forbidden, NotFound } from './http/errors.ts'
import { failureResponse, requestIdOf, secured } from './http/respond.ts'
import { callMcpTool, connectMcpServer, getMcpPrompt, listMcpServers, readMcpResource } from './mcp/routes.ts'

export { PersonalAgent } from './agent.ts'

const Input = Schema.Struct({
  input: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(20_000)),
  operationId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200)),
})
const Stop = Schema.Struct({ operationId: Schema.optional(Schema.String) })
const Resource = Schema.Struct({ uri: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(2048)) })
const Body = Schema.Unknown

async function agentRequest(request: Request, env: RuntimeEnv): Promise<Response> {
  const principal = await requireOwnerSession(request, env)
  const agent = env.AGENTS.getByName('root')
  const path = new URL(request.url).pathname
  if (path === '/api/agent' && request.method === 'POST') {
    const input = await readJson(request, Input)
    return Response.json(await agent.submitAuthenticated(input.input, input.operationId, principal), { status: 202 })
  }
  if (path === '/api/agent/stop' && request.method === 'POST') {
    const input = await readJson(request, Stop)
    return Response.json({ stopped: await agent.stop(input.operationId) })
  }
  if (path === '/api/agent/wait' && request.method === 'GET') {
    const operationId = new URL(request.url).searchParams.get('operationId')
    if (operationId === null || operationId.length === 0 || operationId.length > 200)
      return Response.json({ error: 'operation_id_required' }, { status: 400 })
    return Response.json(await agent.wait(operationId))
  }
  if (request.method === 'GET' && (path === '/api/agent/events' || path === '/api/agent/snapshot')) {
    return agent.fetch(`https://agent/${path.endsWith('/events') ? 'events' : 'snapshot'}`)
  }
  throw new NotFound({ what: path })
}

async function mcpCaller(request: Request, env: RuntimeEnv): Promise<'human' | 'app'> {
  if (request.headers.get('x-mcp-caller') !== 'app') return 'human'
  await requireOwnerSession(request, env)
  return 'app'
}

async function mcpRequest(request: Request, env: RuntimeEnv): Promise<Response> {
  const url = new URL(request.url)
  if (url.pathname === '/api/mcp/grants') return handleGrantRequest(request, env)
  const principal = await authPrincipal(request, env)
  if (url.pathname === '/api/mcp/servers' && request.method === 'GET') return listMcpServers(env)
  const [, serverId, action] =
    /^\/api\/mcp\/([^/]+)\/(connect|tools\/call|resources\/read|prompts\/get)$/u.exec(url.pathname) ?? []
  if (serverId === undefined || request.method !== 'POST') throw new NotFound({ what: url.pathname })
  const caller = await mcpCaller(request, env)
  if (action === 'connect') return connectMcpServer(env, principal, serverId)
  if (action === 'tools/call') return callMcpTool(env, principal, serverId, await readJson(request, Body), caller)
  if (action === 'resources/read') {
    const resource = await readJson(request, Resource)
    return readMcpResource(env, principal, serverId, resource.uri, caller)
  }
  return getMcpPrompt(env, principal, serverId, await readJson(request, Body))
}

async function apiRequest(request: Request, env: RuntimeEnv): Promise<Response> {
  if (request.method !== 'GET') {
    const origin = request.headers.get('origin')
    if (origin !== null && origin !== new URL(env.APP_URL).origin) throw new Forbidden({ reason: 'origin' })
  }
  const path = new URL(request.url).pathname
  return path.startsWith('/api/agent') ? agentRequest(request, env) : mcpRequest(request, env)
}

export default {
  async fetch(request: Request, env: RuntimeEnv): Promise<Response> {
    const url = new URL(request.url)
    if (url.pathname === '/health') return Response.json({ ok: true, service: 'purrable', stage: env.STAGE })
    if (url.pathname.startsWith('/.well-known/oauth-protected-resource'))
      return secured(Response.json(protectedResourceMetadata(env)))
    if (url.pathname.startsWith('/api/auth/')) return handleAuth(request, env)
    if (!url.pathname.startsWith('/api/')) return Response.json({ error: 'NotFound' }, { status: 404 })
    try {
      return secured(await apiRequest(request, env))
    } catch (cause) {
      return failureResponse(cause, url.pathname, requestIdOf(request))
    }
  },
}
