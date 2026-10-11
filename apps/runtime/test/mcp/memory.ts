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
  readonly pending = new Map<string, { connectionId: string; codeVerifier: string; createdAt: number }>()
  #row(connectionId: string): Row {
    const row = this.rows.get(connectionId) ?? { status: 'needs_auth' }
    this.rows.set(connectionId, row)
    return row
  }
  status(connectionId: string): ConnectionStatus {
    const row = this.rows.get(connectionId)
    if (row === undefined) return 'disconnected'
    return row.status === 'connected' && row.tokens !== undefined ? 'connected' : 'needs_auth'
  }
  tokenExpiresAt(connectionId: string): number | undefined {
    return this.rows.get(connectionId)?.expiresAt
  }
  async clientInformation(connectionId: string) {
    return this.rows.get(connectionId)?.client
  }
  async saveClientInformation(connectionId: string, info: StoredOAuthClientInformation) {
    this.#row(connectionId).client = info
  }
  async tokens(connectionId: string) {
    return this.rows.get(connectionId)?.tokens
  }
  async saveTokens(connectionId: string, tokens: StoredOAuthTokens, now: number) {
    const row = this.#row(connectionId)
    row.tokens = tokens
    row.status = 'connected'
    if (tokens.expires_in === undefined) delete row.expiresAt
    else row.expiresAt = now + tokens.expires_in
  }
  discoveryState(connectionId: string) {
    return this.rows.get(connectionId)?.discovery
  }
  saveDiscoveryState(connectionId: string, state: OAuthDiscoveryState) {
    this.#row(connectionId).discovery = state
  }
  markNeedsAuth(connectionId: string) {
    this.#row(connectionId).status = 'needs_auth'
  }
  invalidate(connectionId: string, scope: InvalidationScope) {
    const row = this.#row(connectionId)
    if (scope === 'all' || scope === 'tokens') {
      delete row.tokens
      delete row.expiresAt
      row.status = 'needs_auth'
    }
    if (scope === 'all' || scope === 'client') delete row.client
    if (scope === 'all' || scope === 'discovery') delete row.discovery
  }
  remove(connectionId: string) {
    this.rows.delete(connectionId)
  }
  async savePending(state: string, connectionId: string, codeVerifier: string, now: number) {
    this.pending.set(state, { connectionId, codeVerifier, createdAt: now })
  }
  async takePending(state: string, now: number) {
    const entry = this.pending.get(state)
    this.pending.delete(state)
    if (entry === undefined || entry.createdAt < now - PENDING_TTL_SECONDS) return undefined
    return { connectionId: entry.connectionId, codeVerifier: entry.codeVerifier }
  }
}

export class MemoryGrants implements Grants {
  readonly #grants = new Map<string, Grant>()
  readonly #versions = new Map<string, string>()
  constructor(initial: readonly Grant[] = []) {
    for (const grant of initial) this.set(grant, true)
  }
  #key = (grant: Grant): string => JSON.stringify([grant.connectionId, grant.capability, grant.name])
  allows(grant: Grant): boolean {
    return this.#grants.has(this.#key(grant))
  }
  list(connectionId?: string): readonly Grant[] {
    return [...this.#grants.values()].filter(
      (grant) => connectionId === undefined || grant.connectionId === connectionId,
    )
  }
  set(grant: Grant, allowed: boolean): void {
    if (allowed) {
      if (!this.#grants.has(this.#key(grant))) {
        this.#grants.set(this.#key(grant), grant)
        this.#versions.set(this.#key(grant), crypto.randomUUID())
      }
    } else this.#grants.delete(this.#key(grant))
  }
  policy(grant: Grant) {
    const row = this.#grants.get(this.#key(grant))
    return row === undefined
      ? undefined
      : { askFirst: row.askFirst ?? false, version: this.#versions.get(this.#key(grant)) ?? '' }
  }
  setAskFirst(grant: Grant, enabled: boolean): void {
    const row = this.#grants.get(this.#key(grant))
    if (row === undefined) throw new Error('Missing fixture grant')
    this.#grants.set(this.#key(grant), { ...row, askFirst: enabled })
    this.#versions.set(this.#key(grant), crypto.randomUUID())
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
    this.#servers.set(server.connectionId, server)
  }
  remove(connectionId: string): void {
    this.#servers.delete(connectionId)
    this.#credentials.remove(connectionId)
    for (const grant of this.#grants.list(connectionId)) this.#grants.set(grant, false)
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
