import type { ResidentStatus } from '@goblin/contracts'
import { eq } from 'drizzle-orm'
import type { SQLiteAsyncDatabase } from 'drizzle-orm/sqlite-core/async/db'
import { ResidentInactive } from './http/errors.ts'
import { appResident } from './storage/schema.ts'

/** The agent may act on its own for this long after the owner's last signed-in action. */
export const RESIDENT_TTL_SECONDS = 30 * 24 * 60 * 60

export type { ResidentStatus }

/** The database resident authority lives in: its one `app_resident` row. */
type Database = SQLiteAsyncDatabase<'sync', unknown>

/** Resident authority at `now` (epoch seconds). */
export function residentStatus(db: Database, now: number): ResidentStatus {
  const row = db.select().from(appResident).where(eq(appResident.id, 1)).get()
  if (row === undefined) return { state: 'never' }
  const times = {
    renewedAt: row.renewedAt,
    expiresAt: row.expiresAt,
    ...(row.revokedAt === null ? {} : { revokedAt: row.revokedAt }),
  }
  if (row.revokedAt !== null) return { state: 'revoked', ...times }
  return { state: row.expiresAt > now ? 'active' : 'expired', ...times }
}

/** Owner activity: extend the window, unless the owner revoked authority (a renewal never clears a revocation). */
export function renewResident(db: Database, now: number): void {
  const values = { id: 1, renewedAt: now, expiresAt: now + RESIDENT_TTL_SECONDS }
  db.insert(appResident)
    .values(values)
    .onConflictDoUpdate({ target: appResident.id, set: { renewedAt: now, expiresAt: values.expiresAt } })
    .run()
}

/** Revokes it, sticky until the owner enables it again; the window is renewed first so its times are current. */
export function revokeResident(db: Database, now: number): void {
  renewResident(db, now)
  db.update(appResident).set({ revokedAt: now }).where(eq(appResident.id, 1)).run()
}

/** Clears a revocation and renews. */
export function enableResident(db: Database, now: number): void {
  renewResident(db, now)
  db.update(appResident).set({ revokedAt: null }).where(eq(appResident.id, 1)).run()
}

/**
 * Resident authority: what lets tools run without a live browser session (chat, inbound MCP clients, routines and
 * channels). Every owner request renews it; a revocation is sticky until the owner re-enables it. The legacy start
 * still hands this object to the services it makes; the `Resident` service (mcp/service.ts) reads the same row.
 */
export class ResidentAuthority {
  readonly #db: Database
  constructor(db: Database) {
    this.#db = db
  }

  status(now: number): ResidentStatus {
    return residentStatus(this.#db, now)
  }

  renew(now: number): void {
    renewResident(this.#db, now)
  }

  revoke(now: number): void {
    revokeResident(this.#db, now)
  }

  enable(now: number): void {
    enableResident(this.#db, now)
  }

  require(now: number): void {
    const status = this.status(now)
    if (status.state !== 'active') throw new ResidentInactive({ state: status.state })
  }
}
