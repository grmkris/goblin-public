/**
 * OAuth 2.1 for public MCP clients, ported from Sidequest's `apps/api/src/oauth-validation.ts`: exact redirect URIs
 * (HTTPS, or HTTP on loopback), PKCE S256 only, one protected resource (`<origin>/mcp`), and tokens kept only as their
 * SHA-256.
 */

/** What a connection may do: read the wallet, and spend within the owner's limits. */
export const OAUTH_SCOPES = ['wallet:read', 'wallet:spend'] as const
export type OAuthScope = (typeof OAUTH_SCOPES)[number]

const isScope = (value: string): value is OAuthScope => OAUTH_SCOPES.some((scope) => scope === value)

/**
 * The scopes a request gets: the supported ones it asked for, in our order. Unknown scopes are dropped (RFC 6749
 * lets the server grant less); a request naming none of ours, or no `scope` at all, asks for every scope, and the
 * consent page shows exactly which.
 */
export const grantedScopes = (requested: string | null): OAuthScope[] => {
  const asked = new Set((requested ?? '').split(' ').filter(isScope))
  const scopes = OAUTH_SCOPES.filter((scope) => asked.has(scope))
  return scopes.length === 0 ? [...OAUTH_SCOPES] : scopes
}

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]'])

/** An exact redirect URI a client may register: HTTPS, or HTTP on loopback; no credentials, no fragment. */
export const validRedirect = (value: unknown): value is string => {
  if (typeof value !== 'string' || value.length > 2048 || !URL.canParse(value)) return false
  const url = new URL(value)
  return (
    url.username === '' &&
    url.password === '' &&
    url.hash === '' &&
    (url.protocol === 'https:' || (url.protocol === 'http:' && LOOPBACK.has(url.hostname)))
  )
}

/**
 * A URL the wallet may send the owner back to once setup is done: HTTPS, or HTTP on loopback for local development,
 * without credentials. Whether its origin is one of the owner's clients is the store's to say (`returnOrigins`).
 */
export const returnUrl = (value: string): URL | undefined => {
  if (value.length > 2048 || !URL.canParse(value)) return undefined
  const url = new URL(value)
  const secure = url.protocol === 'https:' || (url.protocol === 'http:' && LOOPBACK.has(url.hostname))
  return secure && url.username === '' && url.password === '' ? url : undefined
}

/** The one protected resource: this origin's `/mcp`, exactly. */
export const mcpResource = (origin: string): string => `${origin}/mcp`

export const PKCE_CHALLENGE = /^[-_A-Za-z0-9]{43}$/u
export const PKCE_VERIFIER = /^[A-Za-z0-9._~-]{43,128}$/u

const hex = (bytes: ArrayBuffer | Uint8Array): string =>
  Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, '0')).join('')

/** 32 random bytes as hex, with a prefix that tells a secret scanner what it is. */
export const randomToken = (prefix: string): string => `${prefix}${hex(crypto.getRandomValues(new Uint8Array(32)))}`

/** What the store keeps instead of a token: its SHA-256, hex. */
export const tokenHash = async (token: string): Promise<string> =>
  hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token)))

/** RFC 7636 S256: base64url(SHA-256(verifier)) without padding. */
export const pkceChallenge = async (verifier: string): Promise<string> => {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)))
  return btoa(String.fromCharCode(...digest))
    .replaceAll('=', '')
    .replaceAll('+', '-')
    .replaceAll('/', '_')
}
