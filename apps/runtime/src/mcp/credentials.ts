import type { OAuthDiscoveryState, StoredOAuthClientInformation, StoredOAuthTokens } from '@modelcontextprotocol/client'
import { and, eq, lt } from 'drizzle-orm'
import type { DrizzleSqliteDODatabase } from 'drizzle-orm/durable-sqlite'
import { appMcpCredentials, appMcpOauthPending } from '../storage/schema.ts'
import type { CredentialCipher } from './cipher.ts'

export type ConnectionStatus = 'connected' | 'needs_auth' | 'disconnected'
export type InvalidationScope = 'all' | 'client' | 'tokens' | 'verifier' | 'discovery'

/** Pending authorizations older than this are refused at the callback. */
export const PENDING_TTL_SECONDS = 600

// Each reader parses a value this store wrote with JSON.stringify of the same SDK type; the SDK revalidates it.
const readClient = (json: string): StoredOAuthClientInformation =>
  // SAFETY: AES-GCM-authenticated JSON of StoredOAuthClientInformation written by saveClientInformation.
  JSON.parse(json) as StoredOAuthClientInformation
const readTokens = (json: string): StoredOAuthTokens =>
  // SAFETY: AES-GCM-authenticated JSON of StoredOAuthTokens written by saveTokens.
  JSON.parse(json) as StoredOAuthTokens
const readDiscovery = (json: string): OAuthDiscoveryState =>
  // SAFETY: JSON of OAuthDiscoveryState written by saveDiscoveryState; it holds public metadata only.
  JSON.parse(json) as OAuthDiscoveryState

/** Outbound OAuth credential records per server (the OAuth provider and host depend on this, not on SQLite). */
export interface Credentials {
  status(serverId: string): ConnectionStatus
  tokenExpiresAt(serverId: string): number | undefined
  clientInformation(serverId: string): Promise<StoredOAuthClientInformation | undefined>
  saveClientInformation(serverId: string, info: StoredOAuthClientInformation, now: number): Promise<void>
  tokens(serverId: string): Promise<StoredOAuthTokens | undefined>
  saveTokens(serverId: string, tokens: StoredOAuthTokens, now: number): Promise<void>
  discoveryState(serverId: string): OAuthDiscoveryState | undefined
  saveDiscoveryState(serverId: string, state: OAuthDiscoveryState, now: number): void
  markNeedsAuth(serverId: string, now: number): void
  invalidate(serverId: string, scope: InvalidationScope, now: number): void
  remove(serverId: string): void
  savePending(state: string, serverId: string, codeVerifier: string, now: number): Promise<void>
  takePending(state: string, now: number): Promise<{ serverId: string; codeVerifier: string } | undefined>
}

/** Outbound OAuth credentials, one row per configured server. Secrets are encrypted; nothing here is logged. */
export class CredentialStore implements Credentials {
  readonly #db: DrizzleSqliteDODatabase
  readonly #cipher: CredentialCipher
  constructor(db: DrizzleSqliteDODatabase, cipher: CredentialCipher) {
    this.#db = db
    this.#cipher = cipher
  }

