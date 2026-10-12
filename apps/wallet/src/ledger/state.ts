import type { Ctx } from './rows.ts'

/** Small key/value facts of the ledger (revocation, the app's view state). */
export function getState(ctx: Ctx, key: string): string | undefined {
  return ctx.sql.all<{ value: string }>('SELECT value FROM state WHERE key = ?', key)[0]?.value
}

export function putState(ctx: Ctx, key: string, value: string): void {
  ctx.sql.run(
    'INSERT INTO state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    key,
    value,
  )
}

export const REVOKED_KEY = 'revoked_at_ms'
export const isRevoked = (ctx: Ctx): boolean => getState(ctx, REVOKED_KEY) !== undefined

/** The app's view state is bounded JSON, never authority. */
export const VIEW_STATE_MAX_BYTES = 8192
