import * as Schema from 'effect/Schema'
import * as Effect from 'effect/Effect'
import {
  AppCall,
  AppDiagnostic,
  AgentAppChange,
  DeleteAgentApp,
  CapabilityChange,
  CreateApp,
  CreateConversation,
  SendMessage,
  UpdateApp,
  UpdateConversation,
  QueueRemoval,
} from '@goblin/contracts'
import type { AgentRpc, RuntimeEnv } from './env.ts'
import {
  handleAuth,
  listInboundClients,
  resourceMetadata,
  requireUserSession,
  revokeInboundClient,
} from './auth/index.ts'
import { mailerOf } from './auth/mail.ts'
import { signupMode } from './auth/signup.ts'
import { readBytes, readJson } from './http/body.ts'
import { Forbidden, InvalidInput, NotFound } from './http/errors.ts'
import { failureResponse, requestIdOf, secured } from './http/respond.ts'
import { unwrap } from './http/rpc.ts'
import { handleInboundMcp } from './inbound/route.ts'
import { eventsHookTokenValid } from './mcp/events/route-token.ts'
import { EVENT_BODY_BYTES } from './mcp/events/webhook.ts'
import { hookTokenValid } from './channel/doorbell.ts'
import { canonicalRedirect } from './http/canonical.ts'
import { billingApi, billingDeps } from './billing/routes.ts'
import { billingWebhook } from './billing/webhook.ts'
import { runBillingCron } from './billing/cron.ts'
import { billingMode, requireAccountPlan } from './billing/gates.ts'
import { routineRoute } from './routines/routes.ts'
import { browserWrite } from './http/csrf.ts'

export { PersonalAgent } from './agent.ts'

const Bounded = (max: number) => Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(max))
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
const AskFirstChange = Schema.Struct({ serverId: Bounded(64), name: Bounded(256), enabled: Schema.Boolean })
const ApprovalDecision = Schema.Struct({ allowed: Schema.Boolean })
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
const ChannelPick = Schema.Struct({ serverId: Bounded(64) })
const ModelPick = Schema.Struct({ model: Bounded(128) })

const json = (value: unknown, status = 200): Response => Response.json(value, { status })
/** Only the authenticated user ID supplies the native Agent name. */
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
  'GET /api/agent/channel': async (_request, agent) => json(unwrap(await agent.channelStatus())),
  'PUT /api/agent/channel': async (request, agent) =>
    json(unwrap(await agent.channelEnable((await readJson(request, ChannelPick)).serverId))),
  'DELETE /api/agent/channel': async (_request, agent) => json(unwrap(await agent.channelDisable())),
}

/** The largest doorbell body accepted (myagent sends `{ botId, cursor }`). */
const DOORBELL_BYTES = 1024

/**
 * POST /hooks/myagent/<userId>/<token>: a doorbell from myagent (channel/doorbell.ts). The token is checked here,
 * before any agent wakes; only the user it was made for reaches their agent, which checks myagent's signature.
 */
async function doorbellRoute(request: Request, env: RuntimeEnv, path: string): Promise<Response> {
  const [, userId = '', token = ''] = /^\/hooks\/myagent\/([\w-]{1,200})\/([\w-]{43})$/u.exec(path) ?? []
  if (request.method !== 'POST' || userId === '' || !(await hookTokenValid(env.CREDENTIAL_KEY, userId, token)))
    throw new NotFound({ what: path })
  await requireAccountPlan(env, userId)
  const body = await request.text()
  if (body.length > DOORBELL_BYTES) throw new InvalidInput({ reason: 'doorbell too large' })
  unwrap(
    await agentOf(env, userId).channelDoorbell({
      body,
      timestamp: request.headers.get('x-myagent-timestamp') ?? '',
      signature: request.headers.get('x-myagent-signature') ?? '',
    }),
  )
  return new Response(null, { status: 204 })
}

