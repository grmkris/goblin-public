import type { McpServerConfig } from '@goblin/contracts'
import * as Schema from 'effect/Schema'
import { Internal } from '../http/errors.ts'

const ServerSchema = Schema.Struct({
  serverId: Schema.NonEmptyString,
  endpoint: Schema.NonEmptyString,
  issuer: Schema.optional(Schema.NonEmptyString),
  resource: Schema.optional(Schema.NonEmptyString),
})
const decodeServers = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Array(ServerSchema)))

/** The configured outbound servers (`MCP_SERVERS` JSON). Only https endpoints, or http on localhost for tests. */
export const configuredServers = (json: string | undefined): readonly McpServerConfig[] => {
  let parsed: readonly (typeof ServerSchema.Type)[]
  try {
    parsed = decodeServers(json ?? '[]')
  } catch {
    throw new Internal({ reason: 'MCP_SERVERS is not a valid server list' })
  }
  return parsed.map((item) => ({
    serverId: item.serverId,
    endpoint: item.endpoint,
    ...(item.issuer === undefined ? {} : { issuer: item.issuer }),
    ...(item.resource === undefined ? {} : { resource: item.resource }),
  }))
}
