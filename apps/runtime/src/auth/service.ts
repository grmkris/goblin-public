import { verifyJwsAccessToken } from 'better-auth/oauth2'
import type { RuntimeEnv } from '../env.ts'
import { nowSeconds } from '../clock.ts'
import { Unauthenticated } from '../http/errors.ts'
import { authIssuer, createAuth } from './options.ts'
import {
  type ConsentRow,
  clientFromClaims,
  type ClientPrincipal,
  consentCovers,
  type TokenClaims,
} from './principal.ts'
import { type Endpoint, protectedResourceMetadata, requiredScope, resourceOf } from './resources.ts'

type UserSession = {
  readonly userId: string
  readonly expiresAt: number
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
    expiresAt: Math.floor(session.session.expiresAt.getTime() / 1000),
  }
}

/**
 * An inbound MCP client's access token for one endpoint: a signature from our own JWKS (read locally, no self-fetch),
 * our issuer, the endpoint's audience and scope, an enabled client, and the user's standing consent to that scope and
 * resource. Revoking the consent or the client, or consenting again more narrowly, ends access at once.
 */
export const verifyClientToken = async (
  token: string,
  env: RuntimeEnv,
  endpoint: Endpoint = 'ask',
): Promise<ClientPrincipal> => {
  const auth = createAuth(env, env.AUTH_DB)
  const resource = resourceOf(env.APP_URL, endpoint)
  let claims: TokenClaims
  try {
    claims = await verifyJwsAccessToken(token, {
      jwksFetch: () => auth.api.getJwks(),
      jwksCacheKey: auth,
      verifyOptions: { issuer: authIssuer(env.APP_URL), audience: resource },
    })
  } catch {
    throw new Unauthenticated({ reason: 'token' })
  }
  const principal = clientFromClaims(claims, { issuer: authIssuer(env.APP_URL), resource, now: nowSeconds() })
  const scope = requiredScope(endpoint)
  if (scope !== undefined && !principal.scopes.includes(scope)) throw new Unauthenticated({ reason: 'scope' })
  const client = await env.AUTH_DB.prepare('SELECT disabled FROM oauthClient WHERE clientId = ?')
    .bind(principal.clientId)
    .first<{ disabled: number | null }>()
  if (client === null || client.disabled === 1) throw new Unauthenticated({ reason: 'client revoked' })
  const consent = await env.AUTH_DB.prepare(
    'SELECT scopes, resources FROM oauthConsent WHERE clientId = ? AND userId = ?',
  )
    .bind(principal.clientId, principal.subject)
    .first<ConsentRow>()
  if (consent === null || !consentCovers(consent, scope, resource))
    throw new Unauthenticated({ reason: 'consent revoked' })
  return principal
}

/** No logging of auth request content; the provider owns its discovery/OAuth responses. */
export const handleAuth = (request: Request, env: RuntimeEnv): Promise<Response> =>
  createAuth(env, env.AUTH_DB).handler(request)

/** RFC 9728 metadata for the endpoint a `/.well-known/oauth-protected-resource…` path names. */
export const resourceMetadata = (env: Pick<RuntimeEnv, 'APP_URL'>, endpoint: Endpoint) =>
  protectedResourceMetadata(env.APP_URL, authIssuer(env.APP_URL), endpoint)

/** The registered name of an inbound client, for display and its conversation label. */
export const clientName = async (clientId: string, env: RuntimeEnv): Promise<string | undefined> =>
  (
    await env.AUTH_DB.prepare('SELECT name FROM oauthClient WHERE clientId = ?')
      .bind(clientId)
      .first<{ name: string | null }>()
  )?.name ?? undefined
