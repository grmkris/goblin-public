import type { InboundClient } from '@goblin/contracts'
import type { RuntimeEnv } from '../env.ts'
import { nowSeconds } from '../clock.ts'

type Row = { clientId: string; name: string | null; uri: string | null; consentedAt: string | number | null }

const text = (value: string | number | null): string | undefined =>
  value === null ? undefined : typeof value === 'number' ? new Date(value).toISOString() : value

/** MCP clients this user has consented to and not revoked. */
export const listInboundClients = async (env: RuntimeEnv, userId: string): Promise<readonly InboundClient[]> => {
  const { results } = await env.AUTH_DB.prepare(
    `SELECT c.clientId AS clientId, c.name AS name, c.uri AS uri, MIN(o.createdAt) AS consentedAt
       FROM oauthConsent o JOIN oauthClient c ON c.clientId = o.clientId
      WHERE o.userId = ? AND (c.disabled IS NULL OR c.disabled = 0)
      GROUP BY c.clientId, c.name, c.uri ORDER BY consentedAt DESC`,
  )
    .bind(userId)
    .all<Row>()
  return results.map((row) => {
    const consentedAt = text(row.consentedAt)
    return {
      clientId: row.clientId,
      ...(row.name === null ? {} : { name: row.name }),
      ...(row.uri === null ? {} : { uri: row.uri }),
      ...(consentedAt === undefined ? {} : { consentedAt }),
    }
  })
}

/**
 * End a client's access to this user's agent now: the user's consent goes and their refresh tokens for it are revoked.
 * Access tokens stop working at once because every /mcp request checks the consent. Other users of the same client
 * registration are untouched.
 */
export const revokeInboundClient = async (env: RuntimeEnv, userId: string, clientId: string): Promise<void> => {
  const revokedAt = new Date(nowSeconds() * 1000).toISOString()
  await env.AUTH_DB.batch([
    env.AUTH_DB.prepare('DELETE FROM oauthConsent WHERE clientId = ? AND userId = ?').bind(clientId, userId),
    env.AUTH_DB.prepare(
      'UPDATE oauthRefreshToken SET revoked = ? WHERE clientId = ? AND userId = ? AND revoked IS NULL',
    ).bind(revokedAt, clientId, userId),
  ])
}
