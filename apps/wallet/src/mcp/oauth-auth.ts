import type { WalletEnv } from '../env.ts'
import { unauthorized, verifyAccessToken } from '../oauth/access.ts'
import { authStore } from '../oauth/durable.ts'
import type { McpAuthenticator, McpPrincipal } from './auth.ts'

const BEARER = /^Bearer ([A-Za-z0-9_]{8,200})$/u

/** The deployed authenticator: lane S's OAuth store resolves the bearer token to an owner, a client and its scopes. */
export const oauthAuthenticator: McpAuthenticator = async (request, env: WalletEnv) => {
  if (!BEARER.test(request.headers.get('authorization') ?? '')) return unauthorized(new URL(request.url).origin, false)
  const access = await verifyAccessToken(request, env)
  if (!access.ok) return access.response
  const { grant } = access
  const name = (await authStore(env.AUTH).client(grant.clientId))?.name
  const token = BEARER.exec(request.headers.get('authorization') ?? '')?.[1] ?? ''
  const principal: McpPrincipal = {
    ownerUserId: grant.ownerUserId,
    clientId: grant.clientId,
    clientName: name ?? 'an MCP client',
    scopes: grant.scopes,
    token,
  }
  return principal
}
