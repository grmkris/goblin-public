import * as Schema from 'effect/Schema'
import { AppContext } from '@purrable/contracts'
import type { AgentRpc, RuntimeEnv } from './env.ts'
import {
  handleAuth,
  listInboundClients,
  protectedResourceMetadata,
  requireUserSession,
  revokeInboundClient,
} from './auth/index.ts'
import { mailerOf } from './auth/mail.ts'
import { signupMode } from './auth/signup.ts'
import { readJson } from './http/body.ts'
import { Forbidden, InvalidInput, NotFound } from './http/errors.ts'
import { failureResponse, requestIdOf, secured } from './http/respond.ts'
import { unwrap } from './http/rpc.ts'
import { handleInboundMcp } from './inbound/route.ts'

export { PersonalAgent } from './agent.ts'

const Bounded = (max: number) => Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(max))
const Submit = Schema.Struct({
  input: Bounded(20_000),
  operationId: Bounded(200),
  appContext: Schema.optional(Schema.Array(AppContext).check(Schema.isMaxLength(2))),
})
const Stop = Schema.Struct({ operationId: Schema.optional(Bounded(200)) })
const CreateThread = Schema.Struct({ from: Schema.optional(Schema.Int.check(Schema.isGreaterThan(0))) })
const UpdateThread = Schema.Struct({ title: Schema.optional(Bounded(120)), archived: Schema.optional(Schema.Boolean) })
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
const AddServer = Schema.Struct({
  endpoint: Bounded(2048),
  source: Schema.optional(
    Schema.Struct({ registry: Bounded(2048), name: Bounded(256), version: Schema.optional(Bounded(64)) }),
  ),
})
const RegistryChange = Schema.Struct({ url: Bounded(2048) })
const AppGrantChange = Schema.Struct({
  serverId: Bounded(64),
  uri: Bounded(2048).check(Schema.isPattern(/^ui:\/\//u)),
  allowed: Schema.Boolean,
})
const SkillsChange = Schema.Struct({ serverId: Bounded(64), enabled: Schema.Boolean })
const ResidentChange = Schema.Struct({ enabled: Schema.Boolean })
const ModelPick = Schema.Struct({ model: Bounded(128) })

const json = (value: unknown, status = 200): Response => Response.json(value, { status })
/** Every user has their own agent object, named by their user ID. */
const agentOf = (env: RuntimeEnv, userId: string): DurableObjectStub<AgentRpc> => env.AGENTS.getByName(userId)

type Route = (request: Request, agent: DurableObjectStub<AgentRpc>) => Promise<Response>

/** The agent-wide routes (resident authority, budget, model), keyed `METHOD path`. */
const agentRoutes: Readonly<Record<string, Route>> = {
  'GET /api/agent/resident': async (_request, agent) => json(unwrap(await agent.residentStatus())),
  'GET /api/agent/usage': async (_request, agent) => json(unwrap(await agent.usageToday())),
  'GET /api/agent/memory': async (_request, agent) => json(unwrap(await agent.memoryStatus())),
  'GET /api/agent/model': async (_request, agent) => json(unwrap(await agent.modelChoice())),
  'PUT /api/agent/model': async (request, agent) =>
    json(unwrap(await agent.chooseModel((await readJson(request, ModelPick)).model))),
  'POST /api/agent/resident': async (request, agent) =>
    json(unwrap(await agent.residentSet((await readJson(request, ResidentChange)).enabled))),
}

async function agentRoute(request: Request, agent: DurableObjectStub<AgentRpc>, path: string): Promise<Response> {
  const route = agentRoutes[`${request.method} ${path}`]
  if (route === undefined) throw new NotFound({ what: path })
  return route(request, agent)
}

/** One conversation's routes, keyed `METHOD action`; the agent checks the thread is one of the owner's. */
const threadRoutes: Readonly<
  Record<string, (request: Request, agent: DurableObjectStub<AgentRpc>, thread: string) => Promise<Response>>
> = {
  'POST messages': async (request, agent, thread) => {
    const body = await readJson(request, Submit)
    return json(unwrap(await agent.submit(thread, body.input, body.operationId, body.appContext ?? [])), 202)
  },
  'POST stop': async (request, agent, thread) =>
    json({ stopped: unwrap(await agent.stop(thread, (await readJson(request, Stop)).operationId)) }),
  'GET events': (_request, agent, thread) => agent.fetch(`https://agent/threads/${thread}/events`),
  'GET snapshot': (_request, agent, thread) => agent.fetch(`https://agent/threads/${thread}/snapshot`),
  'GET history': (request, agent, thread) =>
    agent.fetch(`https://agent/threads/${thread}/history${new URL(request.url).search}`),
  'PATCH ': async (request, agent, thread) =>
    json(unwrap(await agent.updateThread(thread, await readJson(request, UpdateThread)))),
}

async function threadRoute(request: Request, agent: DurableObjectStub<AgentRpc>, path: string): Promise<Response> {
  if (path === '/api/threads' && request.method === 'GET') return json(unwrap(await agent.threads()))
  if (path === '/api/threads' && request.method === 'POST')
    return json(unwrap(await agent.createThread((await readJson(request, CreateThread)).from)), 201)
  const [, thread = '', action = ''] = /^\/api\/threads\/(\d{1,12})(?:\/([a-z]+))?$/u.exec(path) ?? []
  const route = threadRoutes[`${request.method} ${action}`]
  if (thread === '' || route === undefined) throw new NotFound({ what: path })
  return route(request, agent, thread)
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
  if (action === 'remove') return json(unwrap(await agent.mcpRemoveServer(serverId)))
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

/** The owner's MCP routes that are not about one server, keyed `METHOD path`. */
const mcpRoutes: Readonly<Record<string, Route>> = {
  'GET /api/mcp/servers': async (_request, agent) => json(unwrap(await agent.mcpServers())),
  'POST /api/mcp/servers': async (request, agent) => {
    const body = await readJson(request, AddServer)
    return json(unwrap(await agent.mcpAddServer(body.endpoint, body.source)), 201)
  },
  'GET /api/mcp/suggested': async (_request, agent) => json(unwrap(await agent.mcpSuggested())),
  'GET /api/mcp/catalog': async (request, agent) => {
    const query = new URL(request.url).searchParams.get('q') ?? ''
    if (query.length > 100) throw new InvalidInput({ reason: 'query_too_long' })
    return json(unwrap(await agent.mcpCatalog(query)))
  },
  'GET /api/mcp/registries': async (_request, agent) => json(unwrap(await agent.mcpRegistries())),
  'POST /api/mcp/registries': async (request, agent) =>
    json(unwrap(await agent.mcpAddRegistry((await readJson(request, RegistryChange)).url)), 201),
  'POST /api/mcp/registries/remove': async (request, agent) =>
    json(unwrap(await agent.mcpRemoveRegistry((await readJson(request, RegistryChange)).url))),
  'GET /api/mcp/grants': async (_request, agent) => json(unwrap(await agent.mcpGrants())),
  'PUT /api/mcp/grants': async (request, agent) => {
    const body = await readJson(request, GrantChange)
    return json(unwrap(await agent.mcpSetToolGrant(body.serverId, body.name, body.allowed)))
  },
  'PUT /api/mcp/skills': async (request, agent) => {
    const body = await readJson(request, SkillsChange)
    return json(unwrap(await agent.mcpSetSkills(body.serverId, body.enabled)))
  },
  'PUT /api/mcp/app-grants': async (request, agent) => {
    const body = await readJson(request, AppGrantChange)
    return json(unwrap(await agent.mcpSetAppGrant(body.serverId, body.uri, body.allowed)))
  },
}

async function mcpRoute(request: Request, agent: DurableObjectStub<AgentRpc>, path: string, env: RuntimeEnv) {
  if (path === '/api/mcp/oauth/callback' && request.method === 'GET') return oauthCallback(request, agent, env)
  const route = mcpRoutes[`${request.method} ${path}`]
  return route === undefined ? mcpServerRoute(request, agent, path) : route(request, agent)
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
  if (path.startsWith('/api/agent/')) return agentRoute(request, agent, path)
  if (path === '/api/threads' || path.startsWith('/api/threads/')) return threadRoute(request, agent, path)
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
      return Response.json({
        ok: true,
        service: 'purrable',
        stage: env.STAGE,
        signup: signupMode(env.SIGNUP_MODE),
        mail: mailerOf(env) !== undefined,
      })
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