/** User-bound route token precedes object lookup; raw bytes are bounded before RPC/signature verification. */
async function mcpEventsRoute(request: Request, env: RuntimeEnv, path: string): Promise<Response> {
  const [, userId = '', token = ''] = /^\/hooks\/mcp-events\/([\w-]{1,200})\/([\w-]{43})$/u.exec(path) ?? []
  if (request.method !== 'POST' || userId === '' || !(await eventsHookTokenValid(env.CREDENTIAL_KEY, userId, token)))
    throw new NotFound({ what: path })
  await requireAccountPlan(env, userId)
  const body = await readBytes(request, EVENT_BODY_BYTES)
  const result = unwrap(
    await agentOf(env, userId).mcpEventsWebhook({
      body,
      subscriptionId: request.headers.get('x-mcp-subscription-id') ?? '',
      id: request.headers.get('webhook-id') ?? '',
      timestamp: request.headers.get('webhook-timestamp') ?? '',
      signature: request.headers.get('webhook-signature') ?? '',
    }),
  )
  return new Response(result.response ?? null, {
    status: result.status,
    ...(result.response === undefined ? {} : { headers: { 'content-type': 'application/json' } }),
  })
}

async function agentRoute(request: Request, agent: DurableObjectStub<AgentRpc>, path: string): Promise<Response> {
  const route = agentRoutes[`${request.method} ${path}`]
  if (route === undefined) throw new NotFound({ what: path })
  return route(request, agent)
}

/** One conversation's routes, keyed `METHOD action`; the agent checks the conversation is one of the owner's. */
const conversationRoutes: Readonly<
  Record<string, (request: Request, agent: DurableObjectStub<AgentRpc>, thread: string) => Promise<Response>>
> = {
  'POST messages': async (request, agent, thread) => {
    const body = await readJson(request, SendMessage)
    const { input, operationId, appContext = [], attachments = [], selections = [] } = body
    return json(unwrap(await agent.submit(thread, input, operationId, { appContext, attachments, selections })), 202)
  },
  'POST stop': async (request, agent, thread) =>
    json({ stopped: unwrap(await agent.stop(thread, (await readJson(request, Stop)).operationId)) }),
  'GET queue': async (_request, agent, thread) => json(unwrap(await agent.conversationQueue(thread))),
  'DELETE queue': async (request, agent, thread) =>
    json(unwrap(await agent.removeQueuedInput(thread, await readJson(request, QueueRemoval)))),
  'GET events': (_request, agent, thread) => agent.fetch(`https://agent/conversations/${thread}/events`),
  'GET snapshot': (_request, agent, thread) => agent.fetch(`https://agent/conversations/${thread}/snapshot`),
  'GET history': (request, agent, thread) =>
    agent.fetch(`https://agent/conversations/${thread}/history${new URL(request.url).search}`),
  'PUT read': async (_request, agent, thread) => json({ read: unwrap(await agent.markRead(thread)) }),
  'PATCH ': async (request, agent, thread) =>
    json(unwrap(await agent.updateConversation(thread, await readJson(request, UpdateConversation)))),
  'GET capabilities': async (_request, agent, thread) => json(unwrap(await agent.conversationCapabilities(thread))),
  'GET composer': async (_request, agent, thread) => json(unwrap(await agent.composerOptions(thread))),
  'PATCH capabilities': async (request, agent, thread) =>
    json(unwrap(await agent.setConversationCapability(thread, await readJson(request, CapabilityChange)))),
}

async function conversationRoute(
  request: Request,
  agent: DurableObjectStub<AgentRpc>,
  path: string,
): Promise<Response> {
  if (path === '/api/conversations' && request.method === 'GET') return json(unwrap(await agent.conversations()))
  if (path === '/api/conversations' && request.method === 'POST')
    return json(unwrap(await agent.createConversation(await readJson(request, CreateConversation))), 201)
  const [, id = '', action = ''] = /^\/api\/conversations\/(\d{1,12})(?:\/([a-z-]+))?$/u.exec(path) ?? []
  const route = conversationRoutes[`${request.method} ${action}`]
  if (id === '' || route === undefined) throw new NotFound({ what: path })
  return route(request, agent, id)
}

type AppRoute = (request: Request, agent: DurableObjectStub<AgentRpc>, id: string) => Promise<Response>

