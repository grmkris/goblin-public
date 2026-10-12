import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'
import type { Sql } from '../ledger/sql.ts'

/**
 * The OAuth server's state in the `WalletAuth` singleton, ported from Sidequest's `apps/api/src/oauth.ts` tables:
 * registered public clients, pending consent requests, single-use codes, token families and their tokens. Tokens and
 * codes are stored only as SHA-256 hashes. Times are epoch seconds. Every method is synchronous and each write is one
 * transaction, so nothing here waits while holding it.
 *
 * One owner (a Privy user) holds one wallet; a connection (a token family) is one client's grant to it. Revoking a
 * family revokes every token in it; replaying a used refresh token revokes its family (OAuth 2.1 §4.3.1).
 */

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS oauth_clients (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, redirect_uris_json TEXT NOT NULL, created_at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS oauth_requests (
    id TEXT PRIMARY KEY, client_id TEXT NOT NULL, redirect_uri TEXT NOT NULL, code_challenge TEXT NOT NULL,
    state TEXT NOT NULL, scopes_json TEXT NOT NULL, resource TEXT NOT NULL, status TEXT NOT NULL, owner TEXT,
    expires_at INTEGER NOT NULL, opened_at INTEGER)`,
  `CREATE TABLE IF NOT EXISTS oauth_codes (
    hash TEXT PRIMARY KEY, request_id TEXT NOT NULL, owner TEXT NOT NULL, expires_at INTEGER NOT NULL,
    consumed_at INTEGER)`,
  `CREATE TABLE IF NOT EXISTS oauth_families (
    id TEXT PRIMARY KEY, client_id TEXT NOT NULL, owner TEXT NOT NULL, scopes_json TEXT NOT NULL,
    resource TEXT NOT NULL, created_at INTEGER NOT NULL, last_used_at INTEGER, revoked_at INTEGER)`,
  `CREATE INDEX IF NOT EXISTS oauth_families_owner ON oauth_families (owner)`,
  `CREATE TABLE IF NOT EXISTS oauth_tokens (
    hash TEXT PRIMARY KEY, family_id TEXT NOT NULL, kind TEXT NOT NULL, expires_at INTEGER NOT NULL,
    consumed_at INTEGER)`,
  `CREATE INDEX IF NOT EXISTS oauth_tokens_family ON oauth_tokens (family_id)`,
]

export const REQUEST_TTL_S = 600
/** A consent page that stays open keeps its request this long past each keep-alive… */
export const KEEP_ALIVE_S = 600
/** …but never longer than this after the request opened: setup inside consent takes minutes, not hours. */
export const MAX_OPEN_S = 3600
export const CODE_TTL_S = 120
export const ACCESS_TTL_S = 3600
export const REFRESH_TTL_S = 30 * 86_400
/** `last_used_at` is written at most this often per connection, so a busy client is not a write per call. */
const LAST_USED_GRANULARITY_S = 60

const Strings = Schema.fromJsonString(Schema.Array(Schema.String))
const decodeStrings = Schema.decodeUnknownOption(Strings)
const strings = (json: string): string[] => [...Option.getOrElse(decodeStrings(json), () => [])]

export interface ClientRecord {
  readonly id: string
  readonly name: string
  readonly redirectUris: readonly string[]
}

/** A pending consent request as the consent page sees it; `expired` once it passed its time unanswered. */
export interface RequestRecord {
  readonly id: string
  readonly clientId: string
  readonly clientName: string
  readonly redirectUri: string
  readonly scopes: readonly string[]
  readonly expiresAt: number
  readonly expired: boolean
}

/** The request is bound to another owner: the first one who opened it signed in. */
export const OTHER_OWNER = 'other_owner'
export type OtherOwner = typeof OTHER_OWNER

interface PendingRow {
  client_id: string
  client_name: string
  redirect_uri: string
  scopes_json: string
  expires_at: number
  owner: string | null
  opened_at: number | null
}

const recordOf = (id: string, row: PendingRow, now: number): RequestRecord => ({
  id,
  clientId: row.client_id,
  clientName: row.client_name,
  redirectUri: row.redirect_uri,
  scopes: strings(row.scopes_json),
  expiresAt: row.expires_at,
  expired: row.expires_at <= now,
})

/** Origins of redirect URIs, each once; a stored URI that no longer parses is skipped. */
const originsOf = (uris: readonly string[]): string[] => [
  ...new Set(uris.filter((uri) => URL.canParse(uri)).map((uri) => new URL(uri).origin)),
]

/**
 * `opened_at` came after the first deployment: a table created before it gets the column once. A request opened
 * before then counts as opened at its first keep-alive; pending requests live minutes, so nothing else needs it.
 */
function addOpenedAt(sql: Sql): void {
  try {
    sql.all('SELECT opened_at FROM oauth_requests LIMIT 0')
  } catch {
    // expected: "no such column" on a table created before `opened_at`; the column is added here, once
    sql.run('ALTER TABLE oauth_requests ADD COLUMN opened_at INTEGER')
  }
}

/** Where to send the browser after the owner decided: the client's redirect URI and its `state`. */
export interface Decided {
  readonly redirectUri: string
  readonly state: string
}

/** What a valid access token grants. */
export interface AccessRecord {
  readonly owner: string
  readonly clientId: string
  readonly familyId: string
  readonly scopes: readonly string[]
}

/** Tokens just issued to a family. */
export interface Issued {
  readonly familyId: string
  readonly scopes: readonly string[]
}

export interface ConnectionRecord {
  readonly id: string
  readonly client: string
  readonly scopes: readonly string[]
  readonly createdAt: number
  readonly lastUsedAt: number | null
}

export interface OpenRequest {
  readonly id: string
  readonly clientId: string
  readonly redirectUri: string
  readonly codeChallenge: string
  readonly state: string
  readonly scopes: readonly string[]
  readonly resource: string
  readonly now: number
}

export interface CodeExchange {
  readonly codeHash: string
  readonly clientId: string
  readonly redirectUri: string
  readonly resource: string
  /** S256 of the verifier the client sent, computed by the caller. */
  readonly challenge: string
  readonly familyId: string
  readonly accessHash: string
  readonly refreshHash: string
  readonly now: number
}

export interface RefreshExchange {
  readonly refreshHash: string
  readonly clientId: string
  /** The resource the client named, or null to keep the family's. */
  readonly resource: string | null
  readonly accessHash: string
  readonly newRefreshHash: string
  readonly now: number
}

export class OAuthStore {
  readonly #sql: Sql

  constructor(sql: Sql) {
    this.#sql = sql
    for (const statement of SCHEMA) sql.run(statement)
    addOpenedAt(sql)
  }

  registerClient(input: { id: string; name: string; redirectUris: readonly string[]; now: number }): void {
    this.#sql.run(
      'INSERT INTO oauth_clients (id,name,redirect_uris_json,created_at) VALUES (?,?,?,?)',
      input.id,
      input.name,
      JSON.stringify(input.redirectUris),
      input.now,
    )
  }

  client(id: string): ClientRecord | undefined {
    const row = this.#sql.all<{ name: string; redirect_uris_json: string }>(
      'SELECT name,redirect_uris_json FROM oauth_clients WHERE id=?',
      id,
    )[0]
    return row === undefined ? undefined : { id, name: row.name, redirectUris: strings(row.redirect_uris_json) }
  }

  /**
   * A pending consent request, or the identical one already pending: the same sign-in link opened twice (the client
   * opens it and the person clicks it too) is one consent, not two.
   */
  openRequest(input: OpenRequest): string {
    return this.#sql.atomic(() => {
      this.#sql.run('DELETE FROM oauth_requests WHERE expires_at<?', input.now - 86_400)
      const scopes = JSON.stringify(input.scopes)
      const pending = this.#sql.all<{ id: string }>(
        `SELECT id FROM oauth_requests WHERE client_id=? AND redirect_uri=? AND code_challenge=? AND state=?
          AND resource=? AND scopes_json=? AND status='pending' AND expires_at>?`,
        input.clientId,
        input.redirectUri,
        input.codeChallenge,
        input.state,
        input.resource,
        scopes,
        input.now,
      )[0]
      if (pending !== undefined) return pending.id
      this.#sql.run(
        `INSERT INTO oauth_requests
          (id,client_id,redirect_uri,code_challenge,state,scopes_json,resource,status,expires_at,opened_at)
          VALUES (?,?,?,?,?,?,?,'pending',?,?)`,
        input.id,
        input.clientId,
        input.redirectUri,
        input.codeChallenge,
        input.state,
        scopes,
        input.resource,
        input.now + REQUEST_TTL_S,
        input.now,
      )
      return input.id
    })
  }

  #pending(id: string): PendingRow | undefined {
    return this.#sql.all<PendingRow>(
      `SELECT r.client_id,c.name client_name,r.redirect_uri,r.scopes_json,r.expires_at,r.owner,r.opened_at
        FROM oauth_requests r JOIN oauth_clients c ON c.id=r.client_id
        WHERE r.id=? AND r.status='pending'`,
      id,
    )[0]
  }

  /**
   * A pending request as its owner's consent page reads it, expired or not; undefined once answered or forgotten. The
   * first signed-in owner to read it while it is open is bound to it, and any other owner is refused from then on.
   */
  viewRequest(id: string, owner: string, now: number): RequestRecord | OtherOwner | undefined {
    return this.#sql.atomic(() => {
      const row = this.#pending(id)
      if (row === undefined) return undefined
      if (row.owner !== null && row.owner !== owner) return OTHER_OWNER
      if (row.owner === null && row.expires_at > now)
        this.#sql.run('UPDATE oauth_requests SET owner=?, opened_at=COALESCE(opened_at,?) WHERE id=?', owner, now, id)
      return recordOf(id, row, now)
    })
  }

  /**
   * The consent page is still open: the request stays pending `KEEP_ALIVE_S` from now, never past `MAX_OPEN_S` after
   * it opened and never shorter than it was. Binds the owner as a read does. An expired request stays expired.
   */
  keepAlive(id: string, owner: string, now: number): RequestRecord | OtherOwner | undefined {
    return this.#sql.atomic(() => {
      const row = this.#pending(id)
      if (row === undefined) return undefined
      if (row.owner !== null && row.owner !== owner) return OTHER_OWNER
      if (row.expires_at <= now) return recordOf(id, row, now)
      const opened = row.opened_at ?? now
      const extended = Math.max(row.expires_at, Math.min(now + KEEP_ALIVE_S, opened + MAX_OPEN_S))
      this.#sql.run(
        'UPDATE oauth_requests SET owner=?, opened_at=?, expires_at=? WHERE id=?',
        owner,
        opened,
        extended,
        id,
      )
      return recordOf(id, { ...row, expires_at: extended }, now)
    })
  }

  /**
   * The origins the owner's own clients redirect to: every redirect URI of a client with a live connection of theirs
   * or a pending request bound to them. `/setup?return=` may send the owner back to one of these, and nowhere else.
   */
  returnOrigins(owner: string, now: number): string[] {
    const rows = this.#sql.all<{ redirect_uris_json: string }>(
      `SELECT redirect_uris_json FROM oauth_clients WHERE id IN (
        SELECT client_id FROM oauth_families WHERE owner=? AND revoked_at IS NULL
        UNION SELECT client_id FROM oauth_requests WHERE owner=? AND status='pending' AND expires_at>?)`,
      owner,
      owner,
      now,
    )
    return originsOf(rows.flatMap((row) => strings(row.redirect_uris_json)))
  }

  /**
   * The owner's answer, once: approval stores the single-use code. Undefined when the request expired or was already
   * answered; `other_owner` when another owner opened it first.
   */
  decide(input: {
    id: string
    owner: string
    approve: boolean
    codeHash: string
    now: number
  }): Decided | OtherOwner | undefined {
    return this.#sql.atomic(() => {
      const bound = this.#pending(input.id)?.owner
      if (typeof bound === 'string' && bound !== input.owner) return OTHER_OWNER
      const row = this.#sql.all<{ redirect_uri: string; state: string }>(
        `UPDATE oauth_requests SET status=?, owner=? WHERE id=? AND status='pending' AND expires_at>?
          RETURNING redirect_uri,state`,
        input.approve ? 'approved' : 'denied',
        input.owner,
        input.id,
        input.now,
      )[0]
      if (row === undefined) return undefined
      if (input.approve)
        this.#sql.run(
          'INSERT INTO oauth_codes (hash,request_id,owner,expires_at) VALUES (?,?,?,?)',
          input.codeHash,
          input.id,
          input.owner,
          input.now + CODE_TTL_S,
        )
      return { redirectUri: row.redirect_uri, state: row.state }
    })
  }

  /** Authorization code → a new token family; the code, client, redirect, resource and PKCE must all match. */
  exchangeCode(input: CodeExchange): Issued | undefined {
    return this.#sql.atomic(() => {
      // Spent whatever happens next: a code tried with the wrong verifier or client is gone.
      const code = this.#sql.all<{ owner: string; request_id: string }>(
        `UPDATE oauth_codes SET consumed_at=? WHERE hash=? AND consumed_at IS NULL AND expires_at>?
          RETURNING owner,request_id`,
        input.now,
        input.codeHash,
        input.now,
      )[0]
      if (code === undefined) return undefined
      const request = this.#sql.all<{
        client_id: string
        redirect_uri: string
        code_challenge: string
        scopes_json: string
        resource: string
      }>(
        "SELECT client_id,redirect_uri,code_challenge,scopes_json,resource FROM oauth_requests WHERE id=? AND status='approved'",
        code.request_id,
      )[0]
      if (
        request === undefined ||
        request.client_id !== input.clientId ||
        request.redirect_uri !== input.redirectUri ||
        request.resource !== input.resource ||
        request.code_challenge !== input.challenge
      )
        return undefined
      this.#sql.run(
        'INSERT INTO oauth_families (id,client_id,owner,scopes_json,resource,created_at) VALUES (?,?,?,?,?,?)',
        input.familyId,
        input.clientId,
        code.owner,
        request.scopes_json,
        request.resource,
        input.now,
      )
      this.#issue(input.familyId, input.accessHash, input.refreshHash, input.now)
      return { familyId: input.familyId, scopes: strings(request.scopes_json) }
    })
  }

  /**
   * A refresh token → a new access and refresh token; the old refresh token is spent. A spent refresh token presented
   * again is a replay: the whole family is revoked and `replayed` is returned.
   */
  refresh(input: RefreshExchange): Issued | 'invalid' | 'replayed' {
    return this.#sql.atomic(() => {
      const row = this.#sql.all<{
        family_id: string
        consumed_at: number | null
        client_id: string
        scopes_json: string
        resource: string
      }>(
        `SELECT t.family_id,t.consumed_at,f.client_id,f.scopes_json,f.resource
          FROM oauth_tokens t JOIN oauth_families f ON f.id=t.family_id
          WHERE t.hash=? AND t.kind='refresh' AND t.expires_at>? AND f.revoked_at IS NULL`,
        input.refreshHash,
        input.now,
      )[0]
      if (row === undefined || row.client_id !== input.clientId) return 'invalid'
      if (input.resource !== null && input.resource !== row.resource) return 'invalid'
      if (row.consumed_at !== null) {
        this.#sql.run('UPDATE oauth_families SET revoked_at=? WHERE id=?', input.now, row.family_id)
        return 'replayed'
      }
      this.#sql.run('UPDATE oauth_tokens SET consumed_at=? WHERE hash=?', input.now, input.refreshHash)
      this.#sql.run('DELETE FROM oauth_tokens WHERE family_id=? AND expires_at<=?', row.family_id, input.now)
      this.#issue(row.family_id, input.accessHash, input.newRefreshHash, input.now)
      return { familyId: row.family_id, scopes: strings(row.scopes_json) }
    })
  }

  /** The grant behind an access token for this resource, or undefined. Notes the connection's last use. */
  resolveAccess(hash: string, resource: string, now: number): AccessRecord | undefined {
    const row = this.#sql.all<{
      family_id: string
      owner: string
      client_id: string
      scopes_json: string
      resource: string
      last_used_at: number | null
    }>(
      `SELECT f.id family_id,f.owner,f.client_id,f.scopes_json,f.resource,f.last_used_at
        FROM oauth_tokens t JOIN oauth_families f ON f.id=t.family_id
        WHERE t.hash=? AND t.kind='access' AND t.expires_at>? AND f.revoked_at IS NULL`,
      hash,
      now,
    )[0]
    if (row === undefined || row.resource !== resource) return undefined
    if (row.last_used_at === null || now - row.last_used_at >= LAST_USED_GRANULARITY_S)
      this.#sql.run('UPDATE oauth_families SET last_used_at=? WHERE id=?', now, row.family_id)
    return { owner: row.owner, clientId: row.client_id, familyId: row.family_id, scopes: strings(row.scopes_json) }
  }

  /** RFC 7009: revoking any token of a family revokes the family, but only for the client it was issued to. */
  revokeToken(hash: string, clientId: string, now: number): void {
    this.#sql.run(
      `UPDATE oauth_families SET revoked_at=? WHERE revoked_at IS NULL AND client_id=?
        AND id IN (SELECT family_id FROM oauth_tokens WHERE hash=?)`,
      now,
      clientId,
      hash,
    )
  }

  /** The owner's live connections, newest first. */
  connections(owner: string): ConnectionRecord[] {
    return this.#sql
      .all<{ id: string; name: string; scopes_json: string; created_at: number; last_used_at: number | null }>(
        `SELECT f.id,c.name,f.scopes_json,f.created_at,f.last_used_at
          FROM oauth_families f JOIN oauth_clients c ON c.id=f.client_id
          WHERE f.owner=? AND f.revoked_at IS NULL ORDER BY f.created_at DESC, f.id`,
        owner,
      )
      .map((row) => ({
        id: row.id,
        client: row.name,
        scopes: strings(row.scopes_json),
        createdAt: row.created_at,
        lastUsedAt: row.last_used_at,
      }))
  }

  /** Revokes one of the owner's connections; false when it is not theirs or already revoked. */
  disconnect(owner: string, familyId: string, now: number): boolean {
    return (
      this.#sql.all<{ id: string }>(
        'UPDATE oauth_families SET revoked_at=? WHERE id=? AND owner=? AND revoked_at IS NULL RETURNING id',
        now,
        familyId,
        owner,
      ).length > 0
    )
  }

  /** Revokes every connection of the owner (the wallet's "revoke all"); returns how many were live. */
  revokeOwner(owner: string, now: number): number {
    return this.#sql.all<{ id: string }>(
      'UPDATE oauth_families SET revoked_at=? WHERE owner=? AND revoked_at IS NULL RETURNING id',
      now,
      owner,
    ).length
  }

  #issue(familyId: string, accessHash: string, refreshHash: string, now: number): void {
    this.#sql.run(
      "INSERT INTO oauth_tokens (hash,family_id,kind,expires_at) VALUES (?,?,'access',?)",
      accessHash,
      familyId,
      now + ACCESS_TTL_S,
    )
    this.#sql.run(
      "INSERT INTO oauth_tokens (hash,family_id,kind,expires_at) VALUES (?,?,'refresh',?)",
      refreshHash,
      familyId,
      now + REFRESH_TTL_S,
    )
  }
}
