import type { Connection } from '@goblin/wallet/contract'
import type { WalletEnv } from '../env.ts'
import { type AuthApi, authStore } from './durable.ts'
import { type OAuthScope, mcpResource, tokenHash } from './validation.ts'

/** What an MCP request's access token grants: whose wallet, which client and connection, and which scopes. */
export interface AccessGrant {
  /** The owner's Privy user id: the ledger's Durable Object name. */
  readonly ownerUserId: string
  readonly clientId: string
  /** The connection (token family) the token belongs to, as `/api/connections` lists it. */
  readonly connectionId: string
  readonly scopes: readonly string[]
}

export type AccessResult =
  | { readonly ok: true; readonly grant: AccessGrant }
  | { readonly ok: false; readonly response: Response }

const resourceMetadata = (origin: string): string => `${origin}/.well-known/oauth-protected-resource/mcp`

const challenge = (origin: string, extra: string): string =>
  `Bearer resource_metadata="${resourceMetadata(origin)}"${extra}`

/** RFC 6750 401: no token, or one that is unknown, expired, revoked or for another resource. */
export const unauthorized = (origin: string, invalid: boolean): Response =>
  new Response(
    JSON.stringify({
      error: invalid ? 'invalid_token' : 'unauthorized',
      error_description: 'Connect this client to Goblin Wallet again.',
    }),
    {
      status: 401,
      headers: {
        'content-type': 'application/json; charset=utf-8',
        'www-authenticate': challenge(origin, invalid ? ', error="invalid_token"' : ''),
      },
    },
  )

/** RFC 6750 403 `insufficient_scope`, naming the scope a step-up must ask for. */
export const insufficientScope = (origin: string, scope: OAuthScope): Response =>
  new Response(JSON.stringify({ error: 'insufficient_scope', error_description: `This needs the ${scope} scope.` }), {
    status: 403,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'www-authenticate': challenge(origin, `, error="insufficient_scope", scope="${scope}"`),
    },
  })

/**
 * Checks `authorization: Bearer <access token>` against the store for this origin's `/mcp`. A refusal carries the
 * 401 to send, with the `WWW-Authenticate` header that points the client at the protected-resource metadata.
 */
export async function checkAccess(request: Request, store: AuthApi, nowMs: number): Promise<AccessResult> {
  const origin = new URL(request.url).origin
  const token = /^Bearer ([A-Za-z0-9_]{8,200})$/u.exec(request.headers.get('authorization') ?? '')?.[1]
  if (token === undefined) return { ok: false, response: unauthorized(origin, false) }
  const found = await store.resolveAccess(await tokenHash(token), mcpResource(origin), Math.floor(nowMs / 1000))
  if (found === undefined) return { ok: false, response: unauthorized(origin, true) }
  return {
    ok: true,
    grant: { ownerUserId: found.owner, clientId: found.clientId, connectionId: found.familyId, scopes: found.scopes },
  }
}

/** `checkAccess` over the `WalletAuth` singleton: what the MCP endpoint calls first. */
export const verifyAccessToken = (request: Request, env: WalletEnv): Promise<AccessResult> =>
  checkAccess(request, authStore(env.AUTH), Date.now())

const iso = (epochSeconds: number): string => new Date(epochSeconds * 1000).toISOString()

/** `GET /api/connections`: the owner's live MCP connections in the contract's shape. */
export async function listConnections(store: AuthApi, ownerUserId: string): Promise<Connection[]> {
  const rows = await store.connections(ownerUserId)
  return rows.map((row) => ({
    id: row.id,
    client: row.client,
    scopes: [...row.scopes],
    createdAt: iso(row.createdAt),
    ...(row.lastUsedAt === null ? {} : { lastUsedAt: iso(row.lastUsedAt) }),
  }))
}

/** `DELETE /api/connections/:id`: revokes one of the owner's connections; answers the remaining list. */
export async function disconnect(store: AuthApi, ownerUserId: string, connectionId: string): Promise<Connection[]> {
  await store.disconnect(ownerUserId, connectionId, Math.floor(Date.now() / 1000))
  return listConnections(store, ownerUserId)
}

/** `POST /api/revoke`'s OAuth half: every connection of the owner stops at once. */
export async function revokeOwnerConnections(store: AuthApi, ownerUserId: string): Promise<number> {
  return store.revokeOwner(ownerUserId, Math.floor(Date.now() / 1000))
}
