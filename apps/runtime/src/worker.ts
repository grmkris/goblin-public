import { Effect, Schema } from 'effect'
import type { RuntimeEnv } from './env.ts'
import {
  handleAuth,
  handleGrantRequest,
  authPrincipal,
  requireOwnerSession,
  protectedResourceMetadata,
} from './auth/index.ts'
import { callMcpTool, connectMcpServer, getMcpPrompt, listMcpServers, readMcpResource } from './mcp/routes.ts'

export { PersonalAgent } from './agent.ts'

const Input = Schema.Struct({
  input: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(20_000)),
  operationId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200)),
})
const Stop = Schema.Struct({ operationId: Schema.optional(Schema.String) })
const Resource = Schema.Struct({ uri: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(2048)) })

class RequestBoundaryError extends Schema.TaggedError<RequestBoundaryError>()('RequestBoundaryError', {
  invalidInput: Schema.Boolean,
}) {}

function securedResponse(response: Response): Response {
  const result = new Response(response.body, response)
  result.headers.set('cache-control', 'no-store')
  result.headers.set('x-content-type-options', 'nosniff')
  return result
}

async function agentRequest(request: Request, env: RuntimeEnv): Promise<Response> {
  const principal = await requireOwnerSession(request, env)
  const agent = env.AGENTS.getByName('root')
  const path = new URL(request.url).pathname
  if (path === '/api/agent' && request.method === 'POST') {
    const input = Schema.decodeUnknownSync(Input)(await request.json())
    return Response.json(await agent.submitAuthenticated(input.input, input.operationId, principal), { status: 202 })
  }
  if (path === '/api/agent/stop' && request.method === 'POST') {
    const input = Schema.decodeUnknownSync(Stop)(await request.json())
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
  return Response.json({ error: 'not_found' }, { status: 404 })
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
  if (serverId === undefined || request.method !== 'POST') return Response.json({ error: 'not_found' }, { status: 404 })
  const caller = await mcpCaller(request, env)
  if (action === 'connect') return connectMcpServer(env, principal, serverId)
  const body: unknown = await request.json()
  if (action === 'tools/call') return callMcpTool(env, principal, serverId, body, caller)
  if (action === 'resources/read') {
    return readMcpResource(env, principal, serverId, Schema.decodeUnknownSync(Resource)(body).uri, caller)
  }
  return getMcpPrompt(env, principal, serverId, body)
}

export default {
  async fetch(request: Request, env: RuntimeEnv): Promise<Response> {
    const url = new URL(request.url)
    if (url.pathname === '/health') return Response.json({ ok: true, service: 'purrable', stage: env.STAGE })
    if (url.pathname.startsWith('/.well-known/oauth-protected-resource'))
      return securedResponse(Response.json(protectedResourceMetadata(env)))
    if (url.pathname.startsWith('/api/auth/')) return handleAuth(request, env)
    if (!url.pathname.startsWith('/api/')) return Response.json({ error: 'not_found' }, { status: 404 })
    if (request.method !== 'GET') {
      const origin = request.headers.get('origin')
      if (origin !== null && origin !== env.APP_URL) return Response.json({ error: 'origin_denied' }, { status: 403 })
      const size = Number(request.headers.get('content-length') ?? 0)
      if (size > 65_536) return Response.json({ error: 'request_too_large' }, { status: 413 })
    }
    return Effect.runPromise(
      Effect.tryPromise({
        try: () => (url.pathname.startsWith('/api/agent') ? agentRequest(request, env) : mcpRequest(request, env)),
        catch: (cause) => new RequestBoundaryError({ invalidInput: cause instanceof Schema.SchemaError }),
      }).pipe(
        Effect.match({
          onSuccess: securedResponse,
          onFailure: (error) =>
            securedResponse(
              Response.json(
                { error: error.invalidInput ? 'invalid_input' : 'authentication_required' },
                { status: error.invalidInput ? 400 : 401 },
              ),
            ),
        }),
      ),
    )
  },
}
