import type { WalletEnv } from '../env.ts'
import { apiError } from '../http.ts'

/** Who an MCP request acts for: the Privy user who consented, and the client they connected. */
export interface McpPrincipal {
  readonly ownerUserId: string
  readonly clientId: string
  /** The client's name as the owner knows it. */
  readonly clientName: string
  readonly scopes: readonly string[]
  readonly token: string
  readonly expiresAt?: number
}

/** Verifies the OAuth bearer token (lane S) and names the principal, or answers the challenge. */
export type McpAuthenticator = (request: Request, env: WalletEnv) => Promise<McpPrincipal | Response>

/** The challenge a client without a token gets: where the protected-resource metadata lives. */
export const challenge = (request: Request): Response => {
  const origin = new URL(request.url).origin
  const response = apiError('unauthorized', 'Connect this client to Goblin Wallet first.', 401)
  const headers = new Headers(response.headers)
  headers.set('www-authenticate', `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"`)
  return new Response(response.body, { status: 401, headers })
}
