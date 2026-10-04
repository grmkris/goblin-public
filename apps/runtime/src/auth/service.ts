import type { RuntimeEnv } from '../env.ts'
import { Unauthenticated } from '../http/errors.ts'
import { authIssuer, canonicalEmail, createAuth, mcpResource } from './options.ts'

export type OwnerSession = { readonly sessionId: string; readonly expiresAt: number }

/**
 * The owner's browser session (cookie). Bearer tokens never count as the owner: a request that carries one is
 * rejected here, so inbound MCP clients cannot reach owner routes or outbound credentials.
 */
export const requireOwnerSession = async (request: Request, env: RuntimeEnv): Promise<OwnerSession> => {
  if (request.headers.has('authorization')) throw new Unauthenticated({ reason: 'owner session required' })
  const session = await createAuth(env, env.AUTH_DB).api.getSession({ headers: request.headers })
  if (
    session === null ||
    session.user.id !== 'owner' ||
    canonicalEmail(session.user.email) !== canonicalEmail(env.OWNER_EMAIL) ||
    session.session.expiresAt.getTime() <= Date.now()
  )
    throw new Unauthenticated({ reason: 'owner session required' })
  return { sessionId: session.session.id, expiresAt: Math.floor(session.session.expiresAt.getTime() / 1000) }
}

/** No logging of auth request content; the provider owns its discovery/OAuth responses. */
export const handleAuth = (request: Request, env: RuntimeEnv): Promise<Response> =>
  createAuth(env, env.AUTH_DB).handler(request)

export const protectedResourceMetadata = (env: Pick<RuntimeEnv, 'APP_URL'>) => ({
  resource: mcpResource(env.APP_URL),
  authorization_servers: [authIssuer(env.APP_URL)],
  bearer_methods_supported: ['header'],
  scopes_supported: ['openid', 'profile', 'email', 'offline_access'],
  resource_name: 'purrable',
})