/** One App's routes by method and action: load it, close or reopen it, and an agent app's view's state, calls, errors. */
const appRoutes: Readonly<Record<string, AppRoute>> = {
  'GET launch': async (_request, agent, id) => json(unwrap(await agent.launchApp(id))),
  'PATCH ': async (request, agent, id) => json(unwrap(await agent.updateApp(id, await readJson(request, UpdateApp)))),
  'GET state': async (_request, agent, id) => json(unwrap(await agent.appSnapshot(id))),
  'POST call': async (request, agent, id) => json(unwrap(await agent.appCall(id, await readJson(request, AppCall)))),
  'POST diagnostics': async (request, agent, id) =>
    json(unwrap(await agent.appDiagnostic(id, await readJson(request, AppDiagnostic)))),
}

/**
 * The owner's agent apps by name (ADR 0021): the list, one in full, a change to one (roll back, pause, run now, move
 * home, answer a power), and deleting one, confirmed by its name.
 */
async function agentAppRoute(request: Request, agent: DurableObjectStub<AgentRpc>, path: string): Promise<Response> {
  if (path === '/api/agent-apps' && request.method === 'GET') return json(unwrap(await agent.agentApps()))
  const name = /^\/api\/agent-apps\/([a-z][a-z0-9-]{1,23})$/u.exec(path)?.[1]
  if (name === undefined) throw new NotFound({ what: path })
  if (request.method === 'GET') return json(unwrap(await agent.agentAppDetail(name)))
  if (request.method === 'POST')
    return json(unwrap(await agent.changeAgentApp(name, await readJson(request, AgentAppChange))))
  if (request.method === 'DELETE')
    return json(unwrap(await agent.deleteAgentApp(name, await readJson(request, DeleteAgentApp))))
  throw new NotFound({ what: path })
}

