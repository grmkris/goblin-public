import { createMcpHandler } from 'agents/mcp/server'
import { clientName, verifyClientToken } from '../auth/index.ts'
import type { RuntimeEnv } from '../env.ts'
import { unwrap } from '../http/rpc.ts'
import { inboundServer } from './server.ts'
import { requireAccountPlan } from '../billing/gates.ts'

export const inboundHosts = (appUrl: string) => ({
  allowedHostnames: [new URL(appUrl).hostname],
  allowedOriginHostnames: [new URL(appUrl).hostname],
})

const challenge = (env: RuntimeEnv): Response =>
  new Response(JSON.stringify({ error: 'Unauthenticated' }), {
    status: 401,
    headers: {
      'content-type': 'application/json',
      'www-authenticate': `Bearer resource_metadata="${new URL('/.well-known/oauth-protected-resource/mcp', env.APP_URL).href}"`,
    },
  })

/** `/mcp`: verify the client's bearer token, then serve the stateless MCP handler bound to that client. */
export const handleInboundMcp = async (request: Request, env: RuntimeEnv): Promise<Response> => {
  const header = request.headers.get('authorization') ?? ''
  if (!header.startsWith('Bearer ')) return challenge(env)
  const token = header.slice('Bearer '.length)
  let principal: Awaited<ReturnType<typeof verifyClientToken>>
  try {
    principal = await verifyClientToken(token, env)
  } catch {
    return challenge(env)
  }
  // The token's subject is the user who consented; the client talks to that user's agent only.
  await requireAccountPlan(env, principal.subject)
  const agent = env.AGENTS.getByName(principal.subject)
  const name = await clientName(principal.clientId, env)
  const handler = createMcpHandler(
    () =>
      inboundServer({
        ask: async (input, operationId, waitMs) =>
          unwrap(await agent.askAsClient(name ?? 'an MCP client', input, operationId, waitMs)),
        recent: async (limit) => unwrap(await agent.recentMessages(limit)),
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
