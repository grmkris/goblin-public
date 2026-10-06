import type { InspectQuery } from '@goblin/contracts/inspect'
import { createMcpHandler } from 'agents/mcp/server'
import { userIdOf } from '../auth/account.ts'
import { type Endpoint, challengeOf, clientName, endpointPath, operatorsOf, verifyClientToken } from '../auth/index.ts'
import type { ClientPrincipal } from '../auth/principal.ts'
import type { AgentRpc, RuntimeEnv } from '../env.ts'
import { Forbidden, NotFound } from '../http/errors.ts'
import { unwrapJson } from '../http/rpc.ts'
import { type InspectReader, inspectServer } from './inspect-server.ts'
import { inboundHosts } from './route.ts'

type Agent = DurableObjectStub<AgentRpc>

/** An agent's internal inspection routes (`inspect/request.ts`), which answer with RPC results as JSON. */
const agentCall = async (agent: Agent, path: string, init?: RequestInit): Promise<unknown> =>
  unwrapJson(await (await agent.fetch(`https://agent${path}`, init)).json())
const post = (body: unknown): RequestInit => ({ method: 'POST', body: JSON.stringify(body) })
const inspect = (agent: Agent, query: InspectQuery) => agentCall(agent, '/inspect', post(query))

/** `/mcp/inspect`: the caller's own agent, nobody else's. */
const ownerReader = (env: RuntimeEnv, principal: ClientPrincipal): InspectReader => {
  const agent = env.AGENTS.getByName(principal.subject)
  return { read: (query) => inspect(agent, query) }
}

/**
 * `/mcp/operator`: any user's agent, named by id or email. Each read is recorded in the operator's own agent first and
 * refused if that fails, then logged with ids only. The user is not told (ADR 0024).
 */
const operatorReader = (env: RuntimeEnv, principal: ClientPrincipal, client: string | undefined): InspectReader => {
  const own = env.AGENTS.getByName(principal.subject)
  return {
    read: async (query, user) => {
      const target = await userIdOf(env, user ?? '')
      if (target === undefined) throw new NotFound({ what: 'user' })
      const tool = `inspect_${query.kind}`
      await agentCall(
        own,
        '/operator-reads',
        post({
          user: target,
          clientId: principal.clientId,
          ...(client === undefined ? {} : { clientName: client }),
          tool,
          arguments: JSON.stringify(query),
        }),
      )
      console.log(
        JSON.stringify({
          level: 'info',
          event: 'operator_read',
          operator: principal.subject,
          user: target,
          client: principal.clientId,
          tool,
        }),
      )
      return inspect(env.AGENTS.getByName(target), query)
    },
    reads: (limit) => agentCall(own, `/operator-reads?limit=${limit}`),
  }
}

/**
 * `/mcp/inspect` and `/mcp/operator`: verify the token for exactly this endpoint (its audience, scope and the owner's
 * standing consent), check the operator allowlist on every request, then serve the stateless inspection server.
 */
export const handleInspectMcp = async (
  request: Request,
  env: RuntimeEnv,
  endpoint: Exclude<Endpoint, 'ask'>,
): Promise<Response> => {
  const header = request.headers.get('authorization') ?? ''
  if (!header.startsWith('Bearer ')) return challengeOf(env.APP_URL, endpoint)
  const token = header.slice('Bearer '.length)
  let principal: ClientPrincipal
  try {
    principal = await verifyClientToken(token, env, endpoint)
  } catch {
    return challengeOf(env.APP_URL, endpoint)
  }
  if (endpoint === 'operator' && !operatorsOf(env.OPERATORS).has(principal.subject))
    throw new Forbidden({ reason: 'not an operator' })
  const name = await clientName(principal.clientId, env)
  const reader = endpoint === 'operator' ? operatorReader(env, principal, name) : ownerReader(env, principal)
  const handler = createMcpHandler(() => inspectServer(reader, endpoint === 'operator'), {
    route: endpointPath(endpoint),
    ...inboundHosts(env.APP_URL),
  })
  return handler.fetch(request, {
    authInfo: { token, clientId: principal.clientId, scopes: [...principal.scopes], expiresAt: principal.expiresAt },
  })
}
