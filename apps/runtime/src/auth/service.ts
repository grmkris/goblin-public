import { verifyJwsAccessToken } from 'better-auth/oauth2'
import { DateTime, Option } from 'effect'
import { nowSeconds } from '../clock.ts'
import { Unauthenticated } from '../http/errors.ts'
import type { RuntimeEnv } from '../env.ts'
import { authIssuer, canonicalEmail, createAuth, mcpResource } from './options.ts'
import { principalFromClaims, type TokenClaims, type VerifiedMcpPrincipal } from './principal.ts'

const verifyBearerPrincipal = async (
  token: string,
  auth: ReturnType<typeof createAuth>,
  env: RuntimeEnv,
  now: number,
): Promise<VerifiedMcpPrincipal> => {
  const claims: TokenClaims = await verifyJwsAccessToken(token, {
    jwksFetch: () => auth.api.getJwks(),
    jwksCacheKey: auth,
    verifyOptions: { issuer: authIssuer(env.APP_URL), audience: mcpResource(env.APP_URL) },
  })
  const principal = principalFromClaims(claims, {
    issuer: authIssuer(env.APP_URL),
    resource: mcpResource(env.APP_URL),
    now,
  })
  if (claims.cnf !== undefined) throw new Unauthenticated({ reason: 'mcp_sender_constraint_unsupported' })
  const client = await env.AUTH_DB.prepare('SELECT disabled FROM oauthClient WHERE clientId = ?')
    .bind(principal.clientId)
    .first<{ disabled: number | null }>()
  if (client === null || client.disabled === 1) throw new Unauthenticated({ reason: 'mcp_client_revoked' })
  if (principal.sessionId === undefined) throw new Unauthenticated({ reason: 'mcp_session_missing' })
  const row = await env.AUTH_DB.prepare('SELECT userId, expiresAt FROM session WHERE id = ?')
    .bind(principal.sessionId)
    .first<{ userId: string; expiresAt: string | number }>()
  if (row === null || row.userId !== principal.subject) throw new Unauthenticated({ reason: 'mcp_session_revoked' })
  const parsed = DateTime.make(row.expiresAt)
  if (Option.isNone(parsed)) throw new Unauthenticated({ reason: 'mcp_session_expired' })
  const sessionExpiry = DateTime.toEpochMillis(parsed.value)
  if (sessionExpiry <= now * 1000) throw new Unauthenticated({ reason: 'mcp_session_expired' })
  return { ...principal, expiresAt: Math.min(principal.expiresAt, Math.floor(sessionExpiry / 1000)) }
}

const ownerPrincipal = (
  env: RuntimeEnv,
  session: { user: { id: string; email: string }; session: { id: string; expiresAt: Date } },
  now: number,
): VerifiedMcpPrincipal => {
  if (session.user.id !== 'owner') throw new Unauthenticated({ reason: 'owner_session_required' })
  if (canonicalEmail(session.user.email) !== canonicalEmail(env.OWNER_EMAIL))
    throw new Unauthenticated({ reason: 'owner_session_required' })
  if (session.session.expiresAt.getTime() <= now * 1000) throw new Unauthenticated({ reason: 'owner_session_required' })
  return {
    issuer: authIssuer(env.APP_URL),
    subject: session.user.id,
    clientId: 'owner-session',
    sessionId: session.session.id,
    resource: mcpResource(env.APP_URL),
    scopes: ['openid', 'profile', 'email', 'offline_access'],
    expiresAt: Math.floor(session.session.expiresAt.getTime() / 1000),
    grantGeneration: 0,
    authKind: 'owner',
  }
}

/** User sessions identify the owner; OAuth access tokens identify an agent and never count as owner sessions. */
export const authPrincipal = async (request: Request, env: RuntimeEnv): Promise<VerifiedMcpPrincipal> => {
  const auth = createAuth(env, env.AUTH_DB)
  const now = nowSeconds()
  const authorization = request.headers.get('authorization')
  if (authorization?.startsWith('Bearer ')) {
    return verifyBearerPrincipal(authorization.slice(7), auth, env, now)
  }
  const session = await auth.api.getSession({ headers: request.headers })
  if (session === null) throw new Unauthenticated({ reason: 'owner_session_required' })
  return ownerPrincipal(env, session, now)
}
export const requireOwnerSession = async (request: Request, env: RuntimeEnv): Promise<VerifiedMcpPrincipal> => {
  if (request.headers.has('authorization')) throw new Unauthenticated({ reason: 'owner_session_required' })
  const principal = await authPrincipal(request, env)
  if (principal.authKind !== 'owner') throw new Unauthenticated({ reason: 'owner_session_required' })
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

/** Revalidate stored owner metadata after a Durable Object wake; only the session id crosses the durable boundary. */
export const validateResidentPrincipal = async (
  env: RuntimeEnv,
  principal: VerifiedMcpPrincipal,
): Promise<VerifiedMcpPrincipal> => {
  if (principal.authKind !== 'owner' || principal.subject !== 'owner' || principal.sessionId === undefined)
    throw new Unauthenticated({ reason: 'owner_session_required' })
  const row = await env.AUTH_DB.prepare('SELECT userId, expiresAt FROM session WHERE id = ?')
    .bind(principal.sessionId)
    .first<{ userId: string; expiresAt: string | number }>()
  if (row === null || row.userId !== 'owner') throw new Unauthenticated({ reason: 'owner_session_revoked' })
  const now = Date.now()
  const parsed = DateTime.make(row.expiresAt)
  if (Option.isNone(parsed)) throw new Unauthenticated({ reason: 'owner_session_expired' })
  const expiry = DateTime.toEpochMillis(parsed.value)
  if (expiry <= now) throw new Unauthenticated({ reason: 'owner_session_expired' })
  return { ...principal, expiresAt: Math.floor(expiry / 1000) }
}
