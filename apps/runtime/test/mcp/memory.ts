import type { OAuthDiscoveryState, StoredOAuthClientInformation, StoredOAuthTokens } from '@modelcontextprotocol/client'
import {
  type ConnectionStatus,
  type Credentials,
  type InvalidationScope,
  PENDING_TTL_SECONDS,
} from '../../src/mcp/credentials.ts'
import type { Grant, Grants } from '../../src/mcp/grants.ts'
import type { AddedRegistries } from '../../src/mcp/registries.ts'
import type { Registry } from '../../src/mcp/registry.ts'
import type { AddedServer, AddedServers } from '../../src/mcp/servers.ts'

type Row = {
  status: 'connected' | 'needs_auth'
  client?: StoredOAuthClientInformation
  tokens?: StoredOAuthTokens
  discovery?: OAuthDiscoveryState
  expiresAt?: number
}

/** The credential records in memory, with the same semantics as the SQLite store (minus encryption). */
export class MemoryCredentials implements Credentials {
  readonly rows = new Map<string, Row>()
  readonly pending = new Map<string, { serverId: string; codeVerifier: string; createdAt: number }>()
  #row(serverId: string): Row {
    const row = this.rows.get(serverId) ?? { status: 'needs_auth' }
    this.rows.set(serverId, row)
    return row
  }
  status(serverId: string): ConnectionStatus {
    const row = this.rows.get(serverId)
    if (row === undefined) return 'disconnected'
    return row.status === 'connected' && row.tokens !== undefined ? 'connected' : 'needs_auth'
  }
  tokenExpiresAt(serverId: string): number | undefined {
    return this.rows.get(serverId)?.expiresAt
  }
  async clientInformation(serverId: string) {
    return this.rows.get(serverId)?.client
  }
  async saveClientInformation(serverId: string, info: StoredOAuthClientInformation) {
    this.#row(serverId).client = info
  }
  async tokens(serverId: string) {
    return this.rows.get(serverId)?.tokens
  }
  async saveTokens(serverId: string, tokens: StoredOAuthTokens, now: number) {
    const row = this.#row(serverId)
    row.tokens = tokens
    row.status = 'connected'
    if (tokens.expires_in === undefined) delete row.expiresAt
    else row.expiresAt = now + tokens.expires_in
  }
  discoveryState(serverId: string) {
    return this.rows.get(serverId)?.discovery
  }
  saveDiscoveryState(serverId: string, state: OAuthDiscoveryState) {
    this.#row(serverId).discovery = state
  }
  markNeedsAuth(serverId: string) {
    this.#row(serverId).status = 'needs_auth'
  }
  invalidate(serverId: string, scope: InvalidationScope) {
    const row = this.#row(serverId)
    if (scope === 'all' || scope === 'tokens') {
      delete row.tokens
      delete row.expiresAt
      row.status = 'needs_auth'
    }
    if (scope === 'all' || scope === 'client') delete row.client
    if (scope === 'all' || scope === 'discovery') delete row.discovery
  }
  remove(serverId: string) {
    this.rows.delete(serverId)
  }
  async savePending(state: string, serverId: string, codeVerifier: string, now: number) {
    this.pending.set(state, { serverId, codeVerifier, createdAt: now })
  }
  async takePending(state: string, now: number) {
    const entry = this.pending.get(state)
    this.pending.delete(state)
    if (entry === undefined || entry.createdAt < now - PENDING_TTL_SECONDS) return undefined
    return { serverId: entry.serverId, codeVerifier: entry.codeVerifier }
  }
}

export class MemoryGrants implements Grants {
  readonly #grants = new Map<string, Grant>()
  constructor(initial: readonly Grant[] = []) {
    for (const grant of initial) this.set(grant, true)
  }
  #key = (grant: Grant): string => JSON.stringify([grant.serverId, grant.capability, grant.name])
  allows(grant: Grant): boolean {
    return this.#grants.has(this.#key(grant))
  }
  list(serverId?: string): readonly Grant[] {
    return [...this.#grants.values()].filter((grant) => serverId === undefined || grant.serverId === serverId)
  }
  set(grant: Grant, allowed: boolean): void {
    if (allowed) this.#grants.set(this.#key(grant), grant)
    else this.#grants.delete(this.#key(grant))
  }
}

/** Added servers in memory; removing one forgets its credentials and grants, as the SQLite store does. */
export class MemoryAddedServers implements AddedServers {
  readonly #servers = new Map<string, AddedServer>()
  readonly #credentials: MemoryCredentials
  readonly #grants: MemoryGrants
  constructor(credentials: MemoryCredentials, grants: MemoryGrants) {
    this.#credentials = credentials
    this.#grants = grants
  }
  list(): readonly AddedServer[] {
    return [...this.#servers.values()]
  }
  add(server: AddedServer): void {
    this.#servers.set(server.serverId, server)
  }
  remove(serverId: string): void {
    this.#servers.delete(serverId)
    this.#credentials.remove(serverId)
    for (const grant of this.#grants.list(serverId)) this.#grants.set(grant, false)
  }
}

/** Added registries in memory, in the order they were added. */
export class MemoryRegistries implements AddedRegistries {
  readonly #registries: Registry[] = []
  list(): readonly Registry[] {
    return [...this.#registries]
  }
  add(registry: Registry): void {
    this.#registries.push(registry)
  }
  remove(url: string): void {
    const index = this.#registries.findIndex((item) => item.url === url)
    if (index >= 0) this.#registries.splice(index, 1)
  }
}
