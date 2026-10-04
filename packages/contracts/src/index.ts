import { Predicate } from 'effect'

export type JsonObject = { readonly [key: string]: JsonValue }
export type JsonValue = null | boolean | number | string | JsonValue[] | JsonObject

export type Principal = {
  readonly issuer?: string
  readonly subject: string
  readonly clientId: string
  readonly tenantId?: string
  readonly scopes: readonly string[]
  readonly expiresAt?: number
  readonly grantGeneration?: number
}

export type ToolGrant = {
  readonly serverId: string
  readonly capability: 'tool' | 'resource' | 'prompt'
  readonly name: string
}

export type McpServerConfig = {
  readonly serverId: string
  readonly endpoint: string
  readonly issuer?: string
  readonly resource?: string
}

export type McpCompatibilityStatus = 'implemented' | 'tested' | 'deferred' | 'gap' | 'unknown'

export type McpCompatibilityRow = {
  readonly feature: string
  readonly revision: string
  readonly clientVersion: string
  readonly serverVersion: string
  readonly serverId: string
  readonly negotiatedCapability?: string
  readonly implementation: McpCompatibilityStatus
  readonly test: McpCompatibilityStatus
  readonly environment: 'unit' | 'workerd' | 'dev' | 'unknown'
  readonly evidence: string
  readonly gap?: string
}

export type PiSnapshot = {
  readonly kind: 'snapshot'
  readonly conversationId: string
  readonly messages: readonly JsonObject[]
  readonly pendingOperations: readonly string[]
}

export type PiEventBatch = {
  readonly kind: 'batch'
  readonly conversationId: string
  readonly events: readonly JsonObject[]
}

export type AgentProjection = PiSnapshot | PiEventBatch

export const isJsonObject = (value: JsonValue): value is JsonObject =>
  Predicate.isObject(value) && !Array.isArray(value)