/** The owner's Apps (ADRs 0020, 0021): keep an MCP App from a call, then each App's own routes. */
async function appRoute(request: Request, agent: DurableObjectStub<AgentRpc>, path: string): Promise<Response> {
  if (path === '/api/apps' && request.method === 'POST')
    return json(unwrap(await agent.createApp(await readJson(request, CreateApp))), 201)
  const [, id = '', action = ''] = /^\/api\/apps\/(\d{1,12})(?:\/([a-z]+))?$/u.exec(path) ?? []
  const route = appRoutes[`${request.method} ${action}`]
  if (id === '' || route === undefined) throw new NotFound({ what: path })
  return route(request, agent, id)
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

async function mcpApprovalRoute(request: Request, agent: DurableObjectStub<AgentRpc>, path: string) {
  const match = /^\/api\/mcp\/approvals\/([\w:-]{1,256})$/u.exec(decodeURIComponent(path))
  const id = match?.[1]
  if (id === undefined) throw new NotFound({ what: path })
  if (request.method === 'GET') return json(unwrap(await agent.mcpApproval(id)))
  if (request.method === 'POST') {
    const body = await readJson(request, ApprovalDecision)
    return json(unwrap(await agent.mcpDecideApproval(id, body.allowed)))
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
  'PUT /api/mcp/ask-first': async (request, agent) => {
    const body = await readJson(request, AskFirstChange)
    return json(unwrap(await agent.mcpSetAskFirst(body.serverId, body.name, body.enabled)))
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
  if (path.startsWith('/api/mcp/approvals/')) return mcpApprovalRoute(request, agent, path)
  if (path === '/api/mcp/oauth/callback' && request.method === 'GET') return oauthCallback(request, agent, env)
  const route = mcpRoutes[`${request.method} ${path}`]
  return route === undefined ? mcpServerRoute(request, agent, path) : route(request, agent)
}

function apiOrigin(request: Request, env: RuntimeEnv): void {
  if (request.method !== 'GET') {
    const origin = request.headers.get('origin')
    if (origin !== null && origin !== new URL(env.APP_URL).origin) throw new Forbidden({ reason: 'origin' })
  }
}

/** Every /api route below belongs to the signed-in user and their agent: a cookie session, same-origin for writes. */
async function apiRequest(request: Request, env: RuntimeEnv): Promise<Response> {
  apiOrigin(request, env)
  const session = await requireUserSession(request, env)
  const { userId } = session
  const path = new URL(request.url).pathname
  if (
    ['/api/routines', '/api/files', '/api/apps', '/api/agent-apps', '/api/home', '/api/mcp'].some((prefix) =>
      under(path, prefix),
    ) ||
    (request.method === 'DELETE' && /^\/api\/conversations\/\d{1,12}\/queue$/u.test(path))
  )
    browserWrite(request, env.APP_URL)
  if (path.startsWith('/api/billing/')) return Effect.runPromise(billingApi(request, env, userId))
  await requireAccountPlan(env, userId)
  return ownerApiRequest(request, env, path, agentOf(env, userId), userId)
}

/** `path` is `prefix` or a path below it. */
const under = (path: string, prefix: string): boolean => path === prefix || path.startsWith(`${prefix}/`)

async function ownerApiRequest(
  request: Request,
  env: RuntimeEnv,
  path: string,
  agent: DurableObjectStub<AgentRpc>,
  userId: string,
): Promise<Response> {
  if (path.startsWith('/api/agent/')) return agentRoute(request, agent, path)
  if (path === '/api/home') return agent.fetch(new Request('https://agent/home', request))
  if (under(path, '/api/routines')) return routineRoute(request, agent, path)
  if (path === '/api/workspace/events' && request.method === 'GET') return agent.fetch('https://agent/workspace/events')
  if (under(path, '/api/files'))
    return agent.fetch(new Request(`https://agent${path.slice('/api'.length)}${new URL(request.url).search}`, request))
  if (under(path, '/api/conversations')) return conversationRoute(request, agent, path)
  if (under(path, '/api/apps')) return appRoute(request, agent, path)
  if (under(path, '/api/agent-apps')) return agentAppRoute(request, agent, path)
  if (path.startsWith('/api/mcp/')) return mcpRoute(request, agent, path, env)
  if (path === '/api/clients' && request.method === 'GET') return json(await listInboundClients(env, userId))
  const revoke = /^\/api\/clients\/([\w.-]{1,200})$/u.exec(path)?.[1]
  if (revoke !== undefined && request.method === 'DELETE') {
    await revokeInboundClient(env, userId, revoke)
    return json({ revoked: true })
  }
  throw new NotFound({ what: path })
}

async function admittedRoute(
  request: Request,
  env: RuntimeEnv,
  ctx: Pick<ExecutionContext, 'waitUntil'>,
): Promise<Response> {
  const path = new URL(request.url).pathname
  if (path === '/mcp') return handleInboundMcp(request, env)
  if (path === '/hooks/dodo') return Effect.runPromise(billingWebhook(billingDeps(env), request, ctx))
  if (path.startsWith('/hooks/mcp-events/')) return mcpEventsRoute(request, env, path)
  if (path.startsWith('/hooks/')) return doorbellRoute(request, env, path)
  if (path.startsWith('/api/')) return apiRequest(request, env)
  throw new NotFound({ what: path })
}

export default {
  async scheduled(_event: ScheduledController, env: RuntimeEnv): Promise<void> {
    await Effect.runPromise(runBillingCron(billingDeps(env)))
  },
  async fetch(request: Request, env: RuntimeEnv, ctx: Pick<ExecutionContext, 'waitUntil'>): Promise<Response> {
    const redirect = canonicalRedirect(request, env.APP_URL)
    if (redirect !== undefined) return redirect
    const url = new URL(request.url)
    if (url.pathname === '/health')
      return Response.json({
        ok: true,
        service: 'goblin',
        stage: env.STAGE,
        signup: signupMode(env.SIGNUP_MODE),
        mail: mailerOf(env) !== undefined,
        billing: {
          mode: env.DODO_PAYMENTS_ENVIRONMENT ?? billingMode(env),
          configured: billingDeps(env) !== undefined,
        },
      })
    if (url.pathname.startsWith('/.well-known/oauth-protected-resource'))
      return secured(Response.json(resourceMetadata(env)))
    if (url.pathname.startsWith('/.well-known/') || url.pathname.startsWith('/api/auth/'))
      return handleAuth(request, env)

    try {
      return secured(await admittedRoute(request, env, ctx))
    } catch (cause) {
      return failureResponse(cause, url.pathname, requestIdOf(request))
    }
  },
}
