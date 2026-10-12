import { move, type MoveResult } from './operations.ts'
import type { Ctx } from './rows.ts'

/** What `pay_challenge` keeps per operation: the challenge it claimed and, once signed, the credential handed over. */
export interface ChallengeCredential {
  readonly challengeId: string
  readonly credential?: string
}

export type ClaimResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly code: 'operation_id_reused' }
  | { readonly ok: false; readonly code: 'challenge_reused'; readonly operationId: string }

interface CredentialRow {
  operation_id: string
  challenge_id: string
  credential: string | null
}

const rowOf = (ctx: Ctx, column: 'operation_id' | 'challenge_id', value: string): CredentialRow | undefined =>
  ctx.sql.all<CredentialRow>(
    `SELECT operation_id, challenge_id, credential FROM challenge_credentials WHERE ${column} = ?`,
    value,
  )[0]

/**
 * Binds a challenge to one operation before anything is reserved: the same operation and challenge claim again; a
 * challenge another operation holds, or another challenge under this operation id, is refused.
 */
export function claimChallenge(ctx: Ctx, operationId: string, challengeId: string): ClaimResult {
  return ctx.sql.atomic((): ClaimResult => {
    const mine = rowOf(ctx, 'operation_id', operationId)
    if (mine !== undefined)
      return mine.challenge_id === challengeId ? { ok: true } : { ok: false, code: 'operation_id_reused' }
    const holder = rowOf(ctx, 'challenge_id', challengeId)
    if (holder !== undefined) return { ok: false, code: 'challenge_reused', operationId: holder.operation_id }
    ctx.sql.run(
      'INSERT INTO challenge_credentials (operation_id, challenge_id, credential, created_at_ms) VALUES (?, ?, NULL, ?)',
      operationId,
      challengeId,
      ctx.now(),
    )
    return { ok: true }
  })
}

/**
 * signing -> uncertain with the credential kept, in one transaction: once the credential leaves the wallet the
 * service may redeem it, so the hold stays until a receipt is reported. A credential is written once, never replaced.
 */
export function handOver(ctx: Ctx, operationId: string, reason: string, credential: string): MoveResult {
  return ctx.sql.atomic((): MoveResult => {
    ctx.sql.run(
      'UPDATE challenge_credentials SET credential = ? WHERE operation_id = ? AND credential IS NULL',
      credential,
      operationId,
    )
    return move(ctx, operationId, 'uncertain', { reason })
  })
}

export function challengeCredential(ctx: Ctx, operationId: string): ChallengeCredential | undefined {
  const row = rowOf(ctx, 'operation_id', operationId)
  if (row === undefined) return undefined
  return { challengeId: row.challenge_id, ...(row.credential === null ? {} : { credential: row.credential }) }
}
