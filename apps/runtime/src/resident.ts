import type { ResidentStatus } from '@goblin/contracts'
import { eq } from 'drizzle-orm'
import type { DrizzleSqliteDODatabase } from 'drizzle-orm/durable-sqlite'
import { ResidentInactive } from './http/errors.ts'
import { appResident } from './storage/schema.ts'

/** The agent may act on its own for this long after the owner's last signed-in action. */
export const RESIDENT_TTL_SECONDS = 30 * 24 * 60 * 60

export type { ResidentStatus }

/**
 * Resident authority: what lets tools run without a live browser session (chat, inbound MCP clients, later routines
 * and channels). Every owner request renews it; a revocation is sticky until the owner re-enables it.
 */
export class ResidentAuthority {
  readonly #db: DrizzleSqliteDODatabase
  constructor(db: DrizzleSqliteDODatabase) {
    this.#db = db
  }

  #row() {
    return this.#db.select().from(appResident).where(eq(appResident.id, 1)).get()
  }

  status(now: number): ResidentStatus {
    const row = this.#row()
    if (row === undefined) return { state: 'never' }
    const times = {
      renewedAt: row.renewedAt,
      expiresAt: row.expiresAt,
      ...(row.revokedAt === null ? {} : { revokedAt: row.revokedAt }),
    }
    if (row.revokedAt !== null) return { state: 'revoked', ...times }
    return { state: row.expiresAt > now ? 'active' : 'expired', ...times }
  }

  /** Owner activity: extend the window, unless the owner revoked authority. */
  renew(now: number): void {
    const values = { id: 1, renewedAt: now, expiresAt: now + RESIDENT_TTL_SECONDS }
    this.#db
      .insert(appResident)
      .values(values)
      .onConflictDoUpdate({ target: appResident.id, set: { renewedAt: now, expiresAt: values.expiresAt } })
      .run()
  }

  revoke(now: number): void {
    this.renew(now)
    this.#db.update(appResident).set({ revokedAt: now }).where(eq(appResident.id, 1)).run()
  }

  enable(now: number): void {
    this.renew(now)
    this.#db.update(appResident).set({ revokedAt: null }).where(eq(appResident.id, 1)).run()
  }

  require(now: number): void {
    const status = this.status(now)
    if (status.state !== 'active') throw new ResidentInactive({ state: status.state })
  }
}