  #row(serverId: string) {
    return this.#db.select().from(appMcpCredentials).where(eq(appMcpCredentials.serverId, serverId)).get()
  }

  #upsert(serverId: string, now: number, values: Partial<typeof appMcpCredentials.$inferInsert>): void {
    this.#db
      .insert(appMcpCredentials)
      .values({ serverId, status: 'needs_auth', updatedAt: now, ...values })
      .onConflictDoUpdate({ target: appMcpCredentials.serverId, set: { ...values, updatedAt: now } })
      .run()
  }

  status(serverId: string): ConnectionStatus {
    const row = this.#row(serverId)
    if (row === undefined) return 'disconnected'
    return row.status === 'connected' && row.tokens !== null ? 'connected' : 'needs_auth'
  }

  tokenExpiresAt(serverId: string): number | undefined {
    return this.#row(serverId)?.tokenExpiresAt ?? undefined
  }

  async clientInformation(serverId: string): Promise<StoredOAuthClientInformation | undefined> {
    const sealed = this.#row(serverId)?.clientInfo
    if (sealed === null || sealed === undefined) return undefined
    return readClient(await this.#cipher.decrypt(sealed, `${serverId}:client`))
  }

  async saveClientInformation(serverId: string, info: StoredOAuthClientInformation, now: number): Promise<void> {
    const clientInfo = await this.#cipher.encrypt(JSON.stringify(info), `${serverId}:client`)
    this.#upsert(serverId, now, { clientInfo })
  }

  async tokens(serverId: string): Promise<StoredOAuthTokens | undefined> {
    const sealed = this.#row(serverId)?.tokens
    if (sealed === null || sealed === undefined) return undefined
    return readTokens(await this.#cipher.decrypt(sealed, `${serverId}:tokens`))
  }

  async saveTokens(serverId: string, tokens: StoredOAuthTokens, now: number): Promise<void> {
    const sealed = await this.#cipher.encrypt(JSON.stringify(tokens), `${serverId}:tokens`)
    const tokenExpiresAt = tokens.expires_in === undefined ? null : now + tokens.expires_in
    this.#upsert(serverId, now, { tokens: sealed, tokenExpiresAt, status: 'connected' })
  }

  discoveryState(serverId: string): OAuthDiscoveryState | undefined {
    const json = this.#row(serverId)?.discovery
    return json === null || json === undefined ? undefined : readDiscovery(json)
  }

  saveDiscoveryState(serverId: string, state: OAuthDiscoveryState, now: number): void {
    this.#upsert(serverId, now, { discovery: JSON.stringify(state) })
  }

  markNeedsAuth(serverId: string, now: number): void {
    this.#upsert(serverId, now, { status: 'needs_auth' })
  }

  invalidate(serverId: string, scope: InvalidationScope, now: number): void {
    if (scope === 'verifier') {
      this.#db.delete(appMcpOauthPending).where(eq(appMcpOauthPending.serverId, serverId)).run()
      return
    }
    const cleared: Partial<typeof appMcpCredentials.$inferInsert> = {
      ...(scope === 'all' || scope === 'tokens' ? { tokens: null, tokenExpiresAt: null, status: 'needs_auth' } : {}),
      ...(scope === 'all' || scope === 'client' ? { clientInfo: null } : {}),
      ...(scope === 'all' || scope === 'discovery' ? { discovery: null } : {}),
    }
    this.#upsert(serverId, now, cleared)
  }

  /** Forget the server entirely: credentials, client registration and pending authorizations. */
  remove(serverId: string): void {
    this.#db.delete(appMcpCredentials).where(eq(appMcpCredentials.serverId, serverId)).run()
    this.#db.delete(appMcpOauthPending).where(eq(appMcpOauthPending.serverId, serverId)).run()
  }

  async savePending(state: string, serverId: string, codeVerifier: string, now: number): Promise<void> {
    this.#db
      .delete(appMcpOauthPending)
      .where(lt(appMcpOauthPending.createdAt, now - PENDING_TTL_SECONDS))
      .run()
    const sealed = await this.#cipher.encrypt(codeVerifier, `${state}:verifier`)
    this.#db.insert(appMcpOauthPending).values({ state, serverId, codeVerifier: sealed, createdAt: now }).run()
  }

  /** One-time use: the row is deleted whether or not it is still fresh. */
  async takePending(state: string, now: number): Promise<{ serverId: string; codeVerifier: string } | undefined> {
    const row = this.#db.select().from(appMcpOauthPending).where(eq(appMcpOauthPending.state, state)).get()
    if (row === undefined) return undefined
    this.#db
      .delete(appMcpOauthPending)
      .where(and(eq(appMcpOauthPending.state, state), eq(appMcpOauthPending.serverId, row.serverId)))
      .run()
    if (row.createdAt < now - PENDING_TTL_SECONDS) return undefined
    return { serverId: row.serverId, codeVerifier: await this.#cipher.decrypt(row.codeVerifier, `${state}:verifier`) }
  }
}
