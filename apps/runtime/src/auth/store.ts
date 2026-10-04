import { Predicate } from 'effect'
import type { GrantCapability, GrantRecord, GrantStore } from './principal.ts'

type StoredGrant = {
  issuer: string
  subject: string
  client_id: string
  tenant_id: string | null
  server_id: string
  capability: GrantCapability
  name: string
  scopes_json: string
  generation: number
  expires_at: number | null
}
const parseScopes = (text: string): readonly string[] => {
  const decoded: unknown = JSON.parse(text)
  if (!Array.isArray(decoded) || !decoded.every((item) => Predicate.isString(item)))
    throw new Error('mcp_grant_scopes_invalid')
  return decoded
}
const grantOf = (row: StoredGrant): GrantRecord => ({
  issuer: row.issuer,
  subject: row.subject,
  clientId: row.client_id,
  ...(row.tenant_id === null ? {} : { tenantId: row.tenant_id }),
  serverId: row.server_id,
  capability: row.capability,
  name: row.name,
  scopes: parseScopes(row.scopes_json),
  generation: row.generation,
  ...(row.expires_at === null ? {} : { expiresAt: row.expires_at }),
})
export class D1GrantStore implements GrantStore {
  readonly #db: D1Database
  constructor(database: D1Database) {
    this.#db = database
  }
  async findGrant(input: {
    issuer: string
    subject: string
    clientId: string
    serverId: string
    capability: GrantCapability
    name: string
  }): Promise<GrantRecord | undefined> {
    const row = await this.#db
      .prepare(
        'SELECT * FROM app_mcp_grants WHERE issuer = ? AND subject = ? AND client_id = ? AND server_id = ? AND capability = ? AND name = ? AND revoked_at IS NULL',
      )
      .bind(input.issuer, input.subject, input.clientId, input.serverId, input.capability, input.name)
      .first<StoredGrant>()
    return row === null ? undefined : grantOf(row)
  }
  async currentGeneration(input: {
    issuer: string
    subject: string
    clientId: string
    serverId: string
  }): Promise<number> {
    const row = await this.#db
      .prepare(
        'SELECT generation FROM app_mcp_grant_generations WHERE issuer = ? AND subject = ? AND client_id = ? AND server_id = ?',
      )
      .bind(input.issuer, input.subject, input.clientId, input.serverId)
      .first<{ generation: number }>()
    return row?.generation ?? 0
  }
  async list(input: { issuer: string; subject: string }): Promise<readonly GrantRecord[]> {
    const rows = await this.#db
      .prepare('SELECT * FROM app_mcp_grants WHERE issuer = ? AND subject = ? AND revoked_at IS NULL')
      .bind(input.issuer, input.subject)
      .all<StoredGrant>()
    return rows.results.map(grantOf)
  }
  async create(grant: GrantRecord, now: number): Promise<void> {
    await this.#db.batch([
      this.#db
        .prepare(
          'INSERT INTO app_mcp_grant_generations (issuer, subject, client_id, server_id, generation) VALUES (?, ?, ?, ?, ?) ON CONFLICT DO NOTHING',
        )
        .bind(grant.issuer, grant.subject, grant.clientId, grant.serverId, grant.generation),
      this.#db
        .prepare(
          'INSERT INTO app_mcp_grants (issuer, subject, client_id, tenant_id, server_id, capability, name, scopes_json, generation, expires_at, created_at, revoked_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL) ON CONFLICT (issuer, subject, client_id, server_id, capability, name) DO UPDATE SET scopes_json = excluded.scopes_json, generation = excluded.generation, expires_at = excluded.expires_at, revoked_at = NULL',
        )
        .bind(
          grant.issuer,
          grant.subject,
          grant.clientId,
          grant.tenantId ?? null,
          grant.serverId,
          grant.capability,
          grant.name,
          JSON.stringify(grant.scopes),
          grant.generation,
          grant.expiresAt ?? null,
          now,
        ),
    ])
  }
  async revoke(
    input: { issuer: string; subject: string; clientId: string; serverId: string },
    now: number,
  ): Promise<void> {
    await this.#db.batch([
      this.#db
        .prepare(
          'UPDATE app_mcp_grants SET revoked_at = ? WHERE issuer = ? AND subject = ? AND client_id = ? AND server_id = ?',
        )
        .bind(now, input.issuer, input.subject, input.clientId, input.serverId),
      this.#db
        .prepare(
          'INSERT INTO app_mcp_grant_generations (issuer, subject, client_id, server_id, generation) VALUES (?, ?, ?, ?, 1) ON CONFLICT (issuer, subject, client_id, server_id) DO UPDATE SET generation = generation + 1',
        )
        .bind(input.issuer, input.subject, input.clientId, input.serverId),
    ])
  }
}
