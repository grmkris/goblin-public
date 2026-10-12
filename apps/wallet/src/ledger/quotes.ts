import { Quote, Terms } from '@goblin/wallet/contract'
import * as Schema from 'effect/Schema'
import type { Ctx } from './rows.ts'

/** A swap or bridge quote the wallet froze: executing it never re-derives the terms from new arguments. */
export const StoredQuote = Schema.Struct({
  kind: Schema.Literals(['swap', 'bridge']),
  quote: Quote,
  terms: Terms,
  /** The rail's own data, opaque to the ledger. */
  payload: Schema.Unknown,
})
export type StoredQuote = typeof StoredQuote.Type

const decodeStored = Schema.decodeUnknownSync(Schema.fromJsonString(StoredQuote))

export function putQuote(ctx: Ctx, stored: StoredQuote): void {
  ctx.sql.run(
    `INSERT INTO quotes (id, body_json, expires_at_ms, created_at_ms) VALUES (?, ?, ?, ?)
     ON CONFLICT(id) DO NOTHING`,
    stored.quote.quote_id,
    JSON.stringify(stored),
    Date.parse(stored.quote.expiresAt),
    ctx.now(),
  )
}

/** The frozen quote, or undefined when it never existed or has expired (unless `includeExpired`: an operation replay). */
export function getQuote(ctx: Ctx, id: string, includeExpired = false): StoredQuote | undefined {
  const row = ctx.sql.all<{ body_json: string; expires_at_ms: number }>(
    'SELECT body_json, expires_at_ms FROM quotes WHERE id = ?',
    id,
  )[0]
  if (row === undefined || (!includeExpired && row.expires_at_ms <= ctx.now())) return undefined
  return decodeStored(row.body_json)
}
