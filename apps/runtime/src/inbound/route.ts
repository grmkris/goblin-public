import { createMcpHandler } from 'agents/mcp/server'
import { challengeOf, clientName, verifyClientToken } from '../auth/index.ts'
import type { RuntimeEnv } from '../env.ts'
import { unwrap } from '../http/rpc.ts'
import { inboundServer } from './server.ts'
import { requireAccountPlan } from '../billing/gates.ts'

export const inboundHosts = (appUrl: string) => ({
  allowedHostnames: [new URL(appUrl).hostname],
  allowedOriginHostnames: [new URL(appUrl).hostname],
})

/** `/mcp`: verify the client's bearer token, then serve the stateless MCP handler bound to that client. */
export const handleInboundMcp = async (request: Request, env: RuntimeEnv): Promise<Response> => {
  const header = request.headers.get('authorization') ?? ''
  if (!header.startsWith('Bearer ')) return challengeOf(env.APP_URL, 'ask')
  const token = header.slice('Bearer '.length)
  let principal: Awaited<ReturnType<typeof verifyClientToken>>
  try {
    principal = await verifyClientToken(token, env)
  } catch {
    return challengeOf(env.APP_URL, 'ask')
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
