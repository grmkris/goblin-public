import type { McpServerConfig } from '@purrable/contracts'
import { Schema } from 'effect'
import type { RuntimeEnv } from '../env.ts'
import type { VerifiedMcpPrincipal } from '../auth/principal.ts'
import { D1GrantStore } from '../auth/store.ts'
import { McpConnectionManager } from './connection.ts'
import type { McpTokenSource } from './types.ts'

const ServerSchema = Schema.Struct({
  serverId: Schema.NonEmptyString,
  endpoint: Schema.NonEmptyString,
  issuer: Schema.optional(Schema.NonEmptyString),
  resource: Schema.optional(Schema.NonEmptyString),
})
const TokenSchema = Schema.Struct({
  token: Schema.NonEmptyString,
  issuer: Schema.NonEmptyString,
  resource: Schema.NonEmptyString,
  subject: Schema.NonEmptyString,
  scopes: Schema.Array(Schema.NonEmptyString),
  expiresAt: Schema.optional(Schema.Number.check(Schema.isInt(), Schema.isGreaterThan(0))),
})
type TokenConfig = typeof TokenSchema.Type
const decodeServers = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Array(ServerSchema)))
const decodeTokens = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Record(Schema.String, TokenSchema)))
const serversOf = (value: string | undefined): readonly McpServerConfig[] => {
  const parsed = decodeServers(value ?? '[]')
  return parsed.map((item) => {
    const url = new URL(item.endpoint)
    const localHttp = url.protocol === 'http:' && (url.hostname === 'localhost' || url.hostname === '127.0.0.1')
    if (url.protocol !== 'https:' && !localHttp) throw new Error('mcp_endpoint_not_https')
    return {
      serverId: item.serverId,
      endpoint: item.endpoint,
      ...(item.issuer === undefined ? {} : { issuer: item.issuer }),
      ...(item.resource === undefined ? {} : { resource: item.resource }),
    }
  })
}
const tokensOf = (value: string | undefined): ReadonlyMap<string, TokenConfig> => {
  const parsed = decodeTokens(value ?? '{}')
  const values = new Map<string, TokenConfig>()
  for (const [serverId, item] of Object.entries(parsed)) {
    values.set(serverId, {
      token: item.token,
      issuer: item.issuer,
      resource: item.resource,
      subject: item.subject,
      scopes: item.scopes,
      ...(item.expiresAt === undefined ? {} : { expiresAt: item.expiresAt }),
    })
  }
  return values
}
/** Build a manager for one authenticated principal. Token bytes stay in this closure and are never serialized. */
export const makeMcpManager = (env: RuntimeEnv, principal: VerifiedMcpPrincipal): McpConnectionManager => {
  const servers = serversOf(env.MCP_SERVERS)
  const tokens = tokensOf(env.MCP_TOKENS)
  return new McpConnectionManager({
    servers,
    grants: new D1GrantStore(env.AUTH_DB),
    tokenSource: async (server) => {
      const token = tokens.get(server.serverId)
      if (
        token === undefined ||
        principal.subject !== 'owner' ||
        (server.issuer !== undefined && token.issuer !== server.issuer) ||
        token.resource !== (server.resource ?? server.endpoint)
      )
        throw new Error('mcp_token_unavailable')
      const state: McpTokenSource['state'] = {
        issuer: token.issuer,
        resource: token.resource,
        subject: token.subject,
        scopes: token.scopes,
        ...(token.expiresAt === undefined ? {} : { expiresAt: token.expiresAt }),
      }
      return { state, token: async () => token.token }
    },
    // SAFETY: network fetch is the runtime's external MCP boundary; tokens are inserted by SDK authProvider only.
    fetch: globalThis.fetch,
    maxPages: 64,
    timeoutMs: 30_000,
  })
}
export const configuredServers = (env: RuntimeEnv): readonly McpServerConfig[] => serversOf(env.MCP_SERVERS)
