import { createMcpHandler } from 'agents/mcp/server'
import { clientName, verifyClientToken } from '../auth/index.ts'
import type { RuntimeEnv } from '../env.ts'
import { unwrap } from '../http/rpc.ts'
import { inboundServer } from './server.ts'

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
  const agent = env.AGENTS.getByName('root')
  const name = await clientName(principal.clientId, env)
  const handler = createMcpHandler(
    () =>
      inboundServer({
        ask: async (input, operationId, waitMs) =>
          unwrap(await agent.askAsClient(principal.clientId, name, input, operationId, waitMs)),
        recent: async (limit) => unwrap(await agent.clientMessages(principal.clientId, limit)),
      }),
    { route: '/mcp' },
  )
  return handler.fetch(request, {
    authInfo: { token, clientId: principal.clientId, scopes: [...principal.scopes], expiresAt: principal.expiresAt },
  })
}
