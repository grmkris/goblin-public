import { createMcpHandler } from 'agents/mcp/server'
import { INSPECT_SCOPE, challengeOf, clientName, verifyClientToken } from '../auth/index.ts'
import type { RuntimeEnv } from '../env.ts'
import { runAtEdge } from '../http/api/edge.ts'
import { internalCall } from './client.ts'
import type { InspectReader } from './inspection.ts'
import { inboundServer } from './server.ts'

export const inboundHosts = (appUrl: string) => ({
  allowedHostnames: [new URL(appUrl).hostname],
  allowedOriginHostnames: [new URL(appUrl).hostname],
})

/** `/mcp`: verify the client's bearer token, then serve the stateless MCP handler bound to that client. */
export const handleInboundMcp = async (request: Request, env: RuntimeEnv): Promise<Response> => {
  const header = request.headers.get('authorization') ?? ''
  if (!header.startsWith('Bearer ')) return challengeOf(env.APP_URL)
  const token = header.slice('Bearer '.length)
  let principal: Awaited<ReturnType<typeof verifyClientToken>>
  try {
    principal = await verifyClientToken(token, env)
  } catch {
    // expected: a token that does not verify is answered with the sign-in challenge, as a missing one is.
    return challengeOf(env.APP_URL)
  }
  // The token's subject is the user who consented; the client talks to that user's agent only, through its internal
  // API. Asking and reading main need a plan, which the agent checks; inspecting your own agent does not.
  const agent = env.AGENTS.getByName(principal.subject)
  const name = await clientName(principal.clientId, env)
  const inspect: InspectReader = (query) =>
    runAtEdge(internalCall(agent, (api) => api.inbound.inspect({ payload: { query } })))
  const handler = createMcpHandler(
    () =>
      inboundServer({
        ask: (input, operationId, waitMs) =>
          runAtEdge(
            internalCall(agent, (api) =>
              api.inbound.ask({ payload: { author: name ?? 'an MCP client', input, operationId, waitMs } }),
            ),
          ),
        recent: (limit) => runAtEdge(internalCall(agent, (api) => api.inbound.recent({ query: { limit } }))),
        ...(principal.scopes.includes(INSPECT_SCOPE) ? { inspect } : {}),
      }),
    {
      route: '/mcp',
      // The canonical host is configuration, not the request's Host/Origin. This keeps custom domains valid while
      // retaining the SDK's DNS-rebinding protection; the Worker redirects alternate hosts before reaching here.
      ...inboundHosts(env.APP_URL),
    },
  )
  return handler.fetch(request, {
    authInfo: { token, clientId: principal.clientId, scopes: [...principal.scopes], expiresAt: principal.expiresAt },
  })
}
