/**
 * goblin's one protected resource (ADR 0024): `/mcp`. Every client asks for the sign-in scopes and `goblin:inspect`;
 * the owner's consent decides, and a client consented without `goblin:inspect` gets no inspection tools.
 */
export const INSPECT_SCOPE = 'goblin:inspect'
/** What a client may ask for: `offline_access` earns a refresh token, `goblin:inspect` the read-only inspection tools. */
export const MCP_SCOPES = ['openid', 'profile', 'email', 'offline_access', INSPECT_SCOPE] as const

const METADATA_PATH = '/.well-known/oauth-protected-resource'
const base = (appUrl: string) => appUrl.replace(/\/$/u, '')

/** The canonical resource URL: the audience every token carries. */
export const mcpResource = (appUrl: string): string => `${base(appUrl)}/mcp`

export const protectedResourceMetadata = (appUrl: string, issuer: string) => ({
  resource: mcpResource(appUrl),
  authorization_servers: [issuer],
  bearer_methods_supported: ['header'],
  scopes_supported: [...MCP_SCOPES],
  resource_name: 'goblin',
})

/**
 * The 401 an unauthenticated request gets: where the metadata is, and the scopes to ask for, so a client's first
 * authorization already asks for inspection and the consent page can say so.
 */
export const challengeOf = (appUrl: string): Response =>
  new Response(JSON.stringify({ error: 'Unauthenticated' }), {
    status: 401,
    headers: {
      'content-type': 'application/json',
      'www-authenticate': `Bearer resource_metadata="${base(appUrl)}${METADATA_PATH}/mcp", scope="${MCP_SCOPES.join(' ')}"`,
    },
  })
