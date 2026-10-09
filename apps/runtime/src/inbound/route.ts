import type { InspectQuery } from '@goblin/contracts/inspect'
import { createMcpHandler } from 'agents/mcp/server'
import { INSPECT_SCOPE, challengeOf, clientName, verifyClientToken } from '../auth/index.ts'
import type { RuntimeEnv } from '../env.ts'
import { unwrap, unwrapJson } from '../http/rpc.ts'
import { inboundServer } from './server.ts'
import { accountPlan } from '../billing/gates.ts'
import { runAtEdge } from '../http/api/edge.ts'

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
  // The token's subject is the user who consented; the client talks to that user's agent only. Asking runs the model,
  // so it needs a plan; reading your own agent does not.
  const agent = env.AGENTS.getByName(principal.subject)
  const name = await clientName(principal.clientId, env)
  const inspect = async (query: InspectQuery) =>
    unwrapJson(
      await (await agent.fetch('https://agent/inspect', { method: 'POST', body: JSON.stringify(query) })).json(),
    )
  const handler = createMcpHandler(
    () =>
      inboundServer({
        ask: async (input, operationId, waitMs) => {
          await runAtEdge(accountPlan(env, principal.subject))
          return unwrap(await agent.askAsClient(name ?? 'an MCP client', input, operationId, waitMs))
        },
        recent: async (limit) => unwrap(await agent.recentMessages(limit)),
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
