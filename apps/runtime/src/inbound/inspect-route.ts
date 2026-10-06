import type { InspectQuery } from '@goblin/contracts/inspect'
import { createMcpHandler } from 'agents/mcp/server'
import { challengeOf, verifyClientToken } from '../auth/index.ts'
import type { ClientPrincipal } from '../auth/principal.ts'
import type { RuntimeEnv } from '../env.ts'
import { unwrapJson } from '../http/rpc.ts'
import { inspectServer } from './inspect-server.ts'
import { inboundHosts } from './route.ts'

/**
 * `/mcp/inspect`: verify the token for exactly this endpoint (its audience, scope and the owner's standing consent),
 * then serve the stateless inspection server over the caller's own agent, nobody else's. The agent answers on its
 * internal `/inspect` route (`inspect/request.ts`) with RPC results as JSON.
 */
export const handleInspectMcp = async (request: Request, env: RuntimeEnv): Promise<Response> => {
  const header = request.headers.get('authorization') ?? ''
  if (!header.startsWith('Bearer ')) return challengeOf(env.APP_URL, 'inspect')
  const token = header.slice('Bearer '.length)
  let principal: ClientPrincipal
  try {
    principal = await verifyClientToken(token, env, 'inspect')
  } catch {
    return challengeOf(env.APP_URL, 'inspect')
  }
  const agent = env.AGENTS.getByName(principal.subject)
  const read = async (query: InspectQuery) =>
    unwrapJson(
      await (await agent.fetch('https://agent/inspect', { method: 'POST', body: JSON.stringify(query) })).json(),
    )
  const handler = createMcpHandler(() => inspectServer(read), { route: '/mcp/inspect', ...inboundHosts(env.APP_URL) })
  return handler.fetch(request, {
    authInfo: { token, clientId: principal.clientId, scopes: [...principal.scopes], expiresAt: principal.expiresAt },
  })
}
