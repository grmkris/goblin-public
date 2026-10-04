import { Predicate } from 'effect'
import type { McpServerConfig } from '@purrable/contracts'
import type { RuntimeEnv } from '../env.ts'
import type { VerifiedMcpPrincipal } from '../auth/principal.ts'
import { McpBoundaryError } from './errors.ts'
import { configuredServers, makeMcpManager } from './runtime.ts'

const json = (value: unknown, status = 200): Response => Response.json(value, { status })
const record = (value: unknown): value is { readonly [key: string]: unknown } => Predicate.isObject(value)
const stringArguments = (value: unknown): Record<string, string> | undefined => {
  if (!record(value)) return undefined
  const entries = Object.entries(value)
  if (entries.length > 128) return undefined
  const result: Record<string, string> = {}
  for (const [key, item] of entries) {
    if (key.length === 0 || key.length > 256 || !Predicate.isString(item) || item.length > 16_384) return undefined
    result[key] = item
  }
  return result
}
const server = (env: RuntimeEnv, id: string): McpServerConfig => {
  const found = configuredServers(env).find((candidate) => candidate.serverId === id)
  if (found === undefined) throw new McpBoundaryError('unsupported', id)
  return found
}
const statusFor = (tag: McpBoundaryError['tag']): number => {
  if (tag === 'grant-denied') return 403
  if (tag === 'unauthorized') return 401
  return 502
}
const errorResponse = (error: unknown): Response =>
  error instanceof McpBoundaryError
    ? json({ error: error.message }, statusFor(error.tag))
    : json({ error: 'mcp_request_failed' }, 502)
export const listMcpServers = (env: RuntimeEnv): Response =>
  json({
    servers: configuredServers(env).map(({ serverId, endpoint, issuer, resource }) => ({
      serverId,
      endpoint,
      ...(issuer === undefined ? {} : { issuer }),
      ...(resource === undefined ? {} : { resource }),
    })),
  })
export const connectMcpServer = async (
  env: RuntimeEnv,
  principal: VerifiedMcpPrincipal,
  serverId: string,
): Promise<Response> => {
  try {
    server(env, serverId)
    const manager = makeMcpManager(env, principal)
    try {
      return json(await manager.connect(principal, serverId))
    } finally {
      await manager.closeAll()
    }
  } catch (error) {
    return errorResponse(error)
  }
}
export const callMcpTool = async (
  env: RuntimeEnv,
  principal: VerifiedMcpPrincipal,
  serverId: string,
  body: unknown,
  caller: 'human' | 'app' = 'human',
): Promise<Response> => {
  try {
    server(env, serverId)
    if (!record(body) || !Predicate.isString(body['name']) || body['name'].length === 0 || body['name'].length > 256)
      return json({ error: 'mcp_tool_invalid' }, 400)
    const args = body['arguments']
    if (args !== undefined && !Predicate.isObject(args)) return json({ error: 'mcp_arguments_invalid' }, 400)
    const manager = makeMcpManager(env, principal)
    try {
      return json(await manager.callTool(principal, serverId, body['name'], args ?? {}, { caller }))
    } finally {
      await manager.closeAll()
    }
  } catch (error) {
    return errorResponse(error)
  }
}
export const readMcpResource = async (
  env: RuntimeEnv,
  principal: VerifiedMcpPrincipal,
  serverId: string,
  uri: string,
  caller: 'human' | 'app' = 'human',
): Promise<Response> => {
  try {
    server(env, serverId)
    const manager = makeMcpManager(env, principal)
    try {
      return json(
        caller === 'app'
          ? await manager.readAppResource(principal, serverId, uri)
          : await manager.readResource(principal, serverId, uri),
      )
    } finally {
      await manager.closeAll()
    }
  } catch (error) {
    return errorResponse(error)
  }
}
export const getMcpPrompt = async (
  env: RuntimeEnv,
  principal: VerifiedMcpPrincipal,
  serverId: string,
  body: unknown,
): Promise<Response> => {
  try {
    server(env, serverId)
    if (!record(body) || !Predicate.isString(body['name'])) return json({ error: 'mcp_prompt_invalid' }, 400)
    const args = body['arguments'] === undefined ? {} : stringArguments(body['arguments'])
    if (args === undefined) return json({ error: 'mcp_prompt_arguments_invalid' }, 400)
    const manager = makeMcpManager(env, principal)
    try {
      return json(await manager.getPrompt(principal, serverId, body['name'], args ?? {}))
    } finally {
      await manager.closeAll()
    }
  } catch (error) {
    return errorResponse(error)
  }
}
