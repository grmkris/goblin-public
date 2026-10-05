import { Effect } from 'effect'
import { inArray, lte } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/d1'
import { Internal } from '../http/errors.ts'
import { admissions, rateLimits } from './schema.ts'

const BATCH_SIZE = 1000
// Preview buckets last one minute; invitation send buckets last one hour. Keep every potentially live bucket.
const MAX_RATE_WINDOW_MS = 3_600_000

/** Expired proofs cannot authorize or replay. Bound each indexed sweep and retain all live hourly send counters. */
export const pruneWorkspaceAccess = Effect.fn('workspaces.prune')(function* (database: D1Database, now: number) {
  const db = drizzle(database)
  yield* Effect.tryPromise({
    try: () =>
      db.batch([
        db
          .delete(admissions)
          .where(
            inArray(
              admissions.proofHash,
              db
                .select({ id: admissions.proofHash })
                .from(admissions)
                .where(lte(admissions.expiresAt, now))
                .orderBy(admissions.expiresAt)
                .limit(BATCH_SIZE),
            ),
          ),
        db.delete(rateLimits).where(
          inArray(
            rateLimits.key,
            db
              .select({ id: rateLimits.key })
              .from(rateLimits)
              .where(lte(rateLimits.windowStart, now - MAX_RATE_WINDOW_MS))
              .orderBy(rateLimits.windowStart)
              .limit(BATCH_SIZE),
          ),
        ),
      ]),
    catch: () => new Internal({ reason: 'workspace cleanup unavailable' }),
  })
})
