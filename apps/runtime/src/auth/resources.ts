/**
 * The protected resources this server issues tokens for (ADR 0024). Each is its own OAuth audience with its own
 * metadata and challenge, so a token for one is never accepted by another:
 *
 * - `ask` (`/mcp`): ask the agent, read main's recent messages. No scope beyond sign-in.
 * - `inspect` (`/mcp/inspect`): read the caller's own agent, in full. Scope `goblin:inspect`.
 *
 * Separate resources instead of step-up scopes on one: MCP clients handle a first-connect challenge reliably, while
 * `insufficient_scope` step-up is not yet dependable in them.
 */
export type Endpoint = 'ask' | 'inspect'

export const INSPECT_SCOPE = 'goblin:inspect'
/** Sign-in scopes every client may ask for; `offline_access` is what earns a refresh token. */
export const SIGN_IN_SCOPES = ['openid', 'profile', 'email', 'offline_access'] as const

const PATHS: Readonly<Record<Endpoint, string>> = { ask: '/mcp', inspect: '/mcp/inspect' }
const SCOPES: Readonly<Record<Endpoint, readonly string[]>> = {
  ask: SIGN_IN_SCOPES,
  inspect: [INSPECT_SCOPE, 'offline_access'],
}
const NAMES: Readonly<Record<Endpoint, string>> = {
  ask: 'goblin',
  inspect: 'goblin inspection',
}
const METADATA_PATH = '/.well-known/oauth-protected-resource'

const base = (appUrl: string) => appUrl.replace(/\/$/u, '')

/** The endpoint's canonical resource URL: the audience its tokens carry. */
export const resourceOf = (appUrl: string, endpoint: Endpoint): string => `${base(appUrl)}${PATHS[endpoint]}`
/** The scope a token needs beyond its audience, if any. */
export const requiredScope = (endpoint: Endpoint): string | undefined =>
  endpoint === 'inspect' ? INSPECT_SCOPE : undefined
/** The scopes a token for the endpoint may carry: the rest of a request is dropped by the provider. */
export const resourceScopes = (endpoint: Endpoint): readonly string[] => SCOPES[endpoint]

/** The endpoint an RFC 9728 metadata path names; the bare path and anything unknown is `/mcp`, as before. */
export const endpointOfMetadata = (pathname: string): Endpoint => {
  const suffix = pathname.slice(METADATA_PATH.length).replace(/\/$/u, '')
  if (suffix === PATHS.inspect) return 'inspect'
  return 'ask'
}

export const protectedResourceMetadata = (appUrl: string, issuer: string, endpoint: Endpoint) => ({
  resource: resourceOf(appUrl, endpoint),
  authorization_servers: [issuer],
  bearer_methods_supported: ['header'],
  scopes_supported: [...SCOPES[endpoint]],
  resource_name: NAMES[endpoint],
})

/**
 * The 401 an unauthenticated request gets: where the endpoint's metadata is and, for the inspection endpoints,
 * exactly the scope to ask for, so a client's first authorization is the right one.
 */
export const challengeOf = (appUrl: string, endpoint: Endpoint): Response => {
  const metadata = `${base(appUrl)}${METADATA_PATH}${PATHS[endpoint]}`
  const scope = endpoint === 'ask' ? '' : `, scope="${SCOPES[endpoint].join(' ')}"`
  return new Response(JSON.stringify({ error: 'Unauthenticated' }), {
    status: 401,
    headers: {
      'content-type': 'application/json',
      'www-authenticate': `Bearer resource_metadata="${metadata}"${scope}`,
    },
  })
}
