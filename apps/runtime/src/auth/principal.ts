import { Clock, Effect, Predicate } from 'effect'
import { constantTimeEqual } from 'better-auth/crypto'

export type VerifiedMcpPrincipal = {
  readonly issuer: string
  readonly subject: string
  readonly clientId: string
  readonly tenantId?: string
  readonly authKind?: 'owner' | 'mcp'
  readonly sessionId?: string
  readonly resource: string
  readonly scopes: readonly string[]
  readonly expiresAt: number
  readonly grantGeneration: number
}
export type GrantCapability = 'tool' | 'resource' | 'prompt'
export type GrantRecord = {
  readonly issuer: string
  readonly subject: string
  readonly clientId: string
  readonly serverId: string
  readonly capability: GrantCapability
  readonly name: string
  readonly scopes: readonly string[]
  readonly generation: number
  readonly expiresAt?: number
  readonly tenantId?: string
}
export interface GrantStore {
  findGrant(input: {
    issuer: string
    subject: string
    clientId: string
    serverId: string
    capability: GrantCapability
    name: string
  }): Promise<GrantRecord | undefined>
  currentGeneration(input: { issuer: string; subject: string; clientId: string; serverId: string }): Promise<number>
}
export interface TokenClaims {
  readonly iss?: unknown
  readonly sub?: unknown
  readonly aud?: unknown
  readonly azp?: unknown
  readonly client_id?: unknown
  readonly scope?: unknown
  readonly exp?: unknown
  readonly tenant?: unknown
  readonly grant_gen?: unknown
  readonly sid?: unknown
  readonly cnf?: unknown
}
const text = (value: unknown): value is string => typeof value === 'string' && value.length > 0
const audiences = (value: unknown): readonly string[] =>
  Array.isArray(value) ? value.filter(text) : text(value) ? [value] : []
export const principalFromClaims = (
  claims: TokenClaims,
  expected: { issuer: string; resource: string; now: number },
): VerifiedMcpPrincipal => {
  const now = expected.now
  const subject = claims.sub
  const issuer = claims.iss
  const clientId = text(claims.azp) ? claims.azp : claims.client_id
  if (!text(issuer) || issuer !== expected.issuer) throw new Error('mcp_issuer_mismatch')
  if (!text(subject)) throw new Error('mcp_subject_missing')
  if (!text(clientId)) throw new Error('mcp_client_missing')
  if (!audiences(claims.aud).includes(expected.resource)) throw new Error('mcp_audience_mismatch')
  if (!Predicate.isNumber(claims.exp) || !Number.isSafeInteger(claims.exp) || claims.exp <= now)
    throw new Error('mcp_token_expired')
  const generation = claims.grant_gen
  if (
    generation !== undefined &&
    (!Predicate.isNumber(generation) || !Number.isSafeInteger(generation) || generation < 0)
  )
    throw new Error('mcp_grant_generation_invalid')
  const scopes = Predicate.isString(claims.scope) ? claims.scope.split(/\s+/u).filter(Boolean) : []
  return {
    issuer,
    subject,
    clientId,
    ...(text(claims.tenant) ? { tenantId: claims.tenant } : {}),
    ...(text(claims.sid) ? { sessionId: claims.sid } : {}),
    resource: expected.resource,
    scopes,
    expiresAt: claims.exp,
    grantGeneration: generation ?? 0,
  }
}
export const requireGrant = async (
  store: GrantStore,
  principal: VerifiedMcpPrincipal,
  input: { serverId: string; capability: GrantCapability; name: string },
): Promise<GrantRecord> => {
  const now = Math.floor((await Effect.runPromise(Clock.currentTimeMillis)) / 1000)
  if (principal.expiresAt <= now) throw new Error('mcp_token_expired')
  const grant = await store.findGrant({
    issuer: principal.issuer,
    subject: principal.subject,
    clientId: principal.clientId,
    ...input,
  })
  if (
    grant === undefined ||
    grant.generation !==
      (await store.currentGeneration({
        issuer: principal.issuer,
        subject: principal.subject,
        clientId: principal.clientId,
        serverId: input.serverId,
      })) ||
    (principal.authKind !== 'owner' && grant.generation !== principal.grantGeneration)
  )
    throw new Error('mcp_grant_denied')
  if (grant.expiresAt !== undefined && grant.expiresAt <= now) throw new Error('mcp_grant_expired')
  if (grant.tenantId !== principal.tenantId || !grant.scopes.every((scope) => principal.scopes.includes(scope)))
    throw new Error('mcp_grant_scope_denied')
  if (!input.name || grant.name !== input.name || grant.capability !== input.capability)
    throw new Error('mcp_grant_capability_denied')
  return grant
}
/** Explicit stage and configured owner identity gate; never admit an unset token. */
export const requireDevBootstrap = (
  env: { STAGE: string; OWNER_EMAIL: string; OWNER_BOOTSTRAP_TOKEN: string },
  token: string,
): void => {
  if (env.STAGE !== 'dev' && env.STAGE !== 'local' && env.STAGE !== 'test') throw new Error('owner_bootstrap_disabled')
  if (!env.OWNER_EMAIL || !env.OWNER_BOOTSTRAP_TOKEN || !constantTimeEqual(token, env.OWNER_BOOTSTRAP_TOKEN))
    throw new Error('owner_bootstrap_denied')
}
