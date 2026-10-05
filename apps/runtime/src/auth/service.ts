import { verifyJwsAccessToken } from 'better-auth/oauth2'
import type { RuntimeEnv } from '../env.ts'
import { nowSeconds } from '../clock.ts'
import { Unauthenticated } from '../http/errors.ts'
import { authIssuer, createAuth, mcpResource } from './options.ts'
import { clientFromClaims, type ClientPrincipal, type TokenClaims } from './principal.ts'

export type UserSession = {
  readonly userId: string
  readonly sessionId: string
  readonly expiresAt: number
  readonly email: string
  readonly emailVerified: boolean
  readonly createdAt: number
}

/**
 * A signed-in user's browser session (cookie): that user owns one agent. Bearer tokens never count: a request that
 * carries one is rejected here, so inbound MCP clients cannot reach owner routes or outbound credentials.
 */
export const requireUserSession = async (request: Request, env: RuntimeEnv): Promise<UserSession> => {
  if (request.headers.has('authorization')) throw new Unauthenticated({ reason: 'session required' })
  const session = await createAuth(env, env.AUTH_DB).api.getSession({ headers: request.headers })
  if (session === null || session.session.expiresAt.getTime() <= Date.now())
    throw new Unauthenticated({ reason: 'session required' })
  return {
    userId: session.user.id,
    sessionId: session.session.id,
    expiresAt: Math.floor(session.session.expiresAt.getTime() / 1000),
    email: session.user.email,
    emailVerified: session.user.emailVerified,
    createdAt: session.session.createdAt.getTime(),
  }
}

/**
 * An inbound MCP client's access token: a signature from our own JWKS (read locally, no self-fetch), our issuer and
 * /mcp audience, an enabled client and the user's standing consent. Revoking the consent or the client ends access.
 */
export const verifyClientToken = async (token: string, env: RuntimeEnv): Promise<ClientPrincipal> => {
  const auth = createAuth(env, env.AUTH_DB)
  let claims: TokenClaims
  try {
    claims = await verifyJwsAccessToken(token, {
      jwksFetch: () => auth.api.getJwks(),
      jwksCacheKey: auth,
      verifyOptions: { issuer: authIssuer(env.APP_URL), audience: mcpResource(env.APP_URL) },
    })
  } catch {
    throw new Unauthenticated({ reason: 'token' })
  }
  const principal = clientFromClaims(claims, {
    issuer: authIssuer(env.APP_URL),
    resource: mcpResource(env.APP_URL),
    now: nowSeconds(),
  })
  const client = await env.AUTH_DB.prepare('SELECT disabled FROM oauthClient WHERE clientId = ?')
    .bind(principal.clientId)
    .first<{ disabled: number | null }>()
  if (client === null || client.disabled === 1) throw new Unauthenticated({ reason: 'client revoked' })
  const consent = await env.AUTH_DB.prepare('SELECT 1 AS ok FROM oauthConsent WHERE clientId = ? AND userId = ?')
    .bind(principal.clientId, principal.subject)
    .first<{ ok: number }>()
  if (consent === null) throw new Unauthenticated({ reason: 'consent revoked' })
  return principal
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

/** The registered name of an inbound client, for display and its conversation label. */
export const clientName = async (clientId: string, env: RuntimeEnv): Promise<string | undefined> =>
  (
    await env.AUTH_DB.prepare('SELECT name FROM oauthClient WHERE clientId = ?')
      .bind(clientId)
      .first<{ name: string | null }>()
  )?.name ?? undefined
