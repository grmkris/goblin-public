import { Predicate } from 'effect'
import { Unauthenticated } from '../http/errors.ts'

/** An inbound MCP client acting for the owner with a Better Auth access token. Never an owner session. */
export type ClientPrincipal = {
  readonly clientId: string
  readonly subject: string
  readonly scopes: readonly string[]
  readonly expiresAt: number
}
export interface TokenClaims {
  readonly iss?: unknown
  readonly sub?: unknown
  readonly aud?: unknown
  readonly azp?: unknown
  readonly client_id?: unknown
  readonly scope?: unknown
  readonly exp?: unknown
  readonly cnf?: unknown
}
const text = (value: unknown): value is string => Predicate.isString(value) && value.length > 0
const audiences = (value: unknown): readonly string[] =>
  Array.isArray(value) ? value.filter(text) : text(value) ? [value] : []

/** Check the claims the signature does not: issuer, audience (our /mcp resource), expiry, subject and client. */
export const clientFromClaims = (
  claims: TokenClaims,
  expected: { readonly issuer: string; readonly resource: string; readonly now: number },
): ClientPrincipal => {
  const clientId = text(claims.azp) ? claims.azp : claims.client_id
  if (!text(claims.iss) || claims.iss !== expected.issuer) throw new Unauthenticated({ reason: 'issuer' })
  if (!audiences(claims.aud).includes(expected.resource)) throw new Unauthenticated({ reason: 'audience' })
  if (!Predicate.isNumber(claims.exp) || !Number.isSafeInteger(claims.exp) || claims.exp <= expected.now)
    throw new Unauthenticated({ reason: 'expired' })
  if (!text(claims.sub)) throw new Unauthenticated({ reason: 'subject' })
  if (!text(clientId)) throw new Unauthenticated({ reason: 'client' })
  if (claims.cnf !== undefined) throw new Unauthenticated({ reason: 'sender-constrained tokens are not supported' })
  return {
    clientId,
    subject: claims.sub,
    scopes: Predicate.isString(claims.scope) ? claims.scope.split(/\s+/u).filter(Boolean) : [],
    expiresAt: claims.exp,
  }
}

/** A user's consent to one client, as the provider stores it: scope and resource lists as JSON text. */
export type ConsentRow = { readonly scopes: string | null; readonly resources: string | null }

const textList = (value: string | null): readonly string[] => {
  if (value === null) return []
  try {
    const parsed: unknown = JSON.parse(value)
    return Array.isArray(parsed) ? parsed.filter(text) : []
  } catch {
    return []
  }
}

/**
 * Whether a standing consent still covers an endpoint: any consent covers `/mcp` (as before resources were recorded);
 * an inspection endpoint needs its scope and its resource in the latest consent. Anything unreadable covers nothing.
 */
export const consentCovers = (consent: ConsentRow, scope: string | undefined, resource: string): boolean =>
  scope === undefined || (textList(consent.scopes).includes(scope) && textList(consent.resources).includes(resource))
