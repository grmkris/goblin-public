import type { OAuthDiscoveryState, StoredOAuthClientInformation, StoredOAuthTokens } from '@modelcontextprotocol/client'
import { and, eq, lt } from 'drizzle-orm'
import type { DrizzleSqliteDODatabase } from 'drizzle-orm/durable-sqlite'
import { appMcpCredentials, appMcpOauthPending } from '../storage/schema.ts'
import type { CredentialCipher } from './cipher.ts'

export type ConnectionStatus = 'connected' | 'needs_auth' | 'disconnected'
export type InvalidationScope = 'all' | 'client' | 'tokens' | 'verifier' | 'discovery'

/**
 * Pending authorizations older than this are refused at the callback. An hour, not ten minutes: the Goblin Wallet's
 * consent now walks the owner through its setup and adding funds before it comes back (ADR 0048), which takes longer.
 */
export const PENDING_TTL_SECONDS = 60 * 60

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
  status(connectionId: string): ConnectionStatus
  tokenExpiresAt(connectionId: string): number | undefined
  clientInformation(connectionId: string): Promise<StoredOAuthClientInformation | undefined>
  saveClientInformation(connectionId: string, info: StoredOAuthClientInformation, now: number): Promise<void>
  tokens(connectionId: string): Promise<StoredOAuthTokens | undefined>
  saveTokens(connectionId: string, tokens: StoredOAuthTokens, now: number): Promise<void>
  discoveryState(connectionId: string): OAuthDiscoveryState | undefined
  saveDiscoveryState(connectionId: string, state: OAuthDiscoveryState, now: number): void
  markNeedsAuth(connectionId: string, now: number): void
  invalidate(connectionId: string, scope: InvalidationScope, now: number): void
  remove(connectionId: string): void
  savePending(state: string, connectionId: string, codeVerifier: string, now: number): Promise<void>
  takePending(state: string, now: number): Promise<{ connectionId: string; codeVerifier: string } | undefined>
}

/** Outbound OAuth credentials, one row per configured server. Secrets are encrypted; nothing here is logged. */
export class CredentialStore implements Credentials {
  readonly #db: DrizzleSqliteDODatabase
  readonly #cipher: CredentialCipher
  constructor(db: DrizzleSqliteDODatabase, cipher: CredentialCipher) {
    this.#db = db
    this.#cipher = cipher
  }

  #row(connectionId: string) {
    return this.#db.select().from(appMcpCredentials).where(eq(appMcpCredentials.connectionId, connectionId)).get()
  }

  #upsert(connectionId: string, now: number, values: Partial<typeof appMcpCredentials.$inferInsert>): void {
    this.#db
      .insert(appMcpCredentials)
      .values({ connectionId, status: 'needs_auth', updatedAt: now, ...values })
      .onConflictDoUpdate({ target: appMcpCredentials.connectionId, set: { ...values, updatedAt: now } })
      .run()
  }

  status(connectionId: string): ConnectionStatus {
    const row = this.#row(connectionId)
    if (row === undefined) return 'disconnected'
    return row.status === 'connected' && row.tokens !== null ? 'connected' : 'needs_auth'
  }

  tokenExpiresAt(connectionId: string): number | undefined {
    return this.#row(connectionId)?.tokenExpiresAt ?? undefined
  }

  async clientInformation(connectionId: string): Promise<StoredOAuthClientInformation | undefined> {
    const sealed = this.#row(connectionId)?.clientInfo
    if (sealed === null || sealed === undefined) return undefined
    return readClient(await this.#cipher.decrypt(sealed, `${connectionId}:client`))
  }

  async saveClientInformation(connectionId: string, info: StoredOAuthClientInformation, now: number): Promise<void> {
    const clientInfo = await this.#cipher.encrypt(JSON.stringify(info), `${connectionId}:client`)
    this.#upsert(connectionId, now, { clientInfo })
  }

  async tokens(connectionId: string): Promise<StoredOAuthTokens | undefined> {
    const sealed = this.#row(connectionId)?.tokens
    if (sealed === null || sealed === undefined) return undefined
    return readTokens(await this.#cipher.decrypt(sealed, `${connectionId}:tokens`))
  }

  async saveTokens(connectionId: string, tokens: StoredOAuthTokens, now: number): Promise<void> {
    const sealed = await this.#cipher.encrypt(JSON.stringify(tokens), `${connectionId}:tokens`)
    const tokenExpiresAt = tokens.expires_in === undefined ? null : now + tokens.expires_in
    this.#upsert(connectionId, now, { tokens: sealed, tokenExpiresAt, status: 'connected' })
  }

  discoveryState(connectionId: string): OAuthDiscoveryState | undefined {
    const json = this.#row(connectionId)?.discovery
    return json === null || json === undefined ? undefined : readDiscovery(json)
  }

  saveDiscoveryState(connectionId: string, state: OAuthDiscoveryState, now: number): void {
    this.#upsert(connectionId, now, { discovery: JSON.stringify(state) })
  }

  markNeedsAuth(connectionId: string, now: number): void {
    this.#upsert(connectionId, now, { status: 'needs_auth' })
  }

  invalidate(connectionId: string, scope: InvalidationScope, now: number): void {
    if (scope === 'verifier') {
      this.#db.delete(appMcpOauthPending).where(eq(appMcpOauthPending.connectionId, connectionId)).run()
      return
    }
    const cleared: Partial<typeof appMcpCredentials.$inferInsert> = {
      ...(scope === 'all' || scope === 'tokens' ? { tokens: null, tokenExpiresAt: null, status: 'needs_auth' } : {}),
      ...(scope === 'all' || scope === 'client' ? { clientInfo: null } : {}),
      ...(scope === 'all' || scope === 'discovery' ? { discovery: null } : {}),
    }
    this.#upsert(connectionId, now, cleared)
  }

  /** Forget the server entirely: credentials, client registration and pending authorizations. */
  remove(connectionId: string): void {
    this.#db.delete(appMcpCredentials).where(eq(appMcpCredentials.connectionId, connectionId)).run()
    this.#db.delete(appMcpOauthPending).where(eq(appMcpOauthPending.connectionId, connectionId)).run()
  }

  async savePending(state: string, connectionId: string, codeVerifier: string, now: number): Promise<void> {
    this.#db
      .delete(appMcpOauthPending)
      .where(lt(appMcpOauthPending.createdAt, now - PENDING_TTL_SECONDS))
      .run()
    const sealed = await this.#cipher.encrypt(codeVerifier, `${state}:verifier`)
    this.#db.insert(appMcpOauthPending).values({ state, connectionId, codeVerifier: sealed, createdAt: now }).run()
  }

  /** One-time use: the row is deleted whether or not it is still fresh. */
  async takePending(state: string, now: number): Promise<{ connectionId: string; codeVerifier: string } | undefined> {
    const row = this.#db.select().from(appMcpOauthPending).where(eq(appMcpOauthPending.state, state)).get()
    if (row === undefined) return undefined
    this.#db
      .delete(appMcpOauthPending)
      .where(and(eq(appMcpOauthPending.state, state), eq(appMcpOauthPending.connectionId, row.connectionId)))
      .run()
    if (row.createdAt < now - PENDING_TTL_SECONDS) return undefined
    return {
      connectionId: row.connectionId,
      codeVerifier: await this.#cipher.decrypt(row.codeVerifier, `${state}:verifier`),
    }
  }
}
